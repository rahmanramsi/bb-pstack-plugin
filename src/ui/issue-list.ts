import { TERMINAL } from "../issues/job.ts";
import type { IssueBoard, IssueJob } from "./layout.ts";

export type CatalogIssue = NonNullable<IssueBoard["issues"]>[number];
export type IssueEntry = { issue: CatalogIssue; job: IssueJob | null };
export type IssueFilter = { repo: string; state: string; query: string; worker: string };

/** BB encodes the route segments when navigating to a plugin panel. */
export function issuePath(issue: Pick<CatalogIssue, "repo" | "issue">): string {
  return `issue/${issue.repo}/${issue.issue}`;
}

/** One row per issue, with its current worker or newest ended job. */
export function issueEntries(board: IssueBoard): IssueEntry[] {
  const entries = new Map<string, IssueEntry>();
  for (const issue of board.issues ?? []) entries.set(`${issue.repo}#${issue.issue}`, { issue, job: null });
  for (const job of board.jobs) {
    const key = `${job.repo}#${job.issue}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { issue: { repo: job.repo, issue: job.issue, title: job.title, issueUrl: job.issueUrl, state: "open", labels: [], updatedAt: job.updatedAt, body: "", author: "", assignees: [], startError: "The issue is missing from the GitHub catalog. Refresh before starting another worker." }, job: null };
      entries.set(key, entry);
    }
    if (!entry.job || (TERMINAL.has(entry.job.state) && !TERMINAL.has(job.state)) || (TERMINAL.has(entry.job.state) === TERMINAL.has(job.state) && job.createdAt > entry.job.createdAt)) entry.job = job;
  }
  return [...entries.values()].sort((a, b) => b.issue.updatedAt - a.issue.updatedAt || a.issue.repo.localeCompare(b.issue.repo) || b.issue.issue - a.issue.issue);
}

export function matchesIssue({ issue, job }: IssueEntry, filter: IssueFilter): boolean {
  if (filter.repo && issue.repo !== filter.repo) return false;
  if (filter.state !== "all" && issue.state !== filter.state) return false;
  const active = job !== null && !TERMINAL.has(job.state);
  if (filter.worker === "active" && !active) return false;
  if (filter.worker === "ready" && (active || issue.state !== "open" || issue.startError)) return false;
  if (filter.worker === "attention" && !(job?.error || job?.poll.error || issue.startError || job?.delivery.error)) return false;
  const text = `${issue.title} #${issue.issue} ${issue.repo} ${issue.labels.join(" ")} ${issue.assignees.join(" ")}`.toLowerCase();
  return filter.query.toLowerCase().trim().split(/\s+/).every((term) => text.includes(term));
}
