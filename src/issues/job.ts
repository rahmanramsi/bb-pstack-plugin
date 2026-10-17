/**
 * The issue job: one durable row per `agent` label event, and every decision about it. Pure: no I/O, clocks or ids.
 *
 * A job is in a resting state or a transit state. A transit state carries its outbox: a non-empty list of effects.
 * The head effect runs, and when the last one succeeds the job enters TRANSIT[state]. plan() returns one action at a
 * time, settle() turns an effect's outcome into the next Change, and acceptReport() is the only way out of `working`.
 * The prompts and everything posted on GitHub are in text.ts.
 */
import type { PluginBoundThreadsArea } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMMENT_MAX, bodyProblems, commentBody, issueText, nudgeText, prBody, processPhrase, replyText, roundPrompt, titleProblems, workerPrompt, workerTitle } from "./text.ts";

export type JobId = string & { readonly __brand: "IssueJobId" };
/** "owner/name", lowercased at the config boundary. */
export type RepoName = string & { readonly __brand: "RepoName" };
/** "agent/issue-<n>-<slug>", with "-<generation>" from the second job on the issue. */
export type BranchName = string & { readonly __brand: "BranchName" };
export type Sha = string & { readonly __brand: "Sha" };

export const JOB_ID = /^psi_[0-9a-f-]{36}$/;

export const LABEL = {
  trigger: "agent",
  working: "agent:working",
  needsInfo: "agent:needs-info",
  review: "agent:review",
} as const;
export type Label = (typeof LABEL)[keyof typeof LABEL];
/** The labels that show a job's progress. An ending job removes all of them, whichever one it was showing. */
const STATUS_LABELS = [LABEL.working, LABEL.needsInfo, LABEL.review] as const;

/** Each transit state and the resting state it enters once its effects are done. The SQL CHECK repeats this list. */
export const TRANSIT = {
  starting: "working",
  publishing: "review",
  asking: "needs-info",
  closing: "done",
  stopping: "stopped",
  sticking: "stuck",
  sending: "addressing",
  respawning: "addressing",
  republishing: "review",
  replying: "review",
} as const;

export type TransitState = keyof typeof TRANSIT;
export const RESTING_STATES = ["ignored", "queued", "working", "needs-info", "review", "addressing", "done", "stopped", "stuck"] as const;
export type RestingState = (typeof RESTING_STATES)[number];
export type JobState = TransitState | RestingState;

/** A new label event on the issue may start a new job only once its last job is in one of these. */
export const TERMINAL: ReadonlySet<JobState> = new Set(["ignored", "done", "stopped", "stuck"]);
/** States that hold one of the worker slots: a worker turn runs or its result is being published. */
export const BUSY: ReadonlySet<JobState> = new Set(["starting", "working", "publishing", "sending", "respawning", "addressing", "republishing", "replying"]);
/** At most this many jobs are BUSY at once. */
export const CONCURRENCY = 3;

/** States in which the worker's report is the next step. */
export const REPORTING: ReadonlySet<JobState> = new Set(["working", "addressing"]);
export const MAX_FEEDBACK_ROUNDS = 5;
/** A round starts once the newest pending feedback is this old, so one review with ten comments is one round. */
export const FEEDBACK_QUIET_MS = 2 * 60_000;

export function isTransit(state: JobState): state is TransitState {
  return Object.hasOwn(TRANSIT, state);
}

type SpawnArgs = Parameters<PluginBoundThreadsArea["spawn"]>[0];
export type ReasoningLevel = NonNullable<SpawnArgs["reasoningLevel"]>;
export type PermissionMode = NonNullable<SpawnArgs["permissionMode"]>;

/** The SDK exports the type but not its values; `satisfies` fails the build when the two drift apart. */
const REASONING_LEVELS = { none: true, low: true, medium: true, high: true, xhigh: true, max: true, ultra: true, ultracode: true } satisfies Record<ReasoningLevel, true>;
export const isReasoningLevel = (value: string): value is ReasoningLevel => Object.hasOwn(REASONING_LEVELS, value);

export type WorkerSettings = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode | null;
};

/** Resolved when the effect is created and stored in the outbox, so a probe or a replay never sees a different prompt. */
export type SpawnSpec = WorkerSettings & {
  title: string;
  prompt: string;
  /** The ref the worktree starts from: the base branch for the first worker, the pushed branch for a replacement. */
  baseRef: string;
};

/**
 * One side effect a transition owes. `key` is stable across retries and restarts, and anything an effect posts embeds
 * it as a marker so a probe can find the earlier write. The pull request number is read from the row at perform time.
 */
