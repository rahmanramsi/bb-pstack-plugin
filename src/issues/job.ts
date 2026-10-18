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
import { COMMENT_MAX, bodyProblems, commentBody, issueText, nudgeText, prBody, processPhrase, progressBody, replyText, roundPrompt, silenceText, titleProblems, workerPrompt, workerTitle } from "./text.ts";

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
  updating: "tracking",
} as const;

export type TransitState = keyof typeof TRANSIT;
export const RESTING_STATES = ["ignored", "queued", "working", "needs-info", "review", "addressing", "tracking", "done", "stopped", "stuck"] as const;
export type RestingState = (typeof RESTING_STATES)[number];
export type JobState = TransitState | RestingState;

/** A new label event on the issue may start a new job only once its last job is in one of these. */
export const TERMINAL: ReadonlySet<JobState> = new Set(["ignored", "done", "stopped", "stuck"]);

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
  | { op: "reply"; key: string; target: ReplyTarget; body: string }
  | { op: "request-review"; key: string; reviewers: readonly string[] }
  | { op: "edit-pr"; key: string; body: string }
  /** A replacement worker's worktree must contain `base`, the branch's head on GitHub; when it does not, it is told to merge. */
  | { op: "check-worktree"; key: string; base: Sha }
  /** A parent's one progress comment: edited when the App's comment with the key's marker exists, else created. */
  | { op: "status"; key: string; body: string }
  | { op: "close-issue"; key: string };

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
  // A repeated copy of the round message tells the worker to do nothing, and a report from it names its round, which
  // parseReport refuses once a later round runs.
  "send-round": { recovery: { kind: "replay" }, leaseMs: 60_000 },
  reply: { recovery: { kind: "probe" }, leaseMs: 60_000 },
  // One request per reviewer when GitHub refuses the batch, so it gets longer than one call.
  "request-review": { recovery: { kind: "replay" }, leaseMs: 2 * 60_000 },
  "edit-pr": { recovery: { kind: "replay" }, leaseMs: 60_000 },
  // A repeated note to merge the branch is harmless.
  "check-worktree": { recovery: { kind: "replay" }, leaseMs: 60_000 },
  status: { recovery: { kind: "replay" }, leaseMs: 60_000 },
  "close-issue": { recovery: { kind: "replay" }, leaseMs: 60_000 },
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

/** `parent` is set on a sub-issue's job: the parent issue as it was when the job was created. */
export type IssueSnapshot = { title: string; body: string; url: string; author: string; parent?: { number: number; title: string; body: string; url: string } };

/** A parent issue's sub-issue as last polled. `blockedBy` lists its open blockers as `#n` or `owner/repo#n`. */
export type SubIssue = { number: number; title: string; url: string; state: "open" | "closed"; blockedBy: string[] };
/** A sub-issue with its latest job: its open job, else the parent's child job. */
export type ChildFact = SubIssue & { job: { state: JobState; merged: boolean } | null };

export type FeedbackKind = "review" | "review-comment" | "pr-comment";
/** What a reply answers. GitHub numbers reviews, inline comments and conversation comments separately. */
export type FeedbackRef = { kind: FeedbackKind; id: number };
/**
 * Where a reply goes. GitHub takes replies only on an inline thread's first comment, so an inline reply carries that
 * comment as `thread`; a review body or a conversation comment is answered in the conversation.
 */
export type ReplyTarget = { kind: "review-comment"; id: number; thread: number } | { kind: "review" | "pr-comment"; id: number };
/** A review body, an inline review comment, or a conversation comment that mentions the App on the job's pull request. */
export type Feedback = FeedbackRef & {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  /** For an inline comment answering in a thread: the thread's first comment, and its author and text when known. */
  inReplyTo: number | null;
  parent: { author: string; body: string } | null;
  reviewId: number | null;
  createdAt: number;
  /**
   * When the item became visible, which the quiet period runs from: a review's submission for the review and its
   * inline comments, which GitHub dates from when they were drafted, and otherwise the comment's last update.
   */
  postedAt: number;
};
/**
 * Feedback as polled, with the state of the review it is or belongs to, before the operator's rules filter it. The
 * poller looks up an inline reply's parent only for an item it stores.
 */
export type PolledFeedback = Omit<Feedback, "parent"> & { pr: number; reviewState: string | null };

