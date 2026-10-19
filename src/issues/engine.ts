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
import type { HostPush, HostInspectCommit } from "../host-contract.ts";
import type { ModelChoice } from "../models.ts";
import { hostId, pickHost, type Facts as PlacementFacts, type Hold, type HostId } from "../placement.ts";
import { repoFromRemote } from "../gh/commands.ts";
import { createStatusDelivery } from "./delivery.ts";
import { issueCommands, type RepoMapping } from "./commands.ts";
import { issueBoard, type BoardFilter, type IssueBoardSchema, type IssueSummarySchema } from "./board.ts";
import { CAN_TRIGGER, GitHubPermanentError, GitHubSetupError, GitHubTransientError, type ActivityCursor, type GitHub, type PollCursor, type RepoClient } from "./github.ts";
import { acceptSync,
  EFFECT_POLICY,
  FACTS_FOR,
  LABEL,
  acceptsReport,
  park,
  PROVIDER_WAIT,
  TERMINAL,
  acceptReport,
  enter,
  rejectReport,
  stick,
  type ReviewFact,
  type AcceptedReport,
  parseReport,
  awaitingThread,
  sendingToWorker,
  containsSha,
  integrationPrerequisites,
  verifiedDeliveredHead,
  publicationRepairPrompt,
  isTransit,
  TRANSIT,
  command,
  counts,
  moreFacts,
  isReasoningLevel,
  needsMachine,
  owesSpawn,
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
  type JobId,
  type RepoName,
  type ReportFacts,
  type Sha,
  type SubIssue,
  type WorkerProblem,
  type WorkerSettings,
} from "./job.ts";
import type { IssueStore, Submission } from "./store.ts";
import { commentBody, effectMarker, mergeNote, workerInstructions, workerPrompt, roundPrompt } from "./text.ts";

export const SWEEP_MS = 15_000;
export const RETRY_WAIT_MS = 60 * 60_000;
export const POLL_MS = 60_000;
const MAX_STEPS = 20;
const SETTLE_MARGIN_MS = 5_000;
/** Kept back from the push so the token can still be revoked before the lease ends. */
const REVOKE_MS = 30_000;

/** Agents can write their own metadata, so it only points at a job; the store decides. */
export const IssueMetadata = z.object({ pstackIssue: z.literal(1), jobId: z.string(), epoch: z.number().int().nonnegative().default(0) });