export type Effect =
  | { op: "labels"; key: string; on: "issue" | "pr"; add: readonly Label[]; remove: readonly Label[] }
  | { op: "spawn"; key: string; spec: SpawnSpec }
  | { op: "push"; key: string; sha: Sha; expectedRemoteSha: Sha | null }
  | { op: "open-pr"; key: string; title: string; body: string }
  | { op: "comment"; key: string; body: string }
  | { op: "stop-thread"; key: string }
  | { op: "send-round"; key: string; text: string }
  /** `body` is posted as is: a conversation reply already quotes what it answers. */
  | { op: "reply"; key: string; target: FeedbackRef; body: string }
  | { op: "request-review"; key: string; reviewers: readonly string[] }
  | { op: "edit-pr"; key: string; body: string };

export type EffectOp = Effect["op"];

/**
 * How an effect runs again after a claim that never settled, which may or may not have happened.
 *   replay: run it again; repeating it is harmless.
 *   probe: look for its trace, and run it again only when there is none.
 *   once: look for its trace and never run it again. No SDK error proves a spawn created no thread, so a probe that
 *     finds nothing waits until `graceMs` after the first claim and then sticks the job.
 */
export type Recovery = { kind: "replay" } | { kind: "probe" } | { kind: "once"; graceMs: number };

/** The one place that says how each effect recovers. `leaseMs` keeps other ticks off a claim and covers the call's timeout. */
export const EFFECT_POLICY = {
  labels: { recovery: { kind: "replay" }, leaseMs: 60_000 },
  spawn: { recovery: { kind: "once", graceMs: 5 * 60_000 }, leaseMs: 2 * 60_000 },
  push: { recovery: { kind: "probe" }, leaseMs: 11 * 60_000 },
  "open-pr": { recovery: { kind: "probe" }, leaseMs: 60_000 },
  comment: { recovery: { kind: "probe" }, leaseMs: 60_000 },
  "stop-thread": { recovery: { kind: "replay" }, leaseMs: 60_000 },
  // A second copy of the round message is harmless: the second report finds the job no longer addressing.
  "send-round": { recovery: { kind: "replay" }, leaseMs: 60_000 },
  reply: { recovery: { kind: "probe" }, leaseMs: 60_000 },
  // One request per reviewer when GitHub refuses the batch, so it gets longer than one call.
  "request-review": { recovery: { kind: "replay" }, leaseMs: 2 * 60_000 },
  "edit-pr": { recovery: { kind: "replay" }, leaseMs: 60_000 },
} as const satisfies { readonly [Op in EffectOp]: { recovery: Recovery; leaseMs: number } };

export const MAX_EFFECT_TRIES = 8;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export type EffectOutcome =
  /** It happened, now or earlier (the probe found it). */
  | { kind: "done"; patch: EffectPatch }
  /** The probe found no trace of it. */
  | { kind: "absent" }
  /** The call failed in a way that does not prove the effect did not happen. */
  | { kind: "unknown"; error: string }
  /** It did not happen, and may on a later try (5xx, rate limit, host offline). */
  | { kind: "retry"; error: string; notBefore: number | null }
  /** It did not happen and will not (permission denied, the remote branch moved, invalid input). */
  | { kind: "fail"; error: string };

export type EffectPatch = { threadId?: string; pushedSha?: Sha; pr?: { number: number; url: string } };

export type IssueSnapshot = { title: string; body: string; url: string; author: string };

export type FeedbackKind = "review" | "review-comment" | "pr-comment";
/** What a reply answers. GitHub numbers reviews, inline comments and conversation comments separately. */
export type FeedbackRef = { kind: FeedbackKind; id: number };
/** A review body, an inline review comment, or an `/agent` comment on the job's pull request. */
export type Feedback = FeedbackRef & {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  inReplyTo: number | null;
  reviewId: number | null;
  createdAt: number;
};
/** Feedback as polled, with the state of the review it is or belongs to, before the operator's rules filter it. */
export type PolledFeedback = Feedback & { pr: number; reviewState: string | null };

const COUNTED_REVIEWS: ReadonlySet<string> = new Set(["CHANGES_REQUESTED", "COMMENTED"]);
const AGENT_COMMAND = /^\s*\/agent\b/i;

/**
 * Whether polled feedback starts a round, before the author check. Conversation comments count only as `/agent`
 * commands; approved and dismissed reviews count for nothing, their inline comments included. A review without a
 * body has nothing to answer: its inline comments arrive on their own.
 */
export function counts(item: PolledFeedback): boolean {
  switch (item.kind) {
    case "pr-comment":
      return AGENT_COMMAND.test(item.body);
    case "review":
      return COUNTED_REVIEWS.has(item.reviewState ?? "") && item.body.trim() !== "";
    case "review-comment":
      return item.reviewState === null || COUNTED_REVIEWS.has(item.reviewState);
  }
}

