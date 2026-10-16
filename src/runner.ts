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
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RESULT_SCHEMAS, STATE_CHANNEL, type ResultKind, type RunPlan, type RunView } from "./contract.ts";
import { formatChoice, parseChoice, type ModelChoice } from "./models.ts";
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

type Tuple = Extract<ModelChoice, { kind: "tuple" }>;

/** A job as compiled from a plan: its prompt, model, result contract and what it waits on. Immutable once stored. */
export type JobDraft = {
  key: string;
  kind: JobKind;
  label: string;
  /** Resolved; `inherit-parent` is replaced by the origin's tuple so a hidden worker never falls back to global defaults. */
  model: Tuple;
  prompt: string;
  result: ResultKind;
  /** Keys this job waits on. Empty means ready at start. A judge waits on every seat; a verifier on its slice. */
  after: readonly string[];
  /** For a judge: how many of `after` must succeed. Ignored otherwise. */
  quorum: number;
  slice: string | null;
};

export const CONCURRENCY = 8;
export const PROVIDER_RETRY_DELAYS_MS = [1_000, 4_000] as const;
export const MAX_REPAIRS = 2;
export const RUN_DEADLINE_MS = 4 * 60 * 60 * 1_000;
const MAX_SEATS = 26;

class CompileError extends Error {}

/** Pure: plan + role table + origin → jobs. The only place that knows the two run shapes. Rejects unknown roles and tuples. */
export function compile(
  plan: RunPlan,
  resolveRole: (role: string) => readonly ModelChoice[],
  origin: Origin,
): { ok: true; jobs: JobDraft[] } | { ok: false; error: string } {
  const originTuple: Tuple = {
    kind: "tuple",
    provider: origin.providerId,
    model: origin.model,
    reasoningLevel: origin.reasoningLevel,
  };
  const resolve = (choice: ModelChoice): Tuple => (choice.kind === "tuple" ? choice : originTuple);
  const models: Models = (ref) => {
    if ("role" in ref) {
      const choices = resolveRole(ref.role);
      if (choices.length === 0) throw new CompileError(`unknown role "${ref.role}"`);
      return choices.map(resolve);
    }
    const choice = parseChoice(ref.tuple);
    if (!choice) throw new CompileError(`"${ref.tuple}" is not "provider/model/level" or "inherit-parent"`);
    return [resolve(choice)];
  };

  try {
    return { ok: true, jobs: plan.kind === "panel" ? compilePanel(plan, models, origin) : compileSwarm(plan, models) };
  } catch (error) {
    if (error instanceof CompileError) return { ok: false, error: error.message };
    throw error;
  }
}

type Models = (ref: { role: string } | { tuple: string }) => Tuple[];

function compilePanel(plan: Extract<RunPlan, { kind: "panel" }>, models: Models, origin: Origin): JobDraft[] {
  const expanded = plan.seats.flatMap((seat) => models(seat.model).map((model) => ({ seat, model })));
  if (expanded.length > MAX_SEATS) throw new CompileError(`${expanded.length} seats after role expansion; the limit is ${MAX_SEATS}`);
  const seats: JobDraft[] = expanded.map(({ seat, model }, index) => ({
    key: `seat-${index + 1}`,
    kind: "seat",
    label: seat.label.replaceAll("{letter}", seatLetter(index)).replaceAll("{n}", String(index + 1)),
    model,
    prompt: seat.prompt,
    result: seat.result,
    after: [],
    quorum: 0,
    slice: null,
  }));
  const duplicate = seats.find((seat, index) => seats.findIndex((other) => other.label === seat.label) !== index);
  if (duplicate) {
    throw new CompileError(`seat label "${duplicate.label}" repeats; put {letter} or {n} in a label whose role expands to several models`);
  }
  if (!plan.judge) return seats;

  const quorum = plan.failure.kind === "all-required" ? seats.length : plan.failure.minimum;
  if (quorum > seats.length) throw new CompileError(`quorum ${quorum} is more than the ${seats.length} seats`);
  const pool = models(plan.judge.model);
  const judge: JobDraft = {
    key: "judge",
    kind: "judge",
    label: plan.judge.label,
    model: pool.find((model) => model.provider !== origin.providerId) ?? pool[0]!,
    prompt: plan.judge.prompt,
    result: plan.judge.result,
    after: seats.map((seat) => seat.key),
    quorum,
    slice: null,
  };
  return [...seats, judge];
}

