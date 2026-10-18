/**
 * SQL for issue_repos, issue_jobs, issue_rounds, issue_feedback and issue_job_polls. Rows are parsed into job.ts types here, and a row
 * that breaks an invariant the types encode throws: that is a bug, not input. Every job write is one UPDATE guarded by
 * the row's version, in one transaction with the round history and feedback rows it implies.
 */
import type { Db } from "../store.ts";
import {
  TERMINAL,
  TRANSIT,
  WATCHED,
  branchFor,
  isTransit,
  type AcceptedReport,
  type Change,
  type Effect,
  type Feedback,
  type FeedbackKind,
  type FeedbackRef,
  type IssueSnapshot,
  type Job,
  type JobId,
  type JobState,
  type Phase,
  type PullState,
  type RepoName,
  type RoundSummary,
  type SubIssue,
  type Sha,
  type BranchName,
  type WorkerSettings,
} from "./job.ts";

export type NewJob = {
  id: JobId;
  repo: RepoName;
  issue: number;
  trigger: { eventId: number | null; actor: string; at: number };
  snapshot: IssueSnapshot;
  /** Set for a sub-issue's job, whose trigger has no event. */
  parentId?: JobId;
  /** Set for a retry, whose trigger has no event. A job is retried at most once. */
  retryOf?: JobId;
  projectId: string;
  hostId: string;
  baseBranch: string;
  /** `ignored` carries its reason in `error`. */
  /** `tracking` for an issue with sub-issues. */
  state: "queued" | "ignored" | "tracking";
  error: string | null;
};

/** A job's last poll of its pull request: the cursor github.ts hands back, the state it read, and why it last failed. */
export type JobPoll = { cursor: unknown; prState: PullState | null; polledAt: number | null; error: string | null };

export type IssueReads = {
  get(id: JobId): Job | null;
  byThread(threadId: string): Job | null;
  byTrigger(eventId: number): Job | null;
  open(repo: RepoName, issue: number): Job | null;
  /** The issue's newest job that was not ignored, in any state. */
  latest(repo: RepoName, issue: number): Job | null;
  /** Jobs that may act at `now`, oldest first: WATCHED ones, and transit ones whose lease and backoff have passed. */
  due(now: number): JobId[];
  /**
   * Newest first. Without `all`: open jobs, and a stuck job while it is the newest job on its issue that was not
   * ignored, since it waits for a person. With `all`, every job.
   */
  list(filter: { repo?: RepoName; all: boolean }): Job[];
  /** The repository's open jobs, which the poll reads feedback and commands for. */
  openJobs(repo: RepoName): Job[];
  /** Whether the item is stored already, sent or not. */
  hasFeedback(repo: RepoName, ref: FeedbackRef): boolean;
  /** The job's feedback not yet sent in a round, oldest first. */
  pendingFeedback(id: JobId): Feedback[];
  /** Each of the job's rounds so far with its accepted report's summary. */
  roundSummaries(id: JobId): RoundSummary[];
  /** The feedback a round sent, which its report must answer. */
  roundFeedback(id: JobId, ordinal: number): Feedback[];
  repoPoll(repo: RepoName): { poll: unknown; polledAt: number | null; error: string | null };
  jobPoll(id: JobId): JobPoll;
};

/** A write that returns null or 0 changed nothing; any other result means it did. */
export type IssueWrites = {
  /**
   * Inserts the job for a label event, a sub-issue or a retry. Its generation is 1 + the issue's earlier jobs that were
   * not ignored, and its branch follows from it. Null when the event or the retried job is already recorded, or an
   * open job holds the issue.
   */
  insert(job: NewJob, now: number): Job | null;
  /**
   * The one write. Returns the new row, or null when the version moved (re-read and replan), or when a round start
   * does not list every pending item. In the same
   * transaction, a round start inserts the round's row and marks its feedback as sent, and the current round's row
   * records the accepted report, the pushed commit, and, once, when the change says the round finished.
   */
  write(id: JobId, version: number, change: Change, now: number): Job | null;
  /** Stores feedback not seen before; an item already stored, sent or not, is left as it is. Returns how many were new. */
  addFeedback(repo: RepoName, items: readonly { jobId: JobId; pr: number; feedback: Feedback }[]): number;
  saveRepoPoll(repo: RepoName, poll: unknown, now: number, error: string | null): void;
  /** A successful poll of the job: its pull request's new feedback and state, and the next cursor, in one transaction. */
  recordPoll(id: JobId, poll: { cursor: unknown; prState: PullState | null; feedback: readonly Feedback[] }, now: number): void;
  /** A failed poll keeps the last cursor and state, so the next poll starts where the last good one ended. */
  recordPollError(id: JobId, error: string, now: number): void;
  /** Every job a parent created, open or ended. */
  children(parentId: JobId): Job[];
  /** A parent's last poll of its sub-issues, null before the first. */
  polledChildren(parentId: JobId): SubIssue[] | null;
  saveChildren(parentId: JobId, children: readonly SubIssue[], now: number): void;
};

