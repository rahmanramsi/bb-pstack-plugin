/**
 * The issue feature's runtime: the only code that calls GitHub, bb.sdk or the host push for issue jobs. It gathers
 * facts, asks job.ts what to do, and writes each answer with one version-guarded store.write. Polling, thread events,
 * the 15 s sweep and the report command all end in tick(jobId).
 *
 * Crash rules, all read from the row: an effect is claimed (tries + 1 and a lease) before it runs, so after a crash
 * the next claim probes for its trace first. A spawn is never run twice. A thread whose metadata names a job that is
 * not waiting for it is stopped.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi, PluginCliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { HostPush } from "../host-contract.ts";
import type { ModelChoice } from "../models.ts";
import { issueCommands, type RepoMapping } from "./commands.ts";
import { issueBoard, type BoardFilter, type IssueBoardSchema, type IssueSummarySchema } from "./board.ts";
import { CAN_TRIGGER, GitHubPermanentError, GitHubSetupError, GitHubTransientError, type ActivityCursor, type GitHub, type PollCursor, type RepoClient } from "./github.ts";
import {
  EFFECT_POLICY,
  FACTS_FOR,
  LABEL,
  REPORTING,
  TERMINAL,
  acceptReport,
  parseReport,
  awaitingThread,
  containsSha,
  isTransit,
  TRANSIT,
  command,
  counts,
  moreFacts,
  isReasoningLevel,
  plan,
  settle,
  stop as stopChange,
  type Action,
  type Change,
  type Effect,
  type EffectMode,
  type EffectOp,
  type EffectOutcome,
  type ChildFact,
  type Facts,
  type Feedback,
  type GateFact,
  type Job,
  type ParsedReport,
  type JobId,
  type RepoName,
  type ReportFacts,
  type Sha,
  type SubIssue,
  type WorkerProblem,
  type WorkerSettings,
} from "./job.ts";
import type { IssueStore } from "./store.ts";
import { commentBody, effectMarker, mergeNote, workerInstructions } from "./text.ts";

export const SWEEP_MS = 15_000;
export const POLL_MS = 60_000;
const MAX_STEPS = 20;
const SETTLE_MARGIN_MS = 5_000;
/** Kept back from the push so the token can still be revoked before the lease ends. */
const REVOKE_MS = 30_000;

/** Agents can write their own metadata, so it only points at a job; the store decides. */
export const IssueMetadata = z.object({ pstackIssue: z.literal(1), jobId: z.string() });

export type IssuesDeps = {
  bb: BbPluginApi;
  store: IssueStore;
  github: GitHub;
  hostPush: HostPush;
  /** Configured repositories; empty while issue workers are not set up. */
  repos: () => readonly RepoMapping[];
  /** The GitHub plugin's issue catalog, when available. Worker execution still requires a repository mapping. */
  catalog?: () => Promise<z.infer<typeof IssueSummarySchema>[]>;
  resolveRole: (role: string) => readonly ModelChoice[];
  prGate: (threadId: string) => GateFact;
  /**
   * Why the host cannot run this `provider/model/level` tuple, or null when it can. Throws when it cannot tell, such as
   * while the host is offline.
   */
  checkWorker: (hostId: string, tuple: string) => Promise<string | null>;
  /** The pstack runs and child threads a thread is waiting on, as the checklist nudge counts them. */
  activeWork: (threadId: string) => Promise<{ activeRuns: number; activeChildren: number }>;
  clock?: () => number;
};

export type Issues = {
  board(filter: BoardFilter): Promise<z.infer<typeof IssueBoardSchema>>;
  start(repo: string, issue: number): Promise<JobId>;
  /** `bb pstack issues …`, spread into the plugin's single CLI. */
  commands: Record<string, PluginCliCommand>;
  /** Thread events and the `pstack-issues` service. */
  register(): void;
  /** Standing instructions for a thread bound to an open job, else null. */
  instructions(threadId: string): string | null;
  /** One pass of the service: poll every repository, reconcile every job that may act, and wait for any reconcile in flight. */
  sweep(): Promise<void>;
  /** Moves the job to stopping and starts its ending effects. False when it already ended or is ending, or does not exist. */
  stop(id: JobId, by: string): Promise<boolean>;
};

export type ReportResult = { ok: true; message: string } | { ok: false; code: string; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  return candidate?.status === 404 || candidate?.code === "thread_not_found";
};
const short = (sha: string) => sha.slice(0, 7);

type Worktree = { ok: true; path: string; headSha: Sha; dirty: boolean; ahead: number; commits: Sha[] } | { ok: false; transient: boolean; error: string };

/** `deadline` is when the claim's lease ends, less a margin to settle; every call the effect makes ends by then. */
type Run<Op extends EffectOp> = (job: Job, effect: Extract<Effect, { op: Op }>, deadline: number) => Promise<EffectOutcome>;
/** How to perform an effect, and how to find its trace when EFFECT_POLICY looks for one before running it again. */
export type EffectHandler<Op extends EffectOp> = { perform: Run<Op> } & ((typeof EFFECT_POLICY)[Op]["recovery"]["kind"] extends "replay"
  ? { probe?: never }
  : { probe: Run<Op> });

