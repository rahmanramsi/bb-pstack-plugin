import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOD, MIN, SHA1, SHA2, SHA3, harness } from "./engine-harness.ts";
import { RETRY_WAIT_MS, SWEEP_MS } from "./engine.ts";

const FAILURE = { outcome: "failure", reason: "The required interface is unavailable.", summary: "The implementation is incomplete.", verification: ["Interface check failed."] };

async function parked(h = harness()) {
  h.label(41);
  await h.settle();
  const working = await h.only();
  const result = await h.report(working.threadId!, FAILURE, { headSha: SHA2, ahead: 1, dirty: true });
  assert.equal(result.exitCode, 0, result.stderr);
  await h.settle();
  const job = await h.only();
  assert.equal(job.state, "checking", job.error ?? "");
  assert.ok(job.pr);
  return { h, job, pr: job.pr.number };
}

test("unfinished commits pass the guarded push and remain in a draft PR with the reason and dirty-work notice", async () => {
  const h = harness();
  h.failures.gate = "local validation is incomplete";
  const { job, pr } = await parked(h);
  const pull = h.gh().issues.get(pr)!;
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0]!.sha, SHA2);
  assert.equal(h.pushes[0]!.expectedRemoteSha, null);
  assert.equal(h.gh().revoked.length, 1);
  assert.equal(pull.pr!.draft, true);
  assert.ok(pull.labels.has("agent:stuck"));
  assert.ok(pull.labels.has("agent"));
  assert.match(pull.title, /^chore\(issue-41\): unfinished work/);
  assert.match(pull.pr!.body, /required interface is unavailable/);
  assert.match(pull.pr!.body, /did not pass the checks/);
  assert.match(pull.pr!.body, /did not pass the checks a pull request normally needs/);
  assert.match(pull.pr!.body, /Uncommitted changes remain/);
  assert.match(pull.pr!.body, /Review this pull request to start another round/);
  assert.match(pull.pr!.body, /Related to #41/);
  assert.doesNotMatch(pull.pr!.body, /(?:fixes|closes|resolves) #41/i);
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
  assert.match(h.gh().comments.get(41)![0]!.body, /Unfinished: draft pull request open/);
  h.restart();
  await h.advance(10 * MIN);
  assert.equal((await h.only()).state, "checking");
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.get(job.id)!.control.parks, 1);
});

for (const gate of ["workflow", "permission", "empty-diff"] as const) {
  test(`unfinished work failing the ${gate} publication gate ends stuck without a push`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const working = await h.only();
    if (gate === "workflow") { h.failures.workflows = true; delete h.gh().grants.workflows; }
    if (gate === "permission") h.gh().grants.contents = "read";
    if (gate === "empty-diff") h.failures.inspectedEmpty = true;
    await h.report(working.threadId!, FAILURE);
    await h.settle();
    assert.equal((await h.only()).state, "stuck");
    assert.equal(h.pushes.length, 0);
    assert.equal((await h.only()).pr, null);
    assert.equal(h.gh().refs.has(working.branch), false);
  });
}

test("a trusted review resumes parked work and supersedes a failed stuck-label delivery", async () => {
  const h = harness();
  const held = h.holdAt("POST /repos/acme/web/pulls", "github");
  const parking = parked(h);
  await held.hit;
  const created = [...h.gh().issues.values()].find((issue) => issue.pr)!;
  h.gh().outages.push({ key: `POST /repos/acme/web/issues/${created.number}/labels`, body: "agent:stuck", status: 403, times: 1 });
  held.free();
  const { job, pr } = await parking;
  assert.equal(h.gh().issues.get(pr)!.labels.has("agent:stuck"), false);
  const feedback = h.review(pr, { body: "Finish the required interface." });
  h.restart();
  await h.advance(3 * MIN);
  const current = await h.only();
  assert.equal(current.state, "addressing", current.error ?? "");
  assert.equal(current.round, 2);
  assert.equal(h.store.get(job.id)!.control.parked, null);
  assert.equal(h.store.get(job.id)!.control.recoveries, 0);
  assert.equal(h.gh().issues.get(pr)!.labels.has("agent:stuck"), false);
  assert.ok(h.sent.some((message) => message.input[0].text.includes(String(feedback.id))));
  const report = { outcome: "changes", round: 1, pr: GOOD.pr, verification: GOOD.verification, summary: GOOD.summary, replies: [{ kind: "review", commentId: feedback.id, body: "The interface is now available." }] };
  const result = await h.report(current.threadId!, report, { headSha: SHA3, ahead: 2, dirty: false });
  assert.equal(result.exitCode, 0, result.stderr);
  await h.settle();
  assert.equal(h.gh().issues.get(pr)!.title, GOOD.pr.title);
  assert.match(h.gh().issues.get(pr)!.pr!.body, /footer covered the button/);
  assert.doesNotMatch(h.gh().issues.get(pr)!.pr!.body, /Unfinished work/);
});

