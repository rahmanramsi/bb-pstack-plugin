import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectHandler } from "./engine.ts";
import { GOOD, MIN, REPO, SHA1, SHA2, harness, type FakeThread, type Hold } from "./engine-harness.ts";
import { EFFECT_POLICY } from "./job.ts";

test("the board lists unlabeled and closed issues without starting them; manual start is idempotent", async () => {
  const h = harness();
  h.label(41);
  h.unlabel(41);
  h.label(42);
  h.unlabel(42);
  h.gh().issues.get(42)!.closed = true;
  h.label(43);
  const board = await h.engine().issues.board({ all: false });
  assert.deepEqual(board.issues?.map((issue) => [issue.issue, issue.state]), [[41, "open"], [42, "closed"], [43, "open"]]);
  assert.equal(board.jobs.length, 0);
  assert.equal(h.spawned.length, 0);
  await h.engine().issues.sweep();
  assert.deepEqual((await h.views()).map((job) => job.issue), [43], "only the labeled issue starts automatically");
  const ids = await Promise.all([h.engine().issues.start(REPO, 41), h.engine().issues.start(REPO, 41)]);
  assert.equal(ids[0], ids[1]);
  await h.settle();
  assert.equal((await h.byIssue(41)).state, "working");
  assert.equal(h.spawned.length, 2);
  assert.ok(!h.gh().issues.get(41)!.labels.has("agent"));
  await assert.rejects(h.engine().issues.start(REPO, 42), /Only an open/);
  await assert.rejects(h.engine().issues.start("other/repo", 41), /not configured/);
});

test("a manually started parent tracks its sub-issues without an agent label", async () => {
  const h = harness();
  h.label(41);
  h.unlabel(41);
  h.label(42);
  h.unlabel(42);
  h.gh().issues.get(41)!.subIssues = [42];
  await h.engine().issues.start(REPO, 41);
  await h.settle();
  assert.equal((await h.byIssue(41)).state, "tracking");
  assert.equal((await h.byIssue(42)).state, "working");
});

test("label to draft pull request: spawn a worker, accept its report, push the reported commit, open and label the PR", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();

  const started = await h.only();
  assert.equal(started.state, "working");
  assert.equal(started.branch, "agent/issue-41-submit-button-hides-behind-the-footer");
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent", "agent:working"]);
  assert.equal(h.spawned.length, 1);
  const { prompt, ...spawn } = h.spawned[0]!;
  assert.deepEqual(spawn, {
    projectId: "prj_web",
    visibility: "visible",
    environment: { type: "host", hostId: "host_worker", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "origin/main" } } },
    pluginMetadata: { pstackIssue: 1, jobId: started.id, epoch: 0 },
    title: "acme/web#41: Submit button hides behind the footer",
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "high",
    permissionMode: "full",
  });
  assert.match(prompt, /^\/poteto-mode /);
  assert.match(prompt, /untrusted GitHub user[\s\S]*```text\nSubmit button hides behind the footer\n\nOn 375px/);
  assert.match(h.engine().issues.instructions(started.threadId!)!, /built-in PR tool/);

  const accepted = await h.report(started.threadId!, GOOD);
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.match(accepted.stdout!, /pushes 2222222 to agent\/issue-41/);
  await h.settle();

  const done = await h.only();
  assert.equal(done.state, "review");
  assert.equal(done.pushedSha, SHA2);
  assert.deepEqual(h.pushes, [{ worktreePath: `/worktrees/env_${started.threadId}`, remoteUrl: "https://github.test/acme/web.git", branch: started.branch, sha: SHA2, expectedRemoteSha: null, comparisonSha: SHA1, workflows: false, token: h.pushes[0]!.token }]);
  assert.ok(h.gh().revoked.includes(h.pushes[0]!.token), "the push token is revoked after the push");
  const pr = h.gh().issues.get(done.pr!.number)!;
  assert.deepEqual(pr.pr, {
    head: started.branch,
    base: "main",
    title: GOOD.pr.title,
    body: `## Why\nThe footer covered the button on small screens.\n\n#41, cc \`@maya\`.\n\nCloses #41\n\n<!-- pstack:pr:${started.id} -->`,
    draft: false,
  });
  assert.deepEqual([...pr.labels], ["agent"]);
  assert.deepEqual([...h.gh().issues.get(41)!.labels].sort(), ["agent", "agent:review"]);
  assert.ok(h.engine().issues.instructions(started.threadId!), "a worker in review keeps its instructions for later rounds");
});

