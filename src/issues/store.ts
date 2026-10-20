/**
 * SQL for issue_repos, issue_jobs, issue_rounds, issue_feedback and issue_job_polls. Rows are parsed into job.ts types here, and a row
 * that breaks an invariant the types encode throws: that is a bug, not input. Every job write is one UPDATE guarded by
 * the row's version, in one transaction with the round history and feedback rows it implies.
 */
import { createHash, randomUUID } from "node:crypto";
import { desiredLabels, STATUS_CONCURRENCY, TERMINAL_STATUS_AUDIT_MS } from "./delivery.ts";
import { statusBody } from "./text.ts";
import type { Db } from "../store.ts";
import {
  TERMINAL,
  initialControl,
  type Control,
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
  projectId: string;
  /** The repository's pin, or null when the job's machine is picked as it starts. A sub-issue's job copies its parent's. */
  hostId: string | null;
  baseBranch: string;
  /** `ignored` carries its reason in `error`. */
  /** `tracking` for an issue with sub-issues. */
  state: "queued" | "ignored" | "tracking";
  error: string | null;
};

/** A queued job that already owns an open pull request whose head is `head`; see `adopt`. */
export type NewAdoption = Omit<NewJob, "state" | "error" | "parentId"> & { branch: BranchName; pr: { number: number; url: string }; head: Sha };
/** `transferred`: how many of the pull request's unanswered feedback items moved from ended jobs to this one. */
export type Adoption = { kind: "adopted"; job: Job; transferred: number } | { kind: "already"; job: Job } | { kind: "refused"; reason: string };

/** A job's last poll of its pull request: the cursor github.ts hands back, the state it read, and why it last failed. */
export type JobPoll = { cursor: unknown; prState: PullState | null; polledAt: number | null; error: string | null };

export type IssueReads = {
  get(id: JobId): Job | null;
  byThread(threadId: string): Job | null;
  byTrigger(eventId: number): Job | null;
  open(repo: RepoName, issue: number): Job | null;
  /** Jobs that may act at `now`, oldest first: WATCHED ones, and transit ones whose lease and backoff have passed. */
  due(now: number): JobId[];
  /** Newest first; terminal jobs only with `all`. */
  list(filter: { repo?: RepoName; all: boolean }): Job[];
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
   * Inserts the job for a label event. Its generation is 1 + the issue's earlier jobs that were not ignored, and its
   * branch follows from it. Null when the event is already recorded or an open job holds the issue.
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

export type Submission = { id: number; jobId: JobId; epoch: number; round: number; threadId: string; raw: string; result: string | null; intendedSha: Sha | null };
export type Decoration = { effect: Effect; nextAt: number; attempts: number; error: string | null };
export type IssueStatus = { repo: RepoName; issue: number; jobId: JobId; generation: number; revision: number; body: string; deliveredRevision: number; leaseUntil: number | null; leaseOwner: string | null; nextAt: number; retryNotBefore: number; error: string | null; decorations: Decoration[] };
export type DurableDelivery = {
  submit(job: Job, threadId: string, raw: string, now: number): Submission;
  pendingSubmissions(id: JobId): Submission[];
  bindSubmission(id: number, sha: Sha): boolean;
  finishSubmission(id: number, result: string, now: number): void;
  statuses(now: number): IssueStatus[];
  delivery(repo: RepoName, issue: number): { pending: boolean; error: string | null };
  claimStatus(status: IssueStatus, now: number): boolean;
  settleStatus(status: IssueStatus, input: { error: string | null; nextAt: number; notBefore?: number; now: number; release?: boolean }): void;
  releaseStatus(status: IssueStatus, now: number): void;
  claimReview(job: Job, now: number): boolean;
  deferReview(job: Job, nextAt: number): void;
  decorate(job: Job, effect: Effect): void;
  claimDecoration(status: IssueStatus, key: string, now: number): number | null;
  /** A `notBefore` from GitHub holds the whole issue's delivery, comment and decorations, until then. */
  settleDecoration(status: IssueStatus, key: string, error: string | null, nextAt: number, now: number, notBefore?: number): void;
};
export type Adoptions = {
  /**
   * Inserts a queued job that owns `job.pr`, in one transaction with its refusals: `already` when the issue's open job
   * owns this pull request and branch, `refused` when another open job holds the issue, the branch or the pull request.
   * The pull request's unanswered feedback that ended jobs own moves to the new job.
   */
  adopt(job: NewAdoption, now: number): Adoption;
};
export type IssueStore = IssueReads & IssueWrites & DurableDelivery & Adoptions;

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
  host_pinned: 0 | 1;
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
  control_json: string;
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

/** SQLite cannot drop host_id's NOT NULL without rebuilding the table, so an automatic job not started yet stores this. */
const NO_HOST = "";

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
    control: { ...initialControl(), ...JSON.parse(row.control_json) as Partial<Control> },
    id: row.id as JobId,
    version: row.version,
    repo: row.repo as RepoName,
    issue: row.issue,
    generation: row.generation,
    trigger: { eventId: row.trigger_event_id, actor: row.triggered_by, at: row.triggered_at },
    snapshot: JSON.parse(row.issue_json) as IssueSnapshot,
    parentId: row.parent_id as JobId | null,
    progress: row.progress,
    projectId: row.project_id,
    host: row.host_pinned ? { pinned: true, id: row.host_id } : { pinned: false, id: row.host_id === NO_HOST ? null : row.host_id },
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
  if (change.control) set.control_json = JSON.stringify(change.control);
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
  if (change.hostId !== undefined) set.host_id = change.hostId;
  return set;
}

