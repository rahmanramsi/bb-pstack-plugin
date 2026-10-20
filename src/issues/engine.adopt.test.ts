import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { APP, MIN, REPO, SHA2, SHA3, harness } from "./engine-harness.ts";
import type { JobId } from "./job.ts";

const BRANCH = "agent/issue-41-salvaged";
const SHA4 = "4".repeat(40);
const SHA5 = "5".repeat(40);
const TITLE = "Submit button hides behind the footer";

/**
 * Issue #41, whose earlier job got stuck, and the App's draft pull request #57 for it. `feedback`: a request and an
 * `@app stop`, both posted before anyone adopts the pull request.
 */
function salvaged(h: ReturnType<typeof harness>, { feedback = true } = {}) {
  h.gh().issues.set(41, { number: 41, title: TITLE, body: "On 375px the footer covers it.", user: "maya", updatedAt: h.clock.now, labels: new Set() });
  const stuck = h.store.insert({ id: `psi_${randomUUID()}` as JobId, repo: REPO, issue: 41, trigger: { eventId: null, actor: "the bb app", at: h.clock.now }, snapshot: { title: TITLE, body: "b", url: "https://github.com/acme/web/issues/41", author: "maya" }, projectId: "prj_web", hostId: "host_worker", baseBranch: "main", state: "queued", error: null }, h.clock.now)!;
  h.store.write(stuck.id, stuck.version, { phase: { state: "stuck" }, error: "the worker stopped without reporting" }, h.clock.now);
  h.gh().issues.set(57, { number: 57, title: "fix(login): keep the submit button above the footer", body: "Keeps the button visible.\n\nCloses #41", user: APP, updatedAt: h.clock.now, labels: new Set(), pr: { head: BRANCH, base: "main", title: "fix(login): keep the submit button above the footer", body: "Keeps the button visible.\n\nCloses #41", draft: true } });
  h.gh().refs.set(BRANCH, SHA2);
  const ask = feedback ? h.converse(57, "maya", "@pstack-test please also cover the 320px layout") : null;
  if (feedback) h.converse(57, "maya", "@pstack-test stop");
  h.clock.now += 5 * MIN;
  return { stuck, ask };
}

const adopt = (h: ReturnType<typeof harness>, pr: number, threadId?: string, flags: string[] = []) => h.engine().run(["issues", "adopt", "--repo", "acme/web", "--pr", String(pr), ...flags], threadId);
const errorCode = (result: { stdout?: string }) => (JSON.parse(result.stdout!) as { error: { code: string } }).error.code;
const roundReport = (commentId: number) => ({ outcome: "changes", round: 1, replies: [{ kind: "pr-comment", commentId, body: "The 320px layout is covered too." }], verification: ["npm test -- login: 15 passed"], summary: "Covered the 320px layout." });
const appReplies = (h: ReturnType<typeof harness>) => (h.gh().comments.get(57) ?? []).filter((comment) => comment.user.login === APP && comment.body.includes("<!-- pstack:reply:"));

test("an adopted pull request's earlier feedback becomes its first round, answered on the same branch by a worker started from the base branch", async () => {
  const h = harness();
  const { stuck, ask } = salvaged(h);
  const adopted = await adopt(h, 57);
  assert.equal(adopted.exitCode, 0, adopted.stderr);
  const id = (await h.views()).find((view) => view.id !== stuck.id)!.id;
  assert.equal(adopted.stdout, `Adopted PR #57 (${BRANCH}) for issue #41 as ${id}; generation 2.\nIts first feedback round starts once review feedback has been quiet for 2 minutes.\n`);

  await h.settle();
  const addressing = (await h.views()).find((view) => view.id === id)!;
  assert.equal(addressing.state, "addressing", addressing.error ?? "");
  assert.equal(addressing.round, 2);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0]!.environment.workspace.baseBranch, { kind: "named", name: "origin/main" });
  assert.match(h.spawned[0]!.prompt, new RegExp(`"commentId": ${ask}`));
  assert.match(h.spawned[0]!.prompt, /git merge origin\/agent\/issue-41-salvaged/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.input[0].text, /merge `origin\/agent\/issue-41-salvaged` before you commit/, "the worktree starts behind the pull request");
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent:working"]);

  const answered = await h.report(addressing.threadId!, roundReport(ask!), { headSha: SHA3, ahead: 2, commits: [SHA3, SHA2] });
  assert.equal(answered.exitCode, 0, answered.stderr);
  await h.settle();
  await h.advance(2 * MIN);

  assert.deepEqual(h.pushes.map((push) => [push.branch, push.sha, push.expectedRemoteSha]), [[BRANCH, SHA3, SHA2]], "pushed on top of the adopted head, never a rewrite");
  assert.equal(appReplies(h).length, 1);
  assert.match(appReplies(h)[0]!.body, /^> `@pstack-test` please also cover the 320px layout\n\nThe 320px layout is covered too\./);
  const back = (await h.views()).find((view) => view.id === id)!;
  assert.equal(back.state, "review", back.error ?? "");
  assert.equal(h.gh().issues.get(57)!.pr!.draft, false, "verified like any round, then marked ready");
  assert.equal(back.pushedSha, SHA3);
  assert.equal(h.stopped.length, 0, "the stop posted before adoption is not a command to this job");
  assert.equal((await h.views()).find((view) => view.id === stuck.id)!.state, "stuck");
});