const NEEDS_INFO = { outcome: "needs-info", questions: ["Which footer, the page or the modal?"], verification: ["read the layout code"] };
const NO_CHANGE = { outcome: "no-change", summary: "The footer already clears the button on main.", verification: ["checked at 375px"] };
const UNCHANGED = { headSha: SHA1, ahead: 0 };
const ISSUE_LABELS = "POST /repos/acme/web/issues/41/labels";
const COMMENTS = "POST /repos/acme/web/issues/41/comments";

type CrashPoint = {
  name: string;
  key: string;
  where: "sdk" | "github";
  lease: number;
  /** What leads to the held call: the start alone, a report after it, or a stop after it. */
  after: { report: unknown; tree: Partial<{ headSha: string; ahead: number }> } | "start" | "stop";
  end: { state: string; labels: string[]; comments: number; pushes: number };
};

const CRASH_POINTS: CrashPoint[] = [
  { name: "the spawn", key: "spawn", where: "sdk", lease: EFFECT_POLICY.spawn.leaseMs, after: "start", end: { state: "review", labels: ["agent", "agent:review"], comments: 1, pushes: 1 } },
  { name: "the push", key: "push", where: "sdk", lease: EFFECT_POLICY.push.leaseMs, after: { report: GOOD, tree: { headSha: SHA2, ahead: 1 } }, end: { state: "review", labels: ["agent", "agent:review"], comments: 1, pushes: 1 } },
  { name: "the pull request", key: "POST /repos/acme/web/pulls", where: "github", lease: EFFECT_POLICY["open-pr"].leaseMs, after: { report: GOOD, tree: { headSha: SHA2, ahead: 1 } }, end: { state: "review", labels: ["agent", "agent:review"], comments: 1, pushes: 1 } },
  { name: "stopping the worker", key: "stop", where: "sdk", lease: EFFECT_POLICY["stop-thread"].leaseMs, after: "stop", end: { state: "stopped", labels: ["agent"], comments: 1, pushes: 0 } },
];

for (const point of CRASH_POINTS) {
  test(`a crash after claiming ${point.name} recovers on restart with one worker, and each write done once`, async () => {
    const h = harness();
    h.label(41);
    let held: Hold;
    let inflight: Promise<unknown>;
    if (point.after === "start") {
      held = h.holdAt(point.key, point.where);
      inflight = h.engine().issues.sweep();
    } else {
      await h.engine().issues.sweep();
      const working = await h.only();
      held = h.holdAt(point.key, point.where);
      inflight = point.after === "stop" ? Promise.resolve(h.engine().run(["issues", "stop", working.id])) : h.report(working.threadId!, point.after.report, point.after.tree);
    }
    await held.hit;
    h.restart();

    await h.engine().issues.sweep();
    const leased = await h.only();
    assert.ok(leased.next, "the claimed effect is still pending under its lease");

    h.clock.now += point.lease + 1;
    await h.settle();
    if (point.after === "start") {
      const working = await h.only();
      assert.equal(working.state, "working");
      await h.report(working.threadId!, GOOD);
      await h.settle();
    }

    const end = await h.only();
    assert.equal(end.state, point.end.state, end.error ?? "");
    assert.equal(h.spawned.length, 1, "one worker");
    assert.equal(h.pushes.length, point.end.pushes, "pushes");
    assert.equal([...h.gh().issues.values()].filter((issue) => issue.pr).length, point.end.pushes, "pull requests");
    assert.equal(h.gh().comments.get(41)?.length ?? 0, point.end.comments, "comments");
    assert.deepEqual([...h.gh().issues.get(41)!.labels].sort(), point.end.labels);
    if (point.after === "stop") assert.ok(h.stopped.includes(end.threadId!), "the worker was stopped");
    held.free();
    await inflight;
  });
}

test("a spawn that throws after creating its thread is adopted once the thread appears, never spawned again", async () => {
  const h = harness();
  h.failures.spawn.push({ create: "later" });
  h.label(41);
  await h.engine().issues.sweep();
  assert.equal((await h.only()).state, "starting");

  h.clock.now += 5_000;
  await h.engine().issues.sweep();
  assert.equal((await h.only()).state, "starting", "no thread yet: keep waiting, do not spawn");

  h.threads.set(h.late[0]!.id, h.late[0]!);
  h.clock.now += 15_000;
  await h.engine().issues.sweep();
  const adopted = await h.only();
  assert.equal(adopted.state, "working");
  assert.equal(adopted.threadId, h.late[0]!.id);
  assert.equal(h.spawned.length, 1);
});

