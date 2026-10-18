import assert from "node:assert/strict";
import { test } from "node:test";
import { issueEntries, issuePath, matchesIssue, type CatalogIssue } from "./issue-list.ts";
import type { IssueJob } from "./layout.ts";

const issue: CatalogIssue = { repo: "acme/web", issue: 41, title: "Fix mobile navigation", issueUrl: "https://github.com/acme/web/issues/41", state: "open", labels: ["bug"], updatedAt: 100, body: "Description", author: "maya", assignees: ["maya"], startError: null };
const job: IssueJob = { id: "psi_00000000-0000-0000-0000-000000000001", repo: issue.repo, issue: 41, title: issue.title, issueUrl: issue.issueUrl, state: "working", next: null, triggeredBy: "maya", branch: "agent/issue-41", host: { id: "host_worker", pinned: true }, parentId: null, threadId: "thr_worker", pr: null, pushedSha: null, round: 1, summary: null, error: null, createdAt: 1, updatedAt: 100, poll: { polledAt: 100, error: null } };

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