const COUNTED_REVIEWS: ReadonlySet<string> = new Set(["CHANGES_REQUESTED", "COMMENTED"]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The comment's own text: quoted lines repeat someone else's words, so a mention there asks for nothing. */
const ownText = (body: string) => body.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
/** `@<slug>` or `@<slug>[bot]` as a whole mention, case-insensitive, so `@pstack-agents` or `x@pstack-agent` do not match. */
const mention = (slug: string, after = "") =>
  new RegExp(`(?<![\\w@./-])@${escape(slug)}(?:\\[bot\\])?(?![\\w-])${after}`, "i");

/** The command a comment gives the App, whoever wrote it; only the poller knows whether its author may. */
export function command(body: string, appSlug: string): "stop" | null {
  return mention(appSlug, "\\s+stop\\b").test(ownText(body)) ? "stop" : null;
}

/**
 * Whether polled feedback starts a round, before the author check. A conversation comment counts only when it
 * mentions the App, and `@<app> stop` is a command, not feedback; approved and dismissed reviews count for nothing,
 * their inline comments included. A review without a body has nothing to answer: its inline comments arrive on their
 * own.
 */
export function counts(item: PolledFeedback, appSlug: string): boolean {
  switch (item.kind) {
    case "pr-comment":
      return mention(appSlug).test(ownText(item.body)) && command(item.body, appSlug) === null;
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
  /** `eventId` is null for a sub-issue's job, which its parent's label event started. */
  trigger: { eventId: number | null; actor: string; at: number };
  snapshot: IssueSnapshot;
  parentId: JobId | null;
  /** For a parent: the status comment body last planned, so a pass can tell when the progress changed. */
  progress: string | null;
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
  /**
   * In a feedback round, the branch's head on GitHub that the round's commit must contain and its push expects. Set
   * when the round starts, and moved when the branch moves on GitHub during the round. Null before the first.
   */
  roundBase: Sha | null;
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
  roundBase?: Sha;
  worker?: WorkerSettings;
  progress?: string;
};

export type ThreadFact =
  | { kind: "active" }
  /** `since` is the thread's last update, compared with the job's to see whether the worker went idle again. */
  | { kind: "idle"; since: number }
  | { kind: "failed"; error: string }
  | { kind: "gone" };

/**
 * Progress across the worker's thread tree: the worker, its child threads, and the threads of the pstack runs they
 * started. `lastActiveAt` is the newest progress event in it, or the last time a member was seen held, so time spent
 * held never counts as silence. `queued`: a member is held right now, before its turn or waiting for a run slot.
 */
export type TreeFact = { lastActiveAt: number | null; queued: boolean };

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
};
/** A round so far with its accepted report's summary, for the next round message. */
export type RoundSummary = { ordinal: number; summary: string | null };

/** Observations the row does not own. The engine gathers only those FACTS_FOR names for the state. */
export type Facts = {
  now: number;
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
  rounds: readonly RoundSummary[] | null;
  /** The branch's head on GitHub, read when a round is due; `head` is null when the branch is gone. */
  remote: { head: Sha | null } | null;
  /** The pull request's state as last polled; null until the job's first successful poll. */
  pr: { state: PullState } | null;
  /** For a parent: its sub-issues as last polled, null until the first poll. */
  children: readonly ChildFact[] | null;
  /** For a sub-issue's queued job: its open blockers as its parent last polled them. */
  blockers: readonly string[] | null;
  tree: TreeFact | null;
};

export type FactName = Exclude<keyof Facts, "now">;

export const FACTS_FOR: { readonly [S in JobState]: readonly FactName[] } = {
  ignored: [],
  queued: ["blockers", "worker"],
  starting: [],
  working: ["thread", "waiting", "gate"],
  publishing: [],
  asking: [],
  "needs-info": [],
  review: ["feedback", "pr"],
  addressing: ["thread", "waiting", "pr"],
  closing: [],
  done: [],
  stopping: [],
  stopped: [],
  sticking: [],
  stuck: [],
  sending: ["pr"],
  respawning: ["pr"],
  republishing: [],
  replying: [],
  tracking: ["children"],
  updating: [],
};

/**
 * What `review` needs once a round is due, and only then: a pull request can wait days for review, and these cost a bb
 * call and store reads per job on every sweep.
 */
export const ROUND_FACTS: readonly FactName[] = ["thread", "rounds", "remote"];

/** The facts to gather after FACTS_FOR's, given what those showed. */
export function moreFacts(job: Job, facts: Facts): readonly FactName[] {
  if (REPORTING.has(job.phase.state)) return silencePossible(job, facts.now) ? ["tree"] : [];
  if (job.phase.state !== "review" || facts.pr?.state !== "open" || !facts.feedback?.pending.length || job.round > MAX_FEEDBACK_ROUNDS) return [];
  return quietAt(facts.feedback.pending) <= facts.now ? ROUND_FACTS : [];
}

/** When a round may start: the newest pending item has been visible for FEEDBACK_QUIET_MS. */
function quietAt(pending: readonly Feedback[]): number {
  return Math.max(...pending.map((item) => item.postedAt)) + FEEDBACK_QUIET_MS;
}

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
const THREAD_FAILED = "the worker thread failed, waiting for it to recover: ";
const IDLE_WORKER = "the worker stopped without reporting after every reminder; message its thread or stop the job";
/** How long the worker's tree may show no progress before it is reminded, and after MAX_NUDGES reminders, waits. */
export const SILENCE_MS = 20 * 60_000;
const SILENT_WORKER = `no activity from the worker or its subagents for ${SILENCE_MS / 60_000} minutes after every reminder`;
const SILENT_IDLE = `${SILENT_WORKER}; message its thread or stop the job`;
const SILENT_MID_TURN = `${SILENT_WORKER} while the worker was mid-turn; message its thread or stop the job`;
/** The job waits for a person because its worker's tree went silent after every reminder. */
export const waitsOnSilence = (job: Job) => job.error?.startsWith(SILENT_WORKER) ?? false;
/** Progress this long after the job's last write, which a reminder makes, means work resumed since that reminder. */
const RESUMED_AFTER_WRITE_MS = 5 * 60_000;
/** The tree costs a bb call per member to read, so it is read only once it may be silent, or while the job waits on it. */
const silencePossible = (job: Job, now: number) => now - job.updatedAt >= SILENCE_MS || waitsOnSilence(job);
export const ROUND_MS = 4 * 60 * 60_000;

/** States a round runs through, from its start until the job rests in review or needs-info, or heads to an end. */
const IN_ROUND: ReadonlySet<JobState> = new Set(["starting", "working", "publishing", "asking", "sending", "respawning", "addressing", "republishing", "replying"]);

function silence(job: Job, thread: "idle" | "active", tree: TreeFact | null, now: number): Action | null {
  if (!tree || tree.queued) return null;
  const nudges = tree.lastActiveAt !== null && tree.lastActiveAt > job.updatedAt + RESUMED_AFTER_WRITE_MS ? 0 : job.nudges;
  if (waitsOnSilence(job)) {
    return tree.lastActiveAt !== null && tree.lastActiveAt > job.updatedAt ? { type: "change", change: { error: null, nudges } } : null;
  }
  if (now - Math.max(tree.lastActiveAt ?? 0, job.updatedAt) < SILENCE_MS) return null;
  // The reminder's write moves updatedAt, which restarts the window, so the reminder never counts as progress.
  if (nudges < MAX_NUDGES) return { type: "nudge", text: silenceText(job, nudges), change: { nudges: nudges + 1 } };
  return { type: "change", change: { error: thread === "active" ? SILENT_MID_TURN : SILENT_IDLE } };
}

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
  // A round handed to the worker for a pull request that has since closed would be a wasted turn or spawn.
  if ((phase.state === "sending" || phase.state === "respawning") && facts.pr && facts.pr.state !== "open") return { type: "change", change: close(job) };
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
      if (facts.blockers?.length) {
        const error = `waiting for ${facts.blockers.join(", ")}`;
        return job.error === error ? null : { type: "change", change: { error } };
      }
      // An unblocked child drops its waiting reason before it starts.
      if (facts.blockers && job.error?.startsWith("waiting for ")) return { type: "change", change: { error: null } };
      if (!facts.worker) return null;
      if ("error" in facts.worker) {
        // Even a problem only an operator can fix waits: the job starts once the role or the host is fixed.
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
      const quiet = quietAt(feedback.pending);
      if (quiet > now) return { type: "sleep", until: quiet };
      if (!facts.thread || !facts.rounds || !facts.remote) return null;
      if (facts.remote.head === null) return { type: "change", change: stick(job, `the branch ${job.branch} no longer exists on GitHub`) };
      // A failed thread cannot take the round's message; it is replaced like a gone one.
      const respawn = facts.thread.kind === "gone" || facts.thread.kind === "failed";
      return { type: "change", change: startRound(job, feedback.pending, facts.rounds, facts.remote.head, respawn, now) };
    }
    case "addressing":
    case "working": {
      if (facts.pr && facts.pr.state !== "open") return { type: "change", change: close(job) };
      const thread = facts.thread;
      if (!thread) return null;
      switch (thread.kind) {
        case "gone":
          return { type: "change", change: stick(job, "the worker thread was archived or deleted before it reported") };
        case "failed": {
          // bb retries provider errors such as an exhausted quota, so a failed thread may come back and report.
          const error = `${THREAD_FAILED}${thread.error}`;
          return job.error === error ? null : { type: "change", change: { error } };
        }
        case "idle":
          if (job.error?.startsWith(THREAD_FAILED)) return { type: "change", change: { error: null } };
          if (job.error === IDLE_WORKER) return null;
          if (thread.since > job.updatedAt && !facts.waiting) {
            if (job.nudges >= MAX_NUDGES) return { type: "change", change: { error: IDLE_WORKER } };
            return { type: "nudge", text: nudgeText(job, facts.gate), change: { nudges: job.nudges + 1 } };
          }
          break;
        case "active":
          if (job.error?.startsWith(THREAD_FAILED) || job.error === IDLE_WORKER || job.error === SILENT_IDLE) return { type: "change", change: { error: null } };
          break;
      }
      return silence(job, thread.kind, facts.tree, now);
    }
    case "tracking":
      return facts.children ? track(job, facts.children) : null;
    default:
      return null;
  }
}

