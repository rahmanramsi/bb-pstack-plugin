import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCoalescedRefresh, hasRevision, signalMatchesThread } from "./live.ts";

test("realtime signals invalidate only the matching thread and include a revision", () => {
  assert.equal(signalMatchesThread({ threadId: "t1", revision: 3 }, "t1"), true);
  assert.equal(signalMatchesThread({ threadId: "t2", revision: 3 }, "t1"), false);
  assert.equal(signalMatchesThread({ threadId: "t1" }, "t1"), false);
  assert.equal(signalMatchesThread({ threadId: "t1", revision: .5 }, "t1"), false);
  assert.equal(signalMatchesThread(null, "t1"), false);
});

test("any issue signal with a revision invalidates issue views, whichever repository or thread changed", () => {
  assert.equal(hasRevision({ revision: 1760000000000 }), true);
  assert.equal(hasRevision({ revision: 3, threadId: "t2" }), true);
  assert.equal(hasRevision({}), false);
  assert.equal(hasRevision({ revision: "3" }), false);
  assert.equal(hasRevision({ revision: .5 }), false);
  assert.equal(hasRevision(null), false);
});

test("refresh bursts coalesce and changes during a request cause one follow-up", async () => {
  let calls = 0;
  let finish: () => void = () => {};
  const queue = createCoalescedRefresh(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
  });
  queue.refresh(); queue.refresh(); queue.refresh();
  await delay(70);
  assert.equal(calls, 1);
  queue.refresh(); queue.refresh(); queue.refresh();
  await delay(70);
  assert.equal(calls, 1);
  finish();
  await delay(70);
  assert.equal(calls, 2);
  queue.dispose();
});

test("disposing prevents scheduled loads and follow-ups after an in-flight load", async () => {
  let calls = 0;
  const scheduled = createCoalescedRefresh(async () => { calls++; });
  scheduled.refresh(); scheduled.dispose();
  await delay(70);
  assert.equal(calls, 0);
  let finish: () => void = () => {};
  const running = createCoalescedRefresh(async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); });
  running.refresh();
  await delay(70);
  running.refresh(); running.dispose(); finish();
  await delay(70);
  assert.equal(calls, 1);
});
