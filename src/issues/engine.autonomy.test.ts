import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, GOOD, MIN, SHA1, SHA2, SHA3, REPO } from "./engine-harness.ts";

test("same-target pending CI clears readiness without reversing a ready conversion", async () => {
  const h = harness();
  h.gh().checkRuns = [{ id: 1, name: "build", head_sha: SHA2, status: "completed", conclusion: "skipped", html_url: null, app: { id: 1 } }];
  h.gh().requiredChecks = [{ context: "build", app_id: 1 }];
  h.gh().readyStartsCI = true;
  h.label(41); await h.settle();
  await h.report((await h.only()).threadId!, GOOD); await h.settle();
  const pr = (await h.only()).pr!.number;
  assert.notEqual((await h.only()).outcome, "ready");
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, false);
  h.restart(); await h.settle();
  assert.deepEqual(h.gh().draftConversions, [false]);
  h.gh().checkRuns[0]!.status = "completed";
  h.gh().checkRuns[0]!.conclusion = "success";
  h.gh().suiteState = { status: "completed", conclusion: "success" };
  await h.settle(); await h.advance(MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.deepEqual(h.gh().draftConversions, [false]);
});

test("legitimate skipped checks remain acceptable after a separate non-draft observation", async () => {
  const h = harness();
  h.gh().checkRuns = [{ id: 1, name: "conditional build", head_sha: SHA2, status: "completed", conclusion: "skipped", html_url: null, app: { id: 9 } }];
  const { job } = await h.toReview();
  assert.equal(job.outcome, "ready");
  assert.deepEqual(h.gh().draftConversions, [false]);
});

test("recorded local evidence cannot claim a default base absent from the verified HEAD", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  h.gh().refs.set("main", SHA3);
  const response = await h.report(job.threadId!, GOOD, { headSha: SHA2, commits: [SHA2], ancestors: [SHA1], ahead: 1 });
  assert.equal(response.exitCode, 1);
  assert.match(response.stderr!, /verified base/);
  assert.equal(h.store.get(job.id)!.control.localEvidence, null);
});

test("healthy verified base advances do not exhaust a lifetime local-evidence budget", async () => {
  const h = harness();
  const { job } = await h.toReview();
  let previousHead = SHA2;
  for (let step = 0; step < 7; step++) {
    const base = (100 + step).toString(16).padStart(40, "0");
    const head = (200 + step).toString(16).padStart(40, "0");
    h.gh().refs.set("main", base);
    await h.advance(2 * MIN);
    const repair = await h.only();
    assert.equal(repair.state, "addressing", repair.error ?? "");
    const report = await h.report(job.threadId!, { outcome: "changes", round: repair.round - 1, replies: [], summary: "Verified current base integration.", verification: ["integration tests passed"] }, { headSha: head, ancestors: [previousHead, base], ahead: 2 });
    assert.equal(report.exitCode, 0, report.stderr);
    await h.advance(2 * MIN);
    assert.equal((await h.only()).outcome, "ready");
    previousHead = head;
  }
});

test("ordinary queued work waits for capacity before new confirmed idle reminder cycles", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  const worker = h.threads.get(job.threadId!)!;
  Object.assign(worker, { status: "idle", updatedAt: h.clock.now + 1, queuedMessageCount: 1 });
  h.queued.add(worker.id);
  h.clock.now += 24 * 60 * MIN;
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.spawned.length, 1);
  for (let cycle = 0; cycle < 2; cycle++) {
    h.queued.delete(worker.id);
    Object.assign(worker, { status: "active", queuedMessageCount: 0 });
    await h.settle();
    h.clock.now += MIN;
    Object.assign(worker, { status: "idle", updatedAt: h.clock.now });
    await h.settle();
    assert.equal(h.sent.length, cycle + 1);
    worker.queuedMessageCount = 1;
    h.queued.add(worker.id);
    h.clock.now += 24 * 60 * MIN;
    await h.settle();
    assert.equal(h.spawned.length, 1);
  }
  h.queued.delete(worker.id);
  Object.assign(worker, { status: "active", queuedMessageCount: 0 });
  await h.settle();
  h.clock.now += MIN;
  Object.assign(worker, { status: "idle", updatedAt: h.clock.now });
  await h.settle();
  assert.equal(h.spawned.length, 2);
});

