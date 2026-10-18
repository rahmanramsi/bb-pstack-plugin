import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN, REPO, SHA3, harness, type Machine } from "./engine-harness.ts";
import { FEEDBACK_QUIET_MS } from "./job.ts";

/** A repository without host=, on these machines. host_server is the bb server's machine. */
function automatic(machines: Record<string, Machine>) {
  const h = harness();
  h.setRepo({ repo: REPO, projectId: "prj_web", hostId: null });
  h.fleet.clear();
  for (const [id, machine] of Object.entries(machines)) h.fleet.set(id, machine);
  return h;
}

const spawnedOn = (h: ReturnType<typeof harness>) => h.spawned.map((spawn) => spawn.environment.hostId);

test("a job without a pinned machine starts on the eligible one with the most free slots, not the bb server's, and pushes from there", async () => {
  const h = automatic({ host_server: { limit: 16 }, host_mini: { limit: 2 }, host_studio: { limit: 4 } });
  const { job } = await h.toReview();
  assert.deepEqual(spawnedOn(h), ["host_studio"]);
  assert.deepEqual(h.store.get(job.id)!.host, { pinned: false, id: "host_studio" });
  assert.equal(h.pushes.length, 1);
});

test("with no eligible machine the job stays queued with each machine's reason, and a later sweep starts it once one is", async () => {
  const h = automatic({
    host_server: {},
    host_mini: { checkout: false },
    host_studio: { catalog: ["codex/gpt-6.1-sol/low"] },
    host_vps: { connected: false },
    host_box: { limit: null },
  });
  h.label(41);
  await h.settle();
  const waiting = await h.only();
  assert.equal(waiting.state, "queued");
  assert.equal(
    waiting.error,
    "no machine is eligible: host_server: the bb server's machine; host_mini: no checkout of this project; host_studio: codex/gpt-6.1-sol/high unavailable; host_vps: disconnected; host_box: unknown concurrency limit",
  );
  assert.equal(h.spawned.length, 0);
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
  assert.deepEqual(waiting.host, { id: null, pinned: false });
  assert.match((await h.engine().run(["issues", "list"])).stdout!, new RegExp(`#41 {2}queued {2}host auto {2}${waiting.id} {2}0m ago {2}no machine is eligible: host_server`));
  assert.match((await h.engine().run(["issues", "show", waiting.id])).stdout!, /machine {7}picked when the job starts\n/);

  h.clock.now += 30 * MIN;
  await h.settle();
  assert.equal((await h.only()).state, "queued", "waiting never sticks the job");

  h.fleet.set("host_mini", {});
  h.clock.now += MIN;
  await h.engine().issues.sweep();
  const started = await h.only();
  assert.deepEqual([started.state, started.error], ["working", null]);
  assert.deepEqual(spawnedOn(h), ["host_mini"]);
  assert.deepEqual(started.host, { id: "host_mini", pinned: false });
  assert.match((await h.engine().run(["issues", "list"])).stdout!, /#41 {2}working {2}on host_mini \(auto\) {2}thr_/);
  assert.match((await h.engine().run(["issues", "show", started.id])).stdout!, /machine {7}host_mini \(picked automatically\)\n/);
});

test("a failure to read the machines leaves the job queued with the reason", async () => {
  const h = automatic({ host_worker: {} });
  h.failures.machines = "bb is restarting";
  h.label(41);
  await h.engine().issues.sweep();
  const waiting = await h.only();
  assert.deepEqual([waiting.state, waiting.error], ["queued", "could not read the machines: bb is restarting"]);
  h.failures.machines = null;
  await h.engine().issues.sweep();
  assert.equal((await h.only()).state, "working");
  assert.deepEqual(spawnedOn(h), ["host_worker"]);
});

test("sub-issues that start in the same sweep spread across machines instead of piling onto the emptiest", async () => {
  const h = automatic({ host_server: {}, host_mini: { limit: 1 }, host_studio: { limit: 1 } });
  const gh = h.gh();
  for (const number of [51, 52]) gh.issues.set(number, { number, title: `Part ${number}`, body: `Do part ${number}.`, user: "maya", updatedAt: h.clock.now, labels: new Set() });
  gh.issues.set(50, { number: 50, title: "Checkout redesign", body: "The whole checkout flow.", user: "maya", updatedAt: h.clock.now, labels: new Set(), subIssues: [51, 52] });
  h.label(50);
  await h.settle();
  assert.deepEqual([(await h.byIssue(51)).state, (await h.byIssue(52)).state], ["working", "working"]);
  assert.deepEqual(spawnedOn(h).sort(), ["host_mini", "host_studio"]);
});

test("a gone worker's replacement gets a newly picked machine, and its feedback waits while no machine is eligible", async () => {
  const h = automatic({ host_server: {}, host_mini: { limit: 4 }, host_studio: { limit: 2 } });
  const { job, pr } = await h.toReview();
  assert.deepEqual(spawnedOn(h), ["host_mini"]);
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  h.fleet.set("host_mini", { connected: false });
  h.fleet.set("host_studio", { limit: 2, checkout: false });
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  const waiting = await h.only();
  assert.equal(waiting.state, "review");
  assert.equal(waiting.error, "no machine is eligible: host_server: the bb server's machine; host_mini: disconnected; host_studio: no checkout of this project");
  assert.equal(h.spawned.length, 1);
  assert.match((await h.engine().run(["issues", "list"])).stdout!, new RegExp(`#41 {2}review {2}on host_mini \\(auto\\) {2}PR #${pr} .* {2}no machine is eligible: host_server`));

  h.fleet.set("host_studio", { limit: 2 });
  h.clock.now += MIN;
  await h.settle();
  const addressing = await h.only();
  assert.equal(addressing.state, "addressing", addressing.error ?? "");
  assert.deepEqual(spawnedOn(h), ["host_mini", "host_studio"]);
  assert.equal(h.spawned[1]!.environment.workspace.baseBranch.name, `origin/${job.branch}`);
  assert.deepEqual(h.store.get(job.id)!.host, { pinned: false, id: "host_studio" });

  const round = { outcome: "changes", round: 1, replies: [{ kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." }], verification: ["npm test: 14 passed"], summary: "Renamed x." };
  assert.equal((await h.report(addressing.threadId!, round, { headSha: SHA3 })).exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "review");
  assert.equal(h.pushes.length, 2, "the replacement's commit is pushed from its own machine");
});

test("a pinned repository's job runs on its machine even when another has more room", async () => {
  const h = harness();
  h.fleet.set("host_worker", { limit: 1 });
  h.fleet.set("host_big", { limit: 64 });
  h.label(41);
  await h.engine().issues.sweep();
  const job = await h.only();
  assert.equal(job.state, "working");
  assert.deepEqual(spawnedOn(h), ["host_worker"]);
  assert.deepEqual(job.host, { id: "host_worker", pinned: true });
  assert.match((await h.engine().run(["issues", "list"])).stdout!, /#41 {2}working {2}on host_worker {2}thr_/);
  assert.match((await h.engine().run(["issues", "show", job.id])).stdout!, /machine {7}host_worker \(pinned by issueRepos\)\n/);
});
