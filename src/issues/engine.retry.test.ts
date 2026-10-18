import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN, REPO, harness } from "./engine-harness.ts";

/** Label #41 with a spawn that never creates its worker, so the job sticks after the grace period. */
async function stuckJob() {
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
  return { h, stuck };
}

test("retrying a stuck job starts a new worker on a new branch, replaces it in the list, and works once", async () => {
  const { h, stuck } = await stuckJob();
  assert.match((await h.engine().run(["issues", "list"])).stdout!, new RegExp(`retry: bb pstack issues retry ${stuck.id}`));
  h.clock.now += MIN;

  const retried = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(retried.exitCode, 0, retried.stderr);
  const [fresh] = (await h.views()).filter((job) => job.id !== stuck.id);
  assert.equal(retried.stdout, `Retrying acme/web#41 as ${fresh!.id} on agent/issue-41-submit-button-hides-behind-the-footer-2.\n`);
  await h.settle();
  const working = (await h.views()).find((job) => job.id === fresh!.id)!;
  assert.equal(working.state, "working");
  assert.equal(working.retryOf, stuck.id);
  assert.equal(working.triggeredBy, "maya");
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1]!.environment.workspace.baseBranch.name, "origin/main");

  const listed = (await h.engine().run(["issues", "list"])).stdout!;
  assert.doesNotMatch(listed, new RegExp(stuck.id), "the replaced stuck job leaves the default list");
  const all = (await h.engine().run(["issues", "list", "--all"])).stdout!;
  assert.match(all, new RegExp(`${stuck.id}.*the spawn may not have happened`));
  assert.doesNotMatch(all, /retry: /, "a replaced stuck job gets no retry hint");

  const again = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr!, new RegExp(`job ${fresh!.id} is already open on acme/web#41`));
  await h.engine().run(["issues", "stop", fresh!.id]);
  await h.settle();
  const replaced = await h.engine().run(["issues", "retry", stuck.id]);
  assert.equal(replaced.exitCode, 1);
  assert.match(replaced.stderr!, new RegExp(`job ${fresh!.id} is newer on acme/web#41`));
  assert.equal((await h.views()).length, 2);
});

test("retry refuses an open job, a worker thread, a role the host cannot run, and an issue that closed or lost its label, creating nothing", async () => {
  const { h, stuck } = await stuckJob();
  const refused = async (id: string, pattern: RegExp, threadId?: string) => {
    const before = (await h.views()).length;
    const result = await h.engine().run(["issues", "retry", id], threadId);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr!, pattern);
    assert.equal((await h.views()).length, before);
  };

  h.label(42);
  await h.engine().issues.sweep();
  const other = await h.byIssue(42);
  await refused(other.id, /is working; only a stuck or stopped job can be retried/);
  await refused(stuck.id, /an issue worker cannot retry issue jobs/, other.threadId!);

  h.setWorkerRole("codex/gpt-missing/high");
  await refused(stuck.id, /no issue job can start on host host_worker: codex\/gpt-missing\/high: not in the host's catalog/);
  h.setWorkerRole("codex/gpt-6.1-sol/high");

  h.setRepo({ repo: REPO, projectId: "prj_web", hostId: "host_server" });
  await refused(stuck.id, /host host_server is the bb server's machine/);
  h.setRepo({ repo: "acme/api" as typeof REPO, projectId: "prj_web", hostId: "host_worker" });
  await refused(stuck.id, /acme\/web is not in issueRepos/);
  h.setRepo({ repo: REPO, projectId: "prj_web", hostId: "host_worker" });

  h.gh().outages.push({ key: "GET /repos/acme/web/issues/41", status: 502 });
  await refused(stuck.id, /could not read acme\/web#41 on GitHub, try again shortly/);

  h.unlabel(41);
  await refused(stuck.id, /acme\/web#41 no longer has the agent label/);
  h.gh().issues.get(41)!.closed = true;
  await refused(stuck.id, /acme\/web#41 is closed/);
});

function withParent(subIssues = [51, 52]) {
  const h = harness();
  const gh = h.gh();
  for (const number of [51, 52]) gh.issues.set(number, { number, title: `Part ${number}`, body: `Do part ${number}.`, user: "maya", updatedAt: h.clock.now, labels: new Set() });
  gh.issues.set(50, { number: 50, title: "Checkout redesign", body: "The whole checkout flow.", user: "maya", updatedAt: h.clock.now, labels: new Set(), subIssues });
  h.label(50);
  return h;
}

/** A parent tracking #51 and #52, with #51's stuck job retried. Only #51 exists when the spawn fails. */
async function retriedChild() {
  const h = withParent([51]);
  h.failures.spawn.push({ create: "never" });
  await h.settle();
  h.gh().issues.get(50)!.subIssues = [51, 52];
  for (let minute = 0; minute < 7; minute++) {
    h.clock.now += MIN;
    await h.settle();
  }
  const parent = await h.byIssue(50);
  const child = await h.byIssue(51);
  assert.equal(child.state, "stuck");
  assert.equal((await h.byIssue(50)).state, "tracking", "#52 still progresses");

  const retried = await h.engine().run(["issues", "retry", child.id]);
  assert.equal(retried.exitCode, 0, retried.stderr);
  await h.settle();
  const fresh = (await h.views()).find((job) => job.retryOf === child.id)!;
  assert.equal(fresh.state, "working");
  assert.equal(fresh.parentId, parent.id);
  assert.match(h.spawned.at(-1)!.prompt, /sub-issue of #50/);
  return { h, parent, fresh };
}

test("stopping the parent stops its retried child", async () => {
  const { h, parent, fresh } = await retriedChild();
  await h.engine().run(["issues", "stop", parent.id]);
  await h.settle();
  assert.equal((await h.views()).find((job) => job.id === fresh.id)!.state, "stopped");
});

test("the parent tracks a retried child's outcome, not the job it retried", async () => {
  const { h, fresh } = await retriedChild();
  await h.engine().run(["issues", "stop", fresh.id]);
  h.gh().issues.get(52)!.closed = true;
  h.clock.now += 2 * MIN;
  await h.settle();
  assert.equal((await h.byIssue(50)).state, "stuck");
  const status = (h.gh().comments.get(50) ?? []).find((comment) => comment.body.includes("Sub-issues:"))!;
  assert.match(status.body, /#51 Part 51 \(stopped\)/);
});

test("a sub-issue's job is retryable only while its parent tracks; retrying the stuck parent starts its open sub-issues again", async () => {
  const h = withParent();
  await h.settle();
  const parent = await h.byIssue(50);
  const child = await h.byIssue(51);
  await h.engine().run(["issues", "stop", child.id]);
  h.gh().issues.get(52)!.closed = true;
  h.clock.now += 2 * MIN;
  await h.settle();
  assert.equal((await h.byIssue(50)).state, "stuck");

  const refused = await h.engine().run(["issues", "retry", child.id]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr!, new RegExp(`the parent job ${parent.id} ended; retry the parent`));

  const retried = await h.engine().run(["issues", "retry", parent.id]);
  assert.equal(retried.exitCode, 0, retried.stderr);
  await h.settle();
  const views = await h.views();
  const newParent = views.find((job) => job.retryOf === parent.id)!;
  assert.equal(newParent.state, "tracking");
  const newChild = views.find((job) => job.issue === 51 && job.parentId === newParent.id)!;
  assert.equal(newChild.state, "working");
});