/** A parent's next step, from its sub-issues and their jobs. */
function track(job: Job, children: readonly ChildFact[]): Action | null {
  const body = progressBody(children);
  const status: Effect = { op: "status", key: `status:${job.id}`, body };
  const open = children.filter((child) => child.state === "open");
  if (open.length === 0) {
    return { type: "change", change: { phase: enter("closing", [status, { op: "close-issue", key: `close-issue:${job.id}` }]), progress: body, error: null } };
  }
  const progressing = open.some((child) => !child.job || !TERMINAL.has(child.job.state));
  const unfinished = open.filter((child) => child.job && TERMINAL.has(child.job.state) && !child.job.merged);
  if (!progressing && unfinished.length > 0) {
    const reason = `${unfinished.map((child) => `#${child.number}`).join(", ")} need a person: their jobs ended without a merged pull request`;
    return { type: "change", change: { phase: enter("sticking", [status, ...endingEffects(job, "stick")]), progress: body, deadline: null, error: reason } };
  }
  if (body === job.progress) return null;
  return { type: "change", change: { phase: enter("updating", [status]), progress: body } };
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
function startRound(job: Job, pending: readonly Feedback[], rounds: readonly RoundSummary[], head: Sha, respawn: boolean, now: number): Change {
  const ordinal = job.round + 1;
  const text = roundPrompt(job, ordinal, pending, rounds, head);
  const relabel: Effect = { op: "labels", key: `labels:${job.id}:working:${ordinal}`, on: "issue", add: [LABEL.working], remove: [LABEL.review] };
  const round = {
    startRound: { ordinal, kind: "feedback", baseSha: head, feedback: pending.map(({ kind, id }) => ({ kind, id })) },
    roundBase: head,
    deadline: now + ROUND_MS,
    rejections: 0,
    nudges: 0,
    error: null,
  } as const;
  if (!respawn) return { phase: enter("sending", [relabel, { op: "send-round", key: `send-round:${job.id}:${ordinal}`, text }]), ...round };
  if (!job.worker) return stick(job, "the worker thread is gone and the job has no worker settings to start another");
  const spec: SpawnSpec = { ...job.worker, title: workerTitle(job), prompt: text, baseRef: `origin/${job.branch}` };
  const check: Effect = { op: "check-worktree", key: `check-worktree:${job.id}:${ordinal}`, base: head };
  return { phase: enter("respawning", [relabel, { op: "spawn", key: `spawn:${job.id}:${ordinal}`, spec }, check]), ...round };
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

export function canStop(state: JobState): boolean {
  return !TERMINAL.has(state) && state !== "stopping" && state !== "sticking";
}

/** Any non-terminal state → stopping. Replaces a pending outbox. Null when the job already ended or is ending. */
export function stop(job: Job, by: string): Change | null {
  if (!canStop(job.phase.state)) return null;
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

/**
 * A feedback round's report. `round` is the feedback round its message named, so a report from a repeated copy of an
 * earlier round's message is told apart. `pr.body`, when set, replaces the pull request description.
 */
const Round = z.number().int().positive();
export const RoundReport = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("changes"), round: Round, pr: z.strictObject({ body: z.string() }).optional(), replies: z.array(Reply), verification: Verification, summary: Line }),
  z.strictObject({ outcome: z.literal("no-change"), round: Round, replies: z.array(Reply), verification: Verification, summary: Line }),
]);
export type RoundReport = z.infer<typeof RoundReport>;