export type Phase =
  | { state: RestingState }
  | {
      state: TransitState;
      effects: readonly [Effect, ...Effect[]];
      /** Claims of the head effect. Above 0 it may already have happened, so the next claim probes first. */
      tries: number;
      /** When the head effect was first claimed; spawn's grace period runs from here. */
      firstAt: number | null;
      leaseUntil: number | null;
      nextAt: number | null;
    };

export type Job = {
  id: JobId;
  /** Every write is guarded by it and bumps it. */
  version: number;
  repo: RepoName;
  issue: number;
  generation: number;
  trigger: { eventId: number; actor: string; at: number };
  snapshot: IssueSnapshot;
  projectId: string;
  hostId: string;
  baseBranch: string;
  branch: BranchName;
  phase: Phase;
  /** Bound by the spawn effect or its probe, never by thread metadata alone. */
  threadId: string | null;
  deadline: number | null;
  rejections: number;
  nudges: number;
  report: AcceptedReport | null;
  pushedSha: Sha | null;
  pr: { number: number; url: string } | null;
  error: string | null;
  /** The current round's ordinal: 1 is the issue, each later one answers feedback on the pull request. */
  round: number;
  /** The worker's settings from the start, so a replacement worker runs the same model. */
  worker: WorkerSettings | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * A round's start, written with the job in one transaction: the round's history row, and every listed feedback item
 * marked as sent in it. Items that arrive later stay pending for the next round.
 */
export type RoundStart = { ordinal: number; kind: "initial" | "feedback"; baseSha: Sha | null; feedback: readonly FeedbackRef[] };

/** The write vocabulary for an existing job. `phase` replaces state, outbox and bookkeeping together. */
export type Change = {
  phase?: Phase;
  threadId?: string;
  deadline?: number | null;
  rejections?: number;
  nudges?: number;
  report?: AcceptedReport;
  pushedSha?: Sha;
  pr?: { number: number; url: string };
  error?: string | null;
  startRound?: RoundStart;
  /** The current round ended with this change; its history row records when. */
  finishRound?: true;
  worker?: WorkerSettings;
};

export type ThreadFact =
  | { kind: "active" }
  /** `since` is the thread's last update, compared with the job's to see whether the worker went idle again. */
  | { kind: "idle"; since: number }
  | { kind: "failed"; error: string }
  | { kind: "gone" };

/**
 * Why a queued job's worker cannot be resolved. `permanent` when only an operator can fix it, such as a model the host
 * does not have: the job sticks with the reason instead of waiting.
 */
export type WorkerProblem = { error: string; permanent: boolean };

export type GateFact = { pass: true } | { pass: false; reason: string };

export type PullState = "open" | "merged" | "closed";

export type FeedbackFact = {
  /** Feedback not yet sent in a round, oldest first. */
  pending: readonly Feedback[];
  /** Every round so far with its accepted report's summary, for the next round message. */
  rounds: readonly { ordinal: number; summary: string | null }[];
};

/** Observations the row does not own. The engine gathers only those FACTS_FOR names for the state. */
export type Facts = {
  now: number;
  slotFree: boolean | null;
  worker: WorkerSettings | WorkerProblem | null;
  thread: ThreadFact | null;
  /**
   * For an idle worker: whether it is waiting on its own pstack runs or child threads. Their results wake it, so it has
   * not stopped.
   */
  waiting: boolean | null;
  /** For an idle worker: `gate pr` on its checklist, which the nudge names when it fails. */
  gate: GateFact | null;
  feedback: FeedbackFact | null;
  /** The pull request's state as last polled; null until the first poll since the service started. */
  pr: { state: PullState } | null;
};

export type FactName = Exclude<keyof Facts, "now">;

export const FACTS_FOR: { readonly [S in JobState]: readonly FactName[] } = {
  ignored: [],
  queued: ["slotFree", "worker"],
  starting: [],
  working: ["thread", "waiting", "gate"],
  publishing: [],
  asking: [],
  "needs-info": [],
  review: ["slotFree", "feedback", "pr", "thread"],
  addressing: ["thread", "waiting", "pr"],
  closing: [],
  done: [],
  stopping: [],
  stopped: [],
  sticking: [],
  stuck: [],
  sending: [],
  respawning: [],
  republishing: [],
  replying: [],
};

/** Resting states whose next action depends on facts outside the row, so the sweep reconciles them every pass. */
export const WATCHED: readonly RestingState[] = RESTING_STATES.filter((state) => FACTS_FOR[state].length > 0);

/**
 * `perform` runs the head effect. `probe` only looks for its trace. `probe-then-perform` runs it when the probe finds
 * nothing, under the same claim, so a replayable effect does not need a second claim to run after a negative probe.
 */
export type EffectMode = "perform" | "probe" | "probe-then-perform";

const RECOVERY_MODE = { replay: "perform", probe: "probe-then-perform", once: "probe" } as const satisfies Record<Recovery["kind"], EffectMode>;

export type Action =
  | { type: "change"; change: Change }
  /** Claim the head effect (tries + 1 and a lease), then run it in `mode`. */
  | { type: "effect"; effect: Effect; mode: EffectMode; leaseUntil: number }
  /** Remind an idle worker that has not reported. The nudge count is written before the send. */
  | { type: "nudge"; text: string; change: Change }
  /** Nothing to do until then. */
  | { type: "sleep"; until: number };

export const MAX_NUDGES = 2;
export const MAX_REJECTIONS = 2;
export const ROUND_MS = 60 * 60_000;

/** States a round runs through, from its start until the job rests in review or needs-info, or heads to an end. */
const IN_ROUND: ReadonlySet<JobState> = new Set(["starting", "working", "publishing", "asking", "sending", "respawning", "addressing", "republishing", "replying"]);

/** Marks a change that takes the job out of its round as the round's end. */
function rounded(job: Job, change: Change): Change {
  return change.phase && IN_ROUND.has(job.phase.state) && !IN_ROUND.has(change.phase.state) ? { ...change, finishRound: true } : change;
}

export function plan(job: Job, facts: Facts): Action | null {
  const action = next(job, facts);
  return action?.type === "change" ? { type: "change", change: rounded(job, action.change) } : action;
}

function next(job: Job, facts: Facts): Action | null {
  const { phase } = job;
  const { now } = facts;
  if (isTransit(phase.state) && "effects" in phase) {
    const head = phase.effects[0];
    const policy = EFFECT_POLICY[head.op];
    if (phase.leaseUntil !== null && phase.leaseUntil > now) return { type: "sleep", until: phase.leaseUntil };
    if (phase.nextAt !== null && phase.nextAt > now) return { type: "sleep", until: phase.nextAt };
    if (phase.tries >= MAX_EFFECT_TRIES) {
      return { type: "change", change: stick(job, `${head.op} failed ${phase.tries} times: ${job.error ?? "no error recorded"}`) };
    }
    const mode: EffectMode = phase.tries === 0 ? "perform" : RECOVERY_MODE[policy.recovery.kind];
    return { type: "effect", effect: head, mode, leaseUntil: now + policy.leaseMs };
  }

  switch (phase.state) {
    case "queued": {
      if (!facts.slotFree || !facts.worker) return null;
      if ("error" in facts.worker) {
        if (facts.worker.permanent) return { type: "change", change: stick(job, facts.worker.error) };
        return job.error === facts.worker.error ? null : { type: "change", change: { error: facts.worker.error } };
      }
      return { type: "change", change: start(job, facts.worker, now) };
    }
    case "review": {
      const { pr, feedback } = facts;
      if (!pr || !feedback) return null;
      if (pr.state !== "open") return { type: "change", change: close(job) };
      if (feedback.pending.length === 0) return null;
      if (job.round > MAX_FEEDBACK_ROUNDS) {
        return { type: "change", change: stick(job, `new feedback after ${MAX_FEEDBACK_ROUNDS} feedback rounds; the pull request needs a person now`) };
      }
      const quietAt = Math.max(...feedback.pending.map((item) => item.createdAt)) + FEEDBACK_QUIET_MS;
      if (quietAt > now) return { type: "sleep", until: quietAt };
      if (!facts.slotFree || !facts.thread) return null;
      // A failed thread cannot take the round's message; it is replaced like a gone one.
      const respawn = facts.thread.kind === "gone" || facts.thread.kind === "failed";
      return { type: "change", change: startRound(job, feedback, respawn, now) };
    }
    case "addressing":
    case "working": {
      if (facts.pr && facts.pr.state !== "open") return { type: "change", change: close(job) };
      if (job.deadline !== null && job.deadline <= now) {
        return { type: "change", change: stick(job, "the worker did not report within 60 minutes") };
      }
      const thread = facts.thread;
      if (!thread) return null;
      switch (thread.kind) {
        case "gone":
          return { type: "change", change: stick(job, "the worker thread was archived or deleted before it reported") };
        case "failed":
          return { type: "change", change: stick(job, `the worker thread failed: ${thread.error}`) };
        case "idle":
          if (thread.since <= job.updatedAt || facts.waiting) return null;
          if (job.nudges >= MAX_NUDGES) return { type: "change", change: stick(job, "the worker stopped without reporting") };
          return { type: "nudge", text: nudgeText(job, facts.gate), change: { nudges: job.nudges + 1 } };
        case "active":
          return job.deadline === null ? null : { type: "sleep", until: job.deadline };
      }
    }
    default:
      return null;
  }
}

/** The Change for an effect's outcome, against the row as it was right after the claim. */
export function settle(job: Job, outcome: EffectOutcome, now: number): Change {
  return rounded(job, settled(job, outcome, now));
}

function settled(job: Job, outcome: EffectOutcome, now: number): Change {
  const { phase } = job;
  if (!isTransit(phase.state) || !("effects" in phase)) throw new Error(`settle on ${job.id} in resting state ${phase.state}`);
  const head = phase.effects[0];
  const backoff = () => now + BACKOFF_MS[Math.min(Math.max(phase.tries - 1, 0), BACKOFF_MS.length - 1)]!;
  switch (outcome.kind) {
    case "done": {
      const [, ...rest] = phase.effects;
      // On the way to stuck or stopped the error is the reason, so it outlives the effects.
      const ending = phase.state === "sticking" || phase.state === "stopping";
      return { phase: enter(phase.state, rest), ...outcome.patch, ...(ending ? {} : { error: null }) };
    }
    case "absent": {
      const { recovery } = EFFECT_POLICY[head.op];
      if (recovery.kind !== "once") throw new Error(`${head.op} runs again when its probe finds nothing, so it never settles as absent`);
      const graceEnd = (phase.firstAt ?? now) + recovery.graceMs;
      if (now >= graceEnd) return stick(job, `the ${head.op} may not have happened: no trace of it ${Math.round(recovery.graceMs / 60_000)} minutes after the first try`);
      return { phase: { ...phase, leaseUntil: null, nextAt: Math.min(graceEnd, backoff()) } };
    }
    case "unknown":
      return { phase: { ...phase, leaseUntil: null, nextAt: backoff() }, error: outcome.error };
    case "retry":
      return { phase: { ...phase, leaseUntil: null, nextAt: Math.max(outcome.notBefore ?? 0, backoff()) }, error: outcome.error };
    case "fail":
      return stick(job, outcome.error);
  }
}

/** queued → starting: label the issue, then spawn the worker. Starts the round's clock. */
export function start(job: Job, worker: WorkerSettings, now: number): Change {
  const effects: Effect[] = [
    { op: "labels", key: `labels:${job.id}:working`, on: "issue", add: [LABEL.working], remove: [] },
    { op: "spawn", key: `spawn:${job.id}`, spec: { ...worker, title: workerTitle(job), prompt: workerPrompt(job), baseRef: `origin/${job.baseBranch}` } },
  ];
  return { phase: enter("starting", effects), deadline: now + ROUND_MS, error: null, worker, startRound: { ordinal: 1, kind: "initial", baseSha: null, feedback: [] } };
}

/**
 * review → sending, or respawning when the worker thread is gone or failed: relabel the issue, then hand the worker every pending
 * item in one message. The round's row and its feedback are written with this change, so no item is sent twice.
 */
function startRound(job: Job, feedback: FeedbackFact, respawn: boolean, now: number): Change {
  const ordinal = job.round + 1;
  const text = roundPrompt(job, ordinal, feedback);
  const relabel: Effect = { op: "labels", key: `labels:${job.id}:working:${ordinal}`, on: "issue", add: [LABEL.working], remove: [LABEL.review] };
  const round = {
    startRound: { ordinal, kind: "feedback", baseSha: job.pushedSha, feedback: feedback.pending.map(({ kind, id }) => ({ kind, id })) },
    deadline: now + ROUND_MS,
    rejections: 0,
    nudges: 0,
    error: null,
  } as const;
  if (!respawn) return { phase: enter("sending", [relabel, { op: "send-round", key: `send-round:${job.id}:${ordinal}`, text }]), ...round };
  if (!job.worker) return stick(job, "the worker thread is gone and the job has no worker settings to start another");
  const spec: SpawnSpec = { ...job.worker, title: workerTitle(job), prompt: text, baseRef: `origin/${job.branch}` };
  return { phase: enter("respawning", [relabel, { op: "spawn", key: `spawn:${job.id}:${ordinal}`, spec }]), ...round };
}

/** review or addressing → closing once the pull request is merged or closed: the worker and the status labels go. */
function close(job: Job): Change {
  return { phase: enter("closing", endingEffects(job, "close")), deadline: null, error: null };
}

/** Waiting for its spawn to create the worker, which may report before the spawn is confirmed. */
export function awaitingThread(job: Job): boolean {
  return "effects" in job.phase && job.phase.effects[0].op === "spawn";
}

/**
 * A worker may exist once the spawn has been claimed. Effects stop it before the job ends, so a stuck or stopped job
 * never leaves a worker running, and the stop finds a late duplicate through its metadata too.
 */
function workerMayExist(job: Job): boolean {
  const { phase } = job;
  if (job.threadId !== null) return true;
  return "effects" in phase && phase.effects[0].op === "spawn" && phase.tries > 0;
}

function endingEffects(job: Job, kind: "stop" | "stick" | "close"): Effect[] {
  const effects: Effect[] = [];
  if (workerMayExist(job)) effects.push({ op: "stop-thread", key: `stop-thread:${job.id}:${kind}` });
  if (job.phase.state !== "queued") effects.push({ op: "labels", key: `labels:${job.id}:${kind}`, on: "issue", add: [], remove: STATUS_LABELS });
  return effects;
}

/**
 * Any non-terminal state → sticking. A job already on its way to an end goes there directly and drops the rest of its
 * outbox, so an effect that keeps failing while the job ends cannot loop.
 */
export function stick(job: Job, reason: string): Change {
  const state = job.phase.state;
  if (state === "stopping" || state === "stopped") return { phase: { state: "stopped" }, error: reason };
  if (state === "sticking" || TERMINAL.has(state)) return { phase: { state: "stuck" }, error: reason };
  return { phase: enter("sticking", endingEffects(job, "stick")), deadline: null, error: reason };
}

/** Any non-terminal state → stopping. Replaces a pending outbox. Null when the job already ended or is ending. */
export function stop(job: Job, by: string): Change | null {
  const state = job.phase.state;
  if (TERMINAL.has(state) || state === "stopping" || state === "sticking") return null;
  return rounded(job, { phase: enter("stopping", endingEffects(job, "stop")), deadline: null, error: `stopped by ${by}` });
}

/** A transit phase with fresh bookkeeping, or the target resting state when there is nothing to do. */
export function enter(state: TransitState, effects: readonly Effect[]): Phase {
  const [head, ...rest] = effects;
  if (!head) return { state: TRANSIT[state] };
  return { state, effects: [head, ...rest], tries: 0, firstAt: null, leaseUntil: null, nextAt: null };
}

const Line = z.string().trim().min(1);
const Verification = z.array(Line).min(1, "list at least one check you ran and its result");
const Reply = z.strictObject({ kind: z.enum(["review", "review-comment", "pr-comment"]), commentId: z.number().int().positive(), body: Line });

/** The first round's report, which the worker writes to the file it passes to `bb pstack issues report --file`. */
export const InitialReport = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("changes"), pr: z.strictObject({ title: z.string(), body: z.string() }), verification: Verification, summary: Line }),
  z.strictObject({ outcome: z.literal("no-change"), verification: Verification, summary: Line }),
  z.strictObject({ outcome: z.literal("needs-info"), questions: z.array(Line).min(1).max(10), verification: Verification, summary: Line.optional() }),
]);
export type InitialReport = z.infer<typeof InitialReport>;