export function createIssues(deps: IssuesDeps): Issues {
  const { bb, store, github } = deps;
  const clock = deps.clock ?? Date.now;
  const done = (patch = {}): EffectOutcome => ({ kind: "done", patch });
  const until = (deadline: number) => AbortSignal.timeout(Math.max(0, deadline - clock()));

  /**
   * Threads in the job's project whose metadata names the job, created since it was, and not bound to another job.
   * bb lists pinned threads first and then newest first, so paging stops at the first unpinned thread older than that.
   */
  async function threadsNaming(job: Job, signal?: AbortSignal | undefined): Promise<string[]> {
    const found: string[] = [];
    const since = job.createdAt - 60_000;
    const PAGE = 100;
    for (let offset = 0; ; offset += PAGE) {
      const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, projectId: job.projectId, includeHidden: true, archived: false, limit: PAGE, offset, ...(signal ? { signal } : {}) });
      const candidates = page.filter((thread) => thread.createdAt >= since && (store.byThread(thread.id)?.id ?? job.id) === job.id).map((thread) => thread.id);
      if (candidates.length > 0) {
        const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: candidates, ...(signal ? { signal } : {}) });
        for (const { threadId, metadata } of threads) {
          const named = IssueMetadata.safeParse(metadata);
          if (named.success && named.data.jobId === job.id) found.push(threadId);
        }
      }
      if (page.length < PAGE || page.some((thread) => thread.pinnedAt === null && thread.createdAt < since)) return found;
    }
  }

  async function worktree(job: Job, signal?: AbortSignal): Promise<Worktree> {
    if (!job.threadId) return { ok: false, transient: false, error: "the job has no worker thread" };
    const thread = await bb.sdk.threads.get({ threadId: job.threadId, ...(signal ? { signal } : {}) });
    if (!thread.environmentId) return { ok: false, transient: true, error: "the worker's worktree is not ready" };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, ...(signal ? { signal } : {}) });
    if (environment.hostId !== job.hostId) return { ok: false, transient: false, error: `the worker runs on ${environment.hostId}, not the mapped host ${job.hostId}` };
    if (environment.status !== "ready" || !environment.path) return { ok: false, transient: true, error: `the worker's worktree is ${environment.status}` };
    const status = await bb.sdk.environments.status({ environmentId: thread.environmentId, mergeBaseBranch: `origin/${job.baseBranch}`, ...(signal ? { signal } : {}) });
    if (status.outcome === "unavailable") return { ok: false, transient: true, error: `the worktree status is unavailable: ${status.failure.message}` };
    if (status.outcome !== "available") return { ok: false, transient: false, error: status.message };
    const { checkout, workingTree, mergeBase } = status.workspace;
    const headSha = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
    if (!headSha) return { ok: false, transient: false, error: "the worktree has no commit" };
    return {
      ok: true,
      path: environment.path,
      headSha: headSha as Sha,
      dirty: workingTree.hasUncommittedChanges || workingTree.files.some((file) => file.status === "??"),
      ahead: mergeBase?.aheadCount ?? 0,
      commits: (mergeBase?.commits ?? []).map((commit) => commit.sha as Sha),
    };
  }

  const EFFECTS: { readonly [Op in EffectOp]: EffectHandler<Op> } = {
    labels: {
      async perform(job, effect, deadline) {
        const repo = github.repo(job.repo, until(deadline));
        const number = effect.on === "pr" ? job.pr?.number : job.issue;
        if (number === undefined) return { kind: "fail", error: "the pull request to label is not recorded" };
        if (effect.add.length > 0) await repo.addLabels(number, effect.add);
        for (const label of effect.remove) await repo.removeLabel(number, label);
        return done();
      },
    },
    spawn: {
      async perform(job, effect) {
        const { spec } = effect;
        try {
          const thread = await bb.sdk.threads.spawn({
            projectId: job.projectId,
            visibility: "visible",
            // Not the project's worktree base: the first worker starts from the ref report validation counts new
            // commits against, so a fresh worktree has nothing ahead of it; a replacement starts from the pushed branch.
            environment: { type: "host", hostId: job.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: spec.baseRef } } },
            pluginMetadata: { pstackIssue: 1, jobId: job.id },
            prompt: spec.prompt,
            title: spec.title,
            providerId: spec.providerId,
            model: spec.model,
            reasoningLevel: spec.reasoningLevel,
            ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
          });
          return done({ threadId: thread.id });
        } catch (error) {
          return { kind: "unknown", error: `spawn: ${message(error)}` };
        }
      },
      async probe(job, _effect, deadline) {
        // A replacement's probe must not adopt the thread it replaces, which still names the job.
        const [threadId] = (await threadsNaming(job, until(deadline))).filter((id) => id !== job.threadId);
        return threadId ? done({ threadId }) : { kind: "absent" };
      },
    },
    push: {
      async perform(job, effect, deadline) {
        const tree = await worktree(job, until(deadline));
        if (!tree.ok) return tree.transient ? { kind: "retry", error: tree.error, notBefore: null } : { kind: "fail", error: tree.error };
        const repo = github.repo(job.repo, until(deadline));
        const { remoteUrl, token } = await repo.pushCredentials();
        try {
          const input = { worktreePath: tree.path, remoteUrl, branch: job.branch, sha: effect.sha, expectedRemoteSha: effect.expectedRemoteSha, token };
          const result = await deps.hostPush(job.hostId, input, until(deadline - REVOKE_MS));
          if (result.status === "pushed") return done({ pushedSha: effect.sha });
          // A claim whose lease ran out may still be pushing the same commit, and its push can land first.
          if (result.status === "rejected" && result.reason === "stale-remote" && (await repo.branchSha(job.branch)) === effect.sha) {
            return done({ pushedSha: effect.sha });
          }
          if (result.status === "rejected") return { kind: "fail", error: `push rejected (${result.reason}): ${result.detail}` };
          return { kind: "unknown", error: `push failed: ${result.detail}` };
        } catch (error) {
          return { kind: "unknown", error: `push: ${message(error)}` };
        } finally {
          await repo.revoke(token).catch((error) => bb.log.warn(`pstack issues: could not revoke a push token: ${message(error)}`));
        }
      },
      async probe(job, effect, deadline) {
        return (await github.repo(job.repo, until(deadline)).branchSha(job.branch)) === effect.sha ? done({ pushedSha: effect.sha }) : { kind: "absent" };
      },
    },
    "open-pr": {
      async perform(job, effect, deadline) {
        try {
          const pr = await github.repo(job.repo, until(deadline)).createDraftPull({ head: job.branch, base: job.baseBranch, title: effect.title, body: effect.body });
          return done({ pr });
        } catch (error) {
          if (error instanceof GitHubPermanentError && error.status === 422) return { kind: "unknown", error: error.message };
          throw error;
        }
      },
      async probe(job, _effect, deadline) {
        const pr = await github.repo(job.repo, until(deadline)).findPull(job.branch);
        return pr ? done({ pr }) : { kind: "absent" };
      },
    },
    comment: {
      async perform(job, effect, deadline) {
        await github.repo(job.repo, until(deadline)).comment(job.issue, commentBody(effect.body, effect.key));
        return done();
      },
      async probe(job, effect, deadline) {
        const since = (("effects" in job.phase && job.phase.firstAt) || clock()) - 60_000;
        return (await github.repo(job.repo, until(deadline)).findComment(job.issue, effectMarker(effect.key), since)) ? done() : { kind: "absent" };
      },
    },
    "send-round": {
      async perform(job, effect) {
        if (!job.threadId) return { kind: "fail", error: "the job has no worker thread" };
        try {
          // Queued behind a turn that is still running, never steered into it.
          await bb.sdk.threads.send({ threadId: job.threadId, mode: "queue-if-active", input: [{ type: "text", text: effect.text, mentions: [] }] });
        } catch (error) {
          if (isMissing(error)) return { kind: "fail", error: "the worker thread is gone" };
          throw error;
        }
        return done();
      },
    },
    reply: {
      async perform(job, effect, deadline) {
        if (!job.pr) return { kind: "fail", error: "the pull request to reply on is not recorded" };
        const repo = github.repo(job.repo, until(deadline));
        const body = commentBody(effect.body, effect.key);
        if (effect.target.kind !== "review-comment") {
          await repo.comment(job.pr.number, body);
          return done();
        }
        try {
          await repo.replyToReviewComment(job.pr.number, effect.target.thread, body);
        } catch (error) {
          if (!(error instanceof GitHubPermanentError && error.status === 404) || (await repo.reviewComment(effect.target.thread)) !== null) throw error;
          // The thread's first comment was deleted, and the thread with it: there is nothing left to answer in.
          bb.log.info(`pstack issues: ${job.id}: review comment ${effect.target.thread} is gone, reply dropped`);
        }
        return done();
      },
      async probe(job, effect, deadline) {
        if (!job.pr) return { kind: "absent" };
        const repo = github.repo(job.repo, until(deadline));
        const since = (("effects" in job.phase && job.phase.firstAt) || clock()) - 60_000;
        const marker = effectMarker(effect.key);
        const found = effect.target.kind === "review-comment" ? await repo.findReviewComment(job.pr.number, marker, since) : await repo.findComment(job.pr.number, marker, since);
        return found ? done() : { kind: "absent" };
      },
    },
    "request-review": {
      async perform(job, effect, deadline) {
        if (!job.pr) return { kind: "fail", error: "the pull request to request reviews on is not recorded" };
        const { dropped } = await github.repo(job.repo, until(deadline)).requestReviewers(job.pr.number, effect.reviewers);
        if (dropped.length > 0) bb.log.info(`pstack issues: ${job.id}: GitHub refused review requests for ${dropped.join(", ")}`);
        return done();
      },
    },
    "edit-pr": {
      async perform(job, effect, deadline) {
        if (!job.pr) return { kind: "fail", error: "the pull request to edit is not recorded" };
        await github.repo(job.repo, until(deadline)).editPull(job.pr.number, { body: effect.body });
        return done();
      },
    },
    "check-worktree": {
      async perform(job, effect, deadline) {
        const tree = await worktree(job, until(deadline));
        if (!tree.ok) return tree.transient ? { kind: "retry", error: tree.error, notBefore: null } : { kind: "fail", error: tree.error };
        if (containsSha(tree, effect.base) || !job.threadId) return done();
        // Steered into the turn the worker is running, which is the one that would commit on a stale base.
        await bb.sdk.threads.send({ threadId: job.threadId, mode: "steer-if-active", input: [{ type: "text", text: mergeNote(job, tree.headSha, effect.base), mentions: [] }] });
        return done();
      },
    },
    status: {
      async perform(job, effect, deadline) {
        const repo = github.repo(job.repo, until(deadline));
        const body = commentBody(effect.body, effect.key);
        const found = await repo.findComment(job.issue, effectMarker(effect.key), job.createdAt);
        if (found) await repo.editComment(found.id, body);
        else await repo.comment(job.issue, body);
        return done();
      },
    },
    "close-issue": {
      async perform(job, _effect, deadline) {
        await github.repo(job.repo, until(deadline)).closeIssue(job.issue);
        return done();
      },
    },
    "stop-thread": {
      async perform(job, _effect, deadline) {
        const signal = until(deadline);
        const threads = new Set([...(job.threadId ? [job.threadId] : []), ...(await threadsNaming(job, signal))]);
        for (const threadId of threads) {
          await bb.sdk.threads.stop({ threadId, signal }).catch((error) => {
            if (!isMissing(error)) throw error;
          });
        }
        return done();
      },
    },
  };

  async function runEffect(job: Job, effect: Effect, mode: EffectMode, deadline: number): Promise<EffectOutcome> {
    const handler = EFFECTS[effect.op] as { perform: Run<EffectOp>; probe?: Run<EffectOp> };
    try {
      if (mode === "perform") return await handler.perform(job, effect, deadline);
      if (!handler.probe) throw new Error(`${effect.op} has no probe`);
      const probed = await handler.probe(job, effect, deadline);
      return probed.kind === "absent" && mode === "probe-then-perform" ? await handler.perform(job, effect, deadline) : probed;
    } catch (error) {
      if (error instanceof GitHubTransientError) return { kind: "retry", error: error.message, notBefore: error.notBefore };
      if (error instanceof GitHubSetupError) return { kind: "retry", error: error.message, notBefore: null };
      if (error instanceof GitHubPermanentError) return { kind: "fail", error: error.message };
      return { kind: "unknown", error: `${effect.op}: ${message(error)}` };
    }
  }

  async function resolveWorker(job: Job): Promise<WorkerSettings | WorkerProblem> {
    const permanent = (error: string): WorkerProblem => ({ error, permanent: true });
    const choice = deps.resolveRole("issue worker")[0];
    if (!choice) return permanent("no model is configured for the issue worker role");
    try {
      const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId: job.projectId });
      const permissionMode = defaults?.permissionMode ?? null;
      let worker: WorkerSettings;
      if (choice.kind === "tuple") {
        if (!isReasoningLevel(choice.reasoningLevel)) return permanent(`the issue worker role's reasoning level "${choice.reasoningLevel}" is not one bb knows`);
        worker = { providerId: choice.provider, model: choice.model, reasoningLevel: choice.reasoningLevel, permissionMode };
      } else {
        if (!defaults) return permanent(`the issue worker role inherits the project's model, and project ${job.projectId} has no default`);
        worker = { providerId: defaults.providerId, model: defaults.model, reasoningLevel: defaults.reasoningLevel, permissionMode };
      }
      const problem = await deps.checkWorker(job.hostId, `${worker.providerId}/${worker.model}/${worker.reasoningLevel}`);
      return problem ? permanent(problem) : worker;
    } catch (error) {
      return { error: message(error), permanent: false };
    }
  }

  async function threadFact(threadId: string | null): Promise<Facts["thread"]> {
    if (!threadId) return { kind: "gone" };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) return { kind: "gone" };
      if (thread.status === "error") return { kind: "failed", error: "the thread is in an error state" };
      if (thread.status === "idle") return { kind: "idle", since: thread.updatedAt };
      return { kind: "active" };
    } catch (error) {
      return isMissing(error) ? { kind: "gone" } : null;
    }
  }

  async function gather(job: Job): Promise<Facts> {
    const facts: Facts = { now: clock(), worker: null, thread: null, waiting: null, gate: null, feedback: null, rounds: null, remote: null, pr: null, children: null, blockers: null };
    const first = FACTS_FOR[job.phase.state];
    if (first.includes("feedback")) facts.feedback = { pending: store.pendingFeedback(job.id) };
    if (first.includes("pr")) {
      const { prState } = store.jobPoll(job.id);
      facts.pr = prState ? { state: prState } : null;
    }
    if (first.includes("children")) facts.children = childFacts(job);
    if (first.includes("blockers") && job.parentId) {
      facts.blockers = store.polledChildren(job.parentId)?.find((child) => child.number === job.issue)?.blockedBy ?? [];
    }
    const wanted = [...first, ...moreFacts(job, facts)];
    if (wanted.includes("rounds")) facts.rounds = store.roundSummaries(job.id);
    if (wanted.includes("remote")) {
      facts.remote = await github
        .repo(job.repo)
        .branchSha(job.branch)
        .then((head) => ({ head }))
        .catch((error) => (bb.log.warn(`pstack issues: ${job.id}: could not read ${job.branch}: ${message(error)}`), null));
    }
    if (wanted.includes("worker")) facts.worker = await resolveWorker(job);
    if (wanted.includes("thread")) facts.thread = await threadFact(job.threadId);
    if (facts.thread?.kind === "idle" && job.threadId) {
      const threadId = job.threadId;
      if (wanted.includes("waiting")) {
        const work = await deps.activeWork(threadId).catch(() => null);
        // Unknown counts as waiting: a missed nudge costs a sweep, a wrong one costs the job.
        facts.waiting = work === null || work.activeRuns > 0 || work.activeChildren > 0;
      }
      if (wanted.includes("gate")) facts.gate = deps.prGate(threadId);
    }
    return facts;
  }

  function childFacts(parent: Job): ChildFact[] | null {
    const polled = store.polledChildren(parent.id);
    if (!polled) return null;
    const created = store.children(parent.id);
    return polled.map((child) => {
      const job = store.open(parent.repo, child.number) ?? created.find((row) => row.issue === child.number);
      return { ...child, job: job ? { state: job.phase.state, merged: store.jobPoll(job.id).prState === "merged" } : null };
    });
  }

  async function apply(job: Job, action: Exclude<Action, { type: "sleep" }>): Promise<void> {
    switch (action.type) {
      case "change":
        store.write(job.id, job.version, action.change, clock());
        return;
      case "nudge": {
        if (!store.write(job.id, job.version, action.change, clock()) || !job.threadId) return;
        await bb.sdk.threads
          .send({ threadId: job.threadId, mode: "queue-if-active", input: [{ type: "text", text: action.text, mentions: [] }] })
          .catch((error) => bb.log.warn(`pstack issues: could not nudge ${job.threadId}: ${message(error)}`));
        return;
      }
      case "effect": {
        const { phase } = job;
        if (!("effects" in phase)) return;
        const claimed = store.write(job.id, job.version, { phase: { ...phase, tries: phase.tries + 1, firstAt: phase.firstAt ?? clock(), leaseUntil: action.leaseUntil } }, clock());
        if (!claimed) return;
        const outcome = await runEffect(claimed, action.effect, action.mode, action.leaseUntil - SETTLE_MARGIN_MS);
        // A lost write here means stop replaced the outbox while the effect ran; its result is dropped on purpose.
        store.write(job.id, claimed.version, settle(claimed, outcome, clock()), clock());
        return;
      }
    }
  }

  async function reconcile(id: JobId): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step++) {
      const job = store.get(id);
      if (!job) return;
      const action = plan(job, await gather(job));
      if (!action || action.type === "sleep") return;
      await apply(job, action);
    }
  }

  const running = new Map<JobId, { again: boolean; done: Promise<void> }>();
  function tick(id: JobId): Promise<void> {
    const current = running.get(id);
    if (current) {
      current.again = true;
      return current.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await reconcile(id);
        } while (entry.again);
      } finally {
        running.delete(id);
      }
    })();
    running.set(id, entry);
    return entry.done;
  }
  const background = (work: Promise<void>) => void work.catch((error) => bb.log.error(`pstack issues: ${message(error)}`));

  /**
   * Writes the Change `decide` computes from a fresh read, re-reading when another writer got there first, and returns
   * the written row with what `decide` concluded. Null when the job is gone or `decide` declines.
   */
  function writeFresh<T>(id: JobId, decide: (job: Job) => { change: Change; result: T } | null): { job: Job; result: T } | null {
    for (let attempt = 0; attempt < 5; attempt++) {
      const job = store.get(id);
      if (!job) return null;
      const decision = decide(job);
      if (!decision) return null;
      const written = store.write(id, job.version, decision.change, clock());
      if (written) return { job: written, result: decision.result };
    }
    throw new Error(`issue job ${id} kept changing while it was being written`);
  }

  async function reportFacts(job: Job): Promise<ReportFacts | { unavailable: string }> {
    try {
      const tree = await worktree(job);
      if (!tree.ok) return { unavailable: tree.error };
      const remoteHead = job.round === 1 ? null : await github.repo(job.repo).branchSha(job.branch);
      if (job.round > 1 && remoteHead === null) return { unavailable: `the branch ${job.branch} is not on GitHub` };
      return {
        now: clock(),
        worktree: { headSha: tree.headSha, dirty: tree.dirty, ahead: tree.ahead, commits: tree.commits },
        remoteHead,
        gate: job.threadId ? deps.prGate(job.threadId) : { pass: false, reason: "the job has no worker thread" },
        titleConvention: await github.repo(job.repo).titleConvention(),
        listed: store.roundFeedback(job.id, job.round),
      };
    } catch (error) {
      return { unavailable: message(error) };
    }
  }

  /**
   * The job a thread's metadata names, null inside when that job does not exist, or null when the metadata names none.
   * Only a pointer: the store's binding decides who may report.
   */
  async function namedJob(threadId: string): Promise<{ job: Job | null } | null> {
    const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null));
    return metadata.success ? { job: store.get(metadata.data.jobId as JobId) } : null;
  }

  async function report(threadId: string, text: string): Promise<ReportResult> {
    const bound = store.byThread(threadId);
    if (!bound) {
      const named = (await namedJob(threadId))?.job;
      if (!named || !awaitingThread(named)) return { ok: false, code: "not_issue_worker", message: "only an issue worker thread can report" };
      background(tick(named.id));
      return { ok: false, code: "unavailable", message: "pstack has not confirmed this thread as the issue's worker yet, try again shortly" };
    }
    if (isTransit(bound.phase.state) && REPORTING.has(TRANSIT[bound.phase.state])) {
      return { ok: false, code: "unavailable", message: "pstack is still starting this round, try again shortly" };
    }
    if (!REPORTING.has(bound.phase.state)) return { ok: false, code: "not_working", message: `job ${bound.id} is ${bound.phase.state}, not waiting for a report` };
    let parsed: ParsedReport;
    try {
      const result = parseReport(bound, JSON.parse(text));
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      parsed = result.parsed;
    } catch (error) {
      return { ok: false, code: "invalid_report", message: `the report is not JSON: ${message(error)}` };
    }
    const facts = await reportFacts(bound);
    if ("unavailable" in facts) return { ok: false, code: "unavailable", message: `pstack could not check the report yet, try again shortly: ${facts.unavailable}` };

    const written = writeFresh(bound.id, (job) => {
      if (!REPORTING.has(job.phase.state) || job.round !== bound.round) return null;
      const verdict = acceptReport(job, parsed, facts);
      return { change: verdict.change, result: verdict };
    });
    if (!written) return { ok: false, code: "not_working", message: `job ${bound.id} is no longer waiting for a report` };
    const outcome = written.result;
    background(tick(bound.id));
    if ("moved" in outcome) {
      return {
        ok: false,
        code: "remote_moved",
        message: `\`${bound.branch}\` on GitHub moved to ${short(outcome.moved)} since this round started. Run \`git fetch origin\`, merge \`origin/${bound.branch}\`, commit, and report again. This does not count as a rejection.`,
      };
    }
    if (!outcome.ok) {
      return {
        ok: false,
        code: "rejected",
        message: ["Report rejected:", ...outcome.reasons.map((reason) => `- ${reason}`), "Fix every reason and report again."].join("\n"),
      };
    }
    const sha = short(facts.worktree.headSha);
    if (parsed.round === "feedback") {
      const push = parsed.report.outcome === "changes" ? `pushes ${sha} to ${bound.branch}, ` : "";
      return { ok: true, message: `Report accepted. pstack ${push}posts your replies, and asks the reviewers to look again.` };
    }
    const messages = {
      changes: `Report accepted. pstack pushes ${sha} to ${bound.branch} and opens a draft pull request.`,
      "needs-info": "Report accepted. pstack posts your questions on the issue.",
      "no-change": "Report accepted. pstack posts your reason on the issue and ends the job.",
    } as const;
    return { ok: true, message: messages[parsed.report.outcome] };
  }

  async function stop(id: JobId, by: string): Promise<boolean> {
    const written = writeFresh(id, (job) => {
      const change = stopChange(job, by);
      return change && { change, result: null };
    });
    if (!written) return false;
    background(tick(id));
    for (const child of store.children(id)) {
      if (!TERMINAL.has(child.phase.state)) await stop(child.id, `parent ${id}`);
    }
    return true;
  }

  async function onThread(threadId: string): Promise<void> {
    const bound = store.byThread(threadId);
    if (bound) return tick(bound.id);
    const named = await namedJob(threadId);
    if (!named) return;
    const { job } = named;
    if (job && awaitingThread(job)) return tick(job.id);
    if (job && ("effects" in job.phase ? job.phase.effects.some((effect) => effect.op === "stop-thread") : false)) return;
    await bb.sdk.threads.stop({ threadId }).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }

  /**
   * Polls each open job on its own, so one that GitHub cannot read holds back no other: it keeps its last cursor and
   * pull request state and records the error. An `@<app> stop` on the issue or the pull request stops the job. The
   * pull request's feedback that counts is stored: job.ts's rules pass, and its author has write access and is not
   * the App.
   */
  async function pollJobs(repo: RepoClient): Promise<void> {
    const jobs = store.list({ repo: repo.name, all: false });
    if (jobs.length === 0) return;
    const appLogin = await repo.appLogin();
    const appSlug = appLogin.replace(/\[bot\]$/, "");
    const trusted = async (author: string) => author !== appLogin && CAN_TRIGGER.has(await repo.permission(author));
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const target = { issue: job.issue, since: job.createdAt, pr: job.pr?.number ?? null };
          const result = await repo.activity(target, store.jobPoll(job.id).cursor as ActivityCursor | null);
          const comments = [...result.issueComments, ...(result.pull?.items.filter((item) => item.kind === "pr-comment") ?? [])];
          let stopper: string | null = null;
          for (const comment of comments) {
            if (!stopper && command(comment.body, appSlug) === "stop" && comment.createdAt >= job.createdAt && (await trusted(comment.author))) stopper = comment.author;
          }
          const feedback: Feedback[] = [];
          for (const item of result.pull?.items ?? []) {
            if (!counts(item, appSlug) || !(await trusted(item.author))) continue;
            const { pr: _, reviewState: __, ...rest } = item;
            const parent = item.inReplyTo !== null && !store.hasFeedback(repo.name, item) ? await repo.reviewComment(item.inReplyTo) : null;
            feedback.push({ ...rest, parent });
          }
          store.recordPoll(job.id, { cursor: result.next, prState: result.pull?.state ?? null, feedback }, clock());
          if (stopper) await stop(job.id, `@${stopper} on GitHub`);
          else if (job.phase.state === "tracking" || job.phase.state === "updating") await pollChildren(repo, job);
        } catch (error) {
          store.recordPollError(job.id, message(error), clock());
        }
      }),
    );
  }

  /**
   * A parent's sub-issues and their blockers. Stops the parent when its issue lost the label or closed, and inserts a
   * job for each open sub-issue that has neither an open job nor one this parent created.
   */
  async function pollChildren(repo: RepoClient, parent: Job): Promise<void> {
    const issue = await repo.issue(parent.issue);
    if (!issue.open || (parent.trigger.eventId !== null && !issue.labels.includes(LABEL.trigger))) {
      await stop(parent.id, issue.open ? `removing the ${LABEL.trigger} label` : "closing the issue");
      return;
    }
    const listed = await repo.subIssues(parent.issue);
    const children: SubIssue[] = await Promise.all(
      listed.map(async ({ number, title, url, state }) => ({ number, title, url, state, blockedBy: state === "open" ? await repo.blockedBy(number) : [] })),
    );
    store.saveChildren(parent.id, children, clock());
    const created = new Set(store.children(parent.id).map((job) => job.issue));
    const baseBranch = await repo.defaultBranch();
    const { title, body, url } = parent.snapshot;
    for (const child of listed) {
      if (child.state !== "open" || created.has(child.number) || store.open(parent.repo, child.number)) continue;
      store.insert(
        {
          id: `psi_${randomUUID()}` as JobId,
          repo: parent.repo,
          issue: child.number,
          trigger: { eventId: null, actor: parent.trigger.actor, at: parent.trigger.at },
          snapshot: { title: child.title, body: child.body, url: child.url, author: child.author, parent: { number: parent.issue, title, body, url } },
          parentId: parent.id,
          projectId: parent.projectId,
          hostId: parent.hostId,
          baseBranch,
          state: "queued",
          error: null,
        },
        clock(),
      );
    }
  }

  async function pollRepo(mapping: RepoMapping, primaryHostId: string | null): Promise<void> {
    const now = clock();
    let cursor = store.repoPoll(mapping.repo).poll as PollCursor | null;
    if (mapping.hostId === primaryHostId) {
      store.saveRepoPoll(mapping.repo, cursor, now, `host ${mapping.hostId} is the bb server's machine; map ${mapping.repo} to another host`);
      return;
    }
    const repo = github.repo(mapping.repo);
    const errors: string[] = [];
    try {
      cursor = (await pollLabels(mapping, repo, cursor, now)) ?? cursor;
    } catch (error) {
      errors.push(message(error));
    }
    try {
      await pollJobs(repo);
    } catch (error) {
      errors.push(message(error));
    }
    store.saveRepoPoll(mapping.repo, cursor, now, errors.join("; ") || null);
  }

  /** Inserts a job for each new label event. Returns the next cursor, or null when nothing changed. */
  async function pollLabels(mapping: RepoMapping, repo: RepoClient, cursor: PollCursor | null, now: number): Promise<PollCursor | null> {
    const result = await repo.labeledIssues(LABEL.trigger, cursor);
    if (!result.changed) return null;
    const [appLogin, baseBranch] = await Promise.all([repo.appLogin(), repo.defaultBranch()]);
    for (const issue of result.issues) {
      if (store.open(mapping.repo, issue.number)) continue;
      const event = await repo.latestLabelEvent(issue.number, LABEL.trigger);
      if (!event || store.byTrigger(event.id)) continue;
      const permission = event.actor === appLogin ? null : await repo.permission(event.actor);
      const refusal =
        permission === null ? "the label was added by the GitHub App" : CAN_TRIGGER.has(permission) ? null : `@${event.actor} has ${permission} permission`;
      store.insert(
        {
          id: `psi_${randomUUID()}` as JobId,
          repo: mapping.repo,
          issue: issue.number,
          trigger: { eventId: event.id, actor: event.actor, at: event.at },
          snapshot: { title: issue.title, body: issue.body, url: issue.url, author: issue.author },
          projectId: mapping.projectId,
          hostId: mapping.hostId,
          baseBranch,
          state: refusal ? "ignored" : issue.subIssues > 0 ? "tracking" : "queued",
          error: refusal,
        },
        now,
      );
    }
    return result.next;
  }

  /** Inserts the jobs new label events start and stores new feedback. The next tickDue acts on both. */
  async function poll(): Promise<void> {
    const repos = deps.repos();
    if (repos.length === 0) return;
    const { primaryHostId } = await bb.sdk.system.config();
    await Promise.all(repos.map((mapping) => pollRepo(mapping, primaryHostId)));
  }

  /** Reconciles every job that may act now, concurrently, and resolves when all of them have. */
  async function tickDue(): Promise<void> {
    await Promise.all(store.due(clock()).map((id) => tick(id).catch((error) => bb.log.error(`pstack issues: ${id}: ${message(error)}`))));
  }

  async function serve(signal: AbortSignal): Promise<void> {
    let nextPoll = 0;
    while (!signal.aborted) {
      try {
        if (clock() >= nextPoll) {
          nextPoll = clock() + POLL_MS;
          await poll();
        }
        // Not awaited: a job's slow push must not hold back polling or the next pass. tick() runs one reconcile per job.
        background(tickDue());
      } catch (error) {
        bb.log.error(`pstack issues: ${message(error)}`);
      }
      await sleep(SWEEP_MS, undefined, { signal }).catch(() => {});
    }
  }

  const openJob = (threadId: string) => {
    const job = store.byThread(threadId);
    return job && !TERMINAL.has(job.phase.state) ? job : null;
  };

  return {
    async board(filter) {
      const mappings = deps.repos();
      const board = issueBoard(store, mappings.map(({ repo }) => repo), filter);
      if ("threadId" in filter) return board;
      if (deps.catalog) {
        try {
          const items = (await deps.catalog()).filter((item) => !filter.repo || item.repo === filter.repo);
          for (const item of items) {
            if (!board.repos.some(({ repo }) => repo === item.repo)) board.repos.push({ repo: item.repo as RepoName, polledAt: null, error: null });
          }
          return { ...board, issues: items.map((item) => ({ ...item, startError: mappings.some(({ repo }) => repo === item.repo) ? null : "Set a project and worker host for this repository in the issueRepos setting to start a worker." })) };
        } catch (error) {
          bb.log.warn(`pstack issues: GitHub plugin catalog unavailable: ${message(error)}`);
        }
      }
      const issues: NonNullable<z.infer<typeof IssueBoardSchema>["issues"]> = [];
      await Promise.all(board.repos.map(async (view) => {
        if (!mappings.some(({ repo }) => repo === view.repo)) return;
        try {
          const items = await github.repo(view.repo).repositoryIssues();
          issues.push(...items.map((item) => ({ repo: view.repo, issue: item.number, title: item.title, issueUrl: item.url, state: item.state, labels: item.labels, updatedAt: item.updatedAt, startError: null, body: item.body, author: item.author, assignees: [] })));
        } catch (error) {
          view.error = [view.error, message(error)].filter(Boolean).join("; ");
        }
      }));
      return { ...board, issues };
    },
    async start(name, number) {
      const mapping = deps.repos().find(({ repo }) => repo === name);
      if (!mapping) throw new Error("This repository is not configured for issue workers.");
      const existing = store.open(mapping.repo, number);
      if (existing) return existing.id;
      const { primaryHostId } = await bb.sdk.system.config();
      if (mapping.hostId === primaryHostId) throw new Error("Map this repository to a worker host before starting an issue.");
      const repo = github.repo(mapping.repo);
      const issue = (await repo.repositoryIssues(true)).find((item) => item.number === number);
      if (!issue || issue.state !== "open") throw new Error("Only an open GitHub issue can be started.");
      const baseBranch = await repo.defaultBranch();
      const now = clock();
      const job = store.insert({
        id: `psi_${randomUUID()}` as JobId, repo: mapping.repo, issue: number,
        trigger: { eventId: null, actor: "the bb app", at: now },
        snapshot: { title: issue.title, body: issue.body, url: issue.url, author: issue.author },
        projectId: mapping.projectId, hostId: mapping.hostId, baseBranch,
        state: issue.subIssues > 0 ? "tracking" : "queued", error: null,
      }, now) ?? store.open(mapping.repo, number);
      if (!job) throw new Error("The issue could not be started. Refresh and try again.");
      background(tick(job.id));
      return job.id;
    },
    commands: issueCommands({ bb, store, repos: deps.repos, clock, report, stop }),
    register() {
      for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) {
        bb.events.on(event, ({ thread }) => {
          if (thread.originPluginId === bb.pluginId) background(onThread(thread.id));
        });
      }
      bb.background.service("pstack-issues", { start: serve });
    },
    instructions(threadId) {
      const job = openJob(threadId);
      return job ? workerInstructions(job) : null;
    },
    async sweep() {
      await poll();
      await tickDue();
      await Promise.all([...running.values()].map((entry) => entry.done.catch(() => {})));
    },
    stop,
  };
}

