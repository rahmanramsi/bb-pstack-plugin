import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, GOOD, MIN, SHA2 } from "./engine-harness.ts";
import { EFFECT_POLICY } from "./job.ts";

for (const lostResponse of [false, true]) {
  test(`idle reminders survive ${lostResponse ? "a lost send response" : "a send outage"} and restart without human action`, async () => {
    let fail = true;
    const h = harness({ configureDeps(deps) {
      const send = deps.bb.sdk.threads.send;
      deps.bb.sdk.threads.send = async (args) => {
        if (!fail) return send(args);
        if (lostResponse) await send(args);
        throw new Error("send connection lost");
      };
    } });
    h.label(41); await h.settle();
    const job = await h.only();
    const worker = h.threads.get(job.threadId!)!;
    Object.assign(worker, { status: "idle", updatedAt: h.clock.now });
    await h.settle();
    const pending = h.store.get(job.id)!;
    assert.equal(pending.phase.state, "recovering");
    assert.ok("effects" in pending.phase && pending.phase.effects[0].op === "send-round");
    assert.equal(pending.nudges, 1);
    h.restart(); fail = false;
    h.clock.now += MIN;
    await h.settle();
    assert.equal((await h.only()).state, "working");
    assert.ok(h.sent.length >= 1);
    h.clock.now += MIN;
    await h.settle();
    assert.equal(h.store.get(job.id)!.nudges, 2);
    h.clock.now += MIN;
    await h.settle();
    assert.equal(h.spawned.length, 2);
    assert.notEqual((await h.only()).threadId, worker.id);
  });
}

test("a crash after accepted reminder send retains delivery intent until lease expiry", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  Object.assign(h.threads.get(job.threadId!)!, { status: "idle", updatedAt: h.clock.now });
  const held = h.holdAt("send", "sdk");
  const sweep = h.engine().issues.sweep();
  await held.hit;
  try {
    h.restart();
    h.clock.now += EFFECT_POLICY["send-round"].leaseMs + 1;
    await h.settle();
    assert.equal((await h.only()).state, "working");
    assert.equal(h.store.get(job.id)!.nudges, 1);
  } finally { held.free(); await sweep; }
  h.clock.now += MIN;
  await h.settle();
  h.clock.now += MIN;
  await h.settle();
  assert.equal(h.spawned.length, 2);
});

test("exhausted feedback-worker recovery preserves its failure and leaves feedback pending", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const row = h.store.get(job.id)!;
  h.store.write(row.id, row.version, { control: { ...row.control, recoveries: 2 } }, h.clock.now);
  h.threads.get(job.threadId!)!.status = "error";
  h.review(pr, { body: "Correct the footer spacing." });
  h.clock.now += 3 * MIN;
  await h.settle();
  const failed = await h.only();
  assert.equal(failed.state, "stuck");
  assert.match(failed.error!, /automatic recovery exhausted.*feedback worker/);
  assert.equal(failed.round, job.round);
  assert.equal(h.store.pendingFeedback(job.id).length, 1);
  assert.equal(h.spawned.length, 1);
});

for (const merged of [true, false]) {
  test(`draft conversion racing ${merged ? "merge" : "closure"} retains the PR disposition`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const working = await h.only();
    const held = h.holdAt("POST /graphql", "github");
    const report = h.report(working.threadId!, GOOD);
    await held.hit;
    const pr = (await h.only()).pr!.number;
    h.gh().pulls.set(pr, { state: "closed", merged, requested: new Set() });
    held.free(); await report; await h.settle();
    const result = await h.only();
    assert.equal(result.state, merged ? "done" : "stuck");
    assert.equal(h.store.get(result.id)!.control.disposition, merged ? "merged" : "closed");
    if (!merged) assert.match(result.error!, /closed without merging/);
    assert.doesNotMatch(result.error ?? "", /readiness conversion/);
  });
}

for (const observation of ["creating", "provisioning", "unavailable"] as const) {
  test(`recovery retries ${observation} workspace observations before reusing the exact environment`, async () => {
    let pending = false;
    const h = harness({ configureDeps(deps) {
      const get = deps.bb.sdk.environments.get;
      const status = deps.bb.sdk.environments.status;
      deps.bb.sdk.environments.get = async (args) => ({ ...await get(args), ...(pending && observation !== "unavailable" ? { status: observation, path: null } : {}) });
      deps.bb.sdk.environments.status = async (args) => pending && observation === "unavailable" ? { outcome: "unavailable", failure: { code: "unknown", message: "host warming up", workspacePath: "/worktrees/preserved" } } : status(args);
    } });
    h.label(41); await h.settle();
    const job = await h.only();
    const worker = h.threads.get(job.threadId!)!;
    await h.report(worker.id, GOOD); await h.settle();
    h.review((await h.only()).pr!.number, { body: "Keep footer spacing consistent." });
    worker.status = "error"; pending = true; h.clock.now += 3 * MIN;
    await h.settle();
    assert.equal((await h.only()).state, "recovering");
    assert.equal(h.spawned.length, 1);
    h.restart(); pending = false; h.clock.now += MIN;
    await h.settle();
    assert.equal((await h.only()).state, "addressing");
    assert.equal(h.spawned.length, 2);
    assert.equal(h.spawned[1]!.environment.environmentId, worker.environmentId);
    assert.match(h.spawned[1]!.prompt, /previous worker stopped after the feedback worker is unavailable/);
    assert.match(h.spawned[1]!.prompt, /Keep footer spacing consistent/);
  });
}