test("publication divergence preserves accepted work and requires a fresh merged report", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  const held = h.holdAt("push:before", "sdk");
  await h.report(job.threadId!, GOOD);
  await held.hit;
  h.gh().refs.set(job.branch, SHA3);
  held.free();
  await h.settle();
  const repairing = await h.only();
  assert.equal(repairing.state, "working");
  assert.equal(h.store.get(job.id)!.report!.headSha, SHA2);
  assert.match(h.sent.at(-1)!.input[0].text, new RegExp(SHA3));
  assert.equal(h.gh().refs.get(job.branch), SHA3);
  h.restart(); await h.settle();
  assert.equal(h.pushes.length, 1, "the old SHA is never retried with the changed lease");
  const fresh = { outcome: "changes", round: repairing.round - 1, replies: [], summary: "Integrated collaborator changes.", verification: ["integration tests passed"] };
  const missingAccepted = await h.report(job.threadId!, fresh, { headSha: "4".repeat(40), ancestors: [SHA3], commits: ["4".repeat(40), SHA3], ahead: 2 });
  assert.match(missingAccepted.stderr!, /preserve accepted commit/);
  const missingRemote = await h.report(job.threadId!, fresh, { headSha: "5".repeat(40), ancestors: [SHA2], commits: ["5".repeat(40), SHA2], ahead: 2 });
  assert.match(missingRemote.stderr!, /does not contain/);
  const accepted = await h.report(job.threadId!, fresh, { headSha: "6".repeat(40), ancestors: [SHA2, SHA3], commits: ["6".repeat(40)], ahead: 3 });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  await h.settle(); await h.advance(MIN);
  const ready = await h.only();
  assert.equal(ready.outcome, "ready");
  assert.equal(h.pushes[1]!.sha, "6".repeat(40));
  assert.equal(h.pushes[1]!.expectedRemoteSha, SHA3);
  assert.equal(h.gh().issues.get(ready.pr!.number)!.pr!.title, GOOD.pr.title);
  assert.match(h.gh().issues.get(ready.pr!.number)!.pr!.body, /footer covered/);
  assert.equal(h.store.get(job.id)!.control.publicationRepair, null);
});

test("an already-contained publication needs fresh no-change verification without an empty commit", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  const held = h.holdAt("push:before", "sdk");
  await h.report(job.threadId!, GOOD); await held.hit;
  h.gh().refs.set(job.branch, SHA3);
  held.free(); await h.settle();
  const repair = await h.only();
  const report = { outcome: "no-change", round: repair.round - 1, replies: [], summary: "The collaborator commit includes the implementation.", verification: ["full tests passed at the remote head"] };
  h.failures.gate = "verification is incomplete";
  const invalid = await h.report(job.threadId!, report, { headSha: SHA3, ancestors: [SHA2], commits: [SHA3], ahead: 2 });
  assert.match(invalid.stderr!, /gate pr/);
  h.failures.gate = null;
  const response = await h.report(job.threadId!, report, { headSha: SHA3, ancestors: [SHA2], commits: [SHA3], ahead: 2 });
  assert.equal(response.exitCode, 0, response.stderr);
  await h.settle(); await h.advance(MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.equal((await h.only()).pushedSha, SHA3);
  assert.equal(h.pushes.length, 1);
});

test("feedback publication repair retains body intent, assigned replies, and original round evidence", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const feedback = h.review(pr, { body: "Fix the layout." });
  await h.advance(2 * MIN);
  const held = h.holdAt("push:before", "sdk");
  await h.report(job.threadId!, { outcome: "changes", round: 1, replies: [{ kind: "review", commentId: feedback.id, body: "The layout is fixed." }], pr: { body: "## Why\nLayout fixes preserve footer space." }, summary: "Fixed review request.", verification: ["layout tests passed"] }, { headSha: SHA3 });
  await held.hit;
  h.gh().refs.set(job.branch, "4".repeat(40));
  held.free(); await h.settle();
  h.restart(); await h.settle();
  const repair = await h.only();
  assert.equal(repair.state, "addressing");
  assert.deepEqual(h.store.roundFeedback(job.id, repair.round).map((item) => item.id), [feedback.id]);
  const missing = await h.report(job.threadId!, { outcome: "changes", round: repair.round - 1, replies: [], summary: "Merged changes.", verification: ["tests passed"] }, { headSha: "5".repeat(40), ancestors: [SHA3, "4".repeat(40)], ahead: 3 });
  assert.match(missing.stderr!, /reply to every listed/);
  await h.report(job.threadId!, { outcome: "changes", round: repair.round - 1, replies: [{ kind: "review", commentId: feedback.id, body: "The merged layout is verified." }], summary: "Merged changes.", verification: ["tests passed"] }, { headSha: "5".repeat(40), ancestors: [SHA3, "4".repeat(40)], ahead: 3 });
  await h.advance(2 * MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.match(h.gh().issues.get(pr)!.pr!.body, /Layout fixes preserve footer space/);
  assert.ok(h.gh().comments.get(pr)!.some((comment) => comment.body.includes("The merged layout is verified")));
  assert.ok(h.gh().pulls.get(pr)!.requested.has("maya"));
  const previous = h.db.prepare("SELECT report_json, finished_at FROM issue_rounds WHERE job_id = ? AND ordinal = 2").get(job.id) as { report_json: string; finished_at: number | null };
  assert.equal(JSON.parse(previous.report_json).headSha, SHA3);
  assert.notEqual(previous.finished_at, null);
});

