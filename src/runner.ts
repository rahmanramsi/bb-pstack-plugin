/**
 * Panel and swarm runs. A run is a fixed set of jobs inserted up front:
 *   panel: one `seat` job per seat, plus an optional `judge` job blocked on every seat;
 *   swarm: one `slice` job per slice, plus an optional `verifier` job blocked on its own slice only.
 * `plan()` is a pure, level-triggered reconciler: given a snapshot it returns the transitions to apply.
 * The engine (createRunner) applies each with a compare-and-set in run-store.ts, so applying one twice does
 * nothing. Events, a 15 s maintenance tick, and startup all just call tick(runId).
 *
 * Restart rule: an attempt is persisted as `issued` before threads.spawn. If the process dies before the
 * thread id is attached, recovery adopts a hidden plugin-owned thread whose metadata names the attempt, and
 * otherwise marks the job `uncertain` until the run deadline. It never spawns again for an issued attempt,
 * because the SDK spawn has no idempotency key and a late success would duplicate the seat or judge.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ResultKind, RunPlan, RunView } from "./contract.ts";
import type { ModelChoice } from "./models.ts";
import type { RunStore } from "./run-store.ts";

export type RunId = string & { readonly __brand: "RunId" };
export type JobKind = "seat" | "judge" | "slice" | "verifier";

/** What the engine needs from the origin thread, snapshotted at start. */
export type Origin = {
  threadId: string;
  projectId: string;
  environmentId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
};

/** A job as compiled from a plan: its prompt, model, result contract and what it waits on. Immutable once stored. */
export type JobDraft = {
  key: string;
  kind: JobKind;
  label: string;
  /** Resolved; `inherit-parent` is replaced by the origin's tuple so a hidden worker never falls back to global defaults. */
  model: Extract<ModelChoice, { kind: "tuple" }>;
  prompt: string;
  result: ResultKind;
  /** Keys this job waits on. Empty means ready at start. A judge waits on every seat; a verifier on its slice. */
  after: readonly string[];
  /** For a judge: how many of `after` must succeed. Ignored otherwise. */
  quorum: number;
  slice: string | null;
};

/** Pure: plan + role table + origin → jobs. The only place that knows the two run shapes. Rejects unknown roles and tuples. */
export function compile(
  plan: RunPlan,
  resolveRole: (role: string) => readonly ModelChoice[],
  origin: Origin,
): { ok: true; jobs: JobDraft[] } | { ok: false; error: string } {
  throw new Error("not implemented");
}

export type JobState = "blocked" | "queued" | "running" | "repairing" | "uncertain" | "succeeded" | "failed" | "skipped" | "cancelled";

export type AttemptSnapshot = {
  ordinal: number;
  state: "issued" | "attached" | "finished";
  threadId: string | null;
  issuedAt: number;
};

export type JobSnapshot = JobDraft & {
  state: JobState;
  attempts: readonly AttemptSnapshot[];
  providerRetries: number;
  repairs: number;
  nextActionAt: number | null;
  /** Validated value (string for text) once succeeded. */
  value: unknown;
  error: string | null;
};

export type RunSnapshot = {
  id: RunId;
  status: "running" | "succeeded" | "partial" | "failed" | "cancelled";
  deadline: number;
  jobs: readonly JobSnapshot[];
};

export type Action =
  | { type: "release"; job: string; prompt: string }
  | { type: "skip"; job: string; reason: string }
  | { type: "spawn"; job: string; ordinal: number }
  | { type: "retry"; job: string; at: number }
  | { type: "repair"; job: string; message: string }
  | { type: "fail"; job: string; error: string }
  | { type: "finish"; status: Exclude<RunSnapshot["status"], "running"> };

/**
 * Pure reconciler. Releases a blocked judge/verifier once its inputs are terminal (materializing its prompt
 * with every input's outcome, failures named, findings tagged `A.1`), skips it when the quorum is missed,
 * schedules spawns within the concurrency limit (verifiers before unstarted slices), schedules provider
 * retries (2, at 1 s and 4 s), fails jobs past the deadline, and finishes the run when every job is terminal.
 */
export function plan(run: RunSnapshot, now: number): Action[] {
  throw new Error("not implemented");
}

/** Pure: the run status derived from job states. */
export function deriveStatus(jobs: readonly JobSnapshot[]): RunSnapshot["status"] {
  throw new Error("not implemented");
}

/** Pure: transient provider failure (retry on a fresh thread) vs everything else (fail). */
export function classifyFailure(error: string): "transient" | "permanent" {
  throw new Error("not implemented");
}

/** Pure: parse a worker's final text or submitted value against its contract. */
export function acceptResult(kind: ResultKind, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  throw new Error("not implemented");
}

/** Pure: snapshot → UI view, including findings with refs and the agreement matrix from a `grouping` judge. */
export function toView(run: RunSnapshot, meta: { kind: "panel" | "swarm"; title: string; createdAt: number; finishedAt: number | null }): RunView {
  throw new Error("not implemented");
}

export type Runner = {
  start(plan: RunPlan, originThreadId: string): Promise<{ runId: RunId; existing: boolean }>;
  stop(runId: RunId, originThreadId: string): Promise<boolean>;
  /** Worker side: `pstack_result({ value })`, identity from the tool's thread id. */
  submit(workerThreadId: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  view(runId: RunId, originThreadId: string): RunView;
  /** Lifecycle hooks; each only records the observation and calls tick. */
  onIdle(threadId: string, lastAssistantText: string | null): Promise<void>;
  onFailed(threadId: string, error: string | null): Promise<void>;
  onGone(threadId: string): Promise<void>;
  /** Background service body: recover, then tick due runs every 15 s until the signal aborts. */
  serve(signal: AbortSignal): Promise<void>;
};

/** The engine: the only module that calls bb.sdk.threads.*. Applies plan() actions via store CAS transitions. */
export function createRunner(bb: BbPluginApi, store: RunStore, resolveRole: (role: string) => readonly ModelChoice[]): Runner {
  throw new Error("not implemented");
}
