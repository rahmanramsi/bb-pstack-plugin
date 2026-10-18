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

test("unknown mergeability waits for fresh observations across restart before bounded diagnosis", async () => {
  const h = harness();
  h.gh().mergeable = null;
  h.label(41); await h.settle();
  const working = await h.only();
  await h.report(working.threadId!, GOOD); await h.settle();
  const first = await h.only();
  assert.equal(first.state, "checking");
  assert.equal(first.round, 1);
  assert.equal(h.sent.length, 0);
  assert.notEqual(first.outcome, "ready");
  await h.settle();
  assert.equal(h.store.get(first.id)!.control.mergeabilityGrace?.observations, 1);
  h.restart(); h.clock.now += 30_000;
  await h.settle();
  assert.equal((await h.only()).state, "checking");
  assert.equal(h.sent.length, 0);
  h.clock.now += 31_000;
  await h.settle();
  assert.equal((await h.only()).state, "addressing");
  assert.match(h.sent.at(-1)!.input[0].text, /mergeability is unknown/);
  assert.notEqual((await h.only()).outcome, "ready");
});

test("clean mergeability within its grace reaches review without a diagnostic worker turn", async () => {
  const h = harness();
  h.gh().mergeable = null;
  h.label(41); await h.settle();
  await h.report((await h.only()).threadId!, GOOD); await h.settle();
  assert.equal((await h.only()).state, "checking");
  h.gh().mergeable = true; h.clock.now += 30_000;
  await h.settle();
  assert.equal((await h.only()).outcome, "ready");
  assert.equal(h.sent.length, 0);
});

test("a replacement repair worker uses work-round labels beyond the feedback budget", async () => {
  const h = harness();
  const { job } = await h.toReview();
  const current = h.store.get(job.id)!;
  assert.ok(current.pushedSha);
  h.store.write(job.id, current.version, { startRound: { ordinal: 9, kind: "feedback", cause: "ci", baseSha: current.pushedSha, feedback: [] }, roundBase: current.pushedSha, phase: { state: "addressing" }, control: { ...current.control, feedbackRounds: 1, workerContext: { round: 9, text: "Repair the failing build and retain the accepted commits.", recoveryReason: null } } }, h.clock.now);
  h.threads.get(job.threadId!)!.status = "error";
  await h.settle();
  assert.equal(h.spawned.length, 2);
  const prompt = h.spawned[1]!.prompt;
  assert.match(prompt, /Work round 8 on pull request/);
  assert.doesNotMatch(prompt, /Feedback round 8 of 5/);
  assert.match(prompt, /"round": 8/);
  assert.match(prompt, /Repair the failing build/);
});

test("feedback after repair work uses its feedback count while retaining the report ordinal", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const current = h.store.get(job.id)!;
  assert.ok(current.pushedSha);
  h.store.write(job.id, current.version, { startRound: { ordinal: 9, kind: "feedback", cause: "ci", baseSha: current.pushedSha, feedback: [] }, control: { ...current.control, feedbackRounds: 1 } }, h.clock.now);
  h.review(pr, { body: "Correct the footer spacing." });
  h.clock.now += 3 * MIN;
  await h.settle();
  const prompt = h.sent.at(-1)!.input[0].text;
  assert.match(prompt, /^Feedback round 2 of 5 on pull request/);
  assert.match(prompt, /"round": 9/);
  assert.equal((await h.only()).round, 10);
});

test("unknown mergeability grace resets when the exact PR target changes", async () => {
  const h = harness();
  h.gh().mergeable = null;
  h.label(41); await h.settle();
  await h.report((await h.only()).threadId!, GOOD); await h.settle();
  h.clock.now += 45_000;
  h.gh().refs.set("main", "3".repeat(40));
  await h.settle();
  h.clock.now += 16_000;
  h.restart(); await h.settle();
  assert.equal((await h.only()).state, "checking");
  assert.equal(h.sent.length, 0);
  h.clock.now += 45_000;
  await h.settle();
  assert.equal((await h.only()).state, "addressing");
});

test("persistent unknown mergeability exhausts its bounded diagnostic repairs", async () => {
  const h = harness();
  h.gh().mergeable = null;
  h.label(41); await h.settle();
  await h.report((await h.only()).threadId!, GOOD); await h.settle();
  h.clock.now += MIN;
  await h.settle();
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = await h.only();
    assert.equal(job.state, "addressing");
    const result = await h.report(job.threadId!, { outcome: "no-change", round: job.round - 1, replies: [], summary: "The footer implementation is verified. GitHub still has no mergeability result.", verification: ["npm test passed"] });
    assert.equal(result.exitCode, 0, result.stderr);
    await h.settle();
  }
  assert.equal((await h.only()).state, "stuck");
  assert.match((await h.only()).error!, /repair exhausted.*mergeability is unknown/);
  assert.equal(h.sent.length, 5);
});

test("a durable reminder respects scheduled provider retry before resending", async () => {
  let fail = true;
  const h = harness({ configureDeps(deps) {
    const send = deps.bb.sdk.threads.send;
    deps.bb.sdk.threads.send = async (args) => { if (fail) throw new Error("send unavailable"); return send(args); };
  } });
  h.label(41); await h.settle();
  const job = await h.only();
  const worker = h.threads.get(job.threadId!)!;
  worker.status = "idle";
  await h.settle();
  fail = false; worker.status = "error";
  h.failures.scheduledRetryAt = h.clock.now + 5 * MIN;
  h.clock.now += MIN;
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.spawned.length, 1);
  h.restart(); h.clock.now += 3 * MIN;
  await h.settle();
  assert.equal(h.sent.length, 0);
  worker.status = "idle"; h.failures.scheduledRetryAt = null;
  h.clock.now += MIN;
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.spawned.length, 1);
});
