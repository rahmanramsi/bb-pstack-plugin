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
import { CAN_TRIGGER, GitHubPermanentError, GitHubSetupError, GitHubTransientError, type GitHub, type PollCursor } from "./github.ts";
import {
  EFFECT_POLICY,
  FACTS_FOR,
  LABEL,
  MAX_REJECTIONS,
  Report,
  TERMINAL,
  acceptReport,
  effectMarker,
  isReasoningLevel,
  plan,
  settle,
  stop as stopChange,
  workerInstructions,
  type Action,
  type Change,
  type Effect,
  type EffectMode,
  type EffectOp,
  type EffectOutcome,
  type Facts,
  type Job,
  type JobId,
  type RepoName,
  type ReportFacts,
  type Sha,
  type WorkerSettings,
} from "./job.ts";
import type { IssueStore } from "./store.ts";

export const CONCURRENCY = 3;
export const SWEEP_MS = 15_000;
export const POLL_MS = 60_000;
const MAX_STEPS = 20;

/** Agents can write their own metadata, so it only points at a job; the store decides. */
export const IssueMetadata = z.object({ pstackIssue: z.literal(1), jobId: z.string() });

export type IssuesDeps = {
  bb: BbPluginApi;
  store: IssueStore;
  github: GitHub;
  hostPush: HostPush;
  /** Configured repositories; empty while issue workers are not set up. */
  repos: () => readonly RepoMapping[];
  resolveRole: (role: string) => readonly ModelChoice[];
  prGate: (threadId: string) => { pass: true } | { pass: false; reason: string };
  clock?: () => number;
};

export type Issues = {
  /** `bb pstack issues …`, spread into the plugin's single CLI. */
  commands: Record<string, PluginCliCommand>;
  /** Thread events and the `pstack-issues` service. */
  register(): void;
  /** Standing instructions for a thread bound to an open job, else null. */
  instructions(threadId: string): string | null;
  /** A thread that is, or was, an issue job's worker. */
  isWorker(threadId: string): boolean;
  /** One pass of the service: poll every repository, then reconcile every open job. */
  sweep(): Promise<void>;
};

export type ReportResult = { ok: true; message: string } | { ok: false; code: string; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  return candidate?.status === 404 || candidate?.code === "thread_not_found";
};
const short = (sha: string) => sha.slice(0, 7);

type Worktree = { ok: true; path: string; headSha: Sha; dirty: boolean; ahead: number } | { ok: false; transient: boolean; error: string };

type Run<Op extends EffectOp> = (job: Job, effect: Extract<Effect, { op: Op }>) => Promise<EffectOutcome>;
/** How to perform an effect, and how to find its trace when EFFECT_POLICY looks for one before running it again. */
export type EffectHandler<Op extends EffectOp> = { perform: Run<Op> } & ((typeof EFFECT_POLICY)[Op]["recovery"]["kind"] extends "replay"
  ? { probe?: never }
  : { probe: Run<Op> });

