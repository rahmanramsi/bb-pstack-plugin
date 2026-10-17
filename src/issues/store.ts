/**
 * SQL for issue_repos, issue_jobs, issue_rounds and issue_feedback. Rows are parsed into job.ts types here, and a row
 * that breaks an invariant the types encode throws: that is a bug, not input. Every job write is one UPDATE guarded by
 * the row's version, in one transaction with the round history and feedback rows it implies.
 */
import type { Db } from "../store.ts";
import {
  BUSY,
  CONCURRENCY,
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
  type IssueSnapshot,
  type Job,
  type JobId,
  type JobState,
  type Phase,
  type RepoName,
  type Sha,
  type BranchName,
  type WorkerSettings,
} from "./job.ts";

export type NewJob = {
  id: JobId;
  repo: RepoName;
  issue: number;
  trigger: { eventId: number; actor: string; at: number };
  snapshot: IssueSnapshot;
  projectId: string;
  hostId: string;
  baseBranch: string;
  /** `ignored` carries its reason in `error`. */
  state: "queued" | "ignored";
  error: string | null;
};

export type IssueStore = {
  /**
   * Inserts the job for a label event. Its generation is 1 + the issue's earlier jobs that were not ignored, and its
   * branch follows from it. Null when the event is already recorded or an open job holds the issue.
   */
  insert(job: NewJob, now: number): Job | null;
  get(id: JobId): Job | null;
  byThread(threadId: string): Job | null;
  byTrigger(eventId: number): Job | null;
  open(repo: RepoName, issue: number): Job | null;
  /** Jobs that may act at `now`, oldest first: WATCHED ones, and transit ones whose lease and backoff have passed. */
  due(now: number): JobId[];
  /** Newest first; terminal jobs only with `all`. */
  list(filter: { repo?: RepoName; all: boolean }): Job[];
  /**
   * Jobs holding a worker slot, and how many queued jobs created before this one could start. A queued job's error is
   * why its worker could not be resolved, so one with an error does not hold back the jobs behind it.
   */
  slots(id: JobId): { busy: number; ahead: number };
  /**
   * The one write. Returns the new row, or null when the version moved (re-read and replan) or when the change would
   * make the job BUSY while CONCURRENCY other jobs already are. Both checks are in the same statement. In the same
   * transaction, a round start inserts the round's row and marks its feedback as sent, and the current round's row
   * records the accepted report, the pushed commit, and, once, when the change says the round finished.
   */
  write(id: JobId, version: number, change: Change, now: number): Job | null;
  /** Open jobs in the repository that have a pull request, whose feedback the poller reads. */
  withPullRequest(repo: RepoName): Job[];
  /** Stores feedback not seen before; an item already stored, sent or not, is left as it is. Returns how many were new. */
  addFeedback(repo: RepoName, items: readonly { jobId: JobId; pr: number; feedback: Feedback }[]): number;
  /** The job's feedback not yet sent in a round, oldest first, and each earlier round's summary. */
  feedback(id: JobId): { pending: Feedback[]; rounds: { ordinal: number; summary: string | null }[] };
  /** The feedback a round sent, which its report must answer. */
  roundFeedback(id: JobId, ordinal: number): Feedback[];
  repoPoll(repo: RepoName): { poll: unknown; polledAt: number | null; error: string | null };
  saveRepoPoll(repo: RepoName, poll: unknown, now: number, error: string | null): void;
  feedbackCursor(repo: RepoName): unknown;
  saveFeedbackCursor(repo: RepoName, cursor: unknown): void;
};

type JobRow = {
  id: string;
  version: number;
  repo: string;
  issue: number;
  generation: number;
  trigger_event_id: number;
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
  review_id: number | null;
  created_at: number;
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
  reviewId: row.review_id,
  createdAt: row.created_at,
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
  return set;
}

const TERMINAL_LIST = [...TERMINAL];
const BUSY_LIST = [...BUSY];
const TRANSIT_LIST = Object.keys(TRANSIT);
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

