import assert from "node:assert/strict";
import { test } from "node:test";
import { issueEntries, issuePath, matchesIssue, type CatalogIssue } from "./issue-list.ts";
import { issueNotes, issueStatus, type IssueJob } from "./layout.ts";

const issue: CatalogIssue = { repo: "acme/web", issue: 41, title: "Fix mobile navigation", issueUrl: "https://github.com/acme/web/issues/41", state: "open", labels: ["bug"], updatedAt: 100, body: "Description", author: "maya", assignees: ["maya"], startError: null };
const job: IssueJob = { id: "psi_00000000-0000-0000-0000-000000000001", repo: issue.repo, issue: 41, title: issue.title, issueUrl: issue.issueUrl, state: "working", next: null, triggeredBy: "maya", branch: "agent/issue-41", parentId: null, threadId: "thr_worker", pr: null, pushedSha: null, round: 1, summary: null, outcome: null, limitation: null, delivery: { pending: false, error: null }, error: null, createdAt: 1, updatedAt: 100, poll: { polledAt: 100, error: null } };

test("issue details use separate owner and repository route segments", () => {
  assert.equal(issuePath(issue), "issue/acme/web/41");
});

test("a catalog issue has one row across worker generations and keeps the active worker", () => {
  const ended = { ...job, id: "psi_00000000-0000-0000-0000-000000000002", state: "stopped", createdAt: 2 } satisfies IssueJob;
  for (const jobs of [[ended, job], [job, ended]]) {
    const rows = issueEntries({ issues: [issue], repos: [], jobs });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.job?.id, job.id);
    assert.equal(rows[0]!.issue.body, "Description");
  }
});

test("an issue missing from the catalog retains its worker and cannot start again", () => {
  const [row] = issueEntries({ issues: [], repos: [], jobs: [job] });
  assert.equal(row!.job?.threadId, "thr_worker");
  assert.match(row!.issue.startError!, /missing/);
});

test("filters combine repository, issue state, worker state, and searchable labels and assignees", () => {
  const filter = { repo: "", state: "open", query: "mobile bug maya #41", worker: "all" };
  const entry = { issue, job: null };
  assert.equal(matchesIssue(entry, filter), true);
  assert.equal(matchesIssue(entry, { ...filter, repo: "acme/other" }), false);
  assert.equal(matchesIssue(entry, { ...filter, state: "closed" }), false);
  assert.equal(matchesIssue(entry, { ...filter, worker: "active" }), false);
  assert.equal(matchesIssue({ issue, job }, { ...filter, worker: "active" }), true);
  assert.equal(matchesIssue({ issue, job }, { ...filter, worker: "ready" }), false);
  assert.equal(matchesIssue({ issue, job: { ...job, error: "Worker unavailable" } }, { ...filter, worker: "attention" }), true);
});

test("a pull request ready for review is not reported as merged, and one closed without merging is not a success", () => {
  const ready = issueStatus({ ...job, state: "review", outcome: "ready" });
  const merged = issueStatus({ ...job, state: "done", outcome: "merged" });
  const closed = issueStatus({ ...job, state: "stuck", outcome: "closed-unmerged" });
  assert.notEqual(ready.label, merged.label);
  assert.notEqual(ready.tone, "succeeded");
  assert.equal(merged.tone, "succeeded");
  assert.equal(closed.tone, "failed");
  assert.equal(matchesIssue({ issue, job: { ...job, state: "stuck", outcome: "closed-unmerged" } }, { repo: "", state: "all", query: "", worker: "attention" }), true);
});

test("GitHub status delivery is reported beside the execution outcome and never replaces it", () => {
  const failed = { ...job, state: "stuck", outcome: "failure", error: "Tests fail on the base branch", delivery: { pending: true, error: "GitHub is unavailable" } } satisfies IssueJob;
  assert.equal(issueStatus(failed).tone, "failed");
  const notes = issueNotes(failed);
  assert.equal(notes[0]?.text, "Tests fail on the base branch");
  assert.ok(notes.some((note) => note.tone === "error" && note.text.includes("GitHub is unavailable")));

  const ready = { ...job, state: "review", outcome: "ready", delivery: { pending: true, error: null } } satisfies IssueJob;
  assert.equal(issueStatus(ready).label, issueStatus({ ...job, state: "review", outcome: "ready" }).label);
  assert.deepEqual(issueNotes(ready).map((note) => note.tone), ["muted"]);
  const filter = { repo: "", state: "all", query: "", worker: "attention" };
  assert.equal(matchesIssue({ issue, job: ready }, filter), false);
  assert.equal(matchesIssue({ issue, job: { ...ready, delivery: { pending: true, error: "rate limited" } } }, filter), true);
});

test("an unreadable branch policy is shown as a limitation of a ready result, not as passed checks", () => {
  const limitation = "Branch policy could not be inspected: rulesets are unavailable. Observed CI and local evidence passed; merge prerequisites are not established.";
  const ready = { ...job, state: "review", outcome: "ready", limitation } satisfies IssueJob;
  assert.equal(issueStatus(ready).label, issueStatus({ ...job, state: "review", outcome: "ready" }).label);
  assert.deepEqual(issueNotes(ready), [{ tone: "warning", text: limitation }]);
});

test("an upgraded job that ended without a recorded outcome is neutral, distinct from every known outcome", () => {
  const unknown = issueStatus({ ...job, state: "done", outcome: null });
  assert.equal(unknown.tone, "neutral");
  for (const outcome of ["merged", "no-change", "closed-unmerged"] as const) {
    const known = issueStatus({ ...job, state: "done", outcome });
    assert.notEqual(known.label, unknown.label);
    assert.notEqual(known.tone, unknown.tone);
  }
  assert.equal(matchesIssue({ issue, job: { ...job, state: "done", outcome: null } }, { repo: "", state: "all", query: "", worker: "attention" }), false);
});