function compileSwarm(plan: Extract<RunPlan, { kind: "swarm" }>, models: Models): JobDraft[] {
  const slices = plan.slices.map((slice) => (typeof slice === "string" ? { name: slice } : slice));
  const duplicate = slices.find((slice, index) => slices.findIndex((other) => other.name === slice.name) !== index);
  if (duplicate) throw new CompileError(`slice "${duplicate.name}" repeats`);
  return slices.flatMap((slice, index): JobDraft[] => {
    const key = `slice-${index + 1}`;
    const worker: JobDraft = {
      key,
      kind: "slice",
      label: slice.name,
      model: models(slice.model ?? plan.model)[0]!,
      prompt: [plan.brief, `Your slice: ${slice.name}`, slice.brief].filter(Boolean).join("\n\n"),
      result: "report",
      after: [],
      quorum: 0,
      slice: slice.name,
    };
    if (!plan.verify) return [worker];
    const verifier: JobDraft = {
      key: `verify-${index + 1}`,
      kind: "verifier",
      label: `Verify ${slice.name}`,
      model: models(plan.verify.model ?? plan.model)[0]!,
      prompt: plan.verify.prompt,
      result: "verdict",
      after: [key],
      quorum: 1,
      slice: slice.name,
    };
    return [worker, verifier];
  });
}

function seatLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export type JobState = "blocked" | "queued" | "running" | "repairing" | "uncertain" | "succeeded" | "failed" | "skipped" | "cancelled";

