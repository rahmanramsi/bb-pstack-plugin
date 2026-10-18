import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, GOOD, MIN, SHA1, SHA2, SHA3, REPO } from "./engine-harness.ts";

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
  await h.settle();
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
  await h.settle();
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
  h.clock.now += 2 * MIN; await h.settle();
  assert.equal(h.gh().comments.get(41)!.length, 1);
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
    await h.settle();
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
  await h.settle();
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
  h.clock.now += MIN; await h.settle();
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
  await h.settle();
  const repairing = await h.only();
  assert.equal(repairing.state, "addressing");
  assert.notEqual(repairing.threadId, job.threadId);
  assert.equal(h.spawned[1]!.environment.type, "reuse");
  assert.equal(h.store.get(job.id)!.control.repair?.cause.includes("conflicting"), true);
});

test("a missing fresh base object asks the authorized worker to fetch and resumes the saved report", async () => {
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
  assert.equal((await h.only()).outcome, "ready");
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
    await h.settle();
    if (status === 403) {
      assert.equal((await h.only()).outcome, "failure");
      assert.equal((await h.only()).pushedSha, job.pushedSha);
      assert.match(h.gh().comments.get(41)![0]!.body, /Failed/);
    } else {
      assert.equal((await h.only()).state, "review");
      h.gh().outages.length = 0;
      await h.settle();
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
    h.restart(); h.clock.now += MIN + 1;
    await h.settle();
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
  } });
  for (const issue of [50, 51, 52]) h.gh().issues.set(issue, { number: issue, title: `Historical part ${issue}`, body: "Verify integration", user: "maya", updatedAt: h.clock.now, labels: new Set(), ...(issue === 50 ? { subIssues: [51, 52] } : {}) });
  h.label(50); await h.settle();
  assert.equal((await h.byIssue(51)).outcome, "no-change");
  assert.equal((await h.byIssue(52)).outcome, "merged");
  assert.equal((await h.byIssue(99)).outcome, null);
  assert.equal((await h.byIssue(50)).state, "working");
  assert.equal(h.spawned.length, 1);
});

test("recovery stops archived same-environment writers and refuses queued or background survivors", async () => {
  for (const activity of ["none", "queued", "background", "command", "goal", "workflow"]) {
    const h = harness();
    h.label(41); await h.settle();
    const original = (await h.only()).threadId!;
    const thread = h.threads.get(original)!;
    const archived = { ...thread, id: "thr_archived_writer", archivedAt: h.clock.now, metadata: {}, queuedMessageCount: activity === "queued" ? 1 : 0, activeBackgroundAgentCount: activity === "background" ? 1 : 0, activeBackgroundCommandCount: activity === "command" ? 1 : 0, activeGoalCount: activity === "goal" ? 1 : 0, activeWorkflowCount: activity === "workflow" ? 1 : 0 };
    h.threads.set(archived.id, archived);
    for (let i = 0; i < 3; i++) await h.report(original, { outcome: `invalid-${i}` });
    await h.settle();
    assert.ok(h.stopped.includes(archived.id));
    if (activity !== "none") {
      assert.equal(h.spawned.length, 1);
      assert.equal((await h.only()).outcome, "failure");
      assert.match((await h.only()).error!, /exclusive.*(?:queued or background work remains|background commands, goals or workflows remain)/);
    } else {
      assert.equal(h.spawned.length, 2);
      assert.equal(h.spawned[1]!.environment.environmentId, thread.environmentId);
    }
  }
});