test("an adopted pull request with no feedback waits in review without starting a worker", async () => {
  const h = harness();
  salvaged(h, { feedback: false });
  assert.equal((await adopt(h, 57)).exitCode, 0);
  await h.settle();
  await h.advance(5 * MIN);
  const waiting = (await h.views()).find((view) => view.state !== "stuck")!;
  assert.equal(waiting.state, "queued");
  assert.equal(waiting.error, "waiting for review feedback on pull request #57");
  assert.equal(h.spawned.length, 0);
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent:review"]);
});

test("when the adopted branch moves during the first round, the report is answered with the new head and the push expects it", async () => {
  const h = harness();
  const { ask } = salvaged(h);
  assert.equal((await adopt(h, 57)).exitCode, 0);
  await h.settle();
  const addressing = (await h.views()).find((view) => view.state === "addressing")!;
  h.gh().refs.set(BRANCH, SHA4);

  const moved = await h.report(addressing.threadId!, roundReport(ask!), { headSha: SHA3, ahead: 2, commits: [SHA3, SHA2] });
  assert.notEqual(moved.exitCode, 0);
  assert.match(moved.stderr!, new RegExp(`Remote moved to ${SHA4}\\. Merge it and submit current evidence\\.`));
  assert.equal(h.pushes.length, 0);

  const merged = await h.report(addressing.threadId!, roundReport(ask!), { headSha: SHA5, ahead: 4, commits: [SHA5, SHA4, SHA3, SHA2] });
  assert.equal(merged.exitCode, 0, merged.stderr);
  await h.settle();
  assert.deepEqual(h.pushes.map((push) => [push.sha, push.expectedRemoteSha]), [[SHA5, SHA4]]);
  assert.equal(appReplies(h).length, 1);
});

test("bb pstack issues adopt refuses a fork's pull request and a worker thread, and adopting twice changes nothing", async () => {
  const h = harness();
  const { stuck } = salvaged(h);
  h.gh().issues.set(58, { number: 58, title: "fix(login): from a fork", body: "b", user: APP, updatedAt: h.clock.now, labels: new Set(), pr: { head: "agent/issue-41-fork", base: "main", title: "fix(login): from a fork", body: "b", draft: true, headRepo: "someone/web" } });
  h.gh().refs.set("agent/issue-41-fork", SHA3);

  const fork = await adopt(h, 58);
  assert.equal(fork.exitCode, 1);
  assert.equal(fork.stderr, "PR #58 cannot be adopted:\n  - its head is in fork someone/web, not acme/web\n");
  assert.equal(errorCode(await adopt(h, 58, undefined, ["--json"])), "adopt_refused");
  assert.equal((await h.views()).length, 1, "a refusal inserts nothing");

  assert.equal((await adopt(h, 57)).exitCode, 0);
  const id = (await h.views()).find((view) => view.id !== stuck.id)!.id;
  const again = await adopt(h, 57);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(again.stdout, `PR #57 is already owned by ${id} (queued).\n`);

  await h.settle();
  const worker = (await h.views()).find((view) => view.id === id)!.threadId!;
  const fromWorker = await adopt(h, 57, worker, ["--json"]);
  assert.equal(fromWorker.exitCode, 1);
  assert.equal(errorCode(fromWorker), "worker_cannot_adopt");
  assert.equal((await h.views()).length, 2);
});
