import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { GOOD, MIN, SHA2, SHA3, harness } from "./engine-harness.ts";
import { EFFECT_POLICY, recover } from "./job.ts";

for (const race of ["held", "restart", "cas"] as const) {
  test(`current worker reports survive ${race} during durable reminder delivery`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const initial = await h.only();
    Object.assign(h.threads.get(initial.threadId!)!, { status: "idle", updatedAt: h.clock.now });
    const hold = h.holdAt("send", "sdk");
    const sweeping = h.engine().issues.sweep();
    await hold.hit;
    assert.equal((await h.only()).state, "recovering");
    const response = await h.report(initial.threadId!, GOOD);
    assert.equal(response.exitCode, 0, response.stderr);
    const pending = h.store.pendingSubmissions(initial.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.intendedSha, SHA2);
    if (race === "restart") h.restart();
    if (race === "cas") {
      const current = h.store.get(initial.id)!;
      assert.ok(h.store.write(current.id, current.version, { error: "concurrent observation" }, h.clock.now));
    }
    hold.free(); await sweeping;
    await h.settle();
    if (race !== "held") {
      h.clock.now += EFFECT_POLICY["send-round"].leaseMs;
      await h.settle();
    }
    await h.advance(2 * MIN);
    assert.equal(h.store.pendingSubmissions(initial.id).length, 0);
    assert.equal(h.store.get(initial.id)!.report!.headSha, SHA2);
    assert.equal((await h.only()).outcome, "ready");
    assert.equal(h.spawned.length, 1);
  });
}

test("pending feedback waits for the provider retry across restart and retains its worker", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const worker = h.threads.get(job.threadId!)!;
  worker.status = "error";
  const retryAt = h.clock.now + 30 * MIN;
  h.failures.scheduledRetryAt = retryAt;
  const feedback = h.review(pr, { body: "Verify the empty result." });
  await h.advance(3 * MIN);
  h.restart(); await h.advance(5 * MIN);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.stopped.length, 0);
  assert.equal(h.store.get(job.id)!.control.recoveries, 0);
  assert.deepEqual(h.store.pendingFeedback(job.id).map((item) => item.id), [feedback.id]);
  worker.status = "active";
  h.failures.scheduledRetryAt = null;
  h.clock.now = retryAt;
  await h.settle();
  assert.equal((await h.only()).state, "addressing");
  assert.equal((await h.only()).threadId, worker.id);
  assert.equal(h.spawned.length, 1);
});

for (const status of ["error", "destroyed", "missing", "unknown-exception"] as const) {
  test(`recovery fails truthfully for confirmed environment ${status}`, async () => {
    let recovering = false;
    const h = harness({ configureDeps(deps) {
      const get = deps.bb.sdk.environments.get;
      deps.bb.sdk.environments.get = async (args) => {
        if (recovering) {
          if (status === "missing") throw new BbHttpError({ status: 404, code: null, body: null, message: "Not Found" });
          if (status === "unknown-exception") throw new Error("unexpected workspace observation failure");
          return { ...await get(args), status };
        }
        return get(args);
      };
    } });
    h.label(41); await h.settle();
    const original = h.store.get((await h.only()).id)!;
    recovering = true;
    assert.ok(h.store.write(original.id, original.version, recover(original, "idle worker"), h.clock.now));
    await h.settle();
    assert.equal((await h.only()).outcome, "failure");
    assert.equal(h.spawned.length, 1);
    assert.ok(h.store.get(original.id)!.control.workspace);
  });
}