test("publication ancestry failures recover a gone worker while denials remain terminal", async () => {
  for (const reason of ["not-descendant", "denied"] as const) {
    const h = harness();
    h.label(41); await h.settle();
    const job = await h.only();
    const worker = h.threads.get(job.threadId!)!;
    const held = h.holdAt("push:before", "sdk");
    await h.report(job.threadId!, GOOD); await held.hit;
    h.failures.pushRejected = reason;
    h.gh().refs.set(job.branch, SHA3);
    worker.archivedAt = h.clock.now;
    held.free(); await h.settle();
    if (reason === "denied") {
      assert.equal((await h.only()).outcome, "failure");
      assert.equal(h.spawned.length, 1);
      assert.equal(h.store.get(job.id)!.report!.headSha, SHA2);
    } else {
      assert.equal((await h.only()).state, "working");
      assert.equal(h.spawned[1]!.environment.type, "reuse");
      assert.equal(h.spawned[1]!.environment.environmentId, worker.environmentId);
      assert.match(h.spawned[1]!.prompt, new RegExp(SHA2));
      assert.match(h.spawned[1]!.prompt, new RegExp(SHA3));
      assert.match(h.spawned[1]!.prompt, /repair worker is unavailable/);
    }
  }
});

test("repeated publication divergence has a durable cause budget despite new commit SHAs", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  let acceptedSha = SHA2;
  for (let attempt = 0; attempt < 6; attempt++) {
    const remote = (10 + attempt * 2).toString(16).padStart(40, "0");
    const head = (11 + attempt * 2).toString(16).padStart(40, "0");
    const held = h.holdAt("push:before", "sdk");
    const current = await h.only();
    await h.report(current.threadId!, attempt === 0 ? GOOD : { outcome: "changes", round: current.round - 1, replies: [], summary: "Integrated the observed remote change.", verification: ["integration tests passed"] }, attempt === 0 ? { headSha: SHA2, ahead: 1 } : { headSha: head, ancestors: [acceptedSha, h.gh().refs.get(job.branch)!], ahead: 3 });
    await held.hit;
    acceptedSha = attempt === 0 ? SHA2 : head;
    h.gh().refs.set(job.branch, remote);
    held.free(); await h.settle();
    h.restart(); await h.settle();
    assert.equal(h.gh().refs.get(job.branch), remote);
  }
  assert.equal((await h.only()).outcome, "failure");
  assert.match((await h.only()).error!, /publication divergence exhausted/);
  assert.equal(h.store.get(job.id)!.report!.headSha, acceptedSha);
  assert.equal(h.pushes.length, 6);
});

test("an asynchronous rejection wakes its idle worker after outage and restart", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  h.gh().outages.push({ key: "GET /repos/acme/web/installation", times: Infinity });
  const result = await h.report(job.threadId!, { ...GOOD, pr: { ...GOOD.pr, title: "invalid title" } });
  assert.match(result.stdout!, /saved/);
  h.clock.now += MIN;
  Object.assign(h.threads.get(job.threadId!)!, { status: "idle", updatedAt: h.clock.now });
  h.restart();
  h.gh().outages.length = 0;
  await h.settle();
  assert.ok(h.sent.some((message) => message.threadId === job.threadId && /title/.test(message.input[0].text)), "the current worker receives validation reasons");
  for (let cycle = 0; cycle < 3; cycle++) {
    h.clock.now += 24 * 60 * MIN;
    h.threads.get(job.threadId!)!.updatedAt = h.clock.now;
    const current = h.store.get(job.id)!;
    h.store.write(current.id, current.version, { error: current.error }, h.clock.now + 1);
    await h.settle();
  }
  assert.ok(h.spawned.length > 1 || (await h.only()).outcome === "failure", "an unresponsive worker cannot remain permanently idle");
});

test("a rejection notification survives a lost response and does not consume provider retry time", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const job = await h.only();
  const worker = h.threads.get(job.threadId!)!;
  h.gh().outages.push({ key: "GET /repos/acme/web/installation", times: Infinity });
  await h.report(worker.id, { ...GOOD, pr: { ...GOOD.pr, title: "invalid title" } });
  await h.settle();
  h.restart();
  h.gh().outages.length = 0;
  worker.status = "error";
  h.failures.scheduledRetryAt = h.clock.now + 10 * MIN;
  await h.settle();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.sent.length, 0);
  const held = h.holdAt("send", "sdk");
  h.clock.now += 11 * MIN;
  h.failures.scheduledRetryAt = null;
  Object.assign(worker, { status: "idle", updatedAt: h.clock.now });
  const sending = h.settle();
  await held.hit;
  h.restart();
  held.free();
  await sending;
  h.clock.now += 2 * MIN;
  await h.settle();
  assert.equal(h.spawned.length, 1);
  assert.ok(h.sent.length >= 2);
  assert.ok(h.sent.every((message) => message.threadId === worker.id && /title/.test(message.input[0].text)));
});

test("accepted changes reach observed readiness with one audited issue comment", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  assert.equal(job.outcome, "ready");
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, false);
  assert.equal(h.gh().comments.get(41)?.length, 1);
  assert.match(h.gh().comments.get(41)![0]!.body, /Ready for review/);
});

