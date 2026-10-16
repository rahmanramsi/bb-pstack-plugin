import type { Db } from "./store.ts";
import type { JobDraft, JobState, Origin, RunId, RunSnapshot } from "./runner.ts";

export type RunStore = {
  /** Inserts the run and all jobs in one transaction. Same origin + requestKey + planHash returns the existing id; a different hash is a conflict. */
  createRun(input: { id: RunId; origin: Origin; requestKey: string | null; planHash: string; kind: "panel" | "swarm"; title: string; deadline: number; jobs: readonly JobDraft[] }): { id: RunId; existing: boolean } | { conflict: true };
  snapshot(runId: RunId): RunSnapshot | null;
  runsForThread(originThreadId: string, active: boolean): RunId[];
  dueRuns(now: number): RunId[];
  /** CAS: moves a job only when its current state is `from`. Returns whether this call won. */
  transitionJob(runId: RunId, key: string, from: JobState, to: JobState, patch?: { releasedPrompt?: string; valueJson?: string; error?: string; nextActionAt?: number | null; providerRetries?: number; repairs?: number }): boolean;
  /** INSERT OR IGNORE of attempt (run, job, ordinal) as `issued`. Only the caller whose insert lands may spawn. */
  claimAttempt(runId: RunId, key: string, ordinal: number, now: number): boolean;
  attachAttempt(runId: RunId, key: string, ordinal: number, threadId: string): boolean;
  attemptByThread(threadId: string): { runId: RunId; key: string; ordinal: number } | null;
  finishRun(runId: RunId, status: Exclude<RunSnapshot["status"], "running">, now: number): boolean;
  /** Monotonic revision of everything this store owns for a thread, for realtime invalidation. */
  revision(threadId: string): number;
};

export function openRunStore(db: Db): RunStore {
  throw new Error("not implemented");
}