test("a spawn that throws and never creates a thread sticks the job after the grace period and unlabels the issue", async () => {
  const h = harness();
  h.failures.spawn.push({ create: "never" });
  h.label(41);
  await h.engine().issues.sweep();
  for (let minute = 0; minute < 7; minute++) {
    h.clock.now += MIN;
    await h.engine().issues.sweep();
  }
  const stuck = await h.only();
  assert.equal(stuck.state, "stuck");
  assert.match(stuck.error!, /spawn may not have happened/);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
});

test("stopping a job after a crash mid-spawn stops the thread the spawn created minutes earlier", async () => {
  const h = harness();
  h.label(41);
  const spawning = h.holdAt("spawn", "sdk");
  const sweeping = h.engine().issues.sweep();
  await spawning.hit;
  const [created] = [...h.threads.keys()];
  h.restart();

  h.clock.now += 5 * MIN;
  const job = await h.only();
  assert.equal(job.state, "starting");
  assert.equal((await h.engine().run(["issues", "stop", job.id])).exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "stopped");
  assert.deepEqual(h.stopped, [created]);
  assert.equal(h.spawned.length, 1);

  spawning.free();
  await sweeping;
});

test("a rejected report lists every reason and leaves the job working; a fixed report is accepted", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  h.failures.gate = "3 open steps block the pr gate.";

  const rejected = await h.report(working.threadId!, { ...GOOD, pr: { ...GOOD.pr, body: "Ran the playbook." } }, { headSha: SHA2, ahead: 1, dirty: true });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr!, /Report rejected:[\s\S]*uncommitted[\s\S]*gate pr` fails: 3 open steps[\s\S]*describes the process \("playbook"\)/);
  const still = await h.only();
  assert.equal(still.state, "working");
  assert.equal(h.pushes.length, 0);

  h.failures.gate = null;
  const accepted = await h.report(working.threadId!, GOOD, { dirty: false });
  assert.equal(accepted.exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "review");
});

test("a corrected commit can reuse report text after a validation rejection", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  for (let attempt = 0; attempt < 1; attempt++) {
    const rejected = await h.report(working.threadId!, GOOD, { headSha: SHA1, ahead: 0 });
    assert.match(rejected.stderr!, /needs a new commit/);
  }
  await h.settle();
  assert.equal((await h.only()).state, "working");
  assert.deepEqual(h.stopped, []);

  const accepted = await h.report(working.threadId!, GOOD);
  assert.equal(accepted.exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "review");
});

test("re-labelling an issue after its job ended starts a new job on a -2 branch", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const first = await h.only();
  const stopped = await h.engine().run(["issues", "stop", first.id]);
  assert.equal(stopped.stdout, `Stopping ${first.id}.\n`);
  await h.settle();
  assert.equal((await h.views())[0]!.state, "stopped");

  h.clock.now += MIN;
  h.unlabel(41);
  await h.engine().issues.sweep();
  assert.equal((await h.views()).length, 1, "an unchanged label event does not start another job");
  h.clock.now += MIN;
  h.label(41);
  await h.engine().issues.sweep();
  const [second] = await h.views();
  assert.equal(second!.state, "working");
  assert.equal(second!.branch, "agent/issue-41-submit-button-hides-behind-the-footer-2");
  assert.equal(h.spawned.length, 2);
});

test("labels from users without write access, and repositories mapped to the server's host, start nothing", async () => {
  const h = harness();
  h.label(41, "drive-by");
  await h.engine().issues.sweep();
  const ignored = await h.only();
  assert.equal(ignored.state, "ignored");
  assert.equal(ignored.error, "@drive-by has read permission");
  assert.equal(h.spawned.length, 0);

  h.setRepo({ repo: REPO, projectId: "prj_web", hostId: "host_server" });
  h.label(42);
  await h.engine().issues.sweep();
  assert.equal((await h.views()).length, 1);

  const listed = await h.engine().run(["issues", "list"]);
  assert.match(listed.stdout!, /acme\/web {2}polled 0m ago\n {2}poll error: host host_server is the bb server's machine/);
  const json = JSON.parse((await h.engine().run(["issues", "list", "--json"])).stdout!);
  assert.deepEqual(json.repos, [{ repo: REPO, polledAt: h.clock.now, error: "host host_server is the bb server's machine; map acme/web to another host" }]);
  const shown = await h.engine().run(["issues", "show", ignored.id]);
  assert.match(shown.stdout!, /repo error {4}host host_server is the bb server's machine/);
});

test("an idle worker that has not reported is reminded twice, then the job waits with the reason shown", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  const thread = h.threads.get(working.threadId!)!;
  for (const expected of [1, 2]) {
    h.clock.now += MIN;
    Object.assign(thread, { status: "idle", updatedAt: h.clock.now });
    h.clock.now += 1;
    await h.engine().issues.sweep();
    assert.equal(h.sent.length, expected);
    await h.engine().issues.sweep();
    assert.equal(h.sent.length, expected, "one reminder per idle");
  }
  assert.match(h.sent[0]!.input[0].text, /bb pstack issues report --file/);
  h.clock.now += MIN;
  Object.assign(thread, { updatedAt: h.clock.now });
  h.clock.now += 1;
  await h.settle();
  const waiting = await h.only();
  assert.equal(waiting.state, "working");
  assert.equal(waiting.error, null);
  assert.notEqual(waiting.threadId, working.threadId);
  assert.equal(h.spawned[1]!.environment.type, "reuse");
  assert.equal(h.sent.length, 2, "no third reminder");
});

test("a worker cannot stop jobs, and a thread naming a job that is not waiting for it is stopped", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  const refused = await h.engine().run(["issues", "stop", working.id], working.threadId!);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr!, /an issue worker cannot stop issue jobs/);
  assert.equal((await h.only()).state, "working");

  h.engine().issues.register();
  assert.deepEqual(h.services, ["pstack-issues"]);
  const duplicate: FakeThread = { ...h.threads.get(working.threadId!)!, id: "thr_dup", metadata: { pstackIssue: 1, jobId: working.id } };
  h.threads.set(duplicate.id, duplicate);
  await h.events.get("thread.idle")!({ thread: { id: duplicate.id, originPluginId: "pstack" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.stopped, ["thr_dup"]);
});

test("an unsupported worker role fails concretely before spawning", async () => {
  for (const [role, reason] of [["codex/gpt-6.1-sol/extreme", /reasoning level "extreme"/], ["codex/gpt-missing/high", /codex\/gpt-missing\/high: not in the host's catalog/]] as const) {
    const h = harness();
    h.setWorkerRole(role);
    h.label(41);
    await h.engine().issues.sweep();
    const job = await h.only();
    assert.equal(job.state, "stuck");
    assert.match(job.error!, reason);
    assert.equal(h.spawned.length, 0);
    assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
  }
});

test("queued jobs that cannot resolve their worker yet do not hold back a job that can", async () => {
  const h = harness();
  h.setRepo({ repo: REPO, projectId: "prj_offline", hostId: "host_worker" });
  for (const issue of [41, 42, 43]) h.label(issue);
  await h.engine().issues.sweep();
  const waiting = await h.views();
  assert.deepEqual(waiting.map((job) => job.state), ["queued", "queued", "queued"]);
  for (const job of waiting) assert.match(job.error!, /project settings are unavailable/);

  h.setRepo({ repo: REPO, projectId: "prj_web", hostId: "host_worker" });
  h.clock.now += MIN;
  h.label(44);
  await h.engine().issues.sweep();
  const [newest] = await h.views();
  assert.equal(newest!.issue, 44);
  assert.equal(newest!.state, "working");
});

test("an effect's handler has a probe exactly when its policy looks for a trace before running it again", () => {
  const perform = async () => ({ kind: "absent" }) as const;
  // @ts-expect-error labels are replayed, so a probe would never run
  const labels: EffectHandler<"labels"> = { perform, probe: perform };
  // @ts-expect-error a push is probed before it runs again
  const push: EffectHandler<"push"> = { perform };
  assert.ok(labels && push);
});

test("stopping a job in review removes its status labels", async () => {
  const h = harness();
  const { job } = await h.toReview();
  assert.equal((await h.engine().run(["issues", "stop", job.id])).exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).state, "stopped");
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
});

test("an idle worker waiting on its own runs or child threads is not reminded; once it stops, the reminder names the failing gate", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  const thread = h.threads.get(working.threadId!)!;
  for (const busy of [{ activeRuns: 1, activeChildren: 0 }, { activeRuns: 0, activeChildren: 2 }, { activeRuns: 1, activeChildren: 0 }]) {
    Object.assign(h.work, busy);
    h.clock.now += MIN;
    Object.assign(thread, { status: "idle", updatedAt: h.clock.now });
    h.clock.now += 1;
    await h.settle();
  }
  assert.equal(h.sent.length, 0);
  assert.equal((await h.only()).state, "working");

  Object.assign(h.work, { activeRuns: 0, activeChildren: 0 });
  h.failures.gate = "2 open steps block the pr gate.\n4. [Verify] Run the tests";
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.input[0].text, /gate pr` to pass, and it fails: 2 open steps block the pr gate\.\n4\. \[Verify\] Run the tests/);
});