export function openIssueStore(db: Db): IssueStore {
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
    if (job.state === "queued" && openRow(job.repo, job.issue)) return null;
    const { earlier } = db
      .prepare("SELECT count(*) AS earlier FROM issue_jobs WHERE repo = ? AND issue = ? AND state != 'ignored'")
      .get(job.repo, job.issue) as { earlier: number };
    const generation = earlier + 1;
    db.prepare(
      `INSERT INTO issue_jobs (id, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json,
         project_id, host_id, base_branch, branch, state, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    return get(job.id);
  });

  return {
    insert,
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
      const where = [
        ...(repo ? ["repo = ?"] : []),
        ...(all ? [] : [`state NOT IN (${placeholders(TERMINAL_LIST)})`]),
      ];
      const rows = db
        .prepare(`SELECT * FROM issue_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`)
        .all(...(repo ? [repo] : []), ...(all ? [] : TERMINAL_LIST)) as JobRow[];
      return rows.map(parse);
    },
    slots(id) {
      const { busy } = db
        .prepare(`SELECT count(*) AS busy FROM issue_jobs WHERE state IN (${placeholders(BUSY_LIST)})`)
        .get(...BUSY_LIST) as { busy: number };
      const { ahead } = db
        .prepare(
          `SELECT count(*) AS ahead FROM issue_jobs q, issue_jobs me WHERE me.id = ? AND q.state = 'queued' AND q.error IS NULL
             AND (q.created_at < me.created_at OR (q.created_at = me.created_at AND q.id < me.id))`,
        )
        .get(id) as { ahead: number };
      return { busy, ahead };
    },
    write: db.transaction((id: JobId, version: number, change: Change, now: number): Job | null => {
      const set = columns(change);
      const names = Object.keys(set);
      const slotGuard =
        change.phase && BUSY.has(change.phase.state)
          ? ` AND (state IN (${placeholders(BUSY_LIST)}) OR (SELECT count(*) FROM issue_jobs WHERE state IN (${placeholders(BUSY_LIST)})) < ?)`
          : "";
      const params = [
        ...Object.values(set),
        now,
        id,
        version,
        ...(slotGuard ? [...BUSY_LIST, ...BUSY_LIST, CONCURRENCY] : []),
      ];
      const assignments = [...names.map((name) => `${name} = ?`), "version = version + 1", "updated_at = ?"].join(", ");
      const changed = db.prepare(`UPDATE issue_jobs SET ${assignments} WHERE id = ? AND version = ?${slotGuard}`).run(...params).changes;
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
    withPullRequest(repo) {
      const rows = db
        .prepare(`SELECT * FROM issue_jobs WHERE repo = ? AND pr_number IS NOT NULL AND state NOT IN (${placeholders(TERMINAL_LIST)}) ORDER BY created_at, id`)
        .all(repo, ...TERMINAL_LIST) as JobRow[];
      return rows.map(parse);
    },
    addFeedback: db.transaction((repo: RepoName, items: readonly { jobId: JobId; pr: number; feedback: Feedback }[]): number => {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO issue_feedback (repo, kind, github_id, job_id, pr_number, author, body, path, line, diff_hunk, in_reply_to, review_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let added = 0;
      for (const { jobId, pr, feedback: item } of items) {
        added += insert.run(repo, item.kind, item.id, jobId, pr, item.author, item.body, item.path, item.line, item.diffHunk, item.inReplyTo, item.reviewId, item.createdAt).changes;
      }
      return added;
    }),
    feedback(id) {
      const pending = db.prepare("SELECT * FROM issue_feedback WHERE job_id = ? AND round IS NULL ORDER BY created_at, github_id").all(id) as FeedbackRow[];
      const rounds = db.prepare("SELECT ordinal, report_json FROM issue_rounds WHERE job_id = ? ORDER BY ordinal").all(id) as { ordinal: number; report_json: string | null }[];
      return {
        pending: pending.map(parseFeedback),
        rounds: rounds.map((round) => ({ ordinal: round.ordinal, summary: round.report_json === null ? null : ((JSON.parse(round.report_json) as AcceptedReport).summary ?? null) })),
      };
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
    saveRepoPoll(repo, poll, now, error) {
      db.prepare(
        `INSERT INTO issue_repos (repo, poll_json, polled_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET poll_json = excluded.poll_json, polled_at = excluded.polled_at, error = excluded.error`,
      ).run(repo, poll === null ? null : JSON.stringify(poll), now, error);
    },
    feedbackCursor(repo) {
      const row = db.prepare("SELECT feedback_json FROM issue_repos WHERE repo = ?").get(repo) as { feedback_json: string | null } | undefined;
      return row?.feedback_json ? JSON.parse(row.feedback_json) : null;
    },
    saveFeedbackCursor(repo, cursor) {
      db.prepare(
        `INSERT INTO issue_repos (repo, feedback_json) VALUES (?, ?)
         ON CONFLICT (repo) DO UPDATE SET feedback_json = excluded.feedback_json`,
      ).run(repo, JSON.stringify(cursor));
    },
  };
}