test("needs-info is retained as an invalid submission and never creates a waiting state", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const working = await h.only();
  const response = await h.report(working.threadId!, { outcome: "needs-info", questions: ["What now?"], verification: ["read source"] }, { headSha: SHA1, ahead: 0 });
  assert.equal(response.exitCode, 1);
  assert.equal((await h.only()).state, "working");
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM issue_submissions").get() as { n: number }).n, 1);
});

test("a durable report is evaluated after an outage and restart without resubmission", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const working = await h.only();
  h.gh().outages.push({ key: "GET /repos/acme/web/installation", times: 2 });
  const response = await h.report(working.threadId!, GOOD);
  assert.equal(response.exitCode, 0);
  assert.match(response.stdout!, /saved/);
  h.restart();
  await h.settle(); await h.advance(MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.equal(h.pushes.length, 1);
});

test("worker recovery preserves the exact environment and dirty files after confirmed stop", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const original = await h.only();
  const worker = h.threads.get(original.threadId!)!;
  h.worktrees.get(worker.environmentId)!.dirty = true;
  for (let i = 0; i < 3; i++) {
    h.clock.now += MIN;
    worker.status = "idle";
    worker.updatedAt = h.clock.now;
    await h.settle();
  }
  const recovered = await h.only();
  assert.notEqual(recovered.threadId, original.threadId);
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: worker.environmentId });
  assert.equal(h.threads.get(recovered.threadId!)!.environmentId, worker.environmentId);
  assert.equal(h.worktrees.get(worker.environmentId)!.dirty, true);
  assert.ok(h.stopped.includes(original.threadId!));
});

test("permanent publication failure preserves accepted SHA and independently delivers failure status", async () => {
  const h = harness();
  h.label(41);
  await h.settle();
  const worker = (await h.only()).threadId!;
  h.gh().outages.push({ key: "POST /repos/acme/web/pulls", status: 403 });
  await h.report(worker, GOOD);
  await h.settle();
  const failed = await h.only();
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.pushedSha, SHA2);
  assert.match(h.gh().comments.get(41)![0]!.body, /Failed/);
  assert.match(h.gh().comments.get(41)![0]!.body, new RegExp(SHA2));
});

test("unknown protected policy is disclosed while complete clean observations reach review", async () => {
  const h = harness();
  h.gh().protected = true;
  h.gh().policyUnavailable = true;
  const { job } = await h.toReview();
  assert.match(job.limitation!, /could not be inspected/);
  assert.match(h.gh().comments.get(41)![0]!.body, /merge prerequisites are not established/);
});

test("a changed remote head clears readiness and requests current local evidence", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.gh().refs.set(job.branch, SHA3);
  await h.advance(2 * MIN);
  const changed = await h.only();
  assert.notEqual(changed.outcome, "ready");
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, true);
  assert.equal(changed.state, "addressing");
  assert.match(h.sent.at(-1)!.input[0].text, new RegExp(SHA3));
});

test("failed stop cannot start a replacement and provider scheduled retries retain their worker", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const original = await h.only();
  const worker = h.threads.get(original.threadId!)!;
  worker.status = "error";
  h.failures.scheduledRetryAt = h.clock.now + 20 * MIN;
  await h.settle();
  assert.equal(h.spawned.length, 1);
  h.failures.scheduledRetryAt = null;
  h.failures.stopUnconfirmed = true;
  worker.status = "active";
  await h.report(worker.id, { outcome: "bad-1" });
  await h.report(worker.id, { outcome: "bad-2" });
  await h.report(worker.id, { outcome: "bad-3" });
  await h.settle();
  assert.equal(h.spawned.length, 1);
  assert.equal((await h.only()).state, "recovering");
  h.failures.stopUnconfirmed = false;
  h.clock.now += MIN;
  await h.settle();
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: worker.environmentId });
});

test("failure reports retain dirty and unreachable work without calling arbitrary verification commands", async () => {
  for (const unreachable of [false, true]) {
    const h = harness();
    h.label(41); await h.settle();
    const worker = (await h.only()).threadId!;
    h.failures.workspaceUnavailable = unreachable;
    const result = await h.report(worker, { outcome: "failure", reason: "Required interface is unavailable", summary: "No usable implementation could be completed.", verification: ["touch /tmp/pstack-untrusted-command; failed to obtain required interface"] }, { dirty: true, headSha: SHA1, ahead: 0 });
    assert.equal(result.exitCode, 0);
    await h.settle();
    assert.equal((await h.only()).outcome, "failure");
    assert.equal(h.pushes.length, 0);
    assert.equal(h.worktrees.get(h.threads.get(worker)!.environmentId)!.dirty, true);
    assert.match(h.gh().comments.get(41)![0]!.body, /Required interface is unavailable/);
  }
});

test("accepted publication survives more than eight transient failures and then resumes", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  h.gh().outages.push({ key: "POST /repos/acme/web/pulls", times: 12 });
  await h.report(worker, GOOD);
  for (let i = 0; i < 10; i++) { h.clock.now += 16 * MIN; await h.settle(); }
  assert.equal((await h.only()).outcome, null);
  assert.equal(h.store.get((await h.only()).id)!.report!.headSha, SHA2);
  for (let i = 0; i < 4; i++) { h.clock.now += 16 * MIN; await h.settle(); }
  await h.advance(2 * MIN);
  assert.equal((await h.only()).outcome, "ready");
  assert.equal(h.pushes.length, 1);
});