export function createIssues(deps: IssuesDeps): Issues {
  const { bb, store, github } = deps;
  const clock = deps.clock ?? Date.now;
  const done = (patch = {}): EffectOutcome => ({ kind: "done", patch });

  async function threadsNaming(job: Job): Promise<string[]> {
    const found: string[] = [];
    const since = job.createdAt - 60_000;
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, projectId: job.projectId, includeHidden: true, archived: false, limit: 100, offset });
      for (const thread of page) {
        if (thread.createdAt < since) continue;
        const bound = store.byThread(thread.id);
        if (bound && bound.id !== job.id) continue;
        const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null));
        if (metadata.success && metadata.data.jobId === job.id) found.push(thread.id);
      }
      if (page.length < 100) return found;
    }
  }

  async function worktree(job: Job): Promise<Worktree> {
    if (!job.threadId) return { ok: false, transient: false, error: "the job has no worker thread" };
    const thread = await bb.sdk.threads.get({ threadId: job.threadId });
    if (!thread.environmentId) return { ok: false, transient: true, error: "the worker's worktree is not ready" };
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.hostId !== job.hostId) return { ok: false, transient: false, error: `the worker runs on ${environment.hostId}, not the mapped host ${job.hostId}` };
    if (environment.status !== "ready" || !environment.path) return { ok: false, transient: true, error: `the worker's worktree is ${environment.status}` };
    const status = await bb.sdk.environments.status({ environmentId: thread.environmentId, mergeBaseBranch: `origin/${job.baseBranch}` });
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
    };
  }

  const EFFECTS: { readonly [Op in EffectOp]: EffectHandler<Op> } = {
    labels: {
      async perform(job, effect) {
        const repo = github.repo(job.repo);
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
            environment: { type: "host", hostId: job.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
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
      async probe(job) {
        const [threadId] = await threadsNaming(job);
        return threadId ? done({ threadId }) : { kind: "absent" };
      },
    },
    push: {
      async perform(job, effect) {
        const tree = await worktree(job);
        if (!tree.ok) return tree.transient ? { kind: "retry", error: tree.error, notBefore: null } : { kind: "fail", error: tree.error };
        const repo = github.repo(job.repo);
        const { remoteUrl, token } = await repo.pushCredentials();
        try {
          const result = await deps.hostPush(job.hostId, {
            worktreePath: tree.path,
            remoteUrl,
            branch: job.branch,
            sha: effect.sha,
            expectedRemoteSha: effect.expectedRemoteSha,
            token,
          });
          if (result.status === "pushed") return done({ pushedSha: effect.sha });
          if (result.status === "rejected") return { kind: "fail", error: `push rejected (${result.reason}): ${result.detail}` };
          return { kind: "unknown", error: `push failed: ${result.detail}` };
        } catch (error) {
          return { kind: "unknown", error: `push: ${message(error)}` };
        } finally {
          await repo.revoke(token).catch((error) => bb.log.warn(`pstack issues: could not revoke a push token: ${message(error)}`));
        }
      },
      async probe(job, effect) {
        return (await github.repo(job.repo).branchSha(job.branch)) === effect.sha ? done({ pushedSha: effect.sha }) : { kind: "absent" };
      },
    },
    "open-pr": {
      async perform(job, effect) {
        try {
          const pr = await github.repo(job.repo).createDraftPull({ head: job.branch, base: job.baseBranch, title: effect.title, body: effect.body });
          return done({ pr });
        } catch (error) {
          if (error instanceof GitHubPermanentError && error.status === 422) return { kind: "unknown", error: error.message };
          throw error;
        }
      },
      async probe(job) {
        const pr = await github.repo(job.repo).findPull(job.branch);
        return pr ? done({ pr }) : { kind: "absent" };
      },
    },
    comment: {
      async perform(job, effect) {
        await github.repo(job.repo).comment(job.issue, `${effect.body}\n\n${effectMarker(effect.key)}`);
        return done();
      },
      async probe(job, effect) {
        const since = (("effects" in job.phase && job.phase.firstAt) || clock()) - 60_000;
        return (await github.repo(job.repo).findComment(job.issue, effectMarker(effect.key), since)) ? done() : { kind: "absent" };
      },
    },
    "stop-thread": {
      async perform(job) {
        const threads = new Set([...(job.threadId ? [job.threadId] : []), ...(await threadsNaming(job))]);
        for (const threadId of threads) {
          await bb.sdk.threads.stop({ threadId }).catch((error) => {
            if (!isMissing(error)) throw error;
          });
        }
        return done();
      },
    },
  };

  async function runEffect(job: Job, effect: Effect, mode: EffectMode): Promise<EffectOutcome> {
    const handler = EFFECTS[effect.op] as { perform: Run<EffectOp>; probe?: Run<EffectOp> };
    try {
      if (mode === "perform") return await handler.perform(job, effect);
      if (!handler.probe) throw new Error(`${effect.op} has no probe`);
      const probed = await handler.probe(job, effect);
      return probed.kind === "absent" && mode === "probe-then-perform" ? await handler.perform(job, effect) : probed;
    } catch (error) {
      if (error instanceof GitHubTransientError) return { kind: "retry", error: error.message, notBefore: error.notBefore };
      if (error instanceof GitHubSetupError) return { kind: "retry", error: error.message, notBefore: null };
      if (error instanceof GitHubPermanentError) return { kind: "fail", error: error.message };
      return { kind: "unknown", error: `${effect.op}: ${message(error)}` };
    }
  }

  async function resolveWorker(projectId: string): Promise<WorkerSettings | { error: string }> {
    const choice = deps.resolveRole("issue worker")[0];
    if (!choice) return { error: "no model is configured for the issue worker role" };
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
    const permissionMode = defaults?.permissionMode ?? null;
    if (choice.kind === "tuple") {
      if (!isReasoningLevel(choice.reasoningLevel)) return { error: `the issue worker role's reasoning level "${choice.reasoningLevel}" is not one bb knows` };
      return { providerId: choice.provider, model: choice.model, reasoningLevel: choice.reasoningLevel, permissionMode };
    }
    if (!defaults) return { error: `the issue worker role inherits the project's model, and project ${projectId} has no default` };
    return { providerId: defaults.providerId, model: defaults.model, reasoningLevel: defaults.reasoningLevel, permissionMode };
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
    const wanted = FACTS_FOR[job.phase.state];
    const facts: Facts = { now: clock(), slotFree: null, worker: null, thread: null };
    if (wanted.includes("slotFree")) {
      const { busy, ahead } = store.slots(job.id);
      facts.slotFree = ahead < CONCURRENCY - busy;
    }
    if (wanted.includes("worker") && facts.slotFree) facts.worker = await resolveWorker(job.projectId).catch((error) => ({ error: message(error) }));
    if (wanted.includes("thread")) facts.thread = await threadFact(job.threadId);
    return facts;
  }

  async function apply(job: Job, action: Exclude<Action, { type: "sleep" }>): Promise<void> {
    switch (action.type) {
      case "change":
        store.write(job.id, job.version, action.change, clock(), CONCURRENCY);
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
        const outcome = await runEffect(claimed, action.effect, action.mode);
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

  /** Writes a Change computed from a fresh read, re-reading when another writer got there first. */
  function writeFresh(id: JobId, decide: (job: Job) => Change | null): { job: Job; change: Change | null } | null {
    for (let attempt = 0; attempt < 5; attempt++) {
      const job = store.get(id);
      if (!job) return null;
      const change = decide(job);
      if (!change) return { job, change: null };
      const written = store.write(id, job.version, change, clock());
      if (written) return { job: written, change };
    }
    throw new Error(`issue job ${id} kept changing while it was being written`);
  }

  async function reportFacts(job: Job): Promise<ReportFacts | { unavailable: string }> {
    try {
      const tree = await worktree(job);
      if (!tree.ok) return { unavailable: tree.error };
      return {
        now: clock(),
        worktree: { headSha: tree.headSha, dirty: tree.dirty },
        newCommit: job.pushedSha === null ? tree.ahead > 0 : tree.headSha !== job.pushedSha,
        gate: job.threadId ? deps.prGate(job.threadId) : { pass: false, reason: "the job has no worker thread" },
        titleConvention: await github.repo(job.repo).titleConvention(),
        listedCommentIds: [],
      };
    } catch (error) {
      return { unavailable: message(error) };
    }
  }

  async function report(threadId: string, text: string): Promise<ReportResult> {
    const bound = store.byThread(threadId);
    if (!bound) return { ok: false, code: "not_issue_worker", message: "only an issue worker thread can report" };
    if (bound.phase.state !== "working") return { ok: false, code: "not_working", message: `job ${bound.id} is ${bound.phase.state}, not waiting for a report` };
    let parsed: Report;
    try {
      const result = Report.safeParse(JSON.parse(text));
      if (!result.success) return { ok: false, code: "invalid_report", message: `the report does not match the contract:\n${z.prettifyError(result.error)}` };
      parsed = result.data;
    } catch (error) {
      return { ok: false, code: "invalid_report", message: `the report is not JSON: ${message(error)}` };
    }
    const facts = await reportFacts(bound);
    if ("unavailable" in facts) return { ok: false, code: "unavailable", message: `pstack could not check the report yet, try again shortly: ${facts.unavailable}` };

    let verdict: ReturnType<typeof acceptReport> | null = null;
    const written = writeFresh(bound.id, (job) => {
      if (job.phase.state !== "working") return null;
      verdict = acceptReport(job, parsed, facts);
      return verdict.change;
    });
    const outcome = verdict as ReturnType<typeof acceptReport> | null;
    if (!written?.change || !outcome) return { ok: false, code: "not_working", message: `job ${bound.id} is no longer waiting for a report` };
    background(tick(bound.id));
    if (!outcome.ok) {
      const ended = written.job.phase.state !== "working";
      return {
        ok: false,
        code: "rejected",
        message: [
          `Report rejected (${written.job.rejections} of ${MAX_REJECTIONS}):`,
          ...outcome.reasons.map((reason) => `- ${reason}`),
          ended ? "The job has ended as stuck." : "Fix every reason and report again.",
        ].join("\n"),
      };
    }
    const sha = short(facts.worktree.headSha);
    const messages = {
      changes: `Report accepted. pstack pushes ${sha} to ${bound.branch} and opens a draft pull request.`,
      "needs-info": "Report accepted. pstack posts your questions on the issue.",
      "no-change": "Report accepted. pstack posts your reason on the issue and ends the job.",
    } as const;
    return { ok: true, message: messages[parsed.outcome] };
  }

  async function stop(id: JobId, by: string): Promise<boolean> {
    const written = writeFresh(id, (job) => stopChange(job, by));
    if (!written?.change) return false;
    background(tick(id));
    return true;
  }

  async function onThread(threadId: string): Promise<void> {
    const bound = store.byThread(threadId);
    if (bound) return tick(bound.id);
    const metadata = IssueMetadata.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null));
    if (!metadata.success) return;
    const job = store.get(metadata.data.jobId as JobId);
    if (job?.phase.state === "starting") return tick(job.id);
    if (job && ("effects" in job.phase ? job.phase.effects.some((effect) => effect.op === "stop-thread") : false)) return;
    await bb.sdk.threads.stop({ threadId }).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }

  async function pollRepo(mapping: RepoMapping, primaryHostId: string | null): Promise<JobId[]> {
    const now = clock();
    const previous = store.repoPoll(mapping.repo).poll as PollCursor | null;
    if (mapping.hostId === primaryHostId) {
      store.saveRepoPoll(mapping.repo, previous, now, `host ${mapping.hostId} is the bb server's machine; map ${mapping.repo} to another host`);
      return [];
    }
    const repo = github.repo(mapping.repo);
    try {
      const result = await repo.labeledIssues(LABEL.trigger, previous);
      if (!result.changed) {
        store.saveRepoPoll(mapping.repo, previous, now, null);
        return [];
      }
      const [appLogin, baseBranch] = await Promise.all([repo.appLogin(), repo.defaultBranch()]);
      const queued: JobId[] = [];
      for (const issue of result.issues) {
        if (store.open(mapping.repo, issue.number)) continue;
        const event = await repo.latestLabelEvent(issue.number, LABEL.trigger);
        if (!event || store.byTrigger(event.id)) continue;
        const permission = event.actor === appLogin ? null : await repo.permission(event.actor);
        const refusal =
          permission === null ? "the label was added by the GitHub App" : CAN_TRIGGER.has(permission) ? null : `@${event.actor} has ${permission} permission`;
        const job = store.insert(
          {
            id: `psi_${randomUUID()}` as JobId,
            repo: mapping.repo,
            issue: issue.number,
            trigger: { eventId: event.id, actor: event.actor, at: event.at },
            snapshot: { title: issue.title, body: issue.body, url: issue.url, author: issue.author },
            projectId: mapping.projectId,
            hostId: mapping.hostId,
            baseBranch,
            state: refusal ? "ignored" : "queued",
            error: refusal,
          },
          now,
        );
        if (job && !refusal) queued.push(job.id);
      }
      store.saveRepoPoll(mapping.repo, result.next, now, null);
      return queued;
    } catch (error) {
      store.saveRepoPoll(mapping.repo, previous, now, message(error));
      return [];
    }
  }

  async function poll(): Promise<void> {
    const repos = deps.repos();
    if (repos.length === 0) return;
    const { primaryHostId } = await bb.sdk.system.config();
    for (const mapping of repos) for (const id of await pollRepo(mapping, primaryHostId)) await tick(id);
  }

  async function tickDue(): Promise<void> {
    for (const id of store.due()) await tick(id).catch((error) => bb.log.error(`pstack issues: ${id}: ${message(error)}`));
  }

  async function serve(signal: AbortSignal): Promise<void> {
    let nextPoll = 0;
    while (!signal.aborted) {
      try {
        if (clock() >= nextPoll) {
          nextPoll = clock() + POLL_MS;
          await poll();
        }
        await tickDue();
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
    commands: issueCommands({ bb, store, report, stop }),
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
    isWorker: (threadId) => store.byThread(threadId) !== null,
    async sweep() {
      await poll();
      await tickDue();
    },
  };
}

