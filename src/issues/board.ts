/**
 * The issue board: each repository's last poll and its issue jobs. `bb pstack issues list|show` and the app read it.
 */
import { toView, type Job, type JobView, type RepoName } from "./job.ts";
import type { IssueStore } from "./store.ts";

/** A repository's last poll. `error` is why it failed, including setup problems such as an App that is not installed. */
export type RepoView = { repo: RepoName; polledAt: number | null; error: string | null };
/** A job with its last poll of its issue and pull request, which fails on its own when GitHub cannot read them. */
export type ListedJob = JobView & { poll: { polledAt: number | null; error: string | null } };
export type IssueBoard = { repos: RepoView[]; jobs: ListedJob[] };

/** Every repository, or one, with its jobs newest first; or the job a worker thread is bound to. */
export type BoardFilter = { repo?: RepoName; all: boolean } | { threadId: string };

export function repoView(store: IssueStore, repo: RepoName): RepoView {
  const { polledAt, error } = store.repoPoll(repo);
  return { repo, polledAt, error };
}

export function listed(store: IssueStore, job: Job): ListedJob {
  const { polledAt, error } = store.jobPoll(job.id);
  return { ...toView(job), poll: { polledAt, error } };
}

/** `configured` repositories are listed even before they have jobs. A thread that is not a worker gets an empty board. */
export function issueBoard(store: IssueStore, configured: readonly RepoName[], filter: BoardFilter): IssueBoard {
  if ("threadId" in filter) {
    const job = store.byThread(filter.threadId);
    return job ? { repos: [repoView(store, job.repo)], jobs: [listed(store, job)] } : { repos: [], jobs: [] };
  }
  const jobs = store.list(filter).map((job) => listed(store, job));
  const names = [...new Set([...configured, ...jobs.map((job) => job.repo)])].filter((repo) => !filter.repo || repo === filter.repo);
  return { repos: names.map((repo) => repoView(store, repo)), jobs };
}