test("terminal status retries independently from labels and unrelated execution, then repairs deletion", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  h.gh().outages.push({ key: "POST /repos/acme/web/issues/41/labels", times: 2, status: 403 });
  h.gh().comments.delete(41);
  h.gh().outages.push({ key: "POST /repos/acme/web/issues/41/comments", times: 2 });
  await h.report(worker, { outcome: "failure", reason: "Essential capability unavailable", summary: "Work retained.", verification: ["Capability request denied"] });
  h.label(42);
  await h.settle();
  assert.equal((await h.byIssue(41)).outcome, "failure");
  assert.equal((await h.byIssue(42)).state, "working");
  h.restart();
  for (let i = 0; i < 4; i++) { h.clock.now += 2 * MIN; await h.settle(); }
  assert.equal(h.gh().comments.get(41)!.length, 1);
  assert.match(h.gh().comments.get(41)![0]!.body, /Essential capability unavailable/);
  h.gh().comments.delete(41);
  h.clock.now += 12 * 60 * MIN; await h.settle();
  assert.equal(h.gh().comments.get(41), undefined, "a deleted terminal comment waits for the daily audit");
  h.clock.now += 12 * 60 * MIN; await h.settle();
  assert.equal(h.gh().comments.get(41)!.length, 1);
  assert.match(h.gh().comments.get(41)![0]!.body, /Essential capability unavailable/);
});

test("pending CI waits while active and missing producers exhaust bounded repair rounds", async () => {
  const h = harness();
  h.gh().checkRuns = [{ id: 1, name: "tests", head_sha: SHA2, status: "in_progress", conclusion: null, html_url: null, app: { id: 9 } }];
  h.label(41); await h.settle();
  await h.report((await h.only()).threadId!, GOOD); await h.settle();
  h.clock.now += 100 * 24 * 60 * MIN; await h.settle();
  assert.equal((await h.only()).state, "checking");
  h.gh().checkRuns = [];
  h.gh().requiredChecks = [{ context: "tests", app_id: 9 }];
  for (let i = 0; i < 6; i++) {
    await h.advance(MIN);
    const job = h.store.get((await h.only()).id)!;
    if (job.phase.state === "stuck") break;
    assert.equal(job.phase.state, "addressing");
    await h.report(job.threadId!, { outcome: "no-change", round: job.round - 1, replies: [], summary: "The producer is unavailable in this repository.", verification: ["Inspected workflow configuration and the missing check producer."] }, { headSha: SHA2, ahead: 1 });
  }
  await h.settle();
  assert.equal((await h.only()).outcome, "failure");
  assert.match((await h.only()).error!, /repair exhausted/);
});

test("a base change during ready conversion cannot settle stale evidence ready", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const held = h.holdAt("POST /graphql", "github");
  await h.report((await h.only()).threadId!, GOOD);
  await held.hit;
  h.gh().refs.set("main", SHA3);
  held.free();
  await h.settle(); await h.advance(MIN);
  const job = await h.only();
  assert.notEqual(job.outcome, "ready");
  assert.equal(h.gh().issues.get(job.pr!.number)!.pr!.draft, true);
  assert.equal(h.store.get(job.id)!.control.readiness, null);
});

test("retired workers cannot poison an identical pending report from the replacement epoch", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const original = (await h.only()).threadId!;
  h.failures.spawn.push({ create: "later" });
  for (let i = 0; i < 3; i++) await h.report(original, { outcome: `invalid-${i}` });
  await h.settle();
  assert.equal((await h.only()).next?.op, "recover-worker");
  assert.equal((await h.report(original, GOOD)).exitCode, 1);
  const replacement = h.late[0]!;
  h.threads.set(replacement.id, replacement);
  const pending = await h.report(replacement.id, GOOD);
  assert.equal(pending.exitCode, 0);
  await h.advance(2 * MIN);
  assert.equal((await h.only()).threadId, replacement.id);
  assert.equal((await h.only()).outcome, "ready");
});

test("alternating invalid reports exhaust a persisted two-recovery budget", async () => {
  const h = harness();
  h.label(41); await h.settle();
  for (let episode = 0; episode < 3; episode++) {
    const worker = (await h.only()).threadId!;
    for (let attempt = 0; attempt < 3; attempt++) await h.report(worker, { outcome: `invalid-${attempt % 2}`, summary: `attempt-${attempt}` });
    await h.settle(); h.restart();
  }
  const job = await h.only();
  assert.equal(job.outcome, "failure");
  assert.match(job.error!, /recovery exhausted/);
  assert.equal(h.spawned.length, 3);
  assert.equal(h.store.get(job.id)!.control.recoveries, 2);
});