/** A feedback round's report. `pr.body`, when set, replaces the pull request description. */
export const RoundReport = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("changes"), pr: z.strictObject({ body: z.string() }).optional(), replies: z.array(Reply), verification: Verification, summary: Line }),
  z.strictObject({ outcome: z.literal("no-change"), replies: z.array(Reply), verification: Verification, summary: Line }),
]);
export type RoundReport = z.infer<typeof RoundReport>;

export type Report = InitialReport | RoundReport;
/** A report checked against the contract of the job's current round. */
export type ParsedReport = { round: "initial"; report: InitialReport } | { round: "feedback"; report: RoundReport };

export function parseReport(job: Job, value: unknown): { ok: true; parsed: ParsedReport } | { ok: false; error: z.ZodError } {
  if (job.round === 1) {
    const result = InitialReport.safeParse(value);
    return result.success ? { ok: true, parsed: { round: "initial", report: result.data } } : { ok: false, error: result.error };
  }
  const result = RoundReport.safeParse(value);
  return result.success ? { ok: true, parsed: { round: "feedback", report: result.data } } : { ok: false, error: result.error };
}

/** A report that passed every check, with the commit it was made at. That commit, not HEAD, is what gets pushed. */
export type AcceptedReport = Report & { headSha: Sha; acceptedAt: number };

