/**
 * Panel and swarm runs. A run is a fixed set of jobs inserted up front:
 *   panel: one `seat` job per seat, plus an optional `judge` job blocked on every seat;
 *   swarm: one `slice` job per slice, plus an optional `verifier` job blocked on its own slice only.
 * `plan()` is a pure, level-triggered reconciler: given a snapshot it returns the transitions to apply.
 * The engine (createRunner) applies each with a compare-and-set in run-store.ts, so applying one twice does
 * nothing. Events, a 15 s maintenance tick, and startup all just call tick(runId).
 *
 * Restart rule: an attempt is persisted as `issued` before threads.spawn. If the spawn call fails or the
 * process dies before the thread id is attached, a hidden plugin-owned thread whose metadata names the attempt
 * is adopted, by an event or by a tick's scan, and until then the job is `uncertain`, up to the run deadline.
 * It never spawns again for an issued attempt, because the SDK spawn has no idempotency key and a late success
 * would duplicate the seat or judge. A thread whose attempt is no longer live is stopped.
 *
 * Cleanup rule: once an attempt finishes (accepted, failed, past the deadline or cancelled), its worker is
 * stopped by every tick of its run, finished or not, until a stop succeeds or the thread is gone.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RESULT_SCHEMAS, STATE_CHANNEL, type Reads, type ResultKind, type RunPlan, type RunView } from "./contract.ts";
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
  reads: Reads;
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
    const jobs = plan.kind === "panel" ? compilePanel(plan, models, origin) : compileSwarm(plan, models);
    for (const job of jobs) {
      const path = job.reads === "origin" ? null : localPath(job.prompt);
      if (path !== null) {
        throw new CompileError(`${job.label} reads "${job.reads}", but its prompt names ${path}, which exists only on this machine; put the content in the prompt or read "origin"`);
      }
    }
    return { ok: true, jobs };
  } catch (error) {
    if (error instanceof CompileError) return { ok: false, error: error.message };
    throw error;
  }
}

type Models = (ref: { role: string } | { tuple: string }) => Tuple[];

const LOCAL_PATH = /(?:^|[\s"'`(=:])((?:\/(?:Users|home|root|tmp|private|var|Volumes|mnt)\/|~\/|\$\{?(?:BB_THREAD_STORAGE|TMPDIR|HOME)\b)[^\s"'`)]*)/;

/** Pure: the first path in `text` under a home, temp, or thread-storage directory, which another machine does not have. */
export function localPath(text: string): string | null {
  return LOCAL_PATH.exec(text)?.[1] ?? null;
}


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
    reads: seat.reads,
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
    reads: plan.judge.reads,
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
      reads: slice.reads ?? plan.reads,
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
      reads: plan.verify.reads,
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

export const TERMINAL: ReadonlySet<JobState> = new Set(["succeeded", "failed", "skipped", "cancelled"]);
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

  const holdSpawnsWhileReleasing = actions.some((action) => action.type === "release");
  const active = run.jobs.filter((job) => LIVE.has(job.state)).length;
  const order = (job: JobSnapshot) => (job.kind === "verifier" ? 0 : 1);
  const ranked = due.map((job, index) => ({ job, index })).sort((a, b) => order(a.job) - order(b.job) || a.index - b.index);
  for (const { job } of holdSpawnsWhileReleasing ? [] : ranked.slice(0, Math.max(0, CONCURRENCY - active))) {
    actions.push({ type: "spawn", job: job.key, ordinal: job.attempts.length + 1 });
  }

  if (actions.length === 0 && run.jobs.every(settled)) actions.push({ type: "finish", status: finalStatus(run.jobs) });
  return actions;
}

