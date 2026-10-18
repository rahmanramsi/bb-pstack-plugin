import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOD, MIN, harness } from "./engine-harness.ts";

function withParent(subIssues = [51, 52]) {
  const h = harness();
  const gh = h.gh();
  for (const number of subIssues) gh.issues.set(number, { number, title: `Part ${number}`, body: `Do part ${number}.`, user: "maya", updatedAt: h.clock.now, labels: new Set() });
  gh.issues.set(50, { number: 50, title: "Checkout redesign", body: "The whole checkout flow.", user: "maya", updatedAt: h.clock.now, labels: new Set(), subIssues });
  h.label(50);
  return h;
}

const statusComments = (h: ReturnType<typeof harness>) => (h.gh().comments.get(50) ?? []).filter((comment) => comment.body.includes("Sub-issues:"));

test("integration reports must contain the exact ready child commits", async () => {
  const h = withParent();
  await h.settle();
  for (const issue of [51, 52]) await h.report((await h.byIssue(issue)).threadId!, GOOD);
  await h.settle();
  await h.advance(MIN);
  const parent = await h.byIssue(50);
  const response = await h.report(parent.threadId!, GOOD, { headSha: "3".repeat(40), commits: ["3".repeat(40)], ahead: 1 });
  assert.equal(response.exitCode, 1);
  assert.match(response.stderr!, /include prerequisite #51/);
  assert.notEqual((await h.byIssue(50)).outcome, "ready");
  const falseList = await h.report(parent.threadId!, GOOD, { headSha: "4".repeat(40), commits: ["4".repeat(40), "2".repeat(40)], ancestors: ["4".repeat(40)], ahead: 1 });
  assert.equal(falseList.exitCode, 1, "SDK membership cannot override negative Git object proof");
  assert.match(falseList.stderr!, /include prerequisite #51/);
});

test("host ancestry proves merged default-base prerequisites beyond the SDK commit list", async () => {
  const h = withParent();
  h.gh().issues.get(52)!.blockedBy = [51];
  await h.settle();
  const child = await h.byIssue(51);
  await h.report(child.threadId!, GOOD); await h.settle();
  Object.assign(h.gh().pulls.get((await h.byIssue(51)).pr!.number)!, { state: "closed", merged: true });
  h.gh().refs.set("main", "2".repeat(40));
  h.clock.now += 2 * 60_000;
  await h.settle();
  const dependent = await h.byIssue(52);
  const response = await h.report(dependent.threadId!, GOOD, { headSha: "3".repeat(40), commits: ["3".repeat(40)], ancestors: ["1".repeat(40), "2".repeat(40)], ahead: 1 });
  assert.equal(response.exitCode, 0, response.stderr);
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.byIssue(52)).outcome, "ready");
  const parent = await h.byIssue(50);
  assert.equal(h.store.get(parent.id)!.control.prerequisites.length, 2);
});

test("a newly ready child head cannot restore its parent's old integration evidence", async () => {
  const h = withParent([51]);
  await h.settle();
  let child = await h.byIssue(51);
  await h.report(child.threadId!, GOOD); await h.settle();
  await h.advance(MIN);
  const parent = await h.byIssue(50);
  await h.report(parent.threadId!, GOOD, { headSha: "3".repeat(40), commits: ["3".repeat(40), "2".repeat(40)], ahead: 2 });
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.byIssue(50)).outcome, "ready");
  h.gh().refs.set(child.branch, "4".repeat(40));
  await h.advance(MIN);
  await h.advance(MIN);
  child = await h.byIssue(51);
  assert.equal(child.state, "addressing");
  await h.report(child.threadId!, { outcome: "changes", round: child.round - 1, replies: [], verification: ["integration tests passed"], summary: "Updated child." }, { headSha: "5".repeat(40), commits: ["5".repeat(40), "4".repeat(40), "2".repeat(40)], ahead: 3 });
  await h.settle();
  await h.advance(MIN);
  await h.advance(MIN);
  assert.equal((await h.byIssue(51)).outcome, "ready");
  assert.notEqual((await h.byIssue(50)).outcome, "ready");
  await h.advance(MIN);
  const current = h.store.get(parent.id)!;
  assert.equal(current.control.localEvidence, null);
  assert.equal(current.control.prerequisites[0]!.sha, "5".repeat(40));
  assert.equal(current.phase.state, "addressing");
  assert.match(h.sent.filter((message) => message.threadId === parent.threadId).at(-1)!.input[0].text, /Repair/);
});

