import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN, harness } from "./engine-harness.ts";

const ids = (stdout: string) => [...stdout.matchAll(/psi_[0-9a-f-]{36}/g)].map(([id]) => id);

test("a stuck job stays on the list with its reason, retries into a new job once the cause is fixed, and then leaves the list", async () => {
  const h = harness();
  const stuck = h.queue(41);
  h.setWorkerRole("codex/gpt-missing/high");
  await h.engine().issues.sweep();
  assert.equal((await h.only()).state, "stuck");
  const listed = (await h.engine().run(["issues", "list"])).stdout!;
  assert.match(listed, new RegExp(`#41 {2}stuck .*${stuck.id} .*codex/gpt-missing/high: not in the host's catalog`));

  const blocked = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr!, /issue worker cannot take new jobs on host_worker/);

  h.setWorkerRole("codex/gpt-6.1-sol/high");
  h.clock.now += MIN;
  const retried = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(retried.exitCode, 0, retried.stderr);
  const [, fresh] = ids(retried.stdout!);
  assert.equal(retried.stdout, `Retrying ${stuck.id} as ${fresh}.\n`);
  await h.settle();
  const job = (await h.views()).find((view) => view.id === fresh)!;
  assert.deepEqual([job.issue, job.state, job.triggeredBy], [41, "working", "the bb CLI"]);
  assert.deepEqual(ids((await h.engine().run(["issues", "list"])).stdout!), [fresh], "the replaced stuck job is hidden");
  assert.deepEqual(ids((await h.engine().run(["issues", "list", "--all"])).stdout!), [fresh, stuck.id]);

  const again = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr!, new RegExp(`already has the open job ${fresh}`));
  const open = await h.engine().run(["issues", "retry", fresh!]);
  assert.equal(open.exitCode, 1);
  assert.match(open.stderr!, /is working; only a stuck or stopped job can be retried/);
  const fromWorker = await h.engine().run(["issues", "retry", stuck.id], job.threadId!);
  assert.equal(fromWorker.exitCode, 1);
  assert.match(fromWorker.stderr!, /an issue worker cannot retry issue jobs/);
  assert.equal((await h.views()).length, 2);
});

test("a stopped job can be retried, and a done or ignored one cannot", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  assert.equal((await h.engine().run(["issues", "stop", working.id])).exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "stopped");
  const retried = await h.engine().issues.retry(working.id, "the bb app");
  assert.ok(retried.ok);
  await h.settle();
  assert.equal(h.store.get(retried.id)!.phase.state, "working");

  h.label(42, "drive-by");
  await h.engine().issues.sweep();
  const ignored = await h.byIssue(42);
  assert.equal(ignored.state, "ignored");
  assert.deepEqual(await h.engine().issues.retry(ignored.id, "the bb app"), { ok: false, code: "job_not_retryable", message: `${ignored.id} is ignored; only a stuck or stopped job can be retried` });

  h.store.write(retried.id, h.store.get(retried.id)!.version, { phase: { state: "done" } }, h.clock.now);
  const done = await h.engine().run(["issues", "retry", retried.id]);
  assert.equal(done.exitCode, 1);
  assert.match(done.stderr!, /is done; only a stuck or stopped job can be retried/);
});

test("a drive-by relabel of a stuck job's issue leaves the stuck job on the list", async () => {
  const h = harness();
  const stuck = h.queue(41);
  h.setWorkerRole("codex/gpt-missing/high");
  await h.engine().issues.sweep();
  h.setWorkerRole("codex/gpt-6.1-sol/high");
  h.label(41, "drive-by");
  await h.engine().issues.sweep();
  const all = await h.views();
  assert.deepEqual(all.map((view) => view.state).sort(), ["ignored", "stuck"]);
  assert.deepEqual(ids((await h.engine().run(["issues", "list"])).stdout!), [stuck.id]);
});

test("a sub-issue job cannot be retried on its own", async () => {
  const h = harness();
  const gh = h.gh();
  for (const number of [51, 52]) gh.issues.set(number, { number, title: `Part ${number}`, body: `Do part ${number}.`, user: "maya", updatedAt: h.clock.now, labels: new Set() });
  gh.issues.set(50, { number: 50, title: "Checkout redesign", body: "The whole checkout flow.", user: "maya", updatedAt: h.clock.now, labels: new Set(), subIssues: [51, 52] });
  h.label(50);
  await h.settle();
  const parent = await h.byIssue(50);
  for (const [issue, state] of [[51, "stuck"], [52, "stopped"]] as const) {
    const child = h.store.get((await h.byIssue(issue)).id)!;
    assert.equal(child.parentId, parent.id);
    h.store.write(child.id, child.version, { phase: { state } }, h.clock.now);
    const count = (await h.views()).length;
    assert.deepEqual(await h.engine().issues.retry(child.id, "the bb app"), {
      ok: false, code: "child_job_not_retryable", message: `${child.id} is a sub-issue job of ${parent.id}; stop and retry the parent job instead`,
    });
    assert.equal((await h.views()).length, count);
  }
});

test("a retry that loses the race to a polled job refuses, while a start returns the polled job", async () => {
  const h = harness();
  const stuck = h.queue(41);
  h.setWorkerRole("codex/gpt-missing/high");
  await h.engine().issues.sweep();
  h.setWorkerRole("codex/gpt-6.1-sol/high");

  const retrying = h.engine().issues.retry(stuck.id, "the bb app");
  const polled = h.queue(41);
  assert.deepEqual(await retrying, { ok: false, code: "issue_has_open_job", message: `acme/web#41 already has the open job ${polled.id}` });

  const starting = h.engine().issues.start("acme/web" as typeof stuck.repo, 42);
  const winner = h.queue(42);
  assert.equal(await starting, winner.id);
  assert.equal((await h.views()).length, 3);
});