const TERMINAL_LIST = [...TERMINAL];
const TRANSIT_LIST = Object.keys(TRANSIT);
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

type StatusRow = { repo: string; issue: number; job_id: string; generation: number; revision: number; body: string; delivered_revision: number; lease_until: number | null; lease_owner: string | null; next_at: number; retry_not_before: number; error: string | null; decorations_json: string };
const statusFromRow = (row: StatusRow): IssueStatus => ({ repo: row.repo as RepoName, issue: row.issue, jobId: row.job_id as JobId, generation: row.generation, revision: row.revision, body: row.body, deliveredRevision: row.delivered_revision, leaseUntil: row.lease_until, leaseOwner: row.lease_owner, nextAt: row.next_at, retryNotBefore: row.retry_not_before, error: row.error, decorations: JSON.parse(row.decorations_json) as Decoration[] });

export function openIssueStore(db: Db, onChange: () => void): IssueStore {
  const get = (id: JobId): Job | null => {
    const row = db.prepare("SELECT * FROM issue_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? parse(row) : null;
  };
  const openRow = (repo: RepoName, issue: number) =>
    db
      .prepare(`SELECT * FROM issue_jobs WHERE repo = ? AND issue = ? AND state NOT IN (${placeholders(TERMINAL_LIST)})`)
      .get(repo, issue, ...TERMINAL_LIST) as JobRow | undefined;

  function projectStatus(job: Job, terminatedAt: number | null = null): void {
    if (job.phase.state === "ignored") return;
    const body = statusBody(job);
    db.prepare(`INSERT INTO issue_status (repo, issue, job_id, generation, revision, body) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(repo,issue) DO UPDATE SET job_id = excluded.job_id, generation = excluded.generation,
        revision = issue_status.revision + 1, body = excluded.body, next_at = 0,
        decorations_json = CASE WHEN excluded.generation > issue_status.generation THEN '[]' ELSE issue_status.decorations_json END,
        desired_labels_key = CASE WHEN excluded.generation > issue_status.generation THEN NULL ELSE issue_status.desired_labels_key END
      WHERE excluded.generation > issue_status.generation OR
        (excluded.job_id = issue_status.job_id AND excluded.body != issue_status.body)`)
      .run(job.repo, job.issue, job.id, job.generation, body);
    if (terminatedAt !== null) db.prepare("UPDATE issue_status SET next_at = max(next_at,?) WHERE repo = ? AND issue = ? AND job_id = ? AND delivered_revision = revision AND error IS NULL")
      .run(terminatedAt + TERMINAL_STATUS_AUDIT_MS, job.repo, job.issue, job.id);
    const row = db.prepare("SELECT job_id, decorations_json, desired_labels_key FROM issue_status WHERE repo = ? AND issue = ?").get(job.repo, job.issue) as { job_id: string; decorations_json: string; desired_labels_key: string | null } | undefined;
    if (!row || row.job_id !== job.id) return;
    const effect = desiredLabels(job);
    const current = JSON.parse(row.decorations_json) as Decoration[];
    const labels = current.filter((item) => item.effect.op === "labels" && item.effect.on === "issue");
    const retained = current.filter((item) => item.effect.op !== "labels" || item.effect.on !== "issue");
    if (row.desired_labels_key !== effect.key || labels.length) {
      if (row.desired_labels_key !== effect.key || labels.some((item) => item.effect.key === effect.key)) retained.push(labels.find((item) => item.effect.key === effect.key) ?? { effect, nextAt: 0, attempts: 0, error: null });
      db.prepare("UPDATE issue_status SET decorations_json = ?, desired_labels_key = ? WHERE repo = ? AND issue = ?").run(JSON.stringify(retained), effect.key, job.repo, job.issue);
    }
  }

  for (const row of db.prepare("SELECT * FROM issue_jobs ORDER BY generation, created_at").all() as JobRow[]) projectStatus(parse(row));

  /** The issue's next generation: one more than its jobs that were not ignored. */
  const nextGeneration = (repo: RepoName, issue: number) =>
    (db.prepare("SELECT count(*) AS earlier FROM issue_jobs WHERE repo = ? AND issue = ? AND state != 'ignored'").get(repo, issue) as { earlier: number }).earlier + 1;

  /** `published`: the pull request and head an adopted job starts with. */
  function insertRow(job: NewJob, now: number, generation: number, branch: BranchName, published: { pr: { number: number; url: string }; head: Sha } | null, resume: Control["resume"]): Job {
    db.prepare(
      `INSERT INTO issue_jobs (id, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json,
         project_id, host_id, host_pinned, base_branch, branch, state, error, created_at, updated_at, parent_id, pr_number, pr_url, pushed_sha, control_json, runtime_protocol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
      job.hostId ?? NO_HOST,
      job.hostId === null ? 0 : 1,
      job.baseBranch,
      branch,
      job.state,
      job.error,
      now,
      now,
      job.parentId ?? null,
      published?.pr.number ?? null,
      published?.pr.url ?? null,
      published?.head ?? null,
      JSON.stringify(resume ? { resume } : {}),
    );
    const inserted = get(job.id)!;
    projectStatus(inserted);
    return inserted;
  }

  const insert = db.transaction((job: NewJob, now: number): Job | null => {
    if (db.prepare("SELECT 1 FROM issue_jobs WHERE trigger_event_id = ?").get(job.trigger.eventId)) return null;
    if (job.state !== "ignored" && openRow(job.repo, job.issue)) return null;
    if (job.parentId && db.prepare("SELECT 1 FROM issue_jobs WHERE parent_id = ? AND issue = ?").get(job.parentId, job.issue)) return null;
    const generation = nextGeneration(job.repo, job.issue);
    const last = db
      .prepare("SELECT branch, state, pushed_sha, error FROM issue_jobs WHERE repo = ? AND issue = ? AND state != 'ignored' ORDER BY generation DESC LIMIT 1")
      .get(job.repo, job.issue) as { branch: BranchName; state: string; pushed_sha: Sha | null; error: string | null } | undefined;
    const resume = last?.state === "stuck" && last.pushed_sha ? { branch: last.branch, sha: last.pushed_sha, reason: last.error } : null;
    return insertRow(job, now, generation, branchFor(job.issue, job.snapshot.title, generation), null, resume);
  });

  const adopt = db.transaction((job: NewAdoption, now: number): Adoption => {
    const open = openRow(job.repo, job.issue);
    if (open) {
      if (open.pr_number === job.pr.number && open.branch === job.branch) return { kind: "already", job: parse(open) };
      return { kind: "refused", reason: `${open.id} is open on issue #${job.issue} (${open.state}); stop it first with \`bb pstack issues stop ${open.id}\`` };
    }
    const holder = db
      .prepare(`SELECT * FROM issue_jobs WHERE repo = ? AND (branch = ? OR pr_number = ?) AND state NOT IN (${placeholders(TERMINAL_LIST)})`)
      .get(job.repo, job.branch, job.pr.number, ...TERMINAL_LIST) as JobRow | undefined;
    if (holder) return { kind: "refused", reason: `${holder.branch === job.branch ? job.branch : `pull request #${job.pr.number}`} belongs to ${holder.id} on issue #${holder.issue}` };
    const { branch, pr, head, ...fields } = job;
    const inserted = insertRow({ ...fields, state: "queued", error: null }, now, nextGeneration(job.repo, job.issue), branch, { pr, head }, null);
    const transferred = db
      .prepare(
        `UPDATE issue_feedback SET job_id = ?, round = NULL
         WHERE repo = ? AND pr_number = ? AND job_id IN (SELECT id FROM issue_jobs WHERE state IN (${placeholders(TERMINAL_LIST)}))
           AND (round IS NULL OR NOT EXISTS (SELECT 1 FROM issue_rounds r WHERE r.job_id = issue_feedback.job_id
             AND coalesce(r.feedback_round, r.ordinal) = issue_feedback.round AND r.report_json IS NOT NULL))`,
      )
      .run(inserted.id, job.repo, pr.number, ...TERMINAL_LIST).changes;
    return { kind: "adopted", job: inserted, transferred };
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
    due(now) {
      const rows = db
        .prepare(
          `SELECT id FROM issue_jobs WHERE id IN (SELECT job_id FROM issue_submissions WHERE evaluated_at IS NULL) OR state IN (${placeholders(WATCHED)})
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
      const rows = db.prepare("SELECT f.* FROM issue_feedback f JOIN issue_rounds r ON r.job_id = f.job_id AND f.round = coalesce(r.feedback_round, r.ordinal) WHERE r.job_id = ? AND r.ordinal = ? ORDER BY f.created_at, f.github_id").all(id, ordinal) as FeedbackRow[];
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
      if (change.startRound?.kind === "feedback" && change.startRound.feedbackFrom === undefined) {
        const { waiting } = db.prepare("SELECT count(*) AS waiting FROM issue_feedback WHERE job_id = ? AND round IS NULL").get(id) as { waiting: number };
        if (waiting !== change.startRound.feedback.length) return null;
      }
      const previous = change.startRound ? get(id) : null;
      const before = db.prepare("SELECT state FROM issue_jobs WHERE id = ?").get(id) as { state: JobState } | undefined;
      const set = columns(change);
      const names = Object.keys(set);
      const assignments = [...names.map((name) => `${name} = ?`), "version = version + 1", "runtime_revision = runtime_revision + 1", "updated_at = ?"].join(", ");
      const changed = db.prepare(`UPDATE issue_jobs SET ${assignments} WHERE id = ? AND version = ?`).run(...Object.values(set), now, id, version).changes;
      if (changed !== 1) return null;
      const job = get(id)!;
      if (change.startRound) {
        const { ordinal, kind, baseSha, feedback } = change.startRound;
        if (previous && ordinal > previous.round) db.prepare("UPDATE issue_rounds SET finished_at = ?, outcome_json = coalesce(outcome_json, ?) WHERE job_id = ? AND ordinal = ? AND finished_at IS NULL").run(now, JSON.stringify({ state: previous.phase.state, report: previous.report?.outcome ?? null, headSha: previous.report?.headSha ?? null }), id, previous.round);
        let feedbackRound: number | null = null;
        if (change.startRound.feedbackFrom !== undefined) {
          const source = db.prepare("SELECT coalesce(feedback_round, ordinal) AS ordinal FROM issue_rounds WHERE job_id = ? AND ordinal = ? AND ordinal < ?").get(id, change.startRound.feedbackFrom, ordinal) as { ordinal: number } | undefined;
          if (!source || feedback.length) throw new Error("publication repair must inherit an existing round's feedback");
          feedbackRound = source.ordinal;
        }
        db.prepare("INSERT INTO issue_rounds (job_id, ordinal, kind, started_at, base_sha, cause, target_json, feedback_round) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, ordinal, kind, now, baseSha, change.startRound.cause ?? kind, change.startRound.target ? JSON.stringify(change.startRound.target) : null, feedbackRound);
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
      if (change.finishRound) db.prepare("UPDATE issue_rounds SET finished_at = ?, outcome_json = coalesce(outcome_json, ?) WHERE job_id = ? AND ordinal = ? AND finished_at IS NULL").run(now, JSON.stringify({ state: job.phase.state, disposition: job.control.disposition, report: job.report?.outcome ?? null }), id, job.round);
      if (change.evaluation) db.prepare("UPDATE issue_submissions SET evaluated_at = ?, result = ?, snapshot_json = ? WHERE id = ? AND evaluated_at IS NULL").run(now, change.evaluation.result, change.evaluation.snapshot ? JSON.stringify(change.evaluation.snapshot) : null, change.evaluation.submissionId);
      projectStatus(job, before && !TERMINAL.has(before.state) && TERMINAL.has(job.phase.state) ? now : null);
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
  const submission = (row: { id: number; job_id: string; epoch: number; round: number; thread_id: string; raw: string; result: string | null; intended_sha: string | null }): Submission => ({ id: row.id, jobId: row.job_id as JobId, epoch: row.epoch, round: row.round, threadId: row.thread_id, raw: row.raw, result: row.result, intendedSha: row.intended_sha as Sha | null });
  const deliveries: DurableDelivery = {
    submit(job, threadId, raw, now) {
      const hash = createHash("sha256").update(raw).update(`\0${job.version}`).digest("hex");
      db.prepare("INSERT OR IGNORE INTO issue_submissions (job_id, epoch, round, thread_id, hash, raw, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(job.id, job.control.epoch, job.round, threadId, hash, raw, now);
      return submission(db.prepare("SELECT * FROM issue_submissions WHERE job_id = ? AND epoch = ? AND round = ? AND thread_id = ? AND hash = ?").get(job.id, job.control.epoch, job.round, threadId, hash) as Parameters<typeof submission>[0]);
    },
    bindSubmission(id, sha) {
      return db.prepare("UPDATE issue_submissions SET intended_sha = ? WHERE id = ? AND evaluated_at IS NULL AND (intended_sha IS NULL OR intended_sha = ?)").run(sha, id, sha).changes === 1;
    },
    pendingSubmissions(id) {
      return (db.prepare("SELECT * FROM issue_submissions WHERE job_id = ? AND evaluated_at IS NULL ORDER BY id").all(id) as Parameters<typeof submission>[0][]).map(submission);
    },
    finishSubmission(id, result, now) {
      db.prepare("UPDATE issue_submissions SET evaluated_at = ?, result = ? WHERE id = ? AND evaluated_at IS NULL").run(now, result, id);
    },
    delivery(repo, issue) {
      const row = db.prepare("SELECT revision, delivered_revision, error, decorations_json FROM issue_status WHERE repo = ? AND issue = ?").get(repo, issue) as { revision: number; delivered_revision: number; error: string | null; decorations_json: string } | undefined;
      if (!row) return { pending: false, error: null };
      const decorations = JSON.parse(row.decorations_json) as Decoration[];
      return { pending: row.revision > row.delivered_revision || decorations.length > 0, error: row.error ?? decorations.find((item) => item.error)?.error ?? null };
    },
    statuses(now) {
      return (db.prepare(`SELECT * FROM issue_status WHERE coalesce(lease_until,0) <= ? AND retry_not_before <= ? AND (
        next_at <= ? OR EXISTS (SELECT 1 FROM json_each(decorations_json) WHERE json_extract(value,'$.nextAt') <= ?)) ORDER BY next_at, repo, issue`).all(now, now, now, now) as StatusRow[]).map(statusFromRow);
    },
    claimStatus(status, now) {
      const leaseUntil = now + 60_000;
      const owner = randomUUID();
      const claimed = db.prepare(`UPDATE issue_status SET lease_until = ?, lease_owner = ? WHERE repo = ? AND issue = ? AND revision = ? AND coalesce(lease_until,0) <= ? AND retry_not_before <= ? AND (
        next_at <= ? OR EXISTS (SELECT 1 FROM json_each(decorations_json) WHERE json_extract(value,'$.nextAt') <= ?))
        AND (SELECT count(*) FROM issue_status WHERE lease_until > ?) < ?`).run(leaseUntil, owner, status.repo, status.issue, status.revision, now, now, now, now, now, STATUS_CONCURRENCY).changes === 1;
      if (claimed) { status.leaseUntil = leaseUntil; status.leaseOwner = owner; }
      return claimed;
    },
    settleStatus(status, input) {
      if (input.notBefore) db.prepare("UPDATE issue_status SET retry_not_before = max(retry_not_before,?) WHERE repo = ? AND issue = ? AND lease_owner = ? AND lease_until > ?")
        .run(input.notBefore, status.repo, status.issue, status.leaseOwner, input.now);
      db.prepare(`UPDATE issue_status SET delivered_revision = CASE WHEN ? IS NULL THEN max(delivered_revision,?) ELSE delivered_revision END,
        lease_until = CASE WHEN ? THEN NULL ELSE lease_until END, lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
        next_at = ?, retry_not_before = max(retry_not_before,?), error = ? WHERE repo = ? AND issue = ? AND job_id = ? AND revision = ? AND lease_owner = ? AND lease_until > ?`)
        .run(input.error, status.revision, input.release === false ? 0 : 1, input.release === false ? 0 : 1, input.nextAt, input.notBefore ?? 0, input.error, status.repo, status.issue, status.jobId, status.revision, status.leaseOwner, input.now);
      if (input.release !== false) db.prepare("UPDATE issue_status SET lease_until = NULL, lease_owner = NULL WHERE repo = ? AND issue = ? AND lease_owner = ? AND lease_until > ?")
        .run(status.repo, status.issue, status.leaseOwner, input.now);
    },
    releaseStatus(status, now) {
      db.prepare("UPDATE issue_status SET lease_until = NULL, lease_owner = NULL WHERE repo = ? AND issue = ? AND lease_owner = ? AND lease_until > ?").run(status.repo, status.issue, status.leaseOwner, now);
    },
    claimReview(job, now) {
      return db.prepare(`INSERT INTO issue_review_schedule (job_id, next_at) VALUES (?, ?)
        ON CONFLICT(job_id) DO UPDATE SET next_at = excluded.next_at WHERE issue_review_schedule.next_at <= ?`).run(job.id, now + 60_000, now).changes === 1;
    },
    deferReview(job, nextAt) {
      db.prepare("UPDATE issue_review_schedule SET next_at = max(next_at,?) WHERE job_id = ?").run(nextAt, job.id);
    },
    decorate: db.transaction((job: Job, effect: Effect) => {
      if (effect.op === "labels" && effect.on === "issue") return;
      const row = db.prepare("SELECT job_id, decorations_json FROM issue_status WHERE repo = ? AND issue = ?").get(job.repo, job.issue) as { job_id: string; decorations_json: string } | undefined;
      if (!row || row.job_id !== job.id) return;
      const decorations = JSON.parse(row.decorations_json) as Decoration[];
      if (!decorations.some((item) => item.effect.key === effect.key)) decorations.push({ effect, attempts: 0, nextAt: 0, error: null });
      db.prepare("UPDATE issue_status SET decorations_json = ? WHERE repo = ? AND issue = ?").run(JSON.stringify(decorations), job.repo, job.issue);
    }),
    claimDecoration: db.transaction((status: IssueStatus, key: string, now: number): number | null => {
      const row = db.prepare("SELECT decorations_json, retry_not_before FROM issue_status WHERE repo = ? AND issue = ? AND job_id = ? AND revision = ? AND lease_owner = ? AND lease_until > ?").get(status.repo, status.issue, status.jobId, status.revision, status.leaseOwner, now) as { decorations_json: string; retry_not_before: number } | undefined;
      if (!row || row.retry_not_before > now) return null;
      const decorations = JSON.parse(row.decorations_json) as Decoration[];
      const item = decorations.find((candidate) => candidate.effect.key === key);
      if (!item || item.nextAt > now) return null;
      const previous = item.attempts;
      item.attempts += 1;
      item.nextAt = status.leaseUntil!;
      db.prepare("UPDATE issue_status SET decorations_json = ? WHERE repo = ? AND issue = ?").run(JSON.stringify(decorations), status.repo, status.issue);
      return previous;
    }),
    settleDecoration: db.transaction((status: IssueStatus, key: string, error: string | null, nextAt: number, now: number, notBefore = 0) => {
      if (notBefore) db.prepare("UPDATE issue_status SET retry_not_before = max(retry_not_before,?) WHERE repo = ? AND issue = ? AND lease_owner = ? AND lease_until > ?")
        .run(notBefore, status.repo, status.issue, status.leaseOwner, now);
      const row = db.prepare("SELECT decorations_json FROM issue_status WHERE repo = ? AND issue = ? AND job_id = ? AND lease_owner = ? AND lease_until > ?").get(status.repo, status.issue, status.jobId, status.leaseOwner, now) as { decorations_json: string } | undefined;
      if (!row) return;
      const current = JSON.parse(row.decorations_json) as Decoration[];
      const decorations = current.flatMap((item) => item.effect.key !== key ? [item] : error === null ? [] : [{ ...item, error, nextAt }]);
      db.prepare("UPDATE issue_status SET decorations_json = ? WHERE repo = ? AND issue = ?").run(JSON.stringify(decorations), status.repo, status.issue);
    }),
  };
  const adoptions: Adoptions = {
    adopt(job, now) {
      const outcome = adopt(job, now);
      if (outcome.kind === "adopted") onChange();
      return outcome;
    },
  };
  return { ...reads, ...notifying(writes, onChange), ...deliveries, ...adoptions };
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
