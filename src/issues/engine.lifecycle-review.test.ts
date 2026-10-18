import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOD, MIN, SHA2, harness } from "./engine-harness.ts";
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
          if (status === "missing") throw Object.assign(new Error("environment not found"), { status: 404 });
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
