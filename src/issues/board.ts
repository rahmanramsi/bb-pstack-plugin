/**
 * The issue board: each repository's last poll and its issue jobs. `bb pstack issues list|show` and the app read it.
 */
import { z } from "zod";
import { EFFECT_POLICY, JOB_ID, RESTING_STATES, TRANSIT, toView, type EffectOp, type Job, type JobState, type JobView, type RepoName } from "./job.ts";
import type { IssueStore } from "./store.ts";

/** A repository's last poll. `error` is why it failed, including setup problems such as an App that is not installed. */
export type RepoView = { repo: RepoName; polledAt: number | null; error: string | null };
/** A job with its last poll of its issue and pull request, which fails on its own when GitHub cannot read them. */
export type ListedJob = JobView & { delivery: { pending: boolean; error: string | null }; poll: { polledAt: number | null; error: string | null } };
export type IssueBoard = { repos: RepoView[]; jobs: ListedJob[] };

const JOB_STATES = [...RESTING_STATES, ...Object.keys(TRANSIT)] as [JobState, ...JobState[]];
const EFFECT_OPS = Object.keys(EFFECT_POLICY) as [EffectOp, ...EffectOp[]];
const Poll = { polledAt: z.number().nullable(), error: z.string().nullable() };
export const IssueSummarySchema = z.object({ repo: z.string(), issue: z.number().int().positive(), title: z.string(), issueUrl: z.string(), state: z.enum(["open", "closed"]), labels: z.array(z.string()), updatedAt: z.number(), body: z.string().default(""), author: z.string().default(""), assignees: z.array(z.string()).default([]) });

export const IssueBoardSchema = z.object({
  issues: z.array(IssueSummarySchema.extend({ startError: z.string().nullable() })).optional(),
  repos: z.array(z.object({ repo: z.string(), ...Poll })),
  jobs: z.array(
    z.object({
      id: z.string().regex(JOB_ID),
      repo: z.string(),
      issue: z.number().int(),
      title: z.string(),
      issueUrl: z.string(),
      state: z.enum(JOB_STATES),
      next: z.object({ state: z.enum(RESTING_STATES), op: z.enum(EFFECT_OPS), tries: z.number().int(), retryAt: z.number().nullable() }).nullable(),
      triggeredBy: z.string(),
      branch: z.string(),
      host: z.object({ id: z.string().nullable(), pinned: z.boolean() }),
      parentId: z.string().regex(JOB_ID).nullable(),
      threadId: z.string().nullable(),
      pr: z.object({ number: z.number().int(), url: z.string() }).nullable(),
      pushedSha: z.string().nullable(),
      round: z.number().int(),
      summary: z.string().nullable(),
      outcome: z.enum(["ready", "no-change", "failure", "cancelled", "merged", "closed-unmerged"]).nullable(),
      limitation: z.string().nullable(),
      delivery: z.object({ pending: z.boolean(), error: z.string().nullable() }),
      error: z.string().nullable(),
      createdAt: z.number(),
      updatedAt: z.number(),
      poll: z.object(Poll),
    }),
  ),
});

export type BoardFilter = { repo?: RepoName; all: boolean } | { threadId: string };

export function repoView(store: IssueStore, repo: RepoName): RepoView {
  const { polledAt, error } = store.repoPoll(repo);
  return { repo, polledAt, error };
}

export function listed(store: IssueStore, job: Job): ListedJob {
  const { polledAt, error } = store.jobPoll(job.id);
  return { ...toView(job), delivery: store.delivery(job.repo, job.issue), poll: { polledAt, error } };
}

export function issueBoard(store: IssueStore, configured: readonly RepoName[], filter: BoardFilter): IssueBoard {
  if ("threadId" in filter) {
    const job = store.byThread(filter.threadId);
    return job ? { repos: [repoView(store, job.repo)], jobs: [listed(store, job)] } : { repos: [], jobs: [] };
  }
  const rows = filter.all ? store.list(filter) : [...store.list(filter), ...store.latestStuck(filter)].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const jobs = rows.map((job) => listed(store, job));
  const names = [...new Set([...configured, ...jobs.map((job) => job.repo)])].filter((repo) => !filter.repo || repo === filter.repo);
  return { repos: names.map((repo) => repoView(store, repo)), jobs };
}