for (const mismatch of ["host", "path", "branch", "missing"] as const) {
  test(`recovery refuses a conclusively ${mismatch === "missing" ? "missing environment" : `changed ${mismatch}`}`, async () => {
    let corrupt = false;
    const h = harness({ configureDeps(deps) {
      const get = deps.bb.sdk.environments.get;
      const status = deps.bb.sdk.environments.status;
      deps.bb.sdk.environments.get = async (args) => {
        if (corrupt && mismatch === "missing") throw Object.assign(new Error("environment not found"), { status: 404 });
        return { ...await get(args), ...(corrupt && mismatch === "host" ? { hostId: "host_other" } : {}), ...(corrupt && mismatch === "path" ? { path: "/other/workspace" } : {}) };
      };
      deps.bb.sdk.environments.status = async (args) => {
        const result = await status(args);
        return corrupt && mismatch === "branch" && result.outcome === "available" ? { ...result, workspace: { ...result.workspace, checkout: { kind: "branch", branchName: "unrelated", headSha: SHA2 } } } : result;
      };
    } });
    const { job, pr } = await h.toReview();
    h.review(pr, { body: "Fix the footer." });
    h.threads.get(job.threadId!)!.status = "error";
    corrupt = true; h.clock.now += 3 * MIN;
    await h.settle();
    assert.equal((await h.only()).state, "stuck");
    assert.equal(h.spawned.length, 1);
  });
}

for (const archived of [false, true]) {
  test(`ending leaves an unrelated ${archived ? "archived" : "active"} thread in the same workspace untouched`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const job = await h.only();
    const original = h.threads.get(job.threadId!)!;
    h.threads.set("user_thread", { ...original, id: "user_thread", metadata: {}, originPluginId: "user", archivedAt: archived ? h.clock.now : null, activeBackgroundCommandCount: 1 });
    await h.engine().issues.stop(job.id, "maya");
    await h.settle();
    assert.equal((await h.only()).state, "stopped");
    assert.equal(h.threads.get("user_thread")!.status, "active");
    assert.ok(!h.stopped.includes("user_thread"));
    assert.ok(h.stopped.includes(original.id));
  });

  test(`recovery inspects unrelated ${archived ? "archived background" : "active"} writers but cannot stop them`, async () => {
    const h = harness();
    const { job, pr } = await h.toReview();
    const original = h.threads.get(job.threadId!)!;
    h.threads.set("user_thread", { ...original, id: "user_thread", metadata: {}, originPluginId: "user", status: archived ? "idle" : "active", archivedAt: archived ? h.clock.now : null, activeBackgroundCommandCount: archived ? 1 : 0 });
    original.status = "error";
    h.review(pr, { body: "Fix the footer." }); h.clock.now += 3 * MIN;
    await h.settle();
    assert.equal((await h.only()).state, "stuck");
    assert.equal(h.spawned.length, 1);
    assert.ok(!h.stopped.includes("user_thread"));
  });
}

for (const remote of ["ssh://git@github.com/ACME/Web.git", "git@github.com:ACME/Web.git", "https://github.com/Acme/Web.git"]) {
  test(`authorized origin ${remote} passes report and publication validation`, async () => {
    const h = harness({ configureDeps(deps) { deps.inspectOrigin = async () => remote; } });
    const { job } = await h.toReview();
    assert.equal(job.outcome, "ready");
    assert.equal(h.pushes.length, 1);
  });
}

test("a foreign workspace origin cannot authorize publication", async () => {
  let origin = "https://github.com/acme/web.git";
  const h = harness({ configureDeps(deps) { deps.inspectOrigin = async () => origin; } });
  h.label(41); await h.settle();
  origin = "ssh://git@github.com/foreign/web.git";
  const response = await h.report((await h.only()).threadId!, GOOD);
  assert.equal(response.exitCode, 1);
  assert.equal(h.pushes.length, 0);
});

test("recovery stops an archived job-owned worker before inspecting exclusive reuse", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const original = h.threads.get(job.threadId!)!;
  h.threads.set("retired_worker", { ...original, id: "retired_worker", archivedAt: h.clock.now });
  original.status = "error";
  h.review(pr, { body: "Fix the footer." }); h.clock.now += 3 * MIN;
  await h.settle();
  assert.ok(h.stopped.includes("retired_worker"));
  assert.equal(h.threads.get("retired_worker")!.status, "idle");
  assert.equal(h.spawned.length, 2);
});

test("an unreachable owned worker remains unconfirmed across restart and elapsed time", async () => {
  let unreachable = false;
  const h = harness({ configureDeps(deps) {
    const stop = deps.bb.sdk.threads.stop;
    deps.bb.sdk.threads.stop = async (args) => {
      if (unreachable) throw new Error("worker host offline");
      return stop(args);
    };
  } });
  const { job, pr } = await h.toReview();
  h.threads.get(job.threadId!)!.status = "error";
  h.review(pr, { body: "Fix the footer." });
  unreachable = true; h.clock.now += 3 * MIN;
  await h.settle();
  h.restart(); h.clock.now += 24 * 60 * MIN;
  await h.settle();
  assert.equal((await h.only()).state, "recovering");
  assert.equal(h.spawned.length, 1);
  unreachable = false; h.clock.now += 20 * MIN;
  await h.settle();
  assert.equal(h.spawned.length, 2);
});