test("pre-spawn transient observations grow backoff across restart and exhaust a separate bounded budget", async () => {
  let recovering = false;
  const observations: number[] = [];
  let wrapped = false;
  const h = harness({ configureDeps(deps) {
    if (wrapped) return;
    wrapped = true;
    const get = deps.bb.sdk.environments.get;
    deps.bb.sdk.environments.get = async (args) => {
      const value = await get(args);
      if (!recovering) return value;
      observations.push(deps.clock!());
      return { ...value, status: "provisioning" };
    };
  } });
  h.label(41); await h.settle();
  const original = h.store.get((await h.only()).id)!;
  recovering = true;
  assert.ok(h.store.write(original.id, original.version, recover(original, "idle worker"), h.clock.now));
  await h.settle();
  for (let attempt = 0; attempt < 12 && (await h.only()).state === "recovering"; attempt++) {
    const current = h.store.get(original.id)!;
    assert.ok("nextAt" in current.phase && current.phase.nextAt !== null);
    h.clock.now = current.phase.nextAt;
    h.restart(); await h.settle();
  }
  assert.equal((await h.only()).outcome, "failure");
  assert.match((await h.only()).error!, /provisioning/);
  assert.equal(h.spawned.length, 1);
  const gaps = observations.slice(1).map((at, index) => at - observations[index]!);
  assert.ok(gaps[1]! > gaps[0]!, JSON.stringify(gaps));
  assert.ok(observations.length <= 10);
  assert.equal(h.store.get(original.id)!.control.recoveries, 1);
});

class BbHttpError extends Error {
  readonly body: unknown;
  readonly code: string | null;
  readonly status: number;
  constructor(args: { body: unknown; code: string | null; message: string; status: number }) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "BbHttpError";
    this.body = args.body;
    this.code = args.code;
    this.status = args.status;
  }
}
class BbRequestTimeoutError extends Error {
  constructor() {
    super("BB request timed out after 75 seconds.");
    this.name = "BbRequestTimeoutError";
  }
}
const transportFailures = [
  { boundary: "get", label: "status 503", error: () => Object.assign(new Error("SDK temporarily unavailable"), { status: 503 }) },
  { boundary: "status", label: "statusCode 503", error: () => Object.assign(new Error("SDK temporarily unavailable"), { statusCode: 503 }) },
  { boundary: "writers", label: "status 429", error: () => Object.assign(new Error("SDK temporarily unavailable"), { status: 429 }) },
  { boundary: "get", label: "BbHttpError 503 without a code", error: () => new BbHttpError({ status: 503, code: null, body: null, message: "Service Unavailable" }) },
  { boundary: "status", label: "BbRequestTimeoutError", error: () => new BbRequestTimeoutError() },
  { boundary: "writers", label: "connection refused", error: () => new Error("Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.") },
] as const;

for (const { boundary, label, error } of transportFailures) {
  for (const persistent of [false, true]) {
    test(`${boundary} SDK ${label} ${persistent ? "exhausts a bounded observation budget" : "recovers after restart without an uncertain spawn"}`, async () => {
      let recovering = false;
      let attempts = 0;
      let wrapped = false;
      let workerThread = "";
      const observations: number[] = [];
      const h = harness({ configureDeps(deps) {
        if (wrapped) return;
        wrapped = true;
        const fail = () => {
          if (!recovering || !persistent && attempts > 0) return;
          const phase = h.store.byThread(workerThread)?.phase;
          if (!phase || !("effects" in phase) || phase.effects[0]?.op !== "recover-worker") return;
          observations.push(deps.clock!());
          attempts++;
          throw error();
        };
        if (boundary === "get") {
          const get = deps.bb.sdk.environments.get;
          deps.bb.sdk.environments.get = async (args) => { fail(); return get(args); };
        } else if (boundary === "status") {
          const status = deps.bb.sdk.environments.status;
          deps.bb.sdk.environments.status = async (args) => { fail(); return status(args); };
        } else {
          const list = deps.bb.sdk.threads.list;
          deps.bb.sdk.threads.list = async (args) => { if (args?.environmentId) fail(); return list(args); };
        }
      } });
      h.label(41); await h.settle();
      const original = h.store.get((await h.only()).id)!;
      workerThread = original.threadId!;
      recovering = true;
      h.store.write(original.id, original.version, recover(original, "idle worker"), h.clock.now);
      await h.settle();
      assert.equal((await h.only()).state, "recovering");
      assert.equal(h.spawned.length, 1);
      assert.equal(h.store.get(original.id)!.control.recoveryObservation!.attempts, 1);
      for (let n = 0; n < 12 && (await h.only()).state === "recovering"; n++) {
        const current = h.store.get(original.id)!;
        assert.ok("nextAt" in current.phase && current.phase.nextAt !== null);
        h.clock.now = current.phase.nextAt;
        h.restart(); await h.settle();
      }
      const result = h.store.get(original.id)!;
      assert.equal(result.control.recoveries, 1);
      if (persistent) {
        assert.equal((await h.only()).outcome, "failure");
        assert.match(result.error!, /safe workspace observation exhausted/);
        assert.equal(h.spawned.length, 1);
        assert.ok(observations.length <= 10);
        const gaps = observations.slice(1).map((at, n) => at - observations[n]!);
        assert.ok(gaps[1]! > gaps[0]!, JSON.stringify(gaps));
      } else {
        assert.equal((await h.only()).state, "working");
        assert.equal(h.spawned.length, 2);
        assert.equal(h.spawned[1]!.environment.environmentId, original.control.workspace!.environmentId);
      }
    });
  }
}

