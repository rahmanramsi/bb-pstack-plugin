import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, GOOD, MIN, REPO, SHA2 } from "./engine-harness.ts";

test("review observations have a durable minimum cadence and transient cooldown", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const working = await h.only();
  const endpoint = `GET /repos/acme/web/commits/${SHA2}/check-suites`;
  h.gh().outages.push({ key: endpoint, status: 500, times: 100 });
  await h.report(working.threadId!, GOOD);
  await h.settle();
  const remaining = () => h.gh().outages.find((item) => item.key === endpoint)!.times!;
  assert.equal(remaining(), 99);
  h.restart();
  h.overlap();
  h.clock.now += MIN - 1;
  await h.settle();
  assert.equal(remaining(), 99);
  h.clock.now += 1;
  await h.settle();
  assert.equal(remaining(), 98);
  const job = h.store.get(working.id)!;
  h.store.deferReview(job, h.clock.now + 10 * MIN);
  h.restart();
  for (let minute = 1; minute < 10; minute++) { h.clock.now += MIN; await h.settle(); }
  assert.equal(remaining(), 98);
  h.clock.now += MIN;
  await h.settle();
  assert.equal(remaining(), 97);
  h.gh().outages.length = 0;
  h.clock.now += MIN;
  await h.settle();
  assert.notEqual((await h.only()).outcome, "ready");
  assert.equal(h.gh().draftConversions.length, 1);
  h.clock.now += MIN;
  await h.settle();
  assert.equal((await h.only()).outcome, "ready");
});

test("accepted reports and new target context cannot reuse a prior ready observation", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const worker = await h.only();
  await h.report(worker.threadId!, GOOD);
  await h.settle();
  h.clock.now += MIN;
  await h.settle();
  assert.equal((await h.only()).outcome, "ready");
  const ready = h.store.get(worker.id)!;
  const head = "3".repeat(40);
  h.gh().refs.set(ready.branch, head);
  const cleared = h.store.write(ready.id, ready.version, { phase: { state: "checking" }, control: { ...ready.control, readiness: null, localEvidence: null } }, h.clock.now)!;
  h.restart();
  await h.settle();
  assert.equal(h.store.get(cleared.id)!.control.readiness, null);
  assert.equal(h.store.claimReview(cleared, h.clock.now), false);
  h.clock.now += MIN;
  await h.settle();
  assert.notEqual((await h.only()).outcome, "ready");
  assert.equal(h.store.get(cleared.id)!.control.readiness, null);
  assert.equal(h.store.open(REPO, 41)!.id, cleared.id);
});


test("a long reconcile consumes only one scheduled observation while draft guards remain fresh", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const working = await h.only();
  const snapshot = h.holdAt(`GET /repos/acme/web/commits/${SHA2}/check-suites`, "github");
  await h.report(working.threadId!, GOOD);
  await snapshot.hit;
  const delivered = h.holdAt("GET /repos/acme/web/issues/41/comments", "github");
  try {
    h.clock.now += 2 * MIN;
    snapshot.free();
    await delivered.hit;
    const job = await h.only();
    assert.equal(job.state, "checking");
    assert.notEqual(job.outcome, "ready");
    assert.deepEqual(h.gh().draftConversions, [false]);
    assert.equal(h.gh().issues.get(job.pr!.number)!.pr!.draft, false);
  } finally {
    snapshot.free();
    delivered.free();
  }
});