test("CI repair recovers a gone published worker in the preserved environment", async () => {
  const h = harness();
  const { job } = await h.toReview();
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  h.gh().mergeable = false;
  await h.advance(2 * MIN);
  const repairing = await h.only();
  assert.equal(repairing.state, "addressing");
  assert.notEqual(repairing.threadId, job.threadId);
  assert.equal(h.spawned[1]!.environment.type, "reuse");
  assert.equal(h.store.get(job.id)!.control.repair?.cause.includes("conflicting"), true);
  assert.match(h.spawned[1]!.prompt, /mergeability is conflicting/);
  assert.match(h.spawned[1]!.prompt, /repair worker is unavailable/);
});

test("a missing fresh base object asks the worker to fetch and requires integrated current evidence", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  h.gh().refs.set("main", SHA3);
  h.failures.missingObject = SHA3;
  const saved = await h.report(worker, GOOD);
  assert.equal(saved.exitCode, 0);
  await h.settle();
  assert.match(h.sent.at(-1)!.input[0].text, /bb pstack gh fetch/);
  assert.match(h.sent.at(-1)!.input[0].text, new RegExp(SHA3));
  assert.equal(h.pushes.length, 0);
  h.failures.missingObject = null;
  h.restart(); await h.settle();
  assert.notEqual((await h.only()).outcome, "ready");
  assert.match(h.sent.at(-1)!.input[0].text, /verified base/);
  const response = await h.report(worker, GOOD, { headSha: "4".repeat(40), ancestors: [SHA3], ahead: 2 });
  assert.equal(response.exitCode, 0, response.stderr);
  await h.settle(); await h.advance(MIN);
  assert.equal((await h.only()).outcome, "ready");
});

test("aggregate pending suites cannot make an otherwise successful head ready", async () => {
  const h = harness();
  h.gh().checkRuns = [{ id: 1, name: "build", head_sha: SHA2, status: "completed", conclusion: "success", html_url: null, app: { id: 9 } }];
  h.gh().requiredChecks = [{ context: "build", app_id: 9 }];
  h.gh().suiteState = { status: "queued", conclusion: null };
  h.label(41); await h.settle();
  const job = await h.only();
  await h.report(job.threadId!, GOOD); await h.settle();
  assert.equal((await h.only()).state, "checking");
  assert.equal((await h.only()).outcome, null);
  assert.deepEqual(h.gh().draftConversions, []);
  h.gh().suiteState = { status: "completed", conclusion: "success" };
  await h.advance(2 * MIN);
  assert.equal((await h.only()).outcome, "ready");
});

test("persistently unknown mergeability stays unready and exhausts its actual repair cause", async () => {
  const h = harness();
  const { job } = await h.toReview();
  h.gh().mergeable = null;
  await h.advance(2 * MIN);
  const waiting = await h.only();
  assert.equal(waiting.state, "checking", "a first unknown read waits for a later fresh observation before repair");
  assert.notEqual(waiting.outcome, "ready");
  assert.equal(h.spawned.length, 1);
  await h.advance(MIN);
  for (let round = 0; round < 5; round++) {
    const current = await h.only();
    assert.equal(current.state, "addressing");
    assert.notEqual(current.outcome, "ready");
    await h.report(job.threadId!, { outcome: "no-change", round: current.round - 1, replies: [], summary: "Verified the current implementation.", verification: ["local tests passed; mergeability is still unknown"] }, { headSha: SHA2, ahead: 1 });
    await h.advance(MIN);
  }
  assert.equal((await h.only()).outcome, "failure");
  assert.match((await h.only()).error!, /repair exhausted.*mergeability is unknown/);
});

test("saved report verification never rebinds to a later worker commit", async () => {
  const h = harness();
  h.label(41); await h.settle();
  const worker = (await h.only()).threadId!;
  h.failures.missingObject = SHA1;
  await h.report(worker, GOOD); await h.settle();
  h.worktrees.get(h.threads.get(worker)!.environmentId)!.headSha = SHA3;
  h.failures.missingObject = null;
  h.restart(); await h.settle();
  assert.equal(h.pushes.length, 0);
  const row = h.db.prepare("SELECT intended_sha, result FROM issue_submissions WHERE intended_sha IS NOT NULL ORDER BY id LIMIT 1").get() as { intended_sha: string; result: string };
  assert.equal(row.intended_sha, SHA2);
  assert.match(row.result, /stale_snapshot/);
  assert.equal((await h.report(worker, GOOD, { headSha: SHA3 })).exitCode, 0);
  await h.settle();
  assert.equal((await h.only()).pushedSha, SHA3);
});

test("permanent report prerequisites fail with preserved submission while transient faults stay pending", async () => {
  for (const status of [403, 404, 502]) {
    const h = harness();
    h.label(41); await h.settle();
    const worker = (await h.only()).threadId!;
    h.gh().outages.push({ key: "GET /repos/acme/web/installation", status, times: Infinity });
    await h.report(worker, GOOD); await h.settle();
    const job = await h.only();
    assert.equal(h.pushes.length, 0);
    if (status === 502) assert.equal(job.state, "working");
    else {
      assert.equal(job.outcome, "failure");
      h.gh().outages.length = 0; h.clock.now += 2 * MIN; h.restart(); await h.settle();
      assert.match(h.gh().comments.get(41)![0]!.body, /Failed/);
      assert.equal((h.db.prepare("SELECT count(*) AS n FROM issue_submissions WHERE raw LIKE '%changes%'").get() as { n: number }).n, 1);
    }
  }
});