export type IssueStore = IssueReads & IssueWrites;

type JobRow = {
  id: string;
  version: number;
  repo: string;
  issue: number;
  generation: number;
  trigger_event_id: number | null;
  triggered_by: string;
  triggered_at: number;
  issue_json: string;
  project_id: string;
  host_id: string;
  base_branch: string;
  branch: string;
  state: JobState;
  effects_json: string | null;
  effect_tries: number;
  effect_first_at: number | null;
  effect_lease_until: number | null;
  effect_next_at: number | null;
  thread_id: string | null;
  deadline: number | null;
  rejections: number;
  nudges: number;
  report_json: string | null;
  pushed_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  round: number;
  worker_json: string | null;
  round_base: string | null;
  parent_id: string | null;
  progress: string | null;
  retry_of: string | null;
};

type FeedbackRow = {
  kind: FeedbackKind;
  github_id: number;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  diff_hunk: string | null;
  in_reply_to: number | null;
  parent_author: string | null;
  parent_body: string | null;
  review_id: number | null;
  created_at: number;
  posted_at: number | null;
};

const parseFeedback = (row: FeedbackRow): Feedback => ({
  kind: row.kind,
  id: row.github_id,
  author: row.author,
  body: row.body,
  path: row.path,
  line: row.line,
  diffHunk: row.diff_hunk,
  inReplyTo: row.in_reply_to,
  parent: row.parent_author === null || row.parent_body === null ? null : { author: row.parent_author, body: row.parent_body },
  reviewId: row.review_id,
  createdAt: row.created_at,
  postedAt: row.posted_at ?? row.created_at,
});

function parsePhase(row: JobRow): Phase {
  if (!isTransit(row.state)) return { state: row.state };
  const effects = JSON.parse(row.effects_json ?? "[]") as Effect[];
  const [head, ...rest] = effects;
  if (!head) throw new Error(`issue job ${row.id} is in ${row.state} with no effects`);
  return {
    state: row.state,
    effects: [head, ...rest],
    tries: row.effect_tries,
    firstAt: row.effect_first_at,
    leaseUntil: row.effect_lease_until,
    nextAt: row.effect_next_at,
  };
}

