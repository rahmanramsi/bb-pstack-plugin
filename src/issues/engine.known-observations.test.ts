import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, MIN } from "./engine-harness.ts";

test("known pending feedback clears readiness before the next scheduled PR observation", async () => {
  const h = harness();
  const { pr } = await h.toReview();
  h.review(pr, { body: "Correct the footer spacing." });
  await h.settle();
  assert.equal((await h.only()).outcome, null);
  assert.equal((await h.only()).state, "checking");
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, true);
  assert.equal(h.sent.length, 0);
});

for (const activity of ["active", "pending", "background-agent"] as const) {
  test(`runtime ${activity} protects an apparently idle worker from recovery`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const original = await h.only();
    const worker = h.threads.get(original.threadId!)!;
    Object.assign(worker, { status: "idle", updatedAt: h.clock.now, ...(activity === "background-agent" ? { activeBackgroundAgentCount: 1 } : { runtime: { displayStatus: activity } }) });
    await h.advance(4 * MIN);
    assert.equal(h.sent.length, 0);
    assert.equal(h.spawned.length, 1);
    assert.equal((await h.only()).threadId, original.threadId);
    assert.equal((await h.only()).outcome, null);
  });
}

for (const count of ["activeBackgroundCommandCount", "activeGoalCount", "activeWorkflowCount"] as const) {
  test(`${count} protects an idle worker whose turn ended from a nudge and recovery`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const original = await h.only();
    Object.assign(h.threads.get(original.threadId!)!, { status: "idle", updatedAt: h.clock.now, [count]: 1 });
    h.engine().issues.register();
    await h.events.get("thread.idle")!({ thread: { id: original.threadId, originPluginId: "pstack" } });
    await h.advance(4 * MIN);
    assert.equal(h.sent.length, 0);
    assert.equal(h.stopped.length, 0);
    assert.equal(h.spawned.length, 1);
    assert.equal((await h.only()).threadId, original.threadId);
    assert.equal((await h.only()).outcome, null);
  });
}

test("a failed worker is not recovered before provider-retry schedules its retry", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const original = await h.only();
  Object.assign(h.threads.get(original.threadId!)!, { status: "error", updatedAt: h.clock.now });
  h.engine().issues.register();
  await h.events.get("thread.failed")!({ thread: { id: original.threadId, originPluginId: "pstack" } });
  await h.settle();
  h.clock.now += 2_000;
  h.failures.scheduledRetryAt = h.clock.now + 30 * MIN;
  await h.advance(4 * MIN);
  assert.equal(h.stopped.length, 0);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.store.get(original.id)!.control.recoveries, 0);
  assert.equal((await h.only()).threadId, original.threadId);
});

test("a failed worker with no scheduled retry is recovered once the grace window passes", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const original = await h.only();
  Object.assign(h.threads.get(original.threadId!)!, { status: "error", updatedAt: h.clock.now });
  h.engine().issues.register();
  await h.events.get("thread.failed")!({ thread: { id: original.threadId, originPluginId: "pstack" } });
  await h.advance(4 * MIN);
  assert.equal(h.store.get(original.id)!.control.recoveries, 1);
  assert.deepEqual(h.stopped, [original.threadId]);
});