test("a push that outlives its lease while a second engine pushes the same commit still ends in review", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  const first = h.holdAt("push:before", "sdk");
  await h.report(working.threadId!, GOOD);
  await first.hit;

  h.overlap();
  h.clock.now += EFFECT_POLICY.push.leaseMs + 1;
  const second = h.holdAt("push:before", "sdk");
  const sweeping = h.engine().issues.sweep();
  await second.hit;
  first.free();
  while (h.gh().refs.get(working.branch) !== SHA2) await new Promise((resolve) => setImmediate(resolve));
  second.free();
  await sweeping;
  await h.settle();

  const done = await h.only();
  assert.equal(done.state, "review", done.error ?? "");
  assert.equal(done.pushedSha, SHA2);
  assert.equal(h.pushes.length, 2, "both engines pushed");
  assert.equal([...h.gh().issues.values()].filter((issue) => issue.pr).length, 1, "one pull request");
});

test("in the service, one job's slow push does not hold back another job", { timeout: 10_000 }, async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  h.clock.now += MIN;
  h.label(42);
  await h.engine().issues.sweep();
  const issue = async (number: number) => (await h.views()).find((job) => job.issue === number)!;
  const pushing = h.holdAt("push", "sdk");
  await h.report((await issue(41)).threadId!, GOOD);
  await pushing.hit;

  const oldWorker = (await issue(42)).threadId!;
  h.threads.get(oldWorker)!.status = "error";
  h.engine().issues.register();
  const service = new AbortController();
  const serving = h.serviceStarts.get("pstack-issues")!(service.signal);
  try {
    while ((await issue(42)).threadId === oldWorker) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    service.abort();
    pushing.free();
  }
  await serving;
});