export type ReportFacts = {
  now: number;
  /** `ahead`: commits on HEAD that `origin/<base>` does not have. */
  worktree: { headSha: Sha; dirty: boolean; ahead: number };
  /** `gate pr` on the worker thread's checklist. Only the first round checks it. */
  gate: GateFact;
  titleConvention: "conventional" | "free";
  /** The feedback the round sent. The replies answer each item exactly once. */
  listed: readonly Feedback[];
};

export type Verdict =
  | { ok: true; change: Change }
  | { ok: false; reasons: readonly string[]; change: Change };

const refKey = (ref: FeedbackRef) => `${ref.kind} ${ref.id}`;

/** HEAD is new this round: ahead of the base branch in the first round, past the pushed commit in a later one. */
function newCommit(job: Job, worktree: ReportFacts["worktree"]): boolean {
  return job.round === 1 ? worktree.ahead > 0 : worktree.headSha !== job.pushedSha;
}

function commitProblems(job: Job, outcome: Report["outcome"], worktree: ReportFacts["worktree"], base: string): string[] {
  const problems: string[] = [];
  if (worktree.dirty) problems.push("the worktree has uncommitted or untracked changes: commit or remove every change before reporting");
  const added = newCommit(job, worktree);
  if (outcome === "changes" && !added) problems.push(`outcome \`changes\` needs a new commit on top of ${base}`);
  if (outcome !== "changes" && added) problems.push(`outcome \`${outcome}\` must not add commits; report \`changes\` instead`);
  return problems;
}

