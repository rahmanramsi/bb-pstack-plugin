import type { Db } from "./store.ts";
import { LIVE, TERMINAL, type AttemptSnapshot, type JobDraft, type JobSnapshot, type JobState, type Origin, type RunId, type RunSnapshot } from "./runner.ts";

type FinalStatus = Exclude<RunSnapshot["status"], "running">;
type NotifyState = "pending" | "sent" | "abandoned";

export type RunInfo = {
  id: RunId;
  origin: Origin;
  kind: "panel" | "swarm";
  title: string;
  status: RunSnapshot["status"];
  createdAt: number;
  finishedAt: number | null;
  notify: { state: NotifyState; attempts: number; nextAt: number | null };
};

export type JobPatch = {
  releasedPrompt?: string;
  valueJson?: string;
  error?: string | null;
  nextActionAt?: number | null;
  providerRetries?: number;
  repairs?: number;
};

export type RunStore = {
  /** Inserts the run and all jobs in one transaction. Same origin + requestKey + planHash returns the existing id; a different hash is a conflict. */
  createRun(input: { id: RunId; origin: Origin; requestKey: string | null; planHash: string; kind: "panel" | "swarm"; title: string; deadline: number; jobs: readonly JobDraft[] }): { id: RunId; existing: boolean } | { conflict: true };
  snapshot(runId: RunId): RunSnapshot | null;
  info(runId: RunId): RunInfo | null;
  runsForThread(originThreadId: string, active: boolean): RunId[];
  dueRuns(now: number): RunId[];
  transitionJobAndAttempt(runId: RunId, key: string, from: JobState, to: JobState, patch?: JobPatch): boolean;
  claimAttempt(runId: RunId, key: string, ordinal: number, now: number): boolean;
  attachAttempt(runId: RunId, key: string, ordinal: number, threadId: string): boolean;
  /** Records a thread that turned up after its attempt finished without one, with cleanup pending. */
  recordLateThread(runId: RunId, key: string, ordinal: number, threadId: string): boolean;
  attemptByThread(threadId: string): { runId: RunId; key: string; ordinal: number } | null;
  finishRun(runId: RunId, status: FinalStatus, now: number): boolean;
  /** Cancels a running run, its open jobs and their attempts in one transaction. */
  cancelRun(runId: RunId, now: number): boolean;
  /** Threads of finished attempts that have not been confirmed stopped. A finished attempt's cleanup stays `pending` until markCleaned. */
  pendingCleanup(runId: RunId): string[];
  markCleaned(threadId: string): void;
  settleNotification(runId: RunId, outcome: Exclude<NotifyState, "pending">): boolean;
  deferNotification(runId: RunId, nextAt: number): void;
  /** Monotonic revision of everything this store owns for a thread, for realtime invalidation. */
  revision(threadId: string): number;
};

type RunRow = {
  id: string;
  origin_json: string;
  kind: "panel" | "swarm";
  title: string;
  status: RunSnapshot["status"];
  deadline: number;
  created_at: number;
  finished_at: number | null;
  notify_state: NotifyState;
  notify_attempts: number;
  notify_next_at: number | null;
};

type JobRow = {
  key: string;
  draft_json: string;
  state: JobState;
  released_prompt: string | null;
  provider_retries: number;
  repairs: number;
  next_action_at: number | null;
  value_json: string | null;
  error: string | null;
};

type AttemptRow = { job_key: string; ordinal: number; state: AttemptSnapshot["state"]; thread_id: string | null; issued_at: number; finished_at: number | null };

const PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  releasedPrompt: "released_prompt",
  valueJson: "value_json",
  error: "error",
  nextActionAt: "next_action_at",
  providerRetries: "provider_retries",
  repairs: "repairs",
};