function repairMessage(job: JobSnapshot): string {
  const turn = `Corrective turn ${job.repairs + 1} of ${MAX_REPAIRS}.`;
  if (job.result === "text") return `Your final message is your result, and ${job.error}. Reply with your result as your final message. ${turn}`;
  return [
    `Your result does not match the \`${job.result}\` contract: ${job.error}`,
    `Call \`pstack_result\` exactly once with \`{ "value": ... }\` matching the contract. ${turn}`,
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
  if (succeeded === jobs.length) return jobs.some(weakOutcome) ? "partial" : "succeeded";
  return succeeded === 0 ? "failed" : "partial";
}

function weakOutcome(job: JobSnapshot): boolean {
  const value = job.value as { status?: unknown; verdict?: unknown } | null;
  if (job.kind === "slice") return value?.status === "BLOCKED";
  if (job.kind === "verifier") return value?.verdict !== "VERIFIED";
  return false;
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
  if (kind === "text" && (typeof value !== "string" || value.trim() === "")) return { ok: false, error: "it was empty" };
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


function resultSchema(kind: ResultKind): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(RESULT_SCHEMAS[kind]) as Record<string, unknown>;
  return schema;
}

export function resultToolParameters(kind: ResultKind): Record<string, unknown> {
  return { type: "object", properties: { value: resultSchema(kind) }, required: ["value"], additionalProperties: false };
}

export function workerPrompt(job: Pick<JobDraft, "prompt" | "result" | "slice">): string {
  if (job.result === "text") {
    return `${job.prompt}\n\n## Result\n\nYour final message is the result. It goes back to the thread that started this run exactly as you write it.`;
  }
  const slice = job.slice === null ? "" : `\n\nSet "slice" to ${JSON.stringify(job.slice)}.`;
  return [
    job.prompt,
    "## Result",
    "This contract replaces any output format described above. Call the `pstack_result` tool exactly once with `{ \"value\": <result> }`, where the result matches this JSON Schema. Your final message is not the result.",
    `\`\`\`json\n${JSON.stringify(resultSchema(job.result), null, 2)}\n\`\`\`${slice}`,
    "If the tool is unavailable, end your final message with the result alone in one ```json block.",
  ].join("\n\n");
}

const COMPLETION_MAX_CHARS = 16_000;

export function completionMessage(run: RunSnapshot, meta: { kind: "panel" | "swarm"; title: string }): string {
  const letters = seatLetters(run.jobs);
  const budget = Math.floor((COMPLETION_MAX_CHARS - 1_000) / run.jobs.length);
  const sections = run.jobs.map((job) => {
    const summary = summaryOf(job);
    const head = `### ${job.label} (${formatChoice(job.model)}): ${job.state}${summary ? `, ${summary}` : ""}`;
    if (job.state !== "succeeded") return job.error ? `${head}\n${clip(job.error, Math.max(budget, 200))}` : head;
    if (budget < 200) return head;
    return `${head}\n${clip(formatValue(job.result, job.value, letters.get(job.key) ?? null), budget)}`;
  });
  return [
    `pstack ${meta.kind} run ${run.id} "${meta.title}" finished: ${run.status}.`,
    ...sections,
    `Full results: \`bb pstack run status ${run.id} --json\`.`,
  ].join("\n\n");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 40)}\n… (truncated; see run status)` : text;
}

export class RunnerError extends Error {
  readonly code: "plan_invalid" | "request_key_conflict" | "origin_unavailable" | "run_not_found";
  constructor(code: RunnerError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type JobResult = { key: string; kind: JobKind; label: string; state: JobState; value: unknown; error: string | null };

export type Runner = {
  start(plan: RunPlan, originThreadId: string): Promise<{ runId: RunId; existing: boolean }>;
  stop(runId: RunId, originThreadId: string): Promise<boolean>;
  /** Worker side: `pstack_result({ value })`, identity from the tool's thread id. */
  submit(workerThreadId: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  view(runId: RunId, originThreadId: string): RunView;
  results(runId: RunId, originThreadId: string): JobResult[];
  activeRuns(originThreadId: string): RunId[];
  workerResult(threadId: string, pluginMetadata: unknown): ResultKind | null;
  /** Lifecycle hooks; each only records the observation and calls tick. */
  onIdle(threadId: string, lastAssistantText: string | null): Promise<void>;
  onFailed(threadId: string, error: string | null): Promise<void>;
  onGone(threadId: string): Promise<void>;
  tick(runId: RunId): Promise<void>;
  /** Background service body: recover, then tick due runs every 15 s until the signal aborts. */
  serve(signal: AbortSignal): Promise<void>;
};

const WorkerMetadata = z.object({
  pstackWorker: z.literal(1),
  runId: z.string(),
  job: z.string(),
  ordinal: z.number().int(),
  originThreadId: z.string(),
});

type AttemptRef = { runId: RunId; key: string; ordinal: number };

const POLL_INTERVAL_MS = 15_000;
const REPAIR_POLL_GRACE_MS = 30_000;
const NOTIFY_RETRY_BASE_MS = 1_000;
const NOTIFY_RETRY_MAX_MS = 60 * 60 * 1_000;
const MAX_ROUNDS = 20;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingThread(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === "thread_not_found";
}

const attemptId = (runId: string, key: string, ordinal: number) => `${runId}/${key}/${ordinal}`;
const refOf = (metadata: z.infer<typeof WorkerMetadata>): AttemptRef => ({ runId: metadata.runId as RunId, key: metadata.job, ordinal: metadata.ordinal });

/** The engine: the only module that calls bb.sdk.threads.*. Applies plan() actions via store CAS transitions. */
export function createRunner(
  bb: BbPluginApi,
  store: RunStore,
  resolveRole: (role: string) => readonly ModelChoice[],
  clock: () => number = Date.now,
  /** Returns one problem per tuple the live catalog on the origin's host does not offer. */
  modelProblems: (tuples: readonly string[], environmentId: string) => Promise<string[]> = async () => [],
): Runner {
  const spawning = new Set<string>();
  const notifying = new Set<RunId>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const published = new Map<string, number>();
  function publish(threadId: string): void {
    const revision = store.revision(threadId);
    if (published.get(threadId) === revision) return;
    published.set(threadId, revision);
    bb.realtime.publish(STATE_CHANNEL, { threadId, revision });
  }

  function wakeAt(runId: RunId, at: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reconcile(runId).catch((error) => bb.log.error(`pstack run ${runId}: ${message(error)}`));
    }, Math.max(0, at - clock()));
    timer.unref?.();
    timers.add(timer);
  }

  async function stopWorker(threadId: string): Promise<boolean> {
    try {
      await bb.sdk.threads.stop({ threadId });
      return true;
    } catch (error) {
      if (isMissingThread(error)) return true;
      bb.log.warn(`Could not stop pstack worker ${threadId}: ${message(error)}`);
      return false;
    }
  }

  /** Stops every worker whose attempt finished, and records each confirmed stop so a failed one is retried by the next tick. */
  async function cleanUp(runId: RunId): Promise<void> {
    await Promise.all(
      store.pendingCleanup(runId).map(async (threadId) => {
        if (await stopWorker(threadId)) store.markCleaned(threadId);
      }),
    );
  }

  function currentJob(ref: AttemptRef): { snapshot: RunSnapshot; job: JobSnapshot } | null {
    const snapshot = store.snapshot(ref.runId);
    const job = snapshot?.jobs.find((candidate) => candidate.key === ref.key);
    if (!snapshot || !job || liveAttempt(job)?.ordinal !== ref.ordinal) return null;
    return { snapshot, job };
  }

  function accept(job: JobSnapshot, snapshot: RunSnapshot, value: unknown) {
    const accepted = acceptResult(job.result, value);
    if (!accepted.ok) return accepted;
    let error: string | null = null;
    if (job.kind === "judge" && job.result === "grouping") {
      error = checkGrouping(accepted.value as ResultValueOf<"grouping">, new Set(findingsOf(snapshot.jobs).map((finding) => finding.ref)));
    } else if ((job.result === "report" || job.result === "verdict") && job.slice !== null) {
      const { slice } = accepted.value as ResultValueOf<"report" | "verdict">;
      if (slice !== job.slice) error = `"slice" is ${JSON.stringify(slice)}, but this job's slice is ${JSON.stringify(job.slice)}`;
    }
    return error === null ? accepted : { ok: false as const, error };
  }

  function observeIdle(ref: AttemptRef, text: string | null): void {
    const current = currentJob(ref);
    if (!current || current.job.state !== "running") return;
    if ((current.job.nextActionAt ?? 0) > clock()) return;
    const accepted = accept(current.job, current.snapshot, text ?? "");
    if (accepted.ok) store.transitionJobAndAttempt(ref.runId, ref.key, "running", "succeeded", { valueJson: JSON.stringify(accepted.value), error: null });
    else store.transitionJobAndAttempt(ref.runId, ref.key, "running", "repairing", { error: accepted.error });
  }

  function observeFailed(ref: AttemptRef, error: string): void {
    const current = currentJob(ref);
    if (current) store.transitionJobAndAttempt(ref.runId, ref.key, current.job.state, "failed", { error });
  }

  /** Plugin-owned worker threads not yet bound to an attempt, with the attempt their metadata names. */
  async function unboundWorkers(): Promise<{ threadId: string; ref: AttemptRef }[]> {
    const workers: { threadId: string; ref: AttemptRef }[] = [];
    for (let offset = 0; ; ) {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false, limit: 100, offset });
      for (const thread of threads) {
        if (store.attemptByThread(thread.id)) continue;
        const metadata = WorkerMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null));
        if (metadata.success) workers.push({ threadId: thread.id, ref: refOf(metadata.data) });
      }
      if (threads.length < 100) return workers;
      offset += threads.length;
    }
  }

  function adoptInto(threadId: string, ref: AttemptRef): AttemptRef | null {
    const job = store.snapshot(ref.runId)?.jobs.find((candidate) => candidate.key === ref.key);
    if (!job || liveAttempt(job)?.ordinal !== ref.ordinal) return null;
    if (store.attachAttempt(ref.runId, ref.key, ref.ordinal, threadId) && job.state === "uncertain") {
      store.transitionJobAndAttempt(ref.runId, ref.key, "uncertain", "running", { error: null });
    }
    return store.attemptByThread(threadId);
  }

  /** Stops a worker whose attempt is no longer live, recorded on that attempt so a failed stop is retried. */
  async function retire(threadId: string, ref: AttemptRef): Promise<void> {
    if (store.recordLateThread(ref.runId, ref.key, ref.ordinal, threadId)) await cleanUp(ref.runId);
    else await stopWorker(threadId);
  }

  /** Binds an unbound worker thread to its live attempt, or retires it, so a late duplicate never runs hidden. */
  async function claim(threadId: string, ref: AttemptRef): Promise<AttemptRef | null> {
    const adopted = adoptInto(threadId, ref);
    if (!adopted) await retire(threadId, ref);
    return adopted;
  }

  async function locate(threadId: string): Promise<AttemptRef | null> {
    const known = store.attemptByThread(threadId);
    if (known) return known;
    let metadata;
    try {
      metadata = WorkerMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }));
    } catch {
      return null;
    }
    if (!metadata.success) return null;
    return claim(threadId, refOf(metadata.data));
  }

  async function checkWorker(ref: AttemptRef, threadId: string): Promise<void> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) observeFailed(ref, "the worker thread was archived or deleted");
      else if (thread.status === "idle") observeIdle(ref, (await bb.sdk.threads.output({ threadId })).output);
      else if (thread.status === "error") observeFailed(ref, "the worker thread failed");
    } catch (error) {
      if (isMissingThread(error)) observeFailed(ref, "the worker thread was archived or deleted");
      else bb.log.warn(`Could not check pstack worker ${threadId}: ${message(error)}`);
    }
  }

  async function spawn(runId: RunId, job: JobSnapshot, ordinal: number): Promise<boolean> {
    store.transitionJobAndAttempt(runId, job.key, "queued", "running", { error: null, nextActionAt: null });
    if (!store.claimAttempt(runId, job.key, ordinal, clock())) return false;
    const info = store.info(runId)!;
    const origin = info.origin;
    const id = attemptId(runId, job.key, ordinal);
    const ref: AttemptRef = { runId, key: job.key, ordinal };
    spawning.add(id);
    try {
      let threadId: string | null;
      try {
        const thread = await bb.sdk.threads.spawn({
          lifecycleOwnerThreadId: origin.threadId,
          pluginMetadata: { pstackWorker: 1, runId, job: job.key, ordinal, originThreadId: origin.threadId },
          projectId: origin.projectId,
          environment: { type: "reuse", environmentId: origin.environmentId },
          prompt: workerPrompt(job),
          title: `${info.title} · ${job.label}`,
          providerId: job.model.provider,
          model: job.model.model,
          reasoningLevel: job.model.reasoningLevel as never,
          permissionMode: origin.permissionMode as never,
          visibility: "hidden",
        });
        threadId = thread.id;
      } catch (error) {
        // The server may have created the thread, or may still create it, so no error proves it does not exist.
        const workers = await unboundWorkers().catch(() => []);
        threadId = workers.find((worker) => attemptId(worker.ref.runId, worker.ref.key, worker.ref.ordinal) === id)?.threadId ?? null;
        if (threadId === null) {
          store.transitionJobAndAttempt(runId, job.key, "running", "uncertain", { error: `the worker may not have started: ${message(error)}` });
          return true;
        }
      }
      if (!store.attachAttempt(runId, job.key, ordinal, threadId)) {
        const owner = store.attemptByThread(threadId);
        if (!owner || attemptId(owner.runId, owner.key, owner.ordinal) !== id) {
          await retire(threadId, ref);
          return true;
        }
      }
      publish(origin.threadId);
      await checkWorker(ref, threadId);
      return true;
    } finally {
      spawning.delete(id);
    }
  }

  async function apply(snapshot: RunSnapshot, action: Action): Promise<boolean> {
    const runId = snapshot.id;
    if (action.type === "finish") return store.finishRun(runId, action.status, clock());
    const job = snapshot.jobs.find((candidate) => candidate.key === action.job)!;
    switch (action.type) {
      case "release":
        return store.transitionJobAndAttempt(runId, job.key, "blocked", "queued", { releasedPrompt: action.prompt });
      case "skip":
        return store.transitionJobAndAttempt(runId, job.key, "blocked", "skipped", { error: action.reason });
      case "spawn":
        return spawn(runId, job, action.ordinal);
      case "retry": {
        const moved = store.transitionJobAndAttempt(runId, job.key, "failed", "queued", { nextActionAt: action.at, providerRetries: job.providerRetries + 1 });
        if (moved) wakeAt(runId, action.at);
        return moved;
      }
      case "fail":
        return store.transitionJobAndAttempt(runId, job.key, job.state, "failed", { error: action.error });
      case "repair": {
        const threadId = liveAttempt(job)?.threadId;
        if (!threadId) return store.transitionJobAndAttempt(runId, job.key, "repairing", "failed", { error: "the worker thread is unknown" });
        const moved = store.transitionJobAndAttempt(runId, job.key, "repairing", "running", {
          repairs: job.repairs + 1,
          error: null,
          nextActionAt: clock() + REPAIR_POLL_GRACE_MS,
        });
        if (!moved) return false;
        try {
          await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: action.message, mentions: [] }] });
        } catch (error) {
          store.transitionJobAndAttempt(runId, job.key, "running", "failed", { error: `could not send the corrective turn: ${message(error)}` });
        }
        return true;
      }
    }
  }

  async function pollWorkers(snapshot: RunSnapshot): Promise<void> {
    await Promise.all(
      snapshot.jobs.map((job) => {
        const attempt = liveAttempt(job);
        if (job.state !== "running" || !attempt?.threadId || (job.nextActionAt ?? 0) > clock()) return;
        return checkWorker({ runId: snapshot.id, key: job.key, ordinal: attempt.ordinal }, attempt.threadId);
      }),
    );
  }

  async function reconcile(runId: RunId, poll = false): Promise<void> {
    const info = store.info(runId);
    if (!info) return;
    if (info.status === "running") {
      if (poll) {
        await recover([runId]).catch((error) => bb.log.warn(`Could not look for pstack workers of ${runId}: ${message(error)}`));
        await pollWorkers(store.snapshot(runId)!);
      }
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const snapshot = store.snapshot(runId)!;
        const actions = plan(snapshot, clock());
        if (actions.length === 0) break;
        const changed = await Promise.all(actions.map((action) => apply(snapshot, action)));
        if (!changed.some(Boolean)) break;
      }
    }
    await cleanUp(runId);
    publish(info.origin.threadId);
    await notify(runId);
  }

  async function originGone(threadId: string): Promise<boolean> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.archivedAt !== null || thread.deletedAt !== null;
    } catch (error) {
      if (isMissingThread(error)) return true;
      throw error;
    }
  }

  async function notify(runId: RunId): Promise<void> {
    const info = store.info(runId);
    if (!info || info.status === "running" || info.notify.state !== "pending" || (info.notify.nextAt ?? 0) > clock()) return;
    if (notifying.has(runId)) return;
    notifying.add(runId);
    try {
      if (await originGone(info.origin.threadId)) {
        store.settleNotification(runId, "abandoned");
        return;
      }
      await bb.sdk.threads.send({
        threadId: info.origin.threadId,
        mode: "steer-if-active",
        input: [{ type: "text", text: completionMessage(store.snapshot(runId)!, info), mentions: [], visibility: "agent-only" }],
      });
      store.settleNotification(runId, "sent");
    } catch (error) {
      if (isMissingThread(error)) {
        store.settleNotification(runId, "abandoned");
        return;
      }
      const delay = Math.min(NOTIFY_RETRY_MAX_MS, NOTIFY_RETRY_BASE_MS * 2 ** Math.min(info.notify.attempts, 20));
      store.deferNotification(runId, clock() + delay);
      wakeAt(runId, clock() + delay);
      bb.log.warn(`Could not deliver pstack run ${runId} to ${info.origin.threadId}; retrying in ${delay} ms: ${message(error)}`);
    } finally {
      notifying.delete(runId);
    }
  }

  async function cancel(runId: RunId): Promise<boolean> {
    if (!store.cancelRun(runId, clock())) return false;
    await cleanUp(runId);
    publish(store.info(runId)!.origin.threadId);
    return true;
  }

  /**
   * For issued attempts with no spawn call in flight: claims every unbound worker thread, and marks a running
   * job whose attempt is still unbound uncertain. Lists threads only while such an attempt exists.
   */
  async function recover(runIds: readonly RunId[]): Promise<void> {
    const issued = new Map<string, AttemptRef>();
    for (const runId of runIds) {
      const snapshot = store.snapshot(runId);
      if (snapshot?.status !== "running") continue;
      for (const job of snapshot.jobs) {
        const attempt = liveAttempt(job);
        const id = attempt && attemptId(runId, job.key, attempt.ordinal);
        if (attempt?.state === "issued" && !spawning.has(id!)) issued.set(id!, { runId, key: job.key, ordinal: attempt.ordinal });
      }
    }
    if (issued.size === 0) return;
    for (const { threadId, ref } of await unboundWorkers()) {
      if (await claim(threadId, ref)) issued.delete(attemptId(ref.runId, ref.key, ref.ordinal));
    }
    for (const ref of issued.values()) {
      const current = currentJob(ref);
      if (current?.job.state === "running" && liveAttempt(current.job)?.state === "issued") {
        store.transitionJobAndAttempt(ref.runId, ref.key, "running", "uncertain");
      }
    }
  }

  function owned(runId: RunId, originThreadId: string) {
    const info = store.info(runId);
    if (!info || info.origin.threadId !== originThreadId) throw new RunnerError("run_not_found", `no run ${runId} on this thread`);
    return { info, snapshot: store.snapshot(runId)! };
  }

  async function resolveOrigin(threadId: string): Promise<Origin> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) throw new RunnerError("origin_unavailable", "the thread has no environment for workers to reuse");
    const defaults = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    if (defaults === null) throw new RunnerError("origin_unavailable", "the thread has no resolved model, so workers cannot inherit it");
    return {
      threadId,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
      providerId: thread.providerId,
      model: defaults.model,
      reasoningLevel: defaults.reasoningLevel,
      permissionMode: defaults.permissionMode,
    };
  }

  return {
    async start(runPlan, originThreadId) {
      const origin = await resolveOrigin(originThreadId);
      const compiled = compile(runPlan, resolveRole, origin);
      if (!compiled.ok) throw new RunnerError("plan_invalid", compiled.error);
      const problems = await modelProblems([...new Set(compiled.jobs.map((job) => formatChoice(job.model)))], origin.environmentId);
      if (problems.length > 0) throw new RunnerError("plan_invalid", `models not available on this thread's machine: ${problems.join("; ")}`);
      const created = store.createRun({
        id: `psr_${randomUUID()}` as RunId,
        origin,
        requestKey: runPlan.requestKey ?? null,
        planHash: createHash("sha256").update(JSON.stringify(runPlan)).digest("hex"),
        kind: runPlan.kind,
        title: runPlan.title,
        deadline: clock() + RUN_DEADLINE_MS,
        jobs: compiled.jobs,
      });
      if ("conflict" in created) {
        throw new RunnerError("request_key_conflict", `request key "${runPlan.requestKey}" already names a different plan on this thread`);
      }
      publish(originThreadId);
      if (!created.existing) await reconcile(created.id);
      return { runId: created.id, existing: created.existing };
    },

    async stop(runId, originThreadId) {
      owned(runId, originThreadId);
      const stopped = await cancel(runId);
      if (stopped) await notify(runId);
      return stopped;
    },

    async submit(workerThreadId, value) {
      const ref = await locate(workerThreadId);
      const snapshot = ref && store.snapshot(ref.runId);
      const job = snapshot?.jobs.find((candidate) => candidate.key === ref!.key);
      if (!ref || !snapshot || !job) return { ok: false, error: "This thread is not a pstack worker." };
      if (job.result === "text") return { ok: false, error: "This job's result is your final message; do not call pstack_result." };
      const accepted = accept(job, snapshot, value);
      if (job.state === "succeeded" && liveAttempt(job) === null && job.attempts.at(-1)?.ordinal === ref.ordinal) {
        return accepted.ok && JSON.stringify(accepted.value) === JSON.stringify(job.value)
          ? { ok: true }
          : { ok: false, error: "A different result was already accepted for this job." };
      }
      if ((job.state !== "running" && job.state !== "repairing") || liveAttempt(job)?.ordinal !== ref.ordinal) {
        return { ok: false, error: "This worker's job is no longer running." };
      }
      if (!accepted.ok) return accepted;
      if (!store.transitionJobAndAttempt(ref.runId, job.key, job.state, "succeeded", { valueJson: JSON.stringify(accepted.value), error: null })) {
        return { ok: false, error: "This worker's job changed state before the result was recorded." };
      }
      await reconcile(ref.runId);
      return { ok: true };
    },

    view(runId, originThreadId) {
      const { info, snapshot } = owned(runId, originThreadId);
      return toView(snapshot, info);
    },

    results(runId, originThreadId) {
      return owned(runId, originThreadId).snapshot.jobs.map((job) => ({
        key: job.key,
        kind: job.kind,
        label: job.label,
        state: job.state,
        value: job.state === "succeeded" ? job.value : null,
        error: job.error,
      }));
    },

    activeRuns: (originThreadId) => store.runsForThread(originThreadId, true),

    workerResult(threadId, pluginMetadata) {
      const known = store.attemptByThread(threadId);
      const metadata = known ? null : WorkerMetadata.safeParse(pluginMetadata);
      const ref = known ?? (metadata?.success ? { runId: metadata.data.runId as RunId, key: metadata.data.job } : null);
      if (!ref) return null;
      return store.snapshot(ref.runId)?.jobs.find((job) => job.key === ref.key)?.result ?? null;
    },

    async onIdle(threadId, lastAssistantText) {
      const ref = await locate(threadId);
      if (!ref) return;
      observeIdle(ref, lastAssistantText);
      await reconcile(ref.runId);
    },

    async onFailed(threadId, error) {
      const ref = await locate(threadId);
      if (!ref) return;
      observeFailed(ref, error ?? "the worker thread failed");
      await reconcile(ref.runId);
    },

    async onGone(threadId) {
      const ref = store.attemptByThread(threadId);
      if (ref) {
        observeFailed(ref, "the worker thread was archived or deleted");
        await reconcile(ref.runId);
      }
      for (const runId of store.runsForThread(threadId, false)) {
        await cancel(runId);
        store.settleNotification(runId, "abandoned");
      }
    },

    tick: (runId) => reconcile(runId, true),

    async serve(signal) {
      try {
        await recover(store.dueRuns(clock()));
      } catch (error) {
        bb.log.error(`pstack recovery failed: ${message(error)}`);
      }
      while (!signal.aborted) {
        for (const runId of store.dueRuns(clock())) {
          if (signal.aborted) break;
          await reconcile(runId, true).catch((error) => bb.log.error(`pstack run ${runId}: ${message(error)}`));
        }
        await sleep(POLL_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
      }
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