const permissionFailures = [
  ...[401, 403].map((status) => ({ label: `status ${status} over a nested reset`, error: () => Object.assign(new Error("SDK access denied"), { status, cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }) })),
  ...[401, 403].map((status) => ({ label: `BbHttpError ${status} without a code`, error: () => new BbHttpError({ status, code: null, body: null, message: "Forbidden" }) })),
  { label: "BbHttpError 403 over a transport code and refused cause", error: () => Object.assign(new BbHttpError({ status: 403, code: "ECONNRESET", body: null, message: "Forbidden" }), { cause: new Error("Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.") }) },
];
for (const { label, error } of permissionFailures) {
  test(`SDK observation permission ${label} remains terminal`, async () => {
    let recovering = false;
    const h = harness({ configureDeps(deps) {
      const get = deps.bb.sdk.environments.get;
      deps.bb.sdk.environments.get = async (args) => {
        if (recovering) throw error();
        return get(args);
      };
    } });
    h.label(41); await h.settle();
    const original = h.store.get((await h.only()).id)!;
    recovering = true;
    h.store.write(original.id, original.version, recover(original, "idle worker"), h.clock.now);
    await h.settle();
    assert.equal((await h.only()).outcome, "failure");
    assert.equal(h.spawned.length, 1);
    assert.equal(h.store.get(original.id)!.control.recoveryObservation, null);
  });
}

test("an actual loopback SDK fetch disconnect uses bounded pre-spawn recovery", async (t) => {
  const server = createServer((request) => request.socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let disconnected = false;
  let observed = false;
  const h = harness({ configureDeps(deps) {
    const status = deps.bb.sdk.environments.status;
    deps.bb.sdk.environments.status = async (args) => {
      const phase = disconnected ? h.store.byThread(original.threadId!)?.phase : null;
      if (phase && "effects" in phase && phase.effects[0]?.op === "recover-worker") {
        observed = true;
        await fetch(`http://127.0.0.1:${address.port}`);
      }
      return status(args);
    };
  } });
  h.label(41); await h.settle();
  const original = h.store.get((await h.only()).id)!;
  disconnected = true;
  h.store.write(original.id, original.version, recover(original, "idle worker"), h.clock.now);
  await h.settle();
  assert.equal(observed, true);
  assert.equal((await h.only()).state, "recovering");
  assert.equal(h.store.get(original.id)!.control.recoveryObservation!.attempts, 1);
  disconnected = false;
  const phase = h.store.get(original.id)!.phase;
  assert.ok("nextAt" in phase && phase.nextAt !== null);
  h.clock.now = phase.nextAt;
  await h.settle();
  assert.equal((await h.only()).state, "working");
  assert.equal(h.spawned.length, 2);
});

test("a corrected report is retained while its asynchronous rejection notice is in flight", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  h.gh().outages.push({ key: "GET /repos/acme/web/installation", times: Infinity });
  const saved = await h.report(job.threadId!, { ...GOOD, pr: { ...GOOD.pr, title: "invalid" } });
  assert.equal(saved.exitCode, 0);
  const hold = h.holdAt("send", "sdk");
  h.gh().outages.length = 0;
  const sweeping = h.engine().issues.sweep();
  await hold.hit;
  const foreign = { ...h.threads.get(job.threadId!)!, id: "foreign", metadata: { pstackIssue: 1, jobId: job.id, epoch: 0 } };
  h.threads.set(foreign.id, foreign);
  const unauthorized = await h.report(foreign.id, GOOD);
  assert.equal(unauthorized.exitCode, 1);
  const corrected = await h.report(job.threadId!, GOOD);
  assert.equal(corrected.exitCode, 0, corrected.stderr);
  assert.equal(h.store.pendingSubmissions(job.id).length, 1);
  h.restart(); hold.free(); await sweeping;
  h.clock.now += EFFECT_POLICY["send-round"].leaseMs;
  await h.settle(); await h.advance(2 * MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.equal(h.store.get(job.id)!.report!.headSha, SHA2);
  assert.equal(h.spawned.length, 1);
});

for (const state of ["done", "stopped", "stuck", "ignored"] as const) {
  test(`late worker events and pending submissions cannot reopen ${state}`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const current = h.store.get((await h.only()).id)!;
    const terminal = h.store.write(current.id, current.version, { phase: { state }, control: { ...current.control, disposition: state === "done" ? "no-change" : state === "stopped" ? "stopped" : state === "stuck" ? "failure" : null } }, h.clock.now)!;
    h.store.submit(terminal, terminal.threadId!, JSON.stringify(GOOD), h.clock.now);
    h.engine().issues.register();
    await h.events.get("thread.idle")!({ thread: { id: terminal.threadId, originPluginId: "pstack" } });
    await h.settle();
    assert.equal(h.store.get(current.id)!.phase.state, state);
    assert.equal(h.store.get(current.id)!.version, terminal.version);
    assert.deepEqual(h.store.get(current.id)!.control, terminal.control);
    assert.equal(h.store.pendingSubmissions(current.id).length, 0);
    assert.equal(h.pushes.length, 0);
  });
}