function phraseProblems(texts: readonly string[], where: string): string[] {
  return texts.flatMap((text) => {
    const phrase = processPhrase(text);
    return phrase ? [`${where} describes the process ("${phrase}"); describe the code instead`] : [];
  });
}

function verdict(job: Job, reasons: readonly string[], accepted: () => Change): Verdict {
  if (reasons.length === 0) return { ok: true, change: { ...accepted(), rejections: 0, nudges: 0, deadline: null, error: null } };
  const rejections = job.rejections + 1;
  const change =
    rejections >= MAX_REJECTIONS
      ? { ...stick(job, `${rejections} reports were rejected: ${reasons.join("; ")}`), rejections }
      : { rejections, error: `report rejected: ${reasons.join("; ")}` };
  return { ok: false, reasons, change };
}

export function acceptReport(job: Job, parsed: ParsedReport, facts: ReportFacts): Verdict {
  const verdict = parsed.round === "initial" ? acceptInitialReport(job, parsed.report, facts) : acceptRoundReport(job, parsed.report, facts);
  return { ...verdict, change: rounded(job, verdict.change) };
}

function acceptInitialReport(job: Job, report: InitialReport, facts: ReportFacts): Verdict {
  const reasons = commitProblems(job, report.outcome, facts.worktree, "the base branch");
  switch (report.outcome) {
    case "changes":
      if (!facts.gate.pass) reasons.push(`\`bb pstack gate pr\` fails: ${facts.gate.reason}`);
      reasons.push(...titleProblems(report.pr.title, facts.titleConvention), ...bodyProblems(report.pr.body));
      break;
    case "needs-info":
      reasons.push(...phraseProblems(report.questions, "text posted on the issue"));
      break;
    case "no-change":
      reasons.push(...phraseProblems([report.summary], "text posted on the issue"));
      break;
  }
  const accepted: AcceptedReport = { ...report, headSha: facts.worktree.headSha, acceptedAt: facts.now };
  return verdict(job, reasons, () => ({ phase: enter(...publication(job, accepted)), report: accepted }));
}