test("a transient push-token fault preserves its accepted report for the next claim", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const working = await h.only();
  const held = h.holdAt("push:before", "sdk");
  await h.report(working.threadId!, GOOD);
  await held.hit;
  h.restart();
  h.clock.now += EFFECT_POLICY.push.leaseMs + 1;
  held.free();
  await h.settle();
  assert.equal((await h.only()).pushedSha, SHA2);
  assert.equal(h.store.get(working.id)!.report!.headSha, SHA2);
});

test("finding a worker's thread reads metadata a page at a time and stops at threads older than the job", async () => {
  const h = harness();
  for (let index = 0; index < 250; index++) {
    const id = `thr_old${index}`;
    h.threads.set(id, { id, status: "idle", archivedAt: null, deletedAt: null, createdAt: h.clock.now - 60 * MIN - index, updatedAt: 0, projectId: "prj_web", originPluginId: "pstack", environmentId: `env_${id}`, metadata: {}, pinnedAt: index === 0 ? 1 : null });
  }
  h.failures.spawn.push({ create: "later" });
  h.label(41);
  await h.engine().issues.sweep();
  h.threads.set(h.late[0]!.id, h.late[0]!);
  h.clock.now += 15_000;
  Object.assign(h.calls, { list: 0, getPluginMetadata: 0, listPluginMetadata: 0 });
  await h.engine().issues.sweep();

  const adopted = await h.only();
  assert.equal(adopted.state, "working");
  assert.equal(adopted.threadId, h.late[0]!.id);
  assert.equal(h.calls.list, 1);
  assert.equal(h.calls.listPluginMetadata, 1);
  assert.equal(h.calls.getPluginMetadata, 1);
});

test("a report saved before spawn confirmation is accepted automatically once the worker is bound", async () => {
  const h = harness();
  h.failures.spawn.push({ create: "now" });
  h.label(41);
  await h.engine().issues.sweep();
  const starting = await h.only();
  assert.equal(starting.state, "starting");
  const [threadId] = [...h.threads.keys()];

  const early = await h.report(threadId!, GOOD);
  assert.equal(early.exitCode, 0);
  assert.match(early.stdout!, /saved/i);

  h.clock.now += 15_000;
  await h.engine().issues.sweep();
  assert.equal((await h.only()).threadId, threadId);
  await h.settle();
  assert.equal((await h.only()).state, "review");
});

test("a first-round changes report without a pull request title and body is a schema error, which does not count as a rejection", async () => {
  const h = harness();
  h.label(41);
  await h.engine().issues.sweep();
  const working = await h.only();
  const { pr: _, ...titleless } = GOOD;
  const refused = await h.report(working.threadId!, titleless);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr!, /does not match the contract[\s\S]*pr/);
  const still = await h.only();
  assert.equal(still.state, "working");
  assert.match(still.error!, /report rejected/);
  assert.equal((await h.report(working.threadId!, GOOD)).exitCode, 0);
});