for (const status of ["error", "destroyed", "missing"] as const) {
  test(`a report records confirmed environment ${status} as failure without waiting forever`, async () => {
    let failed = false;
    const h = harness({ configureDeps(deps) {
      const get = deps.bb.sdk.environments.get;
      deps.bb.sdk.environments.get = async (args) => {
        if (failed && status === "missing") throw Object.assign(new Error("environment not found"), { status: 404 });
        return { ...await get(args), ...(failed && status !== "missing" ? { status } : {}) };
      };
    } });
    h.label(41); await h.settle();
    const job = await h.only();
    h.gh().outages.push({ key: "GET /repos/acme/web/installation", times: Infinity });
    const response = await h.report(job.threadId!, GOOD);
    assert.equal(response.exitCode, 0);
    failed = true;
    h.gh().outages.length = 0;
    await h.settle();
    assert.equal((await h.only()).outcome, "failure");
    assert.equal(h.store.pendingSubmissions(job.id).length, 0);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.pushes.length, 0);
  });
}

test("recovery retires pstack's own message queued behind the worker's turn instead of sticking", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  h.failures.queueSends = true;
  h.failures.missingObject = SHA3;
  assert.equal((await h.report(worker, GOOD)).exitCode, 0);
  await h.settle();
  assert.equal(h.rows.get(worker)?.length, 1);
  assert.match(h.rows.get(worker)![0]!.text, /bb pstack gh fetch/);
  Object.assign(h.threads.get(worker)!, { status: "error", updatedAt: h.clock.now });
  await h.advance(3 * MIN);
  const job = await h.only();
  assert.notEqual(job.state, "stuck", job.error ?? "");
  assert.deepEqual(h.rows.get(worker), []);
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1]!.environment.type, "reuse");
  assert.match(h.spawned[1]!.prompt, new RegExp(`Fetch the missing object ${SHA3}`));
});

test("recovery still refuses a workspace whose worker holds a message pstack did not queue", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  Object.assign(h.threads.get(worker)!, { status: "error", updatedAt: h.clock.now, queuedMessageCount: 1 });
  h.queued.add(worker);
  await h.advance(3 * MIN);
  const job = await h.only();
  assert.equal(job.state, "stuck");
  assert.match(job.error!, /exclusive reuse is unavailable/);
  assert.equal(h.spawned.length, 1);
});