test("permanent essential PR observation denial ends checking but a transport outage resumes", async () => {
  for (const status of [403, 502]) {
    const h = harness();
    const { job, pr } = await h.toReview();
    h.gh().outages.push({ key: `GET /repos/acme/web/pulls/${pr}`, status, times: Infinity });
    await h.advance(MIN);
    if (status === 403) {
      assert.equal((await h.only()).outcome, "failure");
      assert.equal((await h.only()).pushedSha, job.pushedSha);
      assert.match(h.gh().comments.get(41)![0]!.body, /Failed/);
    } else {
      assert.equal((await h.only()).state, "review");
      h.gh().outages.length = 0;
      await h.settle(); await h.advance(MIN);
      assert.equal((await h.only()).outcome, "ready");
    }
  }
});

test("uncertain PR creation adopts only the App-owned publication marker for this job", async () => {
  for (const marked of [true, false]) {
    const h = harness();
    h.label(41); await h.settle();
    const worker = (await h.only()).threadId!;
    const held = h.holdAt("POST /repos/acme/web/pulls", "github");
    await h.report(worker, GOOD);
    await held.hit;
    const pull = [...h.gh().issues.values()].find((issue) => issue.pr)!;
    if (!marked) pull.pr!.body = "An unrelated pull request on the same branch.";
    h.restart();
    await h.advance(2 * MIN);
    const job = await h.only();
    assert.equal(job.outcome, marked ? "ready" : "failure");
    if (!marked) assert.match(job.error!, /publication marker/);
    assert.equal([...h.gh().issues.values()].filter((issue) => issue.pr).length, 1);
    held.free();
  }
});

test("a definite PR validation 422 with no matching publication fails instead of retrying forever", async () => {
  const h = harness();
  h.label(41); await h.settle();
  h.gh().outages.push({ key: "POST /repos/acme/web/pulls", status: 422, times: Infinity });
  await h.report((await h.only()).threadId!, GOOD);
  await h.settle();
  const failed = await h.only();
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.pushedSha, SHA2);
  assert.match(failed.error!, /validation failed[\s\S]*422/);
  h.clock.now += 60 * MIN; await h.settle();
  assert.equal((await h.only()).error, failed.error);
  assert.equal([...h.gh().issues.values()].filter((issue) => issue.pr).length, 0);
});

test("a dirty legacy waiting job migrates and resumes exactly once in its original environment", async () => {
  const id = "psi_00000000-0000-0000-0000-000000000041";
  const legacyReport = JSON.stringify({ outcome: "needs-info", questions: ["Which API?"], verification: ["Read the existing interface"], summary: "Interface contract unavailable", headSha: SHA1, acceptedAt: 1 });
  const h = harness({ beforeAutonomyUpgrade(db, now) {
    db.prepare(`INSERT INTO issue_jobs (id,repo,issue,generation,trigger_event_id,triggered_by,triggered_at,issue_json,project_id,host_id,base_branch,branch,state,thread_id,report_json,worker_json,created_at,updated_at)
      VALUES (?, 'acme/web',41,1,NULL,'the bb app',?,?,'prj_web','host_worker','main','agent/issue-41-old','needs-info','thr_legacy',?,?,?,?)`)
      .run(id, now - MIN, JSON.stringify({ title: "Preserve legacy work", body: "Finish the interface", url: "https://github.com/acme/web/issues/41", author: "maya" }), legacyReport, JSON.stringify({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "full" }), now - MIN, now - MIN);
  } });
  h.threads.set("thr_legacy", { id: "thr_legacy", status: "idle", archivedAt: null, deletedAt: null, createdAt: h.clock.now - MIN, updatedAt: h.clock.now - MIN, projectId: "prj_web", originPluginId: "pstack", environmentId: "env_legacy", metadata: { pstackIssue: 1, jobId: id } });
  h.worktrees.set("env_legacy", { headSha: SHA2, dirty: true, ahead: 1 });
  h.label(41); await h.settle();
  const resumed = await h.only();
  assert.equal(resumed.state, "working");
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0]!.environment, { type: "reuse", environmentId: "env_legacy" });
  assert.equal(h.worktrees.get("env_legacy")!.dirty, true);
  assert.equal((h.db.prepare("SELECT report_json FROM issue_jobs WHERE id = ?").get(id) as { report_json: string }).report_json, legacyReport);
  assert.equal((h.db.prepare("SELECT report_json FROM issue_legacy_archive WHERE id = ?").get(id) as { report_json: string }).report_json, legacyReport);
  h.restart(); await h.settle();
  assert.equal(h.spawned.length, 1);
  assert.ok(!h.gh().comments.get(41)!.some((comment) => comment.body.includes("Which API?")));
});