export function openRunStore(db: Db, clock: () => number = Date.now): RunStore {
  let revision = clock();
  const bump = <T>(changed: T): T => {
    if (changed) revision += 1;
    return changed;
  };

  const createRun = db.transaction((input: Parameters<RunStore["createRun"]>[0]): ReturnType<RunStore["createRun"]> => {
    if (input.requestKey !== null) {
      const existing = db
        .prepare("SELECT id, plan_hash FROM runs WHERE origin_thread_id = ? AND request_key = ?")
        .get(input.origin.threadId, input.requestKey) as { id: RunId; plan_hash: string } | undefined;
      if (existing) return existing.plan_hash === input.planHash ? { id: existing.id, existing: true } : { conflict: true };
    }
    db.prepare(
      `INSERT INTO runs (id, origin_thread_id, request_key, plan_hash, kind, title, origin_json, status, deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(input.id, input.origin.threadId, input.requestKey, input.planHash, input.kind, input.title, JSON.stringify(input.origin), input.deadline, clock());
    const insertJob = db.prepare("INSERT INTO jobs (run_id, key, ord, draft_json, state) VALUES (?, ?, ?, ?, ?)");
    input.jobs.forEach((job, index) => {
      insertJob.run(input.id, job.key, index, JSON.stringify(job), job.after.length > 0 ? "blocked" : "queued");
    });
    revision += 1;
    return { id: input.id, existing: false };
  });

  const transitionJobAndAttempt = db.transaction((runId: RunId, key: string, from: JobState, to: JobState, patch: JobPatch): boolean => {
    const entries = Object.entries(patch) as [keyof JobPatch, unknown][];
    const sets = ["state = ?", ...entries.map(([field]) => `${PATCH_COLUMNS[field]} = ?`)].join(", ");
    const changed = db
      .prepare(`UPDATE jobs SET ${sets} WHERE run_id = ? AND key = ? AND state = ?`)
      .run(to, ...entries.map(([, value]) => value), runId, key, from).changes;
    if (changed === 0) return false;
    if (!LIVE.has(to)) {
      db.prepare("UPDATE attempts SET state = 'finished', finished_at = ? WHERE run_id = ? AND job_key = ? AND state != 'finished'").run(clock(), runId, key);
    }
    return true;
  });

  const cancelRun = db.transaction((runId: RunId, now: number): boolean => {
    if (db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").run(now, runId).changes === 0) return false;
    const terminal = [...TERMINAL];
    db.prepare(`UPDATE jobs SET state = 'cancelled' WHERE run_id = ? AND state NOT IN (${terminal.map(() => "?").join(", ")})`).run(runId, ...terminal);
    db.prepare("UPDATE attempts SET state = 'finished', finished_at = ? WHERE run_id = ? AND state != 'finished'").run(now, runId);
    return true;
  });

  function readRun(runId: RunId): RunRow | undefined {
    return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  }

  return {
    createRun: (input) => createRun(input),

    snapshot(runId) {
      const run = readRun(runId);
      if (!run) return null;
      const attempts = db
        .prepare("SELECT job_key, ordinal, state, thread_id, issued_at, finished_at FROM attempts WHERE run_id = ? ORDER BY ordinal")
        .all(runId) as AttemptRow[];
      const jobs = (db.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY ord").all(runId) as JobRow[]).map((row): JobSnapshot => {
        const draft = JSON.parse(row.draft_json) as JobDraft;
        return {
          ...draft,
          prompt: row.released_prompt ?? draft.prompt,
          state: row.state,
          attempts: attempts
            .filter((attempt) => attempt.job_key === row.key)
            .map((attempt) => ({
              ordinal: attempt.ordinal,
              state: attempt.state,
              threadId: attempt.thread_id,
              issuedAt: attempt.issued_at,
              finishedAt: attempt.finished_at,
            })),
          providerRetries: row.provider_retries,
          repairs: row.repairs,
          nextActionAt: row.next_action_at,
          value: row.value_json === null ? null : JSON.parse(row.value_json),
          error: row.error,
        };
      });
      return { id: runId, status: run.status, deadline: run.deadline, jobs };
    },

    info(runId) {
      const run = readRun(runId);
      if (!run) return null;
      return {
        id: runId,
        origin: JSON.parse(run.origin_json) as Origin,
        kind: run.kind,
        title: run.title,
        status: run.status,
        createdAt: run.created_at,
        finishedAt: run.finished_at,
        notify: { state: run.notify_state, attempts: run.notify_attempts, nextAt: run.notify_next_at },
      };
    },

    runsForThread(originThreadId, active) {
      const rows = db
        .prepare(`SELECT id FROM runs WHERE origin_thread_id = ? ${active ? "AND status = 'running'" : ""} ORDER BY created_at, id`)
        .all(originThreadId) as { id: RunId }[];
      return rows.map((row) => row.id);
    },

    dueRuns(now) {
      const rows = db
        .prepare(
          `SELECT id FROM runs WHERE status = 'running'
             OR (notify_state = 'pending' AND (notify_next_at IS NULL OR notify_next_at <= ?))
             OR EXISTS (SELECT 1 FROM attempts WHERE run_id = runs.id AND state = 'finished' AND cleanup = 'pending' AND thread_id IS NOT NULL)
           ORDER BY created_at, id`,
        )
        .all(now) as { id: RunId }[];
      return rows.map((row) => row.id);
    },

    transitionJobAndAttempt: (runId, key, from, to, patch = {}) => bump(transitionJobAndAttempt(runId, key, from, to, patch)),

    claimAttempt(runId, key, ordinal, now) {
      const changes = db
        .prepare(
          `INSERT OR IGNORE INTO attempts (run_id, job_key, ordinal, state, issued_at)
           SELECT ?, ?, ?, 'issued', ? WHERE EXISTS (SELECT 1 FROM jobs WHERE run_id = ? AND key = ? AND state = 'running')`,
        )
        .run(runId, key, ordinal, now, runId, key).changes;
      return bump(changes === 1);
    },

    attachAttempt(runId, key, ordinal, threadId) {
      try {
        const changes = db
          .prepare("UPDATE attempts SET state = 'attached', thread_id = ? WHERE run_id = ? AND job_key = ? AND ordinal = ? AND state = 'issued'")
          .run(threadId, runId, key, ordinal).changes;
        return bump(changes === 1);
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return false;
        throw error;
      }
    },

    recordLateThread(runId, key, ordinal, threadId) {
      try {
        const changes = db
          .prepare(
            `UPDATE attempts SET thread_id = ?, cleanup = 'pending'
             WHERE run_id = ? AND job_key = ? AND ordinal = ? AND state = 'finished' AND thread_id IS NULL`,
          )
          .run(threadId, runId, key, ordinal).changes;
        return changes === 1;
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return false;
        throw error;
      }
    },

    attemptByThread(threadId) {
      const row = db.prepare("SELECT run_id, job_key, ordinal FROM attempts WHERE thread_id = ?").get(threadId) as
        | { run_id: RunId; job_key: string; ordinal: number }
        | undefined;
      return row ? { runId: row.run_id, key: row.job_key, ordinal: row.ordinal } : null;
    },

    finishRun(runId, status, now) {
      const changes = db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(status, now, runId).changes;
      return bump(changes === 1);
    },

    cancelRun: (runId, now) => bump(cancelRun(runId, now)),

    pendingCleanup(runId) {
      const rows = db
        .prepare("SELECT thread_id FROM attempts WHERE run_id = ? AND state = 'finished' AND cleanup = 'pending' AND thread_id IS NOT NULL ORDER BY job_key, ordinal")
        .all(runId) as { thread_id: string }[];
      return rows.map((row) => row.thread_id);
    },

    markCleaned(threadId) {
      db.prepare("UPDATE attempts SET cleanup = 'done' WHERE thread_id = ? AND state = 'finished'").run(threadId);
    },

    settleNotification(runId, outcome) {
      const changes = db
        .prepare("UPDATE runs SET notify_state = ?, notify_next_at = NULL WHERE id = ? AND notify_state = 'pending' AND status != 'running'")
        .run(outcome, runId).changes;
      return changes === 1;
    },

    deferNotification(runId, nextAt) {
      db.prepare("UPDATE runs SET notify_attempts = notify_attempts + 1, notify_next_at = ? WHERE id = ? AND notify_state = 'pending'").run(nextAt, runId);
    },

    revision: () => revision,
  };
}