export type Report = InitialReport | RoundReport;
/** A report checked against the contract of the job's current round. */
export type ParsedReport = { round: "initial"; report: InitialReport } | { round: "feedback"; report: RoundReport };

/**
 * `invalid_report` when the report breaks its round's contract; `other_round` when it answers another feedback round's
 * message. Neither counts as a rejection.
 */
export function parseReport(job: Job, value: unknown): { ok: true; parsed: ParsedReport } | { ok: false; code: "invalid_report" | "other_round"; message: string } {
  const invalid = (error: z.ZodError) => ({ ok: false, code: "invalid_report", message: `the report does not match the contract:\n${z.prettifyError(error)}` }) as const;
  if (job.round === 1) {
    const result = InitialReport.safeParse(value);
    return result.success ? { ok: true, parsed: { round: "initial", report: result.data } } : invalid(result.error);
  }
  const result = RoundReport.safeParse(value);
  if (!result.success) return invalid(result.error);
  const current = job.round - 1;
  if (result.data.round !== current) {
    return { ok: false, code: "other_round", message: `this report is for feedback round ${result.data.round}, and the job is on feedback round ${current}; report only for the latest round message` };
  }
  return { ok: true, parsed: { round: "feedback", report: result.data } };
}

/** A report that passed every check, with the commit it was made at. That commit, not HEAD, is what gets pushed. */
export type AcceptedReport = Report & { headSha: Sha; acceptedAt: number };