test("a labeled parent tracks its sub-issues and runs one worker per open sub-issue with the parent as context", async () => {
  const h = withParent();
  await h.settle();
  const parent = await h.byIssue(50);
  assert.equal(parent.state, "tracking");
  const [a, b] = [await h.byIssue(51), await h.byIssue(52)];
  assert.equal(a.state, "working");
  assert.equal(b.state, "working");
  assert.equal(a.parentId, parent.id);
  assert.equal(h.spawned.length, 2);
  assert.match(h.spawned[0]!.prompt, /sub-issue of #50/);
  assert.match(h.spawned[0]!.prompt, /Checkout redesign/);
  assert.equal(statusComments(h).length, 1);
});

test("a blocked sub-issue waits without holding back other jobs and starts once its blocker closes", async () => {
  const h = withParent();
  h.gh().issues.get(52)!.blockedBy = [51];
  await h.settle();
  const blocked = await h.byIssue(52);
  assert.equal(blocked.state, "queued");
  assert.equal(blocked.error, "waiting for #51");
  h.label(41);
  await h.settle();
  assert.equal((await h.byIssue(41)).state, "working", "an unrelated job behind the blocked child starts");
  h.gh().issues.get(51)!.closed = true;
  h.clock.now += 2 * 60_000;
  await h.settle();
  assert.equal((await h.byIssue(52)).state, "working");
});

test("the parent starts its own integration verification once every sub-issue is closed", async () => {
  const h = withParent();
  await h.settle();
  const a = await h.byIssue(51);
  await h.report(a.threadId!, GOOD);
  h.clock.now += 2 * 60_000;
  await h.settle();
  for (const number of [51, 52]) h.gh().issues.get(number)!.closed = true;
  h.clock.now += 2 * 60_000;
  await h.settle();
  assert.equal((await h.byIssue(50)).state, "working");
  assert.equal(Boolean(h.gh().issues.get(50)!.closed), false);
  const comments = statusComments(h);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /2 of 2 closed/);
  assert.doesNotMatch(comments[0]!.body, /Verify the combined result|Merge origin\//);
});

test("the parent sticks when a sub-issue's job ended and no open sub-issue can still progress", async () => {
  const h = withParent();
  await h.settle();
  await h.engine().run(["issues", "stop", (await h.byIssue(51)).id]);
  h.gh().issues.get(52)!.closed = true;
  h.clock.now += 2 * 60_000;
  await h.settle();
  const parent = await h.byIssue(50);
  assert.equal(parent.state, "stuck");
  assert.match(parent.error ?? "", /prerequisites failed: #51/);
  assert.match(statusComments(h)[0]!.body, /#51 Part 51 \(stopped\)/);
});

test("stopping the parent stops it and its open children", async () => {
  const h = withParent();
  await h.settle();
  h.gh().comments.set(50, [...(h.gh().comments.get(50) ?? []), { id: 9001, body: "@pstack-test stop", user: { login: "maya" }, created_at: new Date(h.clock.now + 1).toISOString(), updated_at: new Date(h.clock.now + 1).toISOString() }]);
  h.clock.now += 2 * 60_000;
  await h.settle();
  for (const issue of [50, 51, 52]) assert.equal((await h.byIssue(issue)).state, "stopped", `#${issue}`);
});

test("removing the label from the parent stops it", async () => {
  const h = withParent();
  await h.settle();
  h.unlabel(50);
  h.clock.now += 2 * 60_000;
  await h.settle();
  for (const issue of [50, 51, 52]) assert.equal((await h.byIssue(issue)).state, "stopped", `#${issue}`);
});

test("a ready unmerged prerequisite supplies its pinned branch and commit to the dependent worker", async () => {
  const h = withParent();
  h.gh().issues.get(52)!.blockedBy = [51];
  await h.settle();
  const prerequisite = await h.byIssue(51);
  await h.report(prerequisite.threadId!, GOOD);
  await h.settle();
  await h.advance(MIN);
  const dependent = await h.byIssue(52);
  assert.equal(dependent.state, "working");
  const prompt = h.spawned.find((spawn) => spawn.pluginMetadata.jobId === dependent.id)!.prompt;
  assert.match(prompt, new RegExp(`merge origin/${prerequisite.branch} at ${"2".repeat(40)}`));
  assert.equal(h.gh().issues.get(51)!.closed, undefined);
  const missing = await h.report(dependent.threadId!, GOOD, { headSha: "3".repeat(40), commits: ["3".repeat(40)], ahead: 1 });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr!, /include prerequisite #51/);
});

test("dependency cycles fail their own children while independent children keep working", async () => {
  const h = withParent([51, 52, 53]);
  h.gh().issues.get(51)!.blockedBy = [52];
  h.gh().issues.get(52)!.blockedBy = [51];
  await h.settle();
  for (const issue of [51, 52]) {
    const child = await h.byIssue(issue);
    assert.equal(child.outcome, "failure");
    assert.match(child.error!, /cycle/);
  }
  assert.equal((await h.byIssue(53)).state, "working");
});

test("the parent aggregates ready children before merge and verifies integration in its own worker", async () => {
  const h = withParent();
  await h.settle();
  for (const issue of [51, 52]) await h.report((await h.byIssue(issue)).threadId!, GOOD);
  await h.settle();
  await h.advance(MIN);
  const parent = await h.byIssue(50);
  assert.equal(parent.state, "working");
  const prompt = h.spawned.find((spawn) => spawn.pluginMetadata.jobId === parent.id)!.prompt;
  for (const issue of [51, 52]) assert.match(prompt, new RegExp(`Merge origin/${(await h.byIssue(issue)).branch}`));
  await h.report(parent.threadId!, GOOD); await h.settle();
  await h.advance(MIN);
  assert.equal((await h.byIssue(50)).outcome, "ready");
  const child = await h.byIssue(51);
  h.gh().refs.set(child.branch, "3".repeat(40));
  await h.advance(MIN);
  assert.notEqual((await h.byIssue(50)).outcome, "ready");
});
