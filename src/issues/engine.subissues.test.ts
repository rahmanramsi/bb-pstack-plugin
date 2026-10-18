import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOD, harness } from "./engine-harness.ts";

function withParent(subIssues = [51, 52]) {
  const h = harness();
  const gh = h.gh();
  for (const number of subIssues) gh.issues.set(number, { number, title: `Part ${number}`, body: `Do part ${number}.`, user: "maya", updatedAt: h.clock.now, labels: new Set() });
  gh.issues.set(50, { number: 50, title: "Checkout redesign", body: "The whole checkout flow.", user: "maya", updatedAt: h.clock.now, labels: new Set(), subIssues });
  h.label(50);
  return h;
}

const statusComments = (h: ReturnType<typeof harness>) => (h.gh().comments.get(50) ?? []).filter((comment) => comment.body.includes("Sub-issues:"));

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

test("the parent closes with one edited status comment once every sub-issue is closed", async () => {
  const h = withParent();
  await h.settle();
  const a = await h.byIssue(51);
  await h.report(a.threadId!, GOOD);
  h.clock.now += 2 * 60_000;
  await h.settle();
  for (const number of [51, 52]) h.gh().issues.get(number)!.closed = true;
  h.clock.now += 2 * 60_000;
  await h.settle();
  assert.equal((await h.byIssue(50)).state, "done");
  assert.equal(h.gh().issues.get(50)!.closed, true);
  const comments = statusComments(h);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /2 of 2 closed/);
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
  assert.match(parent.error ?? "", /#51 need a person/);
  assert.match(statusComments(h)[0]!.body, /#51 Part 51 \(stopped, needs a person\)/);
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
