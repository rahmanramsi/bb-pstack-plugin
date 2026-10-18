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