test("migrated no-change and merged children satisfy parent prerequisites without inventing unknown outcomes", async () => {
  const parent = "psi_00000000-0000-0000-0000-000000000050";
  const unchanged = "psi_00000000-0000-0000-0000-000000000051";
  const merged = "psi_00000000-0000-0000-0000-000000000052";
  const unknown = "psi_00000000-0000-0000-0000-000000000099";
  const h = harness({ beforeAutonomyUpgrade(db, now) {
    const insert = db.prepare(`INSERT INTO issue_jobs (id,repo,issue,generation,trigger_event_id,triggered_by,triggered_at,issue_json,project_id,host_id,base_branch,branch,state,parent_id,report_json,pushed_sha,created_at,updated_at)
      VALUES (?,'acme/web',?,1,NULL,'the bb app',?,?,'prj_web','host_worker','main',?,?,?,?,?,?,?)`);
    const snapshot = JSON.stringify({ title: "Historical implementation", body: "Integrate the result", url: "https://github.com/acme/web/issues/50", author: "maya" });
    const noChange = JSON.stringify({ outcome: "no-change", summary: "The interface already meets the requirement.", verification: ["Verified the existing behavior"], headSha: SHA1, acceptedAt: now - MIN });
    insert.run(parent, 50, now - MIN, snapshot, "agent/issue-50-parent", "tracking", null, null, null, now - MIN, now - MIN);
    insert.run(unchanged, 51, now - MIN, snapshot, "agent/issue-51-unchanged", "done", parent, noChange, null, now - MIN, now - MIN);
    insert.run(merged, 52, now - MIN, snapshot, "agent/issue-52-merged", "done", parent, noChange, SHA2, now - MIN, now - MIN);
    insert.run(unknown, 99, now - MIN, snapshot, "agent/issue-99-unknown", "done", null, null, null, now - MIN, now - MIN);
    db.prepare("INSERT INTO issue_job_polls (job_id,pr_state) VALUES (?, 'merged')").run(merged);
    db.prepare("UPDATE issue_jobs SET pr_number = 70, pr_url = 'https://github.com/acme/web/pull/70' WHERE id = ?").run(merged);
  } });
  for (const issue of [50, 51, 52]) h.gh().issues.set(issue, { number: issue, title: `Historical part ${issue}`, body: "Verify integration", user: "maya", updatedAt: h.clock.now, labels: new Set(), ...(issue === 50 ? { subIssues: [51, 52] } : {}) });
  h.gh().issues.set(70, { number: 70, title: "Historical implementation", body: "Verified result", user: "pstack-test[bot]", updatedAt: h.clock.now, labels: new Set(), pr: { head: "agent/issue-52-merged", base: "main", title: "Historical implementation", body: "Verified result", draft: false } });
  h.gh().refs.set("agent/issue-52-merged", SHA3);
  h.gh().pulls.set(70, { state: "closed", merged: true, requested: new Set() });
  h.label(50); await h.settle();
  assert.equal((await h.byIssue(51)).outcome, "no-change");
  assert.equal((await h.byIssue(52)).outcome, "merged");
  assert.equal((await h.byIssue(99)).outcome, null);
  assert.equal(h.store.get((await h.byIssue(52)).id)!.control.mergedHead, SHA3);
  assert.equal(h.store.get((await h.byIssue(50)).id)!.control.prerequisites[0]!.sha, SHA3);
  assert.equal((await h.byIssue(50)).state, "working");
  assert.equal(h.spawned.length, 1);
});

test("recovery leaves unowned archived same-environment threads untouched and refuses their active work", async () => {
  for (const activity of ["none", "queued", "background", "command", "goal", "workflow"]) {
    const h = harness();
    h.label(41); await h.settle();
    const original = (await h.only()).threadId!;
    const thread = h.threads.get(original)!;
    const archived = { ...thread, id: "thr_unowned_archived", status: "idle" as const, archivedAt: h.clock.now, metadata: {}, queuedMessageCount: activity === "queued" ? 1 : 0, activeBackgroundAgentCount: activity === "background" ? 1 : 0, activeBackgroundCommandCount: activity === "command" ? 1 : 0, activeGoalCount: activity === "goal" ? 1 : 0, activeWorkflowCount: activity === "workflow" ? 1 : 0 };
    h.threads.set(archived.id, archived);
    for (let i = 0; i < 3; i++) await h.report(original, { outcome: `invalid-${i}` });
    await h.settle();
    assert.ok(h.stopped.includes(original));
    assert.ok(!h.stopped.includes(archived.id), "an unowned thread is never stopped");
    if (activity !== "none") {
      assert.equal(h.spawned.length, 1);
      assert.equal((await h.only()).outcome, "failure");
      assert.match((await h.only()).error!, activity === "queued" || activity === "background" ? /exclusive stop is not confirmed for env_\S+; work retained/ : /exclusive stop is not confirmed .*background commands, goals or workflows remain/);
    } else {
      assert.equal(h.spawned.length, 2);
      assert.equal(h.spawned[1]!.environment.environmentId, thread.environmentId);
    }
  }
});