export type IssuesDeps = {
  bb: BbPluginApi;
  store: IssueStore;
  github: GitHub;
  hostPush: HostPush;
  inspectCommit: HostInspectCommit;
  inspectOrigin: (hostId: string, path: string) => Promise<string | null>;
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
  /** Placement's facts for a worker on any machine with a worktree of the project and `provider/model` at `level`. */
  machines: (query: { projectId: string; model: string; level: string }) => Promise<PlacementFacts>;
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
/** The bb SDK replaces a refused connection with a plain Error carrying only this message. */
const SDK_UNREACHABLE = "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.";
function isTransientObservation(error: unknown): boolean {
  for (let depth = 0; depth < 4 && typeof error === "object" && error !== null; depth++) {
    const { status, statusCode, code, name, message, cause } = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    const http = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
    if (http !== undefined) return [408, 429, 500, 502, 503, 504].includes(http);
    if (name === "BbRequestTimeoutError" || message === SDK_UNREACHABLE) return true;
    if (typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
    error = cause;
  }
  return false;
}
const short = (sha: string) => sha.slice(0, 7);

type Worktree = { ok: true; path: string; environmentId: string; branch: string; headSha: Sha; dirty: boolean; ahead: number; commits: Sha[] } | { ok: false; transient: boolean; error: string };

type MachineInputs = { facts: PlacementFacts; model: string; exclude: ReadonlyMap<HostId, string> } | { error: string };

function workerHost(job: Job): string {
  if (job.host.id === null) throw new Error(`issue job ${job.id} has no machine yet`);
  return job.host.id;
}

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

  async function workspaceThreads(environmentId: string, signal?: AbortSignal) {
    const found = new Map<string, Awaited<ReturnType<typeof bb.sdk.threads.list>>[number]>();
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const page = await bb.sdk.threads.list({ environmentId, archived, includeHidden: true, limit: 100, offset, ...(signal ? { signal } : {}) });
        for (const thread of page) found.set(thread.id, thread);
        if (page.length < 100) break;
      }
    }
    return [...found.values()];
  }

  async function matchingEpoch(job: Job, signal?: AbortSignal): Promise<string[]> {
    const matches = [];
    for (const id of await threadsNaming(job, signal)) {
      const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: id, ...(signal ? { signal } : {}) }));
      if (metadata.success && metadata.data.epoch === job.control.epoch) matches.push(id);
    }
    return matches;
  }

  function recoveryPrompt(job: Job): string {
    return [`Continue issue #${job.issue} in the existing workspace. Preserve dirty/untracked files and all local commits.`, `The previous worker stopped after ${job.control.workerContext?.recoveryReason ?? job.error ?? "incomplete delivery"}.`, ...(job.control.bestReasons ?? []), job.control.workerContext?.text ?? "", publicationRepairPrompt(job), job.round > 1 ? roundPrompt(job, job.round, store.roundFeedback(job.id, job.round), store.roundSummaries(job.id), job.roundBase ?? job.pushedSha!) : workerPrompt(job), workerInstructions(job)].join("\n");
  }

  function reviewObservation(job: Job, snapshot: NonNullable<Awaited<ReturnType<RepoClient["reviewSnapshot"]>>>): ReviewFact {
    const reasons: string[] = [];
    if (!snapshot.complete) reasons.push("GitHub observations are incomplete");
    if (snapshot.headRepository !== job.repo || snapshot.headBranch !== job.branch || snapshot.baseBranch !== job.baseBranch) reasons.push("pull request identity no longer matches the publication");
    if (snapshot.mergeability !== "clean") reasons.push(`mergeability is ${snapshot.mergeability}`);
    const pending = snapshot.checks.some((check) => check.state === "pending");
    const failed = snapshot.checks.filter((check) => !["success", "neutral", "skipped", "pending"].includes(check.state));
    reasons.push(...failed.map((check) => `${check.source}/${check.appId}/${check.name}: ${check.state}`));
    {
      reasons.push(...(snapshot.required.blockers ?? []));
      for (const required of snapshot.required.checks ?? []) {
        const matching = snapshot.checks.filter((check) => check.source !== "check-suite" && check.head === snapshot.head && check.name === required.name && (required.source === "either" || required.source === check.source) && (required.appId === null || check.appId === required.appId));
        if (!matching.some((check) => required.accepted.some((accepted) => accepted === check.state)) && !matching.some((check) => check.state === "pending")) reasons.push(`required check missing or unsatisfied: ${required.source}/${required.appId}/${required.name}`);
      }
    }
    return { kind: "observed", target: { pr: snapshot.pr, head: snapshot.head, base: snapshot.base }, state: snapshot.state, draft: snapshot.draft, complete: snapshot.complete, observedAt: snapshot.observedAt, mergeability: snapshot.mergeability, ready: snapshot.complete && reasons.length === 0 && !pending, limitation: snapshot.required.kind === "unavailable" ? `Branch policy could not be inspected: ${snapshot.required.reason}. Observed CI and local evidence passed; merge prerequisites are not established.` : null, pending, reasons, fingerprint: reasons.map((reason) => reason.replace(/[0-9a-f]{40}/g, "<sha>")).sort().join("|") || "healthy" };
  }

  const deliverStatuses = createStatusDelivery({ store, github, clock, runEffect });

  async function worktree(job: Job, signal?: AbortSignal): Promise<Worktree> {
    const thread = job.threadId ? await bb.sdk.threads.get({ threadId: job.threadId, ...(signal ? { signal } : {}) }).catch((error) => { if (isMissing(error)) return null; throw error; }) : null;
    const environmentId = thread && thread.archivedAt === null && thread.deletedAt === null ? thread.environmentId : job.control.workspace?.environmentId;
    if (!environmentId) return { ok: false, transient: true, error: "the worker's worktree is not ready" };
    const environment = await bb.sdk.environments.get({ environmentId, ...(signal ? { signal } : {}) }).catch((error) => { if (isMissing(error)) return null; throw error; });
    if (!environment || environment.status === "error" || environment.status === "destroyed") return { ok: false, transient: false, error: `the worker environment is ${environment?.status ?? "missing"}; original work location retained` };
    if (environment.hostId !== workerHost(job)) return { ok: false, transient: false, error: `the worker runs on ${environment.hostId}, not the job's machine ${workerHost(job)}` };
    if (environment.status === "creating" || environment.status === "provisioning") return { ok: false, transient: true, error: `the worker's worktree is ${environment.status}` };
    if (!environment.path) return { ok: false, transient: false, error: "the ready worker environment has no workspace path" };
    const recorded = job.control.workspace;
    if (recorded && (environment.id !== recorded.environmentId || environment.hostId !== recorded.hostId || environment.path !== recorded.path)) return { ok: false, transient: false, error: "the recorded workspace identity changed; original work location retained" };
    const origin = await deps.inspectOrigin(workerHost(job), environment.path);
    if (!origin || repoFromRemote(origin) !== job.repo.toLowerCase()) return { ok: false, transient: false, error: "the recorded workspace origin does not match the authorized repository" };
    const status = await bb.sdk.environments.status({ environmentId, mergeBaseBranch: `origin/${job.baseBranch}`, ...(signal ? { signal } : {}) });
    if (status.outcome === "unavailable") return { ok: false, transient: status.failure.code === "unknown", error: `the worktree status is unavailable: ${status.failure.message}` };
    if (status.outcome !== "available") return { ok: false, transient: false, error: status.message };
    const { checkout, workingTree, mergeBase } = status.workspace;
    const headSha = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
    if (!headSha) return { ok: false, transient: false, error: "the worktree has no commit" };
    return {
      ok: true,
      path: environment.path,
      environmentId,
      branch: checkout.kind === "branch" ? checkout.branchName : "detached",
      headSha: headSha as Sha,
      dirty: workingTree.hasUncommittedChanges || workingTree.files.some((file) => file.status === "??"),
      ahead: mergeBase?.aheadCount ?? 0,
      commits: (mergeBase?.commits ?? []).map((commit) => commit.sha as Sha),
    };
  }

  async function probePublication(job: Job, effect: Extract<Effect, { op: "open-pr" }>, repo: RepoClient): Promise<EffectOutcome> {
    const pr = await repo.findPull(job.branch);
    if (!pr) return { kind: "absent" };
    const details = await repo.pull(pr.number);
    if (!details || details.author !== await repo.appLogin() || details.body.trimEnd().split("\n").at(-1) !== effectMarker(effect.key)) return { kind: "fail", error: "the existing pull request lacks this job publication marker or App ownership" };
    const snapshot = await repo.reviewSnapshot(pr.number);
    if (!snapshot || snapshot.state !== "open" || snapshot.headRepository !== job.repo || snapshot.headBranch !== job.branch || snapshot.baseBranch !== job.baseBranch || snapshot.head !== job.pushedSha) return { kind: "fail", error: "the existing pull request does not match this job publication" };
    return done({ pr });
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
            environment: { type: "host", hostId: workerHost(job), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: spec.baseRef } } },
            pluginMetadata: { pstackIssue: 1, jobId: job.id, epoch: job.control.epoch },
            prompt: spec.prompt,
            title: spec.title,
            providerId: spec.providerId,
            model: spec.model,
            reasoningLevel: spec.reasoningLevel,
            ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
          });
          const worker = await bb.sdk.threads.get({ threadId: thread.id });
          const environment = worker.environmentId ? await bb.sdk.environments.get({ environmentId: worker.environmentId }) : null;
          const tree = await worktree({ ...job, threadId: thread.id });
          if (!tree.ok && !tree.transient) return { kind: "fail", error: tree.error };
          const control = tree.ok && worker.environmentId ? { ...job.control, workspace: { environmentId: worker.environmentId, hostId: environment?.hostId ?? workerHost(job), path: tree.path, branch: tree.branch } } : job.control;
          return done({ threadId: thread.id, control });
        } catch (error) {
          return { kind: "unknown", error: `spawn: ${message(error)}` };
        }
      },
      async probe(job, _effect, deadline) {
        // A replacement's probe must not adopt the thread it replaces, which still names the job.
        const [threadId] = (await matchingEpoch(job, until(deadline))).filter((id) => id !== job.threadId);
        return threadId ? done({ threadId }) : { kind: "absent" };
      },
    },
    push: {
      async perform(job, effect, deadline) {
        const tree = await worktree(job, until(deadline));
        if (!tree.ok) return tree.transient ? { kind: "retry", error: tree.error, notBefore: null } : { kind: "fail", error: tree.error };
        const repo = github.repo(job.repo, until(deadline));
        const remoteSha = await repo.branchSha(job.branch);
        if (remoteSha === effect.sha) return done({ pushedSha: effect.sha });
        if (remoteSha !== effect.expectedRemoteSha) return remoteSha ? { kind: "publication-diverged", remoteSha, reason: "stale-remote" } : { kind: "fail", error: "the publication branch disappeared; accepted work is preserved" };
        const capabilities = await repo.capabilities({ fresh: true });
        if (capabilities.archived || capabilities.permissions.contents !== "write" || capabilities.permissions.pullRequests !== "write") return { kind: "fail", error: "publication requires existing contents and pull requests write grants on an active repository", publicFailure: { kind: "publication-denied" } };
        const comparisonSha = job.report?.outcome === "changes" && job.report.headSha === effect.sha && job.report.comparisonSha ? job.report.comparisonSha : capabilities.defaultHead;
        const inspected = await deps.inspectCommit(workerHost(job), { worktreePath: tree.path, sha: effect.sha, comparisonSha, publishedSha: effect.expectedRemoteSha }, until(deadline));
        if (inspected.kind !== "inspected") return { kind: "fail", error: `publication commit ${inspected.sha} is unavailable; original workspace retained` };
        if (!inspected.nonemptyDiff) return { kind: "fail", error: "the pinned publication has no changes against its comparison commit" };
        if (inspected.workflows && capabilities.permissions.workflows !== "write") return { kind: "fail", error: "workflow changes require workflows write, which is not already granted; commits retained", publicFailure: { kind: "workflow-permission" } };
        const { remoteUrl, token } = await repo.pushCredentials({ workflows: inspected.workflows });
        try {
          const input = { worktreePath: tree.path, remoteUrl, branch: job.branch, sha: effect.sha, expectedRemoteSha: effect.expectedRemoteSha, comparisonSha, workflows: inspected.workflows, token };
          const result = await deps.hostPush(workerHost(job), input, until(deadline - REVOKE_MS));
          if (result.status === "pushed") return done({ pushedSha: effect.sha });
          // A claim whose lease ran out may still be pushing the same commit, and its push can land first.
          if (result.status === "rejected" && (result.reason === "stale-remote" || result.reason === "not-descendant")) {
            const remoteSha = await repo.branchSha(job.branch);
            if (remoteSha === effect.sha) return done({ pushedSha: effect.sha });
            return remoteSha ? { kind: "publication-diverged", remoteSha, reason: result.reason } : { kind: "fail", error: "the publication branch disappeared; accepted work is preserved" };
          }
          if (result.status === "rejected") return { kind: "fail", error: `push rejected (${result.reason}): ${result.detail}`, ...(result.reason === "denied" ? { publicFailure: { kind: "publication-denied" as const } } : {}) };
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
          const pr = await github.repo(job.repo, until(deadline)).createDraftPull({ head: job.branch, base: job.baseBranch, title: effect.title, body: commentBody(effect.body, effect.key) });
          return done({ pr });
        } catch (error) {
          if (error instanceof GitHubPermanentError && error.status === 422) {
            const observed = await probePublication(job, effect, github.repo(job.repo, until(deadline)));
            return observed.kind === "absent" ? { kind: "fail", error: `pull request validation failed and no matching publication exists: ${error.message}` } : observed;
          }
          throw error;
        }
      },
      async probe(job, effect, deadline) {
        return probePublication(job, effect, github.repo(job.repo, until(deadline)));
      },
    },
    comment: {
      async perform(job, effect, deadline) {
        await github.repo(job.repo, until(deadline)).comment(job.issue, commentBody(effect.body, effect.key));
        return done();
      },
      async probe(job, effect, deadline) {
        const since = job.createdAt - 60_000;
        return (await github.repo(job.repo, until(deadline)).findComment(job.issue, effectMarker(effect.key), since)) ? done() : { kind: "absent" };
      },
    },
    "send-round": {
      async perform(job, effect) {
        if (!job.threadId) return { kind: "fail", error: "the job has no worker thread" };
        const thread = await threadFact(job.threadId);
        if (thread?.kind === "failed" && thread.retryAt && thread.retryAt > clock()) return { kind: "retry", error: PROVIDER_WAIT, notBefore: thread.retryAt };
        if (thread === null || thread.kind === "waiting") return { kind: "retry", error: "worker activity is unavailable or awaiting queued work", notBefore: null };
        if (thread?.kind === "gone" || thread?.kind === "failed") return { kind: "fail", error: "the repair worker is unavailable" };
        try {
          // Queued behind a turn that is still running, never steered into it.
          await bb.sdk.threads.send({ threadId: job.threadId, mode: "queue-if-active", input: [{ type: "text", text: effect.text, mentions: [] }] });
        } catch (error) {
          if (isMissing(error)) return { kind: "fail", error: "the worker thread is gone" };
          throw error;
        }
        return thread.kind === "idle" ? done({ control: { ...job.control, idleObservation: { since: thread.since, remindedAt: clock() } } }) : done();
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
        const since = job.createdAt - 60_000;
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
        await github.repo(job.repo, until(deadline)).editPull(job.pr.number, { ...(effect.title ? { title: effect.title } : {}), body: commentBody(effect.body, `pr:${job.id}`) });
        return done();
      },
    },
    "inspect-work": {
      async perform(job, _effect, deadline) {
        try {
          const tree = await worktree(job, until(deadline));
          if (!tree.ok) return { kind: tree.transient ? "retry-unissued" : "fail", error: tree.error, notBefore: null };
          const remote = await github.repo(job.repo, until(deadline)).branchSha(job.branch);
          const added = job.round === 1 ? tree.ahead > 0 : tree.headSha !== (job.roundBase ?? job.pushedSha);
          return { kind: "work", work: added && tree.headSha !== remote ? { kind: "commits", sha: tree.headSha, dirty: tree.dirty } : { kind: "empty", dirty: tree.dirty } };
        } catch (error) {
          return isTransientObservation(error) ? { kind: "retry-unissued", error: message(error), notBefore: null } : { kind: "fail", error: message(error) };
        }
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
      async perform() { return done(); },
    },
    "recover-worker": {
      async perform(job) {
        const workspace = job.control.workspace;
        const settings = job.worker;
        if (!workspace || !settings) return { kind: "fail", error: "safe environment reuse is unavailable; the original thread and workspace are retained" };
        try {
          const environment = await bb.sdk.environments.get({ environmentId: workspace.environmentId }).catch((error) => { if (isMissing(error)) return null; throw error; });
          if (!environment || environment.status === "destroyed" || environment.status === "error") return { kind: "fail", error: `the recorded environment ${workspace.environmentId} is ${environment?.status ?? "missing"}; work location retained at ${workspace.path}` };
          if (environment.status === "creating" || environment.status === "provisioning") return { kind: "retry-unissued", error: `the recorded environment is ${environment.status}; awaiting safe workspace observation`, notBefore: null };
          if (!environment.path) return { kind: "fail", error: `the recorded environment has no workspace path; work retained at ${workspace.path}` };
          if (environment.id !== workspace.environmentId || environment.hostId !== workspace.hostId || environment.path !== workspace.path) return { kind: "fail", error: `the recorded environment ${workspace.environmentId} cannot be safely reused; work retained at ${workspace.path}` };
          const status = await bb.sdk.environments.status({ environmentId: workspace.environmentId, mergeBaseBranch: `origin/${job.baseBranch}` });
          if (status.outcome === "unavailable" && status.failure.code === "unknown") return { kind: "retry-unissued", error: `preserved workspace status is unavailable: ${status.failure.message}`, notBefore: null };
          if (status.outcome !== "available" || status.workspace.checkout.kind !== "branch" || status.workspace.checkout.branchName !== workspace.branch) return { kind: "fail", error: `the preserved branch identity cannot be confirmed in ${workspace.environmentId}; workspace retained` };
          const writers = await workspaceThreads(workspace.environmentId);
          for (const writer of writers) {
            if (writer.activity.activeBackgroundCommandCount > 0 || writer.activity.activeGoalCount > 0 || writer.activity.activeWorkflowCount > 0) return { kind: "fail", error: `exclusive stop is not confirmed for ${workspace.environmentId}: background commands, goals or workflows remain; work retained` };
            const current = await bb.sdk.threads.get({ threadId: writer.id }).catch((error) => { if (isMissing(error)) return null; throw error; });
            if (current && (!["idle", "error"].includes(current.status) || (current.runtime !== undefined && !["idle", "error"].includes(current.runtime.displayStatus)) || current.queuedMessageCount > 0 || current.activeBackgroundAgentCount > 0)) return { kind: "fail", error: `exclusive stop is not confirmed for ${workspace.environmentId}; work retained` };
          }
        } catch (error) {
          if (error instanceof GitHubSetupError || error instanceof GitHubPermanentError) return { kind: "fail", error: message(error) };
          return isTransientObservation(error) ? { kind: "retry-unissued", error: message(error), notBefore: null } : { kind: "fail", error: `safe workspace observation failed: ${message(error)}; work retained at ${workspace.path}` };
        }
        try {
          const thread = await bb.sdk.threads.spawn({ projectId: job.projectId, visibility: "visible", environment: { type: "reuse", environmentId: workspace.environmentId }, pluginMetadata: { pstackIssue: 1, jobId: job.id, epoch: job.control.epoch }, prompt: recoveryPrompt(job), title: `Recover issue #${job.issue}`, providerId: settings.providerId, model: settings.model, reasoningLevel: settings.reasoningLevel, ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}) });
          return done({ threadId: thread.id, worker: settings });
        } catch (error) { return { kind: "unknown", error: `recovery spawn: ${message(error)}` }; }
      },
      async probe(job, _effect, deadline) {
        const matches = await matchingEpoch(job, until(deadline));
        if (matches.length > 1) return { kind: "fail", error: "multiple recovery workers exist; stopping them and preserving the workspace" };
        return matches[0] ? done({ threadId: matches[0] }) : { kind: "absent" };
      },
    },
    "set-draft": {
      async perform(job, effect, deadline) {
        const result = await github.repo(job.repo, until(deadline)).setDraft({ expected: effect.target, draft: effect.draft });
        if (result.kind === "missing") return { kind: "fail", error: "the pull request disappeared during readiness conversion" };
        if (result.kind === "closed") return result.snapshot.state === "open" ? { kind: "retry", error: "pull request closure is not confirmed", notBefore: null } : { kind: "closed", state: result.snapshot.state };
        if (result.kind === "stale") return { kind: "changed-target", target: { pr: result.snapshot.pr, head: result.snapshot.head, base: result.snapshot.base } };
        return done({ control: { ...job.control, readiness: null, reviewIntent: effect.draft ? null : effect.target } });
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
        let workspace = job.control.workspace;
        if (!workspace && job.threadId) {
          const original = await bb.sdk.threads.get({ threadId: job.threadId, signal }).catch((error) => { if (isMissing(error)) return null; throw error; });
          const environment = original?.environmentId ? await bb.sdk.environments.get({ environmentId: original.environmentId, signal }) : null;
          if (original?.environmentId && environment?.path) {
            const tree = await worktree(job, signal);
            workspace = { environmentId: original.environmentId, hostId: environment.hostId!, path: environment.path, branch: tree.ok ? tree.branch : "unknown" };
          }
        }
        const threads = new Set([...(job.threadId ? [job.threadId] : []), ...(await threadsNaming(job, signal))]);
        if (workspace) {
          for (const writer of await workspaceThreads(workspace.environmentId, signal)) {
            if (writer.originPluginId !== bb.pluginId || writer.projectId !== job.projectId || writer.createdAt < job.createdAt - 60_000 || (store.byThread(writer.id)?.id ?? job.id) !== job.id) continue;
            const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: writer.id, signal }));
            if (metadata.success && metadata.data.jobId === job.id && metadata.data.epoch <= job.control.epoch) threads.add(writer.id);
          }
        }
        for (const threadId of threads) {
          await bb.sdk.threads.stop({ threadId, signal }).catch((error) => { if (!isMissing(error)) throw error; });
          const stopped = await bb.sdk.threads.get({ threadId, signal }).catch((error) => { if (isMissing(error)) return null; throw error; });
          if (stopped && (stopped.status !== "idle" && stopped.status !== "error" || (stopped.runtime !== undefined && !["idle", "error"].includes(stopped.runtime.displayStatus)))) return { kind: "retry", error: `stop is not confirmed for ${threadId}`, notBefore: clock() + SWEEP_MS };
          if (job.phase.state === "recovering" && stopped && (stopped.queuedMessageCount > 0 || stopped.activeBackgroundAgentCount > 0)) return { kind: "fail", error: `exclusive reuse is unavailable for ${threadId}: queued or background work remains after stop; the original workspace is preserved` };
        }
        return done({ control: { ...job.control, workspace } });
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
      if (error instanceof GitHubSetupError) return { kind: "fail", error: error.message };
      if (error instanceof GitHubPermanentError) return { kind: "fail", error: error.message, ...(error.status === 403 && (effect.op === "push" || effect.op === "open-pr") ? { publicFailure: { kind: "publication-denied" as const } } : {}) };
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
      const capabilities = await github.repo(job.repo).capabilities({ fresh: true });
      if (capabilities.archived) return permanent("the repository is archived");
      if (capabilities.defaultBranch !== job.baseBranch) return permanent("the configured base no longer matches the repository default branch");
      if (capabilities.permissions.contents !== "write" || capabilities.permissions.pullRequests !== "write") return permanent("the existing installation lacks publication grants");
      if (!job.host.pinned) return worker;
      const problem = await deps.checkWorker(job.host.id, `${worker.providerId}/${worker.model}/${worker.reasoningLevel}`);
      return problem ? permanent(problem) : worker;
    } catch (error) {
      return { error: message(error), permanent: error instanceof GitHubSetupError || error instanceof GitHubPermanentError };
    }
  }

  async function threadFact(threadId: string | null): Promise<Facts["thread"]> {
    if (!threadId) return { kind: "gone" };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) return { kind: "gone" };
      if (thread.status === "error" || thread.queuedMessageCount > 0) {
        const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
        const retry = queued.filter((item) => item.payload.kind === "retry" && (item.sendAt === null || item.sendAt >= clock() - RETRY_WAIT_MS)).map((item) => Math.max(item.sendAt ?? 0, clock() + SWEEP_MS));
        if (retry.length || thread.status === "error") return { kind: "failed", error: "the thread is in an error state", retryAt: retry.length ? Math.max(...retry) : null };
        if (thread.status === "idle" && queued.length) return { kind: "waiting" };
      }
      if (thread.status === "idle" && (thread.activeBackgroundAgentCount > 0 || thread.runtime && !["idle", "error"].includes(thread.runtime.displayStatus))) return { kind: "waiting" };
      if (thread.status === "idle") return { kind: "idle", since: thread.updatedAt };
      return { kind: "active" };
    } catch (error) {
      return isMissing(error) ? { kind: "gone" } : null;
    }
  }

  async function machineInputs(job: Job, worker: WorkerSettings): Promise<MachineInputs> {
    const model = `${worker.providerId}/${worker.model}`;
    try {
      const [facts, { primaryHostId }] = await Promise.all([deps.machines({ projectId: job.projectId, model, level: worker.reasoningLevel }), bb.sdk.system.config()]);
      return { facts, model, exclude: new Map(primaryHostId ? [[hostId.parse(primaryHostId), "the bb server's machine"]] : []) };
    } catch (error) {
      return { error: `could not read the machines: ${message(error)}` };
    }
  }

  async function machineFor(job: Job, facts: Facts): Promise<MachineInputs | null> {
    const worker = needsMachine(job, facts);
    return worker ? await machineInputs(job, worker) : null;
  }

  function pickNow(facts: Facts, machine: MachineInputs | null): Facts {
    if (!machine) return facts;
    if ("error" in machine) return { ...facts, machine: { wait: machine.error } };
    const holds = store.list({ all: false }).flatMap((row): Hold[] => (owesSpawn(row) && row.host.id !== null ? [{ hostId: hostId.parse(row.host.id), threadId: null, settledAt: null }] : []));
    const pick = pickHost(machine.facts, holds, { model: machine.model }, machine.exclude, facts.now);
    return { ...facts, machine: pick.hostId === null ? { wait: pick.why } : { hostId: pick.hostId } };
  }

  async function gather(job: Job, observations?: { review: boolean }): Promise<Facts> {
    const facts: Facts = { now: clock(), worker: null, thread: null, waiting: null, gate: null, feedback: null, rounds: null, remote: null, pr: null, children: null, blockers: null, machine: null };
    const unobserved = new Set<number>();
    const first = FACTS_FOR[job.phase.state];
    if (first.includes("feedback")) facts.feedback = { pending: store.pendingFeedback(job.id) };
    if (first.includes("pr")) {
      const { prState } = store.jobPoll(job.id);
      facts.pr = prState ? { state: prState } : null;
    }
    if (first.includes("children")) facts.children = await childFacts(job, facts);
    if (facts.children?.length) {
      facts.prerequisites = integrationPrerequisites(facts.children);
      for (const child of facts.children) if ((child.job?.merged || child.job?.disposition === "merged") && !child.job.sha) unobserved.add(child.number);
      const failed = facts.children.find((child) => child.state === "open" && child.job && TERMINAL.has(child.job.state) && !child.job.merged && child.job.disposition !== "no-change");
      if (failed && job.phase.state !== "tracking") facts.prerequisiteProblem = `prerequisites failed: #${failed.number}`;
      const unpinned = facts.children.find((child) => (child.job?.ready || child.job?.merged || child.job?.disposition === "merged") && (!child.job.branch || !child.job.sha));
      if (unpinned && !facts.prerequisiteWait && !facts.prerequisiteProblem) facts.prerequisiteProblem = `prerequisite #${unpinned.number} has no established commit`;
    }
    if (job.parentId && ["queued", "working", "addressing", "checking", "review"].includes(job.phase.state)) {
      const children = store.polledChildren(job.parentId) ?? [];
      const blockers = children.find((child) => child.number === job.issue)?.blockedBy ?? [];
      const localNumber = (ref: string) => Number(new RegExp(`^(?:${job.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?#(\\d+)$`).exec(ref)?.[1] ?? NaN);
      const visits = new Set<number>();
      const path = new Set<number>();
      const cycle = (number: number): boolean => {
        if (path.has(number)) return true;
        if (visits.has(number)) return false;
        visits.add(number); path.add(number);
        for (const ref of children.find((child) => child.number === number)?.blockedBy ?? []) if (cycle(localNumber(ref))) return true;
        path.delete(number); return false;
      };
      if (cycle(job.issue)) facts.prerequisiteProblem = "prerequisite dependency cycle";
      facts.prerequisites ??= [];
      const siblings = new Map<number, Job>();
      for (const ref of blockers) {
        const number = localNumber(ref);
        const candidate = store.open(job.repo, number) ?? store.children(job.parentId).find((row) => row.issue === number);
        if (candidate) {
          const observed = await observeMergedHead(candidate, facts);
          siblings.set(number, observed);
          if (!observed.control.mergedHead && (observed.control.disposition === "merged" || store.jobPoll(observed.id).prState === "merged")) unobserved.add(number);
        }
      }
      facts.blockers = blockers.filter((ref) => {
        const number = localNumber(ref);
        const child = children.find((candidate) => candidate.number === number);
        if (!child) { facts.prerequisiteProblem = `prerequisite ${ref} is outside this parent job's owned scope`; return false; }
        const prerequisite = siblings.get(number);
        const head = prerequisite ? verifiedDeliveredHead(prerequisite) : null;
        if (prerequisite && TERMINAL.has(prerequisite.phase.state) && prerequisite.control.disposition !== "no-change" && prerequisite.control.disposition !== "merged") { facts.prerequisiteProblem = `prerequisite ${ref} failed`; return false; }
        if (prerequisite && (prerequisite.control.readiness || prerequisite.control.disposition === "merged") && !head && !facts.prerequisiteWait && !facts.prerequisiteProblem) facts.prerequisiteProblem = `prerequisite ${ref} has no established commit`;
        if (prerequisite && head && prerequisite.control.disposition !== "no-change") facts.prerequisites = [...(facts.prerequisites ?? []), { issue: prerequisite.issue, branch: prerequisite.branch, sha: head }];
        return child.state !== "closed" && !prerequisite?.control.readiness && !prerequisite?.control.mergedHead && prerequisite?.control.disposition !== "no-change" && prerequisite?.control.disposition !== "merged";
      });
      facts.prerequisites = [...facts.prerequisites].sort((a, b) => a.issue - b.issue);
    }
    if (facts.prerequisiteWait && facts.prerequisites) {
      const observed = facts.prerequisites;
      facts.prerequisites = [...observed, ...job.control.prerequisites.filter((pin) => unobserved.has(pin.issue) && !observed.some((current) => current.issue === pin.issue))].sort((a, b) => a.issue - b.issue);
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
    if (wanted.includes("review") && job.pr && observations?.review !== false && store.claimReview(job, clock())) {
      if (observations) observations.review = false;
      try {
        const snapshot = await github.repo(job.repo).reviewSnapshot(job.pr.number);
        facts.review = snapshot ? reviewObservation(job, snapshot) : { kind: "observed", target: { pr: job.pr.number, head: job.pushedSha!, base: job.pushedSha! }, state: "closed", draft: true, complete: true, observedAt: clock(), mergeability: "unknown", ready: false, pending: false, reasons: ["pull request missing"], fingerprint: "missing" };
      } catch (error) {
        store.deferReview(job, Math.max(clock() + POLL_MS, error instanceof GitHubTransientError ? error.notBefore ?? 0 : 0));
        facts.review = { kind: "unavailable", reason: message(error), permanent: error instanceof GitHubPermanentError || error instanceof GitHubSetupError };
      }
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

  async function observeMergedHead(job: Job, facts: Facts): Promise<Job> {
    if (job.control.mergedHead || (job.control.disposition !== "merged" && store.jobPoll(job.id).prState !== "merged")) return job;
    const failed = (reason: string) => { facts.prerequisiteProblem = `prerequisite #${job.issue}: ${reason}`; };
    if (!job.pr) { failed("the historical merged head has no recorded pull request"); return job; }
    if (!store.claimReview(job, clock())) { facts.prerequisiteWait = true; return job; }
    try {
      const snapshot = await github.repo(job.repo).reviewSnapshot(job.pr.number);
      if (snapshot && (!snapshot.complete || snapshot.state === "open")) { facts.prerequisiteWait = true; return job; }
      if (!snapshot || snapshot.state !== "merged" || snapshot.headRepository !== job.repo || snapshot.headBranch !== job.branch || snapshot.baseBranch !== job.baseBranch) { failed("the merged pull request identity cannot be established"); return job; }
      const written = store.write(job.id, job.version, { control: { ...job.control, mergedHead: snapshot.head } }, clock()) ?? store.get(job.id) ?? job;
      if (!written.control.mergedHead) facts.prerequisiteWait = true;
      return written;
    } catch (error) {
      if (error instanceof GitHubPermanentError || error instanceof GitHubSetupError) failed(message(error));
      else {
        store.deferReview(job, Math.max(clock() + POLL_MS, error instanceof GitHubTransientError ? error.notBefore ?? 0 : 0));
        facts.prerequisiteWait = true;
      }
      return job;
    }
  }

  async function childFacts(parent: Job, facts: Facts): Promise<ChildFact[] | null> {
    const polled = store.polledChildren(parent.id);
    if (!polled) return null;
    const created = store.children(parent.id);
    return Promise.all(polled.map(async (child) => {
      const candidate = store.open(parent.repo, child.number) ?? created.find((row) => row.issue === child.number);
      const job = candidate ? await observeMergedHead(candidate, facts) : null;
      return { ...child, job: job ? { state: job.phase.state, merged: job.control.disposition === "merged" || job.control.mergedHead !== null || store.jobPoll(job.id).prState === "merged", ready: job.control.readiness !== null, disposition: job.control.disposition, branch: job.branch, sha: verifiedDeliveredHead(job) } : null };
    }));
  }

  async function apply(job: Job, action: Exclude<Action, { type: "sleep" | "change" }>): Promise<void> {
    switch (action.type) {
      case "nudge": {
        store.write(job.id, job.version, { ...action.change, phase: enter("recovering", [{ op: "send-round", key: `nudge:${job.id}:${job.version}`, text: action.text }]) }, clock());
        return;
      }
      case "effect": {
        const { phase } = job;
        if (!("effects" in phase)) return;
        const claimed = store.write(job.id, job.version, { phase: { ...phase, tries: phase.tries + 1, firstAt: phase.firstAt ?? clock(), leaseUntil: action.leaseUntil } }, clock());
        if (!claimed) return;
        const decoration = ["labels", "reply", "request-review", "status"].includes(action.effect.op);
        if (decoration) store.decorate(claimed, action.effect);
        const outcome = decoration ? done() : await runEffect(claimed, action.effect, action.mode, action.leaseUntil - SETTLE_MARGIN_MS);
        // A lost write here means stop replaced the outbox while the effect ran; its result is dropped on purpose.
        store.write(job.id, claimed.version, settle(claimed, outcome, clock()), clock());
        return;
      }
    }
  }

  async function reconcile(id: JobId): Promise<void> {
    const observations = { review: true };
    for (let step = 0; step < MAX_STEPS; step++) {
      const job = store.get(id);
      if (!job) return;
      const pending = store.pendingSubmissions(id);
      if (pending.length > 0 && (acceptsReport(job) || TERMINAL.has(job.phase.state))) {
        const result = await evaluateSubmission(job, pending[0]!, true);
        if (result.code === "pending") return;
        if (result.code === "worker-action") {
          const current = store.get(id);
          if (!current) return;
          const facts = await gather(current, observations);
          const machine = await machineFor(current, facts);
          const action = plan(current, pickNow(facts, machine));
          if (!action || action.type === "sleep") return;
          if (action.type === "change") store.write(current.id, current.version, action.change, clock());
          else await apply(current, action);
        }
        continue;
      }
      const facts = await gather(job, observations);
      const machine = await machineFor(job, facts);
      const action = plan(job, pickNow(facts, machine));
      if (!action || action.type === "sleep") return;
      if (action.type === "change") store.write(job.id, job.version, action.change, clock());
      else await apply(job, action);
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

  async function reportFacts(job: Job): Promise<ReportFacts | { unavailable: string; disposition: "retry" | "worker" | "fail"; sha?: Sha }> {
    try {
      const tree = await worktree(job);
      if (!tree.ok) return { unavailable: tree.error, disposition: tree.transient ? "retry" : "fail" };
      const remoteHead = job.round === 1 ? null : await github.repo(job.repo).branchSha(job.branch);
      if (job.round > 1 && remoteHead === null) return { unavailable: `the branch ${job.branch} is not on GitHub`, disposition: "fail" };
      const capabilities = await github.repo(job.repo).capabilities({ fresh: true });
      const comparisonSha = capabilities.defaultHead;
      const ancestorShas = [...new Set([capabilities.defaultHead, ...job.control.prerequisites.map((prerequisite) => prerequisite.sha), ...(job.roundBase ? [job.roundBase] : []), ...(job.control.publicationRepair ? [job.control.publicationRepair.acceptedSha] : [])])];
      const inspected = await deps.inspectCommit(workerHost(job), { worktreePath: tree.path, sha: tree.headSha, comparisonSha, publishedSha: job.roundBase ?? remoteHead, ancestorShas });
      if (inspected.kind !== "inspected") return { unavailable: `missing local commit object ${inspected.sha}`, disposition: "worker", sha: inspected.sha as Sha };
      if (ancestorShas.some((sha) => !inspected.ancestry?.some((proof) => proof.sha === sha))) return { unavailable: "the host did not establish the requested Git ancestry", disposition: "retry" };
      const gate = job.threadId ? deps.prGate(job.threadId) : { pass: false as const, reason: "the job has no worker thread" };
      const finalTree = await worktree(job);
      if (!finalTree.ok || finalTree.headSha !== tree.headSha || finalTree.dirty !== tree.dirty) return { unavailable: "the worker changed its snapshot while the report was being inspected", disposition: "retry" };
      return {
        now: clock(),
        baseSha: capabilities.defaultHead,
        inspected: { ...inspected, sha: inspected.sha as Sha, comparisonSha: inspected.comparisonSha as Sha },
        worktree: { headSha: tree.headSha, dirty: tree.dirty, ahead: tree.ahead, commits: tree.commits, ancestry: inspected.ancestry?.map((proof) => ({ ...proof, sha: proof.sha as Sha })) },
        remoteHead,
        gate,
        titleConvention: await github.repo(job.repo).titleConvention(),
        listed: store.roundFeedback(job.id, job.round),
      };
    } catch (error) {
      return { unavailable: message(error), disposition: error instanceof GitHubPermanentError || error instanceof GitHubSetupError ? "fail" : "retry" };
    }
  }

  /**
   * The job a thread's metadata names, null inside when that job does not exist, or null when the metadata names none.
   * Only a pointer: the store's binding decides who may report.
   */
  async function namedJob(threadId: string): Promise<{ job: Job | null; epoch: number } | null> {
    const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null));
    return metadata.success ? { job: store.get(metadata.data.jobId as JobId), epoch: metadata.data.epoch } : null;
  }

  /** A worker in review publishes a merge commit; see acceptSync. */
  async function sync(threadId: string): Promise<ReportResult> {
    const bound = store.byThread(threadId);
    if (!bound) return { ok: false, code: "not_issue_worker", message: "only an issue worker thread can sync" };
    if (bound.phase.state !== "review") return { ok: false, code: "not_review", message: `job ${bound.id} is ${bound.phase.state}; sync is only for a job in review${acceptsReport(bound) ? ", so report with `bb pstack issues report`" : ""}` };
    let facts: Parameters<typeof acceptSync>[1];
    try {
      const tree = await worktree(bound);
      if (!tree.ok) return { ok: false, code: "unavailable", message: `pstack could not read the worktree yet, try again shortly: ${tree.error}` };
      facts = { worktree: tree, remoteHead: await github.repo(bound.repo).branchSha(bound.branch) };
    } catch (error) {
      return { ok: false, code: "unavailable", message: `pstack could not check the sync yet, try again shortly: ${message(error)}` };
    }
    const written = writeFresh(bound.id, (job) => {
      const verdict = acceptSync(job, facts);
      return verdict.ok ? { change: verdict.change, result: verdict } : null;
    });
    if (!written) {
      const verdict = acceptSync(store.get(bound.id) ?? bound, facts);
      const reasons = verdict.ok ? [`job ${bound.id} changed while pstack checked it; try again`] : verdict.reasons;
      return { ok: false, code: "rejected", message: ["Sync refused:", ...reasons.map((reason) => `- ${reason}`)].join("\n") };
    }
    background(tick(bound.id));
    return { ok: true, message: `Sync accepted. pstack pushes ${short(facts.worktree.headSha)} to ${bound.branch}; checks resume before review.` };
  }

  async function evaluateSubmission(job: Job, submission: Submission, notify = false): Promise<{ code: string; result: ReportResult }> {
    const reject = (code: string, explanation: string) => ({ code, result: { ok: false, code, message: explanation } as const });
    const rejectedChange = (change: Change, explanation: string): Change => notify && (!change.phase || acceptsReport({ ...job, ...change, phase: change.phase }))
      ? { ...change, phase: enter("recovering", [{ op: "send-round", key: `evaluation:${job.id}:${submission.id}`, text: `${explanation}\nCorrect the report in this worker and submit current verification with bb pstack issues report.` }]) }
      : change;
    if (submission.epoch !== job.control.epoch || submission.round !== job.round || submission.threadId !== job.threadId) {
      if (awaitingThread(job) && submission.epoch === job.control.epoch) return reject("pending", "Report saved pending worker confirmation.");
      store.finishSubmission(submission.id, "stale worker or round", clock());
      return reject("stale_report", "The report is retained but belongs to a retired worker or round.");
    }
    if (sendingToWorker(job)) {
      try {
        const tree = await worktree(job);
        if (tree.ok && !submission.intendedSha && store.bindSubmission(submission.id, tree.headSha)) submission.intendedSha = tree.headSha;
      } catch {}
      return reject("pending", "Report saved while the current worker message is delivered.");
    }
    if (!acceptsReport(job)) {
      store.finishSubmission(submission.id, "job no longer reporting", clock());
      return reject("not_working", `job ${job.id} is ${job.phase.state}`);
    }
    let parsed: ReturnType<typeof parseReport>;
    try { parsed = parseReport(job, JSON.parse(submission.raw)); }
    catch (error) { parsed = { ok: false, code: "invalid_report", message: `the report is not JSON: ${message(error)}` }; }
    if (!parsed.ok) {
      const result = reject(parsed.code, parsed.message);
      if (parsed.code === "other_round") { store.finishSubmission(submission.id, JSON.stringify(result.result), clock()); return result; }
      store.write(job.id, job.version, { ...rejectedChange(rejectReport(job, [parsed.message]), parsed.message), evaluation: { submissionId: submission.id, result: JSON.stringify(result.result) } }, clock());
      return result;
    }
    if (parsed.parsed.report.outcome === "failure") {
      const report = parsed.parsed.report;
      let headSha: Sha | null = null;
      let control = job.control;
      try {
        const tree = await worktree(job);
        if (tree.ok) { headSha = tree.headSha; control = { ...control, workspace: { environmentId: tree.environmentId, hostId: workerHost(job), path: tree.path, branch: tree.branch }, preservation: tree.dirty ? "dirty and untracked work retained" : "local commits retained" }; }
        else control = { ...control, preservation: tree.error };
      } catch (error) { control = { ...control, preservation: message(error) }; }
      const change = park({ ...job, control }, report.reason, control.bestReasons ?? []);
      const accepted: AcceptedReport = { ...report, headSha, acceptedAt: clock() };
      const result = { ok: true, message: "Failure report saved. The original work and reason are preserved." } as const;
      const written = store.write(job.id, job.version, { ...change, control: { ...(change.control ?? control), publicFailure: { kind: "report", reason: report.reason } }, report: accepted, evaluation: { submissionId: submission.id, result: JSON.stringify(result) } }, clock());
      return written ? { code: "accepted", result } : reject("pending", "Report saved for evaluation after the current transition.");
    }
    try {
      const tree = await worktree(job);
      if (tree.ok) {
        if (submission.intendedSha && tree.headSha !== submission.intendedSha) {
          const result = reject("stale_snapshot", `The saved report is bound to ${submission.intendedSha}; the worker must verify and report the current commit.`);
          store.write(job.id, job.version, { ...rejectedChange(rejectReport(job, [result.result.message]), result.result.message), evaluation: { submissionId: submission.id, result: JSON.stringify(result.result) } }, clock());
          return result;
        }
        if (!store.bindSubmission(submission.id, tree.headSha)) return reject("pending", "The report snapshot is being reconciled.");
        submission.intendedSha = tree.headSha;
      }
    } catch {}
    const currentFacts = await gather(job);
    if (currentFacts.prerequisiteProblem) {
      const result = reject("prerequisite_failed", currentFacts.prerequisiteProblem);
      store.write(job.id, job.version, { ...stick(job, currentFacts.prerequisiteProblem, { kind: "prerequisite", issues: job.control.prerequisites.map(({ issue }) => issue) }), evaluation: { submissionId: submission.id, result: JSON.stringify(result.result) } }, clock());
      return result;
    }
    if (currentFacts.prerequisiteWait || currentFacts.blockers?.length || currentFacts.children?.some((child) => child.state === "open" && !child.job?.ready && !child.job?.merged && child.job?.disposition !== "no-change")) return reject("pending", "Report saved while prerequisites regain readiness.");
    if (currentFacts.prerequisites && JSON.stringify(currentFacts.prerequisites) !== JSON.stringify(job.control.prerequisites)) {
      store.write(job.id, job.version, { control: { ...job.control, prerequisites: currentFacts.prerequisites, readiness: null, localEvidence: null } }, clock());
      return reject("pending", "Report saved while current prerequisites are reconciled.");
    }
    const facts = await reportFacts(job);
    if ("unavailable" in facts) {
      if (facts.disposition === "fail") {
        const result = reject("prerequisite_failed", facts.unavailable);
        const change = stick(job, facts.unavailable);
        store.write(job.id, job.version, { ...change, control: { ...(change.control ?? job.control), preservedSha: submission.intendedSha }, evaluation: { submissionId: submission.id, result: JSON.stringify(result.result), snapshot: { unavailable: facts.unavailable } } }, clock());
        return result;
      }
      if (facts.disposition === "worker" && facts.sha) {
        if (job.control.objectRepair?.sha !== facts.sha) {
          const text = `Your report is saved and bound to ${submission.intendedSha}. Fetch the missing object ${facts.sha} with bb pstack gh fetch in this worker, incorporate the current base if needed, and run the relevant checks. If HEAD changes, submit a fresh report with the actual verification results. No human retry is needed.`;
          store.write(job.id, job.version, { phase: enter("recovering", [{ op: "send-round", key: `fetch-object:${job.id}:${job.round}:${facts.sha}`, text }]), control: { ...job.control, objectRepair: { sha: facts.sha }, workerContext: { round: job.round, text, recoveryReason: null } }, error: facts.unavailable }, clock());
        }
        return reject("worker-action", "Report saved. The worker is fetching the missing Git object and verifying the current base.");
      }
      return reject("pending", `Report saved. Evaluation resumes automatically when dependencies recover. ${facts.unavailable}`);
    }
    if (submission.intendedSha !== facts.worktree.headSha) {
      const result = reject("stale_snapshot", "The worker changed HEAD during report evaluation; current verification is required.");
      store.write(job.id, job.version, { ...rejectedChange(rejectReport(job, [result.result.message]), result.result.message), evaluation: { submissionId: submission.id, result: JSON.stringify(result.result) } }, clock());
      return result;
    }
    const verdict = acceptReport({ ...job, control: { ...job.control, objectRepair: null } }, parsed.parsed, facts);
    const result: ReportResult = verdict.ok ? { ok: true, message: `Report accepted. pstack pushes ${short(facts.worktree.headSha)} to ${job.branch}; publication and verification continue automatically.` } : { ok: false, code: "rejected", message: "moved" in verdict ? `Remote moved to ${verdict.moved}. Merge it and submit current evidence.` : ["Report rejected:", ...verdict.reasons.map((reason) => `- ${reason}`)].join("\n") };
    const written = store.write(job.id, job.version, { ...(verdict.ok ? verdict.change : rejectedChange(verdict.change, result.message)), evaluation: { submissionId: submission.id, result: JSON.stringify(result), snapshot: { worktree: facts.worktree, gate: facts.gate, inspected: facts.inspected, baseSha: facts.baseSha } } }, clock());
    return written ? { code: verdict.ok ? "accepted" : "rejected", result } : reject("pending", "Report saved for automatic reevaluation.");
  }

  async function report(threadId: string, raw: string): Promise<ReportResult> {
    let job = store.byThread(threadId);
    if (!job) {
      const candidate = await namedJob(threadId);
      const named = candidate?.job;
      if (!named || candidate?.epoch !== named.control.epoch || !awaitingThread(named)) return { ok: false, code: "not_issue_worker", message: "only a confirmed issue worker can report" };
      job = named;
    }
    if (!acceptsReport(job) && !awaitingThread(job) && !sendingToWorker(job)) return { ok: false, code: "not_working", message: `job ${job.id} is not accepting a worker report` };
    if (awaitingThread(job) || sendingToWorker(job)) {
      const candidate = await namedJob(threadId);
      if (!candidate || candidate.epoch !== job.control.epoch) return { ok: false, code: "stale_report", message: "the worker epoch is retired" };
    }
    const submission = store.submit(job, threadId, raw, clock());
    if (submission.result) {
      try { return JSON.parse(submission.result) as ReportResult; } catch { return { ok: false, code: "stale_report", message: submission.result }; }
    }
    const evaluated = await evaluateSubmission(job, submission);
    background(tick(job.id).then(deliverStatuses));
    return ["pending", "worker-action"].includes(evaluated.code) ? { ok: true, message: evaluated.result.message } : evaluated.result;
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
    if (job && awaitingThread(job) && named.epoch === job.control.epoch) return tick(job.id);
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
          hostId: parent.host.pinned ? parent.host.id : null,
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
    if (mapping.hostId !== null && mapping.hostId === primaryHostId) {
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
          await poll().catch((error) => bb.log.warn(message(error)));
        }
        // Not awaited: a job's slow push must not hold back polling or the next pass. tick() runs one reconcile per job.
        background(tickDue());
        background(deliverStatuses());
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
      if (mapping.hostId !== null && mapping.hostId === primaryHostId) throw new Error("Map this repository to a worker host before starting an issue.");
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
    commands: issueCommands({ bb, store, repos: deps.repos, clock, report, sync, stop }),
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
      await poll().catch((error) => bb.log.warn(message(error)));
      await tickDue();
      await deliverStatuses();
      await Promise.all([...running.values()].map((entry) => entry.done.catch(() => {})));
    },
    stop,
  };
}