function acceptRoundReport(job: Job, report: RoundReport, facts: ReportFacts): Verdict {
  const reasons = commitProblems(job, report.outcome, facts.worktree, "the pushed commit");
  const listed = new Set(facts.listed.map(refKey));
  const replied = report.replies.map((reply) => refKey({ kind: reply.kind, id: reply.commentId }));
  const missing = [...listed].filter((key) => !replied.includes(key));
  const extra = replied.filter((key) => !listed.has(key));
  const repeated = replied.filter((key, index) => replied.indexOf(key) !== index);
  if (missing.length > 0) reasons.push(`reply to every listed comment; missing: ${missing.join(", ")}`);
  if (extra.length > 0) reasons.push(`these comments were not listed, remove their replies: ${extra.join(", ")}`);
  if (repeated.length > 0) reasons.push(`reply to each comment once; repeated: ${[...new Set(repeated)].join(", ")}`);
  if (report.outcome === "changes" && report.pr) reasons.push(...bodyProblems(report.pr.body));
  for (const reply of report.replies) {
    const where = `the reply to ${refKey({ kind: reply.kind, id: reply.commentId })}`;
    reasons.push(...phraseProblems([reply.body], where));
    const item = facts.listed.find((candidate) => refKey(candidate) === refKey({ kind: reply.kind, id: reply.commentId }));
    const effect = item && replyEffect(job, reply, item);
    const length = effect ? commentBody(effect.body, effect.key).length : 0;
    if (length > COMMENT_MAX) reasons.push(`${where} is ${length} characters as posted; GitHub's limit is ${COMMENT_MAX}`);
  }
  const accepted = { ...report, headSha: facts.worktree.headSha, acceptedAt: facts.now };
  return verdict(job, reasons, () => ({ phase: enter(...republication(job, accepted, facts.listed)), report: accepted }));
}