export type AttemptSnapshot = {
  ordinal: number;
  state: "issued" | "attached" | "finished";
  threadId: string | null;
  issuedAt: number;
  finishedAt: number | null;
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

const TERMINAL: ReadonlySet<JobState> = new Set(["succeeded", "failed", "skipped", "cancelled"]);
/** States in which a job's latest attempt may own a live worker thread. */
export const LIVE: ReadonlySet<JobState> = new Set(["running", "repairing", "uncertain"]);

function retryable(job: JobSnapshot): boolean {
  return (
    job.state === "failed" &&
    job.error !== null &&
    job.providerRetries < PROVIDER_RETRY_DELAYS_MS.length &&
    classifyFailure(job.error) === "transient"
  );
}

function settled(job: JobSnapshot): boolean {
  return TERMINAL.has(job.state) && !retryable(job);
}

/** The attempt that may own a worker right now, or null while a running job still has to claim one. */
export function liveAttempt(job: JobSnapshot): AttemptSnapshot | null {
  const latest = job.attempts.at(-1);
  return LIVE.has(job.state) && latest && latest.state !== "finished" ? latest : null;
}

/**
 * Pure reconciler. Releases a blocked judge/verifier once its inputs are terminal (materializing its prompt
 * with every input's outcome, failures named, findings tagged `A.1`), skips it when the quorum is missed,
 * schedules spawns within the concurrency limit (verifiers before unstarted slices), schedules provider
 * retries (2, at 1 s and 4 s), fails jobs past the deadline, and finishes the run when every job is terminal.
 */
export function plan(run: RunSnapshot, now: number): Action[] {
  if (run.status !== "running") return [];
  if (now >= run.deadline) {
    const open = run.jobs.filter((job) => !TERMINAL.has(job.state));
    if (open.length > 0) return open.map((job) => ({ type: "fail", job: job.key, error: "the run deadline passed" }));
    return [{ type: "finish", status: finalStatus(run.jobs) }];
  }

  const byKey = new Map(run.jobs.map((job) => [job.key, job]));
  const actions: Action[] = [];
  const due: JobSnapshot[] = [];
  for (const job of run.jobs) {
    switch (job.state) {
      case "blocked": {
        const inputs = job.after.map((key) => byKey.get(key)!);
        if (!inputs.every(settled)) break;
        const succeeded = inputs.filter((input) => input.state === "succeeded").length;
        actions.push(
          succeeded >= job.quorum
            ? { type: "release", job: job.key, prompt: materialize(job, inputs, run.jobs) }
            : { type: "skip", job: job.key, reason: `${succeeded} of ${inputs.length} inputs succeeded; ${job.quorum} required` },
        );
        break;
      }
      case "queued":
        if (job.nextActionAt === null || job.nextActionAt <= now) due.push(job);
        break;
      case "running":
        if (!liveAttempt(job)) actions.push({ type: "spawn", job: job.key, ordinal: job.attempts.length + 1 });
        break;
      case "repairing":
        actions.push(
          job.repairs < MAX_REPAIRS
            ? { type: "repair", job: job.key, message: repairMessage(job) }
            : { type: "fail", job: job.key, error: `the result was still invalid after ${MAX_REPAIRS} corrective turns: ${job.error}` },
        );
        break;
      case "failed":
        if (retryable(job)) actions.push({ type: "retry", job: job.key, at: now + PROVIDER_RETRY_DELAYS_MS[job.providerRetries]! });
        break;
    }
  }

  const active = run.jobs.filter((job) => LIVE.has(job.state)).length;
  const order = (job: JobSnapshot) => (job.kind === "verifier" ? 0 : 1);
  const ranked = due.map((job, index) => ({ job, index })).sort((a, b) => order(a.job) - order(b.job) || a.index - b.index);
  for (const { job } of ranked.slice(0, Math.max(0, CONCURRENCY - active))) {
    actions.push({ type: "spawn", job: job.key, ordinal: job.attempts.length + 1 });
  }

  if (actions.length === 0 && run.jobs.every(settled)) actions.push({ type: "finish", status: finalStatus(run.jobs) });
  return actions;
}

function repairMessage(job: JobSnapshot): string {
  return [
    `Your result does not match the \`${job.result}\` contract: ${job.error}`,
    `Call \`pstack_result\` exactly once with \`{ "value": ... }\` matching the contract. Corrective turn ${job.repairs + 1} of ${MAX_REPAIRS}.`,
  ].join("\n\n");
}

function seatLetters(jobs: readonly JobSnapshot[]): Map<string, string> {
  return new Map(jobs.filter((job) => job.kind === "seat").map((job, index) => [job.key, seatLetter(index)]));
}

function materialize(job: JobSnapshot, inputs: readonly JobSnapshot[], jobs: readonly JobSnapshot[]): string {
  const letters = seatLetters(jobs);
  const failed = inputs.filter((input) => input.state !== "succeeded");
  const tally = `${inputs.length - failed.length} of ${inputs.length} inputs succeeded.`;
  const named = failed.length > 0 ? ` Did not succeed: ${failed.map((input) => input.label).join(", ")}.` : "";
  const refs = inputs.some((input) => input.result === "review" && input.state === "succeeded")
    ? "\nEach finding carries a ref such as A.1 (seat letter, finding number). Refer to findings only by these refs."
    : "";
  const sections = inputs.map((input) => {
    const head = `### ${input.label} (${formatChoice(input.model)}): ${input.state}`;
    if (input.state !== "succeeded") return `${head}\n${input.error ?? "no result"}`;
    return `${head}\n${formatValue(input.result, input.value, letters.get(input.key) ?? null)}`;
  });
  return [job.prompt, `## Inputs\n\n${tally}${named}${refs}`, ...sections].join("\n\n");
}

function formatValue(kind: ResultKind, value: unknown, letter: string | null): string {
  if (kind === "text") return String(value);
  if (kind === "review" && letter !== null) {
    const { findings } = value as ResultValueOf<"review">;
    if (findings.length === 0) return "No findings.";
    return findings
      .map((finding, index) => {
        const lines = [`- ${letter}.${index + 1} [${finding.severity}] ${finding.title} (${finding.location})`, `  ${finding.detail}`];
        if (finding.suggestion) lines.push(`  Suggestion: ${finding.suggestion}`);
        return lines.join("\n");
      })
      .join("\n");
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

type ResultValueOf<K extends ResultKind> = z.infer<(typeof RESULT_SCHEMAS)[K]>;

/** Pure: the run status derived from job states. */
export function deriveStatus(jobs: readonly JobSnapshot[]): RunSnapshot["status"] {
  if (jobs.some((job) => !TERMINAL.has(job.state)) && !jobs.some((job) => job.state === "cancelled")) return "running";
  return finalStatus(jobs);
}

function finalStatus(jobs: readonly JobSnapshot[]): Exclude<RunSnapshot["status"], "running"> {
  if (jobs.some((job) => job.state === "cancelled")) return "cancelled";
  const succeeded = jobs.filter((job) => job.state === "succeeded").length;
  if (succeeded === jobs.length) return "succeeded";
  return succeeded === 0 ? "failed" : "partial";
}

const TRANSIENT_PATTERNS = [
  /provider[^\n]*(?:overload|capacity|busy|temporar|unavailable|rate.?limit)/,
  /(?:rate.?limit|too many requests)/,
  /(?:http|status|api error|error)\s*(?:429|500|502|503|504|529)\b/,
  /\b(?:econnreset|econnrefused|etimedout|ehostunreach|enetunreach)\b/,
  /(?:connection reset|connection closed|socket hang up|network error)/,
];

/** Pure: transient provider failure (retry on a fresh thread) vs everything else (fail). */
export function classifyFailure(error: string): "transient" | "permanent" {
  const detail = error.toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail)) ? "transient" : "permanent";
}

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```/gi)];
  const candidates = fences.length === 1 ? [trimmed, fences[0]![1]!] : [trimmed];
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {}
  }
  return { ok: false, error: "the final message is not a JSON value or a single fenced JSON block" };
}

/** Pure: parse a worker's final text or submitted value against its contract. */
export function acceptResult(kind: ResultKind, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  let candidate = value;
  if (kind !== "text" && typeof value === "string") {
    const parsed = parseJsonText(value);
    if (!parsed.ok) return parsed;
    candidate = parsed.value;
  }
  const result = RESULT_SCHEMAS[kind].safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: z.prettifyError(result.error).slice(0, 2_000) };
}

type RefFinding = RunView["findings"][number];

function findingsOf(jobs: readonly JobSnapshot[]): RefFinding[] {
  const letters = seatLetters(jobs);
  return jobs.flatMap((job) => {
    if (job.kind !== "seat" || job.result !== "review" || job.state !== "succeeded") return [];
    const { findings } = job.value as ResultValueOf<"review">;
    return findings.map((finding, index) => ({ ...finding, ref: `${letters.get(job.key)}.${index + 1}`, seat: job.label }));
  });
}

/** Pure: every grouping ref names a seat finding, and no ref appears in two groups. */
export function checkGrouping(grouping: ResultValueOf<"grouping">, refs: ReadonlySet<string>): string | null {
  const seen = new Set<string>();
  for (const group of grouping.groups) {
    for (const ref of group.members) {
      if (!refs.has(ref)) return `group "${group.title}" names ${ref}, which is not a seat finding`;
      if (seen.has(ref)) return `${ref} appears in more than one group`;
      seen.add(ref);
    }
  }
  return null;
}

const SEVERITY_RANK = { critical: 3, warning: 2, nit: 1 } as const;

function matrixOf(jobs: readonly JobSnapshot[], findings: readonly RefFinding[]): RunView["matrix"] {
  const judge = jobs.find((job) => job.kind === "judge");
  if (!judge || judge.result !== "grouping" || judge.state !== "succeeded") return null;
  const grouping = judge.value as ResultValueOf<"grouping">;
  const byRef = new Map(findings.map((finding) => [finding.ref, finding]));
  if (checkGrouping(grouping, new Set(byRef.keys())) !== null) return null;

  const seats = jobs.filter((job) => job.kind === "seat").map((job) => job.label);
  const row = (members: readonly RefFinding[]) => {
    const cells: Record<string, RefFinding["severity"] | null> = Object.fromEntries(seats.map((seat) => [seat, null]));
    for (const finding of members) {
      const current = cells[finding.seat];
      if (!current || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current]) cells[finding.seat] = finding.severity;
    }
    return cells;
  };
  const grouped = new Set(grouping.groups.flatMap((group) => group.members));
  return [
    ...grouping.groups.map((group) => ({
      title: group.title,
      severity: group.severity,
      verdict: group.verdict,
      cells: row(group.members.map((ref) => byRef.get(ref)!)),
    })),
    ...findings
      .filter((finding) => !grouped.has(finding.ref))
      .map((finding) => ({ title: finding.title, severity: finding.severity, verdict: null, cells: row([finding]) })),
  ];
}

function summaryOf(job: JobSnapshot): string | null {
  if (job.state !== "succeeded") return null;
  switch (job.result) {
    case "text": {
      const line = String(job.value).trim().split("\n")[0] ?? "";
      return line.length > 80 ? `${line.slice(0, 79)}…` : line;
    }
    case "review": {
      const count = (job.value as ResultValueOf<"review">).findings.length;
      return `${count} finding${count === 1 ? "" : "s"}`;
    }
    case "grouping": {
      const count = (job.value as ResultValueOf<"grouping">).groups.length;
      return `${count} group${count === 1 ? "" : "s"}`;
    }
    case "report":
      return (job.value as ResultValueOf<"report">).status;
    case "verdict":
      return (job.value as ResultValueOf<"verdict">).verdict;
  }
}

/** Pure: snapshot → UI view, including findings with refs and the agreement matrix from a `grouping` judge. */
export function toView(run: RunSnapshot, meta: { kind: "panel" | "swarm"; title: string; createdAt: number; finishedAt: number | null }): RunView {
  const findings = findingsOf(run.jobs);
  return {
    id: run.id,
    kind: meta.kind,
    title: meta.title,
    status: run.status,
    createdAt: meta.createdAt,
    finishedAt: meta.finishedAt,
    jobs: run.jobs.map((job) => {
      const latest = job.attempts.at(-1) ?? null;
      return {
        key: job.key,
        kind: job.kind,
        label: job.label,
        model: formatChoice(job.model),
        state: job.state,
        attempt: Math.max(1, job.attempts.length),
        threadId: latest?.threadId ?? null,
        startedAt: job.attempts[0]?.issuedAt ?? null,
        finishedAt: TERMINAL.has(job.state) ? (latest?.finishedAt ?? null) : null,
        error: job.error,
        summary: summaryOf(job),
        slice: job.slice,
      };
    }),
    findings,
    matrix: matrixOf(run.jobs, findings),
  };
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