test("a current worker's report on a parked job is accepted and restores the PR title and body", async () => {
  const { h, job, pr } = await parked();
  const result = await h.report(job.threadId!, GOOD, { dirty: false });
  assert.equal(result.exitCode, 0, result.stderr);
  await h.settle(); await h.advance(2 * MIN);
  assert.equal(h.store.get(job.id)!.control.parked, null);
  assert.equal(h.gh().issues.get(pr)!.labels.has("agent:stuck"), false);
  assert.equal(h.gh().issues.get(pr)!.title, GOOD.pr.title);
  assert.match(h.gh().issues.get(pr)!.pr!.body, /Closes #41/);
  assert.equal((await h.only()).outcome, "ready");
});

test("an empty workspace gets one replacement in the same environment and then ends stuck", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const working = await h.only();
  const environment = h.threads.get(working.threadId!)!.environmentId;
  await h.report(working.threadId!, FAILURE, { headSha: SHA1, ahead: 0, dirty: true });
  await h.settle();
  const retry = await h.only();
  assert.equal(retry.state, "working");
  assert.notEqual(retry.threadId, working.threadId);
  assert.equal(h.threads.get(retry.threadId!)!.environmentId, environment);
  assert.equal(h.worktrees.get(environment)!.dirty, true);
  h.restart();
  await h.report(retry.threadId!, FAILURE, { headSha: SHA1, ahead: 0 });
  await h.settle();
  assert.equal((await h.only()).state, "stuck");
  assert.match((await h.only()).error!, /produced no commits/);
  assert.equal(h.spawned.length, 2);
  assert.equal(h.pushes.length, 0);
});

for (const overdue of [false, true]) {
  test(`a queued provider retry ${overdue ? "past the wait window recovers" : "just past sendAt waits visibly across restart"}`, async () => {
    const h = harness();
    h.label(41); await h.settle();
    const working = await h.only();
    const worker = h.threads.get(working.threadId!)!;
    worker.status = "error";
    h.failures.scheduledRetryAt = h.clock.now - (overdue ? RETRY_WAIT_MS + 1 : SWEEP_MS);
    await h.settle();
    if (overdue) {
      await h.advance(2 * MIN);
      assert.equal(h.spawned.length, 2);
      return;
    }
    assert.match((await h.only()).error!, /waiting for the worker's provider to retry/);
    h.restart(); await h.advance(3 * MIN);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.stopped.length, 0);
    assert.equal(h.store.get(working.id)!.control.recoveries, 0);
    assert.match(h.gh().comments.get(41)![0]!.body, /waiting for the worker/);
    worker.status = "active";
    h.failures.scheduledRetryAt = null;
    await h.settle();
    assert.equal((await h.only()).error, null);
  });
}

test("a saved parked report survives restart and is evaluated before pending review starts a round", async () => {
  const { h, job, pr } = await parked();
  h.failures.workspaceUnavailable = true;
  const response = await h.report(job.threadId!, GOOD, { dirty: false });
  assert.equal(response.exitCode, 0, response.stderr);
  assert.equal(h.store.pendingSubmissions(job.id).length, 1);
  h.review(pr, { body: "Verify the interface." });
  h.restart();
  h.failures.workspaceUnavailable = false;
  await h.settle();
  assert.equal(h.store.pendingSubmissions(job.id).length, 0);
  assert.equal(h.store.get(job.id)!.report?.outcome, "changes");
  assert.equal(h.store.get(job.id)!.control.parked, null);
  assert.equal(h.gh().issues.get(pr)!.title, GOOD.pr.title);
});