function parse(row: JobRow): Job {
  return {
    id: row.id as JobId,
    version: row.version,
    repo: row.repo as RepoName,
    issue: row.issue,
    generation: row.generation,
    trigger: { eventId: row.trigger_event_id, actor: row.triggered_by, at: row.triggered_at },
    snapshot: JSON.parse(row.issue_json) as IssueSnapshot,
    parentId: row.parent_id as JobId | null,
    retryOf: row.retry_of as JobId | null,
    progress: row.progress,
    projectId: row.project_id,
    hostId: row.host_id,
    baseBranch: row.base_branch,
    branch: row.branch as BranchName,
    phase: parsePhase(row),
    threadId: row.thread_id,
    deadline: row.deadline,
    rejections: row.rejections,
    nudges: row.nudges,
    report: row.report_json === null ? null : (JSON.parse(row.report_json) as AcceptedReport),
    pushedSha: row.pushed_sha as Sha | null,
    pr: row.pr_number === null ? null : { number: row.pr_number, url: row.pr_url ?? "" },
    error: row.error,
    round: row.round,
    roundBase: row.round_base as Sha | null,
    worker: row.worker_json === null ? null : (JSON.parse(row.worker_json) as WorkerSettings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function columns(change: Change): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (change.phase) {
    const phase = change.phase;
    const transit = "effects" in phase;
    set.state = phase.state;
    set.effects_json = transit ? JSON.stringify(phase.effects) : null;
    set.effect_tries = transit ? phase.tries : 0;
    set.effect_first_at = transit ? phase.firstAt : null;
    set.effect_lease_until = transit ? phase.leaseUntil : null;
    set.effect_next_at = transit ? phase.nextAt : null;
  }
  if (change.threadId !== undefined) set.thread_id = change.threadId;
  if (change.deadline !== undefined) set.deadline = change.deadline;
  if (change.rejections !== undefined) set.rejections = change.rejections;
  if (change.nudges !== undefined) set.nudges = change.nudges;
  if (change.report !== undefined) set.report_json = JSON.stringify(change.report);
  if (change.pushedSha !== undefined) set.pushed_sha = change.pushedSha;
  if (change.pr !== undefined) {
    set.pr_number = change.pr.number;
    set.pr_url = change.pr.url;
  }
  if (change.error !== undefined) set.error = change.error;
  if (change.startRound !== undefined) set.round = change.startRound.ordinal;
  if (change.worker !== undefined) set.worker_json = JSON.stringify(change.worker);
  if (change.roundBase !== undefined) set.round_base = change.roundBase;
  if (change.progress !== undefined) set.progress = change.progress;
  return set;
}

const TERMINAL_LIST = [...TERMINAL];
const TRANSIT_LIST = Object.keys(TRANSIT);
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

export function openIssueStore(db: Db, onChange: () => void): IssueStore {
  const get = (id: JobId): Job | null => {
    const row = db.prepare("SELECT * FROM issue_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? parse(row) : null;
  };
  const openRow = (repo: RepoName, issue: number) =>
    db
      .prepare(`SELECT * FROM issue_jobs WHERE repo = ? AND issue = ? AND state NOT IN (${placeholders(TERMINAL_LIST)})`)
      .get(repo, issue, ...TERMINAL_LIST) as JobRow | undefined;

  const insert = db.transaction((job: NewJob, now: number): Job | null => {
    if (db.prepare("SELECT 1 FROM issue_jobs WHERE trigger_event_id = ?").get(job.trigger.eventId)) return null;
    if (job.retryOf && db.prepare("SELECT 1 FROM issue_jobs WHERE retry_of = ?").get(job.retryOf)) return null;
    if (job.state !== "ignored" && openRow(job.repo, job.issue)) return null;
    if (job.parentId && !job.retryOf && db.prepare("SELECT 1 FROM issue_jobs WHERE parent_id = ? AND issue = ? AND retry_of IS NULL").get(job.parentId, job.issue)) return null;
    const { earlier } = db
      .prepare("SELECT count(*) AS earlier FROM issue_jobs WHERE repo = ? AND issue = ? AND state != 'ignored'")
      .get(job.repo, job.issue) as { earlier: number };
    const generation = earlier + 1;
    db.prepare(
      `INSERT INTO issue_jobs (id, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json,
         project_id, host_id, base_branch, branch, state, error, created_at, updated_at, parent_id, retry_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.repo,
      job.issue,
      generation,
      job.trigger.eventId,
      job.trigger.actor,
      job.trigger.at,
      JSON.stringify(job.snapshot),
      job.projectId,
      job.hostId,
      job.baseBranch,
      branchFor(job.issue, job.snapshot.title, generation),
      job.state,
      job.error,
      now,
      now,
      job.parentId ?? null,
      job.retryOf ?? null,
    );
    return get(job.id);
  });

  const addFeedback = db.transaction((repo: RepoName, items: readonly { jobId: JobId; pr: number; feedback: Feedback }[]): number => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO issue_feedback (repo, kind, github_id, job_id, pr_number, author, body, path, line, diff_hunk, in_reply_to, parent_author, parent_body, review_id, created_at, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const { jobId, pr, feedback: item } of items) {
      added += insert.run(repo, item.kind, item.id, jobId, pr, item.author, item.body, item.path, item.line, item.diffHunk, item.inReplyTo, item.parent?.author ?? null, item.parent?.body ?? null, item.reviewId, item.createdAt, item.postedAt).changes;
    }
    return added;
  });

  const reads: IssueReads = {
    get,
    byThread(threadId) {
      const row = db.prepare("SELECT * FROM issue_jobs WHERE thread_id = ?").get(threadId) as JobRow | undefined;
      return row ? parse(row) : null;
    },
    byTrigger(eventId) {
      const row = db.prepare("SELECT * FROM issue_jobs WHERE trigger_event_id = ?").get(eventId) as JobRow | undefined;
      return row ? parse(row) : null;
    },
    open(repo, issue) {
      const row = openRow(repo, issue);
      return row ? parse(row) : null;
    },
    latest(repo, issue) {
      const row = db
        .prepare("SELECT * FROM issue_jobs WHERE repo = ? AND issue = ? AND state != 'ignored' ORDER BY generation DESC LIMIT 1")
        .get(repo, issue) as JobRow | undefined;
      return row ? parse(row) : null;
    },
    due(now) {
      const rows = db
        .prepare(
          `SELECT id FROM issue_jobs WHERE state IN (${placeholders(WATCHED)})
             OR (state IN (${placeholders(TRANSIT_LIST)}) AND coalesce(effect_lease_until, 0) <= ? AND coalesce(effect_next_at, 0) <= ?)
           ORDER BY created_at, id`,
        )
        .all(...WATCHED, ...TRANSIT_LIST, now, now) as { id: JobId }[];
      return rows.map((row) => row.id);
    },
    list({ repo, all }) {
      // Generations count the issue's jobs that were not ignored, so the highest one is the newest of them.
      const where = [
        ...(repo ? ["repo = ?"] : []),
        ...(all
          ? []
          : [
              `(state NOT IN (${placeholders(TERMINAL_LIST)}) OR (state = 'stuck' AND NOT EXISTS (
                 SELECT 1 FROM issue_jobs later WHERE later.repo = issue_jobs.repo AND later.issue = issue_jobs.issue AND later.state != 'ignored' AND later.generation > issue_jobs.generation)))`,
            ]),
      ];
      const rows = db
        .prepare(`SELECT * FROM issue_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`)
        .all(...(repo ? [repo] : []), ...(all ? [] : TERMINAL_LIST)) as JobRow[];
      return rows.map(parse);
    },
    openJobs(repo) {
      const rows = db
        .prepare(`SELECT * FROM issue_jobs WHERE repo = ? AND state NOT IN (${placeholders(TERMINAL_LIST)}) ORDER BY created_at DESC, id DESC`)
        .all(repo, ...TERMINAL_LIST) as JobRow[];
      return rows.map(parse);
    },
    hasFeedback(repo, ref) {
      return db.prepare("SELECT 1 FROM issue_feedback WHERE repo = ? AND kind = ? AND github_id = ?").get(repo, ref.kind, ref.id) !== undefined;
    },
    pendingFeedback(id) {
      const rows = db.prepare("SELECT * FROM issue_feedback WHERE job_id = ? AND round IS NULL ORDER BY created_at, github_id").all(id) as FeedbackRow[];
      return rows.map(parseFeedback);
    },
    roundSummaries(id) {
      const rounds = db.prepare("SELECT ordinal, report_json FROM issue_rounds WHERE job_id = ? ORDER BY ordinal").all(id) as { ordinal: number; report_json: string | null }[];
      return rounds.map((round) => ({ ordinal: round.ordinal, summary: round.report_json === null ? null : ((JSON.parse(round.report_json) as AcceptedReport).summary ?? null) }));
    },
    roundFeedback(id, ordinal) {
      const rows = db.prepare("SELECT * FROM issue_feedback WHERE job_id = ? AND round = ? ORDER BY created_at, github_id").all(id, ordinal) as FeedbackRow[];
      return rows.map(parseFeedback);
    },
    repoPoll(repo) {
      const row = db.prepare("SELECT poll_json, polled_at, error FROM issue_repos WHERE repo = ?").get(repo) as
        | { poll_json: string | null; polled_at: number | null; error: string | null }
        | undefined;
      return { poll: row?.poll_json ? JSON.parse(row.poll_json) : null, polledAt: row?.polled_at ?? null, error: row?.error ?? null };
    },
    jobPoll(id) {
      const row = db.prepare("SELECT cursor_json, pr_state, polled_at, error FROM issue_job_polls WHERE job_id = ?").get(id) as
        | { cursor_json: string | null; pr_state: PullState | null; polled_at: number | null; error: string | null }
        | undefined;
      return { cursor: row?.cursor_json ? JSON.parse(row.cursor_json) : null, prState: row?.pr_state ?? null, polledAt: row?.polled_at ?? null, error: row?.error ?? null };
    },
  };
  const writes: IssueWrites = {
    insert,
    write: db.transaction((id: JobId, version: number, change: Change, now: number): Job | null => {
      // Feedback that arrived after plan() read the queue is newer than the quiet period it checked: refuse, so the
      // replan sees it and waits again, instead of leaving it for a round of its own.
      if (change.startRound?.kind === "feedback") {
        const { waiting } = db.prepare("SELECT count(*) AS waiting FROM issue_feedback WHERE job_id = ? AND round IS NULL").get(id) as { waiting: number };
        if (waiting !== change.startRound.feedback.length) return null;
      }
      const set = columns(change);
      const names = Object.keys(set);
      const assignments = [...names.map((name) => `${name} = ?`), "version = version + 1", "updated_at = ?"].join(", ");
      const changed = db.prepare(`UPDATE issue_jobs SET ${assignments} WHERE id = ? AND version = ?`).run(...Object.values(set), now, id, version).changes;
      if (changed !== 1) return null;
      const job = get(id)!;
      if (change.startRound) {
        const { ordinal, kind, baseSha, feedback } = change.startRound;
        db.prepare("INSERT INTO issue_rounds (job_id, ordinal, kind, started_at, base_sha) VALUES (?, ?, ?, ?, ?)").run(id, ordinal, kind, now, baseSha);
        const send = db.prepare("UPDATE issue_feedback SET round = ? WHERE job_id = ? AND kind = ? AND github_id = ? AND round IS NULL");
        for (const ref of feedback) {
          if (send.run(ordinal, id, ref.kind, ref.id).changes !== 1) throw new Error(`issue job ${id}: ${ref.kind} ${ref.id} is not pending feedback`);
        }
      }
      const history: Record<string, unknown> = {};
      if (change.report !== undefined) history.report_json = set.report_json;
      if (change.pushedSha !== undefined) history.pushed_sha = change.pushedSha;
      const fields = Object.keys(history);
      if (fields.length > 0) {
        db.prepare(`UPDATE issue_rounds SET ${fields.map((name) => `${name} = ?`).join(", ")} WHERE job_id = ? AND ordinal = ?`).run(...Object.values(history), id, job.round);
      }
      if (change.finishRound) db.prepare("UPDATE issue_rounds SET finished_at = ? WHERE job_id = ? AND ordinal = ? AND finished_at IS NULL").run(now, id, job.round);
      return job;
    }),
    addFeedback,
    saveRepoPoll(repo, poll, now, error) {
      db.prepare(
        `INSERT INTO issue_repos (repo, poll_json, polled_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET poll_json = excluded.poll_json, polled_at = excluded.polled_at, error = excluded.error`,
      ).run(repo, poll === null ? null : JSON.stringify(poll), now, error);
    },
    recordPoll: db.transaction((id: JobId, poll: { cursor: unknown; prState: PullState | null; feedback: readonly Feedback[] }, now: number) => {
      const job = get(id);
      if (!job) throw new Error(`no issue job ${id}`);
      if (poll.feedback.length > 0 && !job.pr) throw new Error(`issue job ${id} has feedback but no pull request`);
      addFeedback(job.repo, poll.feedback.map((feedback) => ({ jobId: id, pr: job.pr!.number, feedback })));
      db.prepare(
        `INSERT INTO issue_job_polls (job_id, cursor_json, pr_state, polled_at, error) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (job_id) DO UPDATE SET cursor_json = excluded.cursor_json, pr_state = coalesce(excluded.pr_state, pr_state), polled_at = excluded.polled_at, error = NULL`,
      ).run(id, JSON.stringify(poll.cursor), poll.prState, now);
    }),
    children(parentId) {
      return (db.prepare("SELECT * FROM issue_jobs WHERE parent_id = ? ORDER BY created_at, id").all(parentId) as JobRow[]).map(parse);
    },
    polledChildren(parentId) {
      const row = db.prepare("SELECT children_json FROM issue_job_polls WHERE job_id = ?").get(parentId) as { children_json: string | null } | undefined;
      return row?.children_json ? (JSON.parse(row.children_json) as SubIssue[]) : null;
    },
    saveChildren(parentId, children, now) {
      db.prepare(
        `INSERT INTO issue_job_polls (job_id, children_json, polled_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET children_json = excluded.children_json`,
      ).run(parentId, JSON.stringify(children), now);
    },
    recordPollError(id, error, now) {
      db.prepare(
        `INSERT INTO issue_job_polls (job_id, polled_at, error) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET polled_at = excluded.polled_at, error = excluded.error`,
      ).run(id, now, error);
    },
  };
  return { ...reads, ...notifying(writes, onChange) };
}

function notifying(writes: IssueWrites, onChange: () => void): IssueWrites {
  return Object.fromEntries(
    Object.entries(writes).map(([key, write]) => [
      key,
      (...args: unknown[]) => {
        const result = (write as (...args: unknown[]) => unknown)(...args);
        if (result !== null && result !== 0) onChange();
        return result;
      },
    ]),
  ) as IssueWrites;
}