export type ReportFacts = {
  now: number;
  /** `ahead`: how many commits HEAD has that `origin/<base>` does not; `commits`: those commits. */
  worktree: { headSha: Sha; dirty: boolean; ahead: number; commits: readonly Sha[] };
  /** In a feedback round, the branch's head on GitHub now. */
  remoteHead: Sha | null;
  /** `gate pr` on the worker thread's checklist. Only the first round checks it. */
  gate: GateFact;
  titleConvention: "conventional" | "free";
  /** The feedback the round sent. The replies answer each item exactly once. */
  listed: readonly Feedback[];
};

export type Verdict =
  | { ok: true; change: Change }
  | { ok: false; reasons: readonly string[]; change: Change }
  /** The branch moved on GitHub during the round. Not counted: the worker merges `moved` and reports again. */
  | { ok: false; moved: Sha; change: Change };

const refKey = (ref: FeedbackRef) => `${ref.kind} ${ref.id}`;

const roundBase = (job: Job): Sha | null => job.roundBase ?? job.pushedSha;

/** HEAD is new this round: ahead of the base branch in the first round, past the round's base in a later one. */
function newCommit(job: Job, worktree: ReportFacts["worktree"]): boolean {
  return job.round === 1 ? worktree.ahead > 0 : worktree.headSha !== roundBase(job);
}

export function containsSha(worktree: { headSha: Sha; commits: readonly Sha[] }, sha: Sha): boolean {
  return worktree.headSha === sha || worktree.commits.includes(sha);
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
  // A rejected report goes back to the worker to fix, however many times: ending the job would throw its work away.
  return { ok: false, reasons, change: { rejections: job.rejections + 1, error: `report rejected: ${reasons.join("; ")}` } };
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
  const base = roundBase(job)!;
  if (facts.remoteHead !== null && facts.remoteHead !== base) return { ok: false, moved: facts.remoteHead, change: { roundBase: facts.remoteHead } };
  const reasons = commitProblems(job, report.outcome, facts.worktree, `${base.slice(0, 7)}, the head of \`${job.branch}\``);
  if (!containsSha(facts.worktree, base)) {
    reasons.push(`HEAD does not contain ${base.slice(0, 7)}, the head of \`${job.branch}\` on GitHub: run \`git fetch origin\`, merge \`origin/${job.branch}\`, and report again`);
  }
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
  return ["republishing", [{ op: "push", key: `push:${job.id}:${report.headSha}`, sha: report.headSha, expectedRemoteSha: roundBase(job) }, ...after]];
}

function replyEffect(job: Job, reply: RoundReport["replies"][number], answers: Feedback): Extract<Effect, { op: "reply" }> {
  const target: ReplyTarget = answers.kind === "review-comment" ? { kind: answers.kind, id: answers.id, thread: answers.inReplyTo ?? answers.id } : { kind: answers.kind, id: answers.id };
  return { op: "reply", key: `reply:${job.id}:${job.round}:${reply.kind}:${reply.commentId}`, target, body: replyText(reply.body, answers) };
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
  parentId: JobId | null;
  repo: RepoName;
  issue: number;
  title: string;
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
    parentId: job.parentId,
    repo: job.repo,
    issue: job.issue,
    title: job.snapshot.title,
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