for (const missing of ["missing", "archived"] as const) {
  test(`a ${missing} worker parks commits from the recorded workspace`, async () => {
    const h = harness({ configureDeps(deps) {
      if (missing === "missing") deps.hostPush = async (host, input) => {
        assert.equal(host, "host_worker");
        h.pushes.push(input);
        h.gh().refs.set(input.branch, input.sha);
        return { status: "pushed", sha: input.sha };
      };
    } });
    h.label(41); await h.settle();
    const current = h.store.get((await h.only()).id)!;
    const worker = h.threads.get(current.threadId!)!;
    h.worktrees.set(worker.environmentId, { headSha: SHA2, ahead: 1, dirty: false });
    h.store.write(current.id, current.version, { control: { ...current.control, recoveries: 2 } }, h.clock.now);
    if (missing === "missing") h.threads.delete(worker.id);
    else worker.archivedAt = h.clock.now;
    await h.settle();
    const result = await h.only();
    assert.equal(result.state, "checking", result.error ?? "");
    assert.ok(h.gh().issues.get(result.pr!.number)!.labels.has("agent:stuck"));
    assert.equal(h.pushes[0]!.sha, SHA2);
  });
}

for (const persistent of [false, true]) {
  test(`parking inspection ${persistent ? "exhausts transient observations without publishing" : "retries a transient observation after restart"}`, async () => {
    let offline = false;
    const h = harness({ configureDeps(deps) {
      const status = deps.bb.sdk.environments.status;
      deps.bb.sdk.environments.status = async (args) => {
        if (offline) throw Object.assign(new Error("SDK temporarily unavailable"), { status: 503 });
        return status(args);
      };
    } });
    h.label(41); await h.settle();
    const working = await h.only();
    offline = true;
    await h.report(working.threadId!, FAILURE);
    await h.settle();
    assert.equal((await h.only()).next?.op, "inspect-work");
    if (!persistent) offline = false;
    for (let attempt = 0; attempt < 8 && (await h.only()).state === "publishing"; attempt++) {
      const retry = (await h.only()).next!.retryAt!;
      h.clock.now = retry;
      h.restart(); await h.settle();
    }
    const result = await h.only();
    assert.equal(result.state, persistent ? "stuck" : "checking", result.error ?? "");
    assert.equal(h.pushes.length, persistent ? 0 : 1);
    if (persistent) assert.match(result.error!, /observation exhausted/);
  });
}

test("a review can respawn a parked worker with a fresh recovery budget in the preserved workspace", async () => {
  const { h, job, pr } = await parked();
  const before = h.store.get(job.id)!;
  h.store.write(before.id, before.version, { control: { ...before.control, recoveries: 2, invalid: 3, bestReasons: ["CI failed"], repair: { cause: "CI", attempts: 5 } } }, h.clock.now);
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  h.review(pr, { body: "Finish the interface." });
  await h.advance(3 * MIN);
  const resumed = await h.only();
  assert.equal(resumed.state, "addressing", resumed.error ?? "");
  assert.notEqual(resumed.threadId, job.threadId);
  assert.equal(h.threads.get(resumed.threadId!)!.environmentId, h.threads.get(job.threadId!)!.environmentId);
  assert.equal(h.store.get(job.id)!.control.recoveries, 1);
  assert.equal(h.store.get(job.id)!.control.parks, 1);
  assert.equal(h.gh().issues.get(pr)!.labels.has("agent:stuck"), false);
});

test("two parks are the limit even when the bound worker keeps reporting failure", async () => {
  const { h, job, pr } = await parked();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await h.report(job.threadId!, FAILURE)).exitCode, 0);
    await h.settle();
  }
  assert.equal((await h.only()).state, "stuck");
  assert.equal(h.store.get(job.id)!.control.parks, 2);
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, true);
  assert.equal(h.gh().issues.get(pr)!.labels.has("agent:stuck"), true);
  assert.equal(h.pushes.length, 1);
  assert.equal((await h.report(job.threadId!, GOOD)).exitCode, 1);
});
