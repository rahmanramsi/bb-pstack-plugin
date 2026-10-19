import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN, REPO, SHA3, harness, type Machine } from "./engine-harness.ts";
import { FEEDBACK_QUIET_MS } from "./job.ts";
import { workerProblem, type Catalog } from "../doctor.ts";

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

test("an issue started from the app on a repository without a pinned machine gets a picked one", async () => {
  const h = automatic({ host_server: { limit: 16 }, host_mini: { limit: 2 }, host_studio: { limit: 4 } });
  h.label(41);
  h.unlabel(41);
  await h.engine().issues.start(REPO, 41);
  await h.settle();
  assert.equal((await h.only()).state, "working");
  assert.deepEqual(spawnedOn(h), ["host_studio"]);
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

test("an automatic job's replacement reuses its worker's workspace on the same machine instead of picking again", async () => {
  const h = automatic({ host_server: {}, host_mini: { limit: 4 }, host_studio: { limit: 2 } });
  const { job, pr } = await h.toReview();
  assert.deepEqual(spawnedOn(h), ["host_mini"]);
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  h.fleet.set("host_studio", { limit: 64 });
  h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  const addressing = await h.only();
  assert.equal(addressing.state, "addressing", addressing.error ?? "");
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: h.threads.get(job.threadId!)!.environmentId });
  assert.deepEqual(h.store.get(job.id)!.host, { pinned: false, id: "host_mini" });
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

test("doctor checks the issue worker once per pinned machine and tuple, and fails a machine without the provider", async () => {
  const web = { repo: REPO, projectId: "prj_web", hostId: "host_worker" };
  const repos = [web, { ...web, repo: "acme/api" as typeof REPO }, { ...web, repo: "acme/docs" as typeof REPO, hostId: null }];
  let catalog: Catalog = new Map([["codex", { state: "ok", models: [{ model: "gpt-6.1-sol", levels: ["high"] }] }]]);
  const h = harness({
    configureDeps: (deps) => {
      deps.repos = () => repos;
      deps.checkWorker = async (_hostId, tuple) => workerProblem(tuple, catalog);
    },
  });
  assert.deepEqual(await h.engine().issues.workerChecks(), [{ ok: true, subject: "issue worker on host_worker (acme/web, acme/api): codex/gpt-6.1-sol/high", detail: "available" }]);

  catalog = new Map();
  assert.deepEqual(await h.engine().issues.workerChecks(), [{ ok: false, subject: "issue worker on host_worker (acme/web, acme/api): codex/gpt-6.1-sol/high", detail: 'codex/gpt-6.1-sol/high: provider "codex" is not installed' }]);

  catalog = new Map([["codex", { state: "error", detail: "auth_required" }]]);
  const [unknown] = await h.engine().issues.workerChecks();
  assert.equal(unknown!.ok, false);
  assert.match(unknown!.detail, /^could not check: codex\/gpt-6.1-sol\/high: could not load codex models: auth_required/);
});