/**
 * The end of a feedback round: push the new commit if there is one, answer every listed item, update the description
 * when the report replaced it, ask the reviewers to look again, and show the issue as in review.
 */
function republication(job: Job, report: RoundReport & AcceptedReport, listed: readonly Feedback[]): [TransitState, Effect[]] {
  const replies: Effect[] = report.replies.map((reply) => replyEffect(job, reply, listed.find((item) => refKey(item) === refKey({ kind: reply.kind, id: reply.commentId }))!));
  const reviewers = [...new Set(listed.map((item) => item.author))];
  const after: Effect[] = [
    ...replies,
    ...(report.outcome === "changes" && report.pr ? [{ op: "edit-pr", key: `edit-pr:${job.id}:${job.round}`, body: prBody(report.pr.body, job.issue) } as const] : []),
    ...(reviewers.length > 0 ? [{ op: "request-review", key: `request-review:${job.id}:${job.round}`, reviewers } as const] : []),
    { op: "labels", key: `labels:${job.id}:review:${job.round}`, on: "issue", add: [LABEL.review], remove: [LABEL.working] },
  ];
  if (report.outcome !== "changes") return ["replying", after];
  return ["republishing", [{ op: "push", key: `push:${job.id}:${report.headSha}`, sha: report.headSha, expectedRemoteSha: job.pushedSha }, ...after]];
}

function replyEffect(job: Job, reply: RoundReport["replies"][number], answers: Feedback): Extract<Effect, { op: "reply" }> {
  return { op: "reply", key: `reply:${job.id}:${job.round}:${reply.kind}:${reply.commentId}`, target: { kind: reply.kind, id: reply.commentId }, body: replyText(reply.body, answers) };
}

function publication(job: Job, report: InitialReport & AcceptedReport): [TransitState, Effect[]] {
  switch (report.outcome) {
    case "changes":
      return [
        "publishing",
        [
          { op: "push", key: `push:${job.id}:${report.headSha}`, sha: report.headSha, expectedRemoteSha: job.pushedSha },
          ...(job.pr === null ? [{ op: "open-pr", key: `pr:${job.id}`, title: report.pr.title.trim(), body: prBody(report.pr.body, job.issue) } as const] : []),
          { op: "labels", key: `labels:${job.id}:pr`, on: "pr", add: [LABEL.trigger], remove: [] },
          { op: "labels", key: `labels:${job.id}:review`, on: "issue", add: [LABEL.review], remove: [LABEL.working] },
        ],
      ];
    case "needs-info":
      return [
        "asking",
        [
          { op: "comment", key: `comment:${job.id}:questions`, body: issueText(report.questions.map((question) => `- ${question}`).join("\n")) },
          { op: "labels", key: `labels:${job.id}:needs-info`, on: "issue", add: [LABEL.needsInfo], remove: [LABEL.working] },
        ],
      ];
    case "no-change":
      return [
        "closing",
        [
          { op: "comment", key: `comment:${job.id}:no-change`, body: issueText(report.summary) },
          { op: "labels", key: `labels:${job.id}:done`, on: "issue", add: [], remove: [LABEL.working] },
        ],
      ];
  }
}

export function branchFor(issue: number, title: string, generation: number): BranchName {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "issue";
  return `agent/issue-${issue}-${slug}${generation > 1 ? `-${generation}` : ""}` as BranchName;
}

export type JobView = {
  id: JobId;
  repo: RepoName;
  issue: number;
  issueUrl: string;
  state: JobState;
  /** For a transit state: where it is heading and the effect it is on. */
  next: { state: RestingState; op: EffectOp; tries: number; retryAt: number | null } | null;
  triggeredBy: string;
  branch: BranchName;
  threadId: string | null;
  pr: { number: number; url: string } | null;
  pushedSha: Sha | null;
  /** 1 while the issue is worked on; each feedback round adds one. */
  round: number;
  summary: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export function toView(job: Job): JobView {
  const { phase } = job;
  return {
    id: job.id,
    repo: job.repo,
    issue: job.issue,
    issueUrl: job.snapshot.url,
    state: phase.state,
    next:
      "effects" in phase
        ? { state: TRANSIT[phase.state], op: phase.effects[0].op, tries: phase.tries, retryAt: phase.nextAt }
        : null,
    triggeredBy: job.trigger.actor,
    branch: job.branch,
    threadId: job.threadId,
    pr: job.pr,
    pushedSha: job.pushedSha,
    round: job.round,
    summary: job.report?.summary ?? null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
