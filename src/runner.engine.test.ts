import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { RunPlan } from "./contract.ts";
import { parseChoice, type ModelChoice } from "./models.ts";
import { createPlacement } from "./placement.ts";
import { openRunStore } from "./run-store.ts";
import { createRunner, compile, WORKSPACE_MISMATCH, type RunId } from "./runner.ts";
import { MIGRATIONS } from "./store.ts";

type FakeThread = {
  id: string;
  status: "active" | "idle" | "error";
  archivedAt: number | null;
  deletedAt: number | null;
  output: string | null;
  metadata: Record<string, unknown>;
  originPluginId: string | null;
  environmentId: string;
  hostId: string;
};

const PIN = { branch: "feature", sha: "c0ffee" };
const HOSTS = [
  { id: "host_home", name: "Mac Mini" },
  { id: "host_box", name: "box" },
];

function checkout(options: { branch?: string; sha: string | null; state?: string; pushed?: string | null; mergeBase?: string }) {
  const branch = options.branch ?? PIN.branch;
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: branch, defaultBranch: "main" },
      checkout: { kind: "branch", branchName: branch, headSha: options.sha },
      workingTree: { state: options.state ?? "clean", hasUncommittedChanges: options.state !== undefined && options.state !== "clean" },
      mergeBase: options.mergeBase === undefined ? null : { mergeBaseBranch: options.mergeBase, baseRef: options.pushed === undefined ? options.sha : options.pushed, aheadCount: 0, behindCount: 0 },
    },
  };
}

const ROLES: Record<string, string[]> = {
  "interrogate reviewers": ["claude-code/claude-opus-5-5/high", "codex/gpt-6.1-sol/high"],
  "arena cross-judge pool": ["claude-code/claude-opus-5-5/high", "codex/gpt-6.1-sol/high"],
  "swarm workers": ["codex/gpt-6.1-sol/high"],
};
const resolveRole = (role: string): ModelChoice[] => (ROLES[role] ?? []).map((value) => parseChoice(value)!);

/** `homeLimit` is the origin machine's concurrency limit; the other machine, `box`, has 8 slots and the pinned branch. */
function harness(options: { homeLimit?: number; origin?: ReturnType<typeof checkout> } = {}) {
  const threads = new Map<string, FakeThread>();
  const thread = (fields: Pick<FakeThread, "id"> & Partial<FakeThread>): FakeThread => ({
    status: "active", archivedAt: null, deletedAt: null, output: null, metadata: {}, originPluginId: "pstack", environmentId: `env_${fields.id}`, hostId: "host_home", ...fields,
  });
  threads.set("thr_origin", thread({ id: "thr_origin", originPluginId: null, environmentId: "env_1" }));
  const statuses = new Map<string, unknown>([["env_1", options.origin ?? checkout({ sha: PIN.sha, mergeBase: `origin/${PIN.branch}` })]]);
  const limits = { home: options.homeLimit ?? 20 };
  const spawned: Record<string, any>[] = [];
  const sent: Record<string, any>[] = [];
  const stopped: string[] = [];
  let next = 0;
  const failures = { spawn: [] as { error: Error; create: boolean }[], send: [] as Error[], stop: [] as Error[] };
  const missing = () => Object.assign(new Error("thread not found"), { status: 404 });

  const sdk = {
    threads: {
      async get({ threadId }: { threadId: string }) {
        const thread = threads.get(threadId);
        if (!thread) throw missing();
        return { ...thread, projectId: "prj_1", providerId: "claude-code" };
      },
      async listRunning() {
        return [...threads.values()].filter((entry) => entry.status === "active" && !stopped.includes(entry.id)).map(({ id, hostId }) => ({ id, hostId }));
      },
      async defaultExecutionOptions() {
        return { model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto" };
      },
      async spawn(args: Record<string, any>) {
        spawned.push(args);
        const failure = failures.spawn.shift();
        const id = `thr_w${++next}`;
        if (!failure || failure.create) {
          const away = args.environment.type === "host";
          threads.set(id, thread({ id, metadata: args.pluginMetadata, environmentId: away ? `env_${id}` : args.environment.environmentId, hostId: away ? args.environment.hostId : "host_home" }));
          if (away) statuses.set(`env_${id}`, checkout({ sha: PIN.sha }));
        }
        if (failure) throw failure.error;
        return { id };
      },
      async output({ threadId }: { threadId: string }) {
        return { output: threads.get(threadId)!.output };
      },
      async send(args: Record<string, any>) {
        const failure = failures.send.shift();
        if (failure) throw failure;
        sent.push(args);
        return {};
      },
      async stop({ threadId }: { threadId: string }) {
        const failure = failures.stop.shift();
        if (failure) throw failure;
        stopped.push(threadId);
        return {};
      },
      async list({ offset = 0 }: { offset?: number }) {
        return [...threads.values()].filter((thread) => thread.originPluginId === "pstack" && thread.archivedAt === null).slice(offset, offset + 100);
      },
      async getPluginMetadata({ threadId }: { threadId: string }) {
        const thread = threads.get(threadId);
        if (!thread) throw missing();
        return thread.metadata;
      },
    },
  };
  const machines = {
    hosts: { list: async () => HOSTS.map((host) => ({ ...host, status: "connected", lifecycle: { phase: "active" } })) },
    environments: {
      async get({ environmentId }: { environmentId: string }) {
        return { id: environmentId, hostId: [...threads.values()].find((entry) => entry.environmentId === environmentId)?.hostId ?? "host_home" };
      },
      async status({ environmentId, mergeBaseBranch }: { environmentId: string; mergeBaseBranch?: string }) {
        const status = statuses.get(environmentId) as ReturnType<typeof checkout>;
        if (!status) throw missing();
        const merge = status.workspace.mergeBase;
        return mergeBaseBranch === undefined || !merge ? { ...status, workspace: { ...status.workspace, mergeBase: null } } : merge.mergeBaseBranch === mergeBaseBranch ? status : { ...status, workspace: { ...status.workspace, mergeBase: { ...merge, mergeBaseBranch, baseRef: null } } };
      },
      listProviders: async () => [{ id: "git-worktree", availability: { status: "available" } }],
    },
    projects: { branches: async () => ({ checkout: { kind: "branch", branchName: PIN.branch, headSha: PIN.sha } }) },
    providers: {
      list: async () => [{ id: "claude-code", available: true }, { id: "codex", available: true }],
      models: async () => ({ models: [{ model: "claude-opus-5-5", supportedReasoningEfforts: [] }, { model: "gpt-6.1-sol", supportedReasoningEfforts: [] }] }),
    },
  };
  const bb = {
    pluginId: "pstack",
    sdk: { ...sdk, ...machines },
    realtime: { publish() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as BbPluginApi;

  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const clock = { now: 1_000_000 };
  const store = openRunStore(db, () => clock.now);
  const placement = () => createPlacement(bb, {
    clock: () => clock.now,
    exec: async () => JSON.stringify({ globalLimit: null, hosts: [{ id: "host_home", effectiveLimit: limits.home }, { id: "host_box", effectiveLimit: 8 }] }),
  });
  const runner = createRunner(bb, store, { resolveRole, placement: placement(), clock: () => clock.now });
  const restart = () => createRunner(bb, openRunStore(db, () => clock.now), { resolveRole, placement: placement(), clock: () => clock.now });
  const worker = (index: number) => `thr_w${index}`;
  const toWorker = (threadId: string) => sent.filter((message) => message.threadId === threadId);
  const toOrigin = () => sent.filter((message) => message.threadId === "thr_origin");
  const hosts = (runId: RunId) => runner.view(runId, "thr_origin").jobs.map((job) => job.host?.name ?? null);
  return { bb, db, threads, thread, statuses, spawned, sent, stopped, failures, store, runner, restart, clock, worker, toWorker, toOrigin, hosts };
}

const PANEL_INPUT = {
  kind: "panel",
  title: "Review src/doctor.ts",
  seats: [{ label: "Reviewer {letter}", model: { role: "interrogate reviewers" }, prompt: "Read-only. Review it.", result: "review" }],
  judge: { model: { role: "arena cross-judge pool" }, prompt: "Group the findings.", result: "grouping" },
};
const PANEL = RunPlan.parse(PANEL_INPUT);

const SWARM = (slices: string[], verify = false) =>
  RunPlan.parse({ kind: "swarm", title: "check.sh", brief: "Run check.sh.", slices, ...(verify ? { verify: { prompt: "Re-run it." } } : {}) });

const finding = (title: string) => ({ severity: "warning", title, location: "src/doctor.ts:1", detail: "d" });

test("start spawns one hidden worker per seat with the origin's snapshot and holds the judge", async () => {
  const h = harness();
  const { runId, existing } = await h.runner.start(PANEL, "thr_origin");
  assert.equal(existing, false);
  assert.equal(h.spawned.length, 2);
  const [first, second] = h.spawned;
  assert.deepEqual(
    { ...first, prompt: undefined },
    {
      lifecycleOwnerThreadId: "thr_origin",
      pluginMetadata: { pstackWorker: 1, runId, job: "seat-1", ordinal: 1, originThreadId: "thr_origin" },
      projectId: "prj_1",
      environment: { type: "reuse", environmentId: "env_1" },
      prompt: undefined,
      title: "Review src/doctor.ts · Reviewer A",
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      permissionMode: "auto",
      visibility: "hidden",
    },
  );
  assert.equal(second!.providerId, "codex");
  assert.match(first!.prompt, /^Read-only\. Review it\.[\s\S]*## Result[\s\S]*replaces any output format[\s\S]*`pstack_result`[\s\S]*"findings"/);
  const view = h.runner.view(runId, "thr_origin");
  assert.deepEqual(view.jobs.map((job) => [job.key, job.state, job.threadId]), [
    ["seat-1", "running", h.worker(1)],
    ["seat-2", "running", h.worker(2)],
    ["judge", "blocked", null],
  ]);
});

test("start with the same request key returns the existing run without spawning again", async () => {
  const h = harness();
  const plan = RunPlan.parse({ ...PANEL_INPUT, requestKey: "review-1" });
  const first = await h.runner.start(plan, "thr_origin");
  const second = await h.runner.start(plan, "thr_origin");
  assert.deepEqual(second, { runId: first.runId, existing: true });
  assert.equal(h.spawned.length, 2);
  await assert.rejects(h.runner.start(RunPlan.parse({ ...PANEL_INPUT, requestKey: "review-1", title: "Other" }), "thr_origin"), { code: "request_key_conflict" });
});

test("a pstack delegate without worker metadata leaves every run untouched when it goes idle or fails", async () => {
  const h = harness();
  const { runId } = await h.runner.start(PANEL, "thr_origin");
  h.threads.set("thr_delegate", h.thread({ id: "thr_delegate", status: "idle", output: "done" }));
  const before = JSON.stringify(h.runner.view(runId, "thr_origin"));
  await h.runner.onIdle("thr_delegate", "done");
  await h.runner.onFailed("thr_delegate", "boom");
  assert.equal(JSON.stringify(h.runner.view(runId, "thr_origin")), before);
  assert.equal(h.sent.length, 0);
  assert.equal(h.spawned.length, 2);
});

test("a panel runs seats, then the judge, then tells the origin once with every outcome", async () => {
  const h = harness();
  const { runId } = await h.runner.start(PANEL, "thr_origin");

  assert.deepEqual(await h.runner.submit(h.worker(1), { findings: [finding("Leak"), finding("Race")] }), { ok: true });
  assert.deepEqual(h.stopped, [h.worker(1)], "an accepted result stops its worker");
  await h.runner.onIdle(h.worker(2), "```json\n" + JSON.stringify({ findings: [finding("Memory leak")] }) + "\n```");

  assert.equal(h.spawned.length, 3);
  const judge = h.spawned[2]!;
  assert.equal(judge.providerId, "codex", "the judge comes from the pool by a provider other than the origin's");
  assert.match(judge.prompt, /^Group the findings\.[\s\S]*2 of 2 inputs succeeded[\s\S]*- A\.1 \[warning\] Leak[\s\S]*- B\.1 \[warning\] Memory leak/);

  assert.deepEqual(
    await h.runner.submit(h.worker(3), { summary: "s", groups: [{ title: "Leak", severity: "critical", verdict: "act-on", members: ["A.9"], rationale: "" }] }),
    { ok: false, error: 'group "Leak" names A.9, which is not a seat finding' },
  );
  assert.deepEqual(
    await h.runner.submit(h.worker(3), { summary: "s", groups: [{ title: "Leak", severity: "critical", verdict: "act-on", members: ["A.1", "B.1"], rationale: "" }] }),
    { ok: true },
  );

  const view = h.runner.view(runId, "thr_origin");
  assert.equal(view.status, "succeeded");
  assert.deepEqual(view.matrix!.map((row) => [row.title, row.verdict]), [["Leak", "act-on"], ["Race", null]]);
  const messages = h.toOrigin();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.mode, "steer-if-active");
  const [input] = messages[0]!.input;
  assert.equal(input.visibility, "agent-only");
  assert.match(input.text, /finished: succeeded[\s\S]*Reviewer A[\s\S]*succeeded, 2 findings[\s\S]*Reviewer B[\s\S]*Judge[\s\S]*1 group/);

  await h.runner.tick(runId);
  assert.equal(h.toOrigin().length, 1, "the completion message is sent once");
});

test("an invalid structured result gets two corrective turns, then fails the job", async () => {
  const h = harness();
  const { runId } = await h.runner.start(RunPlan.parse({ ...PANEL_INPUT, judge: undefined }), "thr_origin");
  for (let turn = 1; turn <= 2; turn++) {
    await h.runner.onIdle(h.worker(1), "Looks fine to me.");
    const corrections = h.toWorker(h.worker(1));
    assert.equal(corrections.length, turn);
    assert.equal(corrections.at(-1)!.mode, "auto");
    assert.match(corrections.at(-1)!.input[0].text, new RegExp(`pstack_result[\\s\\S]*${turn} of 2`));
    await h.runner.onIdle(h.worker(1), "Looks fine to me.");
    assert.equal(h.toWorker(h.worker(1)).length, turn, "a stale idle right after a corrective turn spends no budget");
    h.clock.now += 30_000;
  }
  await h.runner.onIdle(h.worker(1), "Still prose.");
  const seat = h.runner.view(runId, "thr_origin").jobs[0]!;
  assert.equal(seat.state, "failed");
  assert.match(seat.error!, /after 2 corrective turns/);
  assert.equal(h.toWorker(h.worker(1)).length, 2);
});

test("a text job succeeds with the worker's final message and rejects pstack_result", async () => {
  const h = harness();
  const plan = RunPlan.parse({ kind: "panel", title: "Explain", seats: [{ label: "Explainer", model: { tuple: "codex/gpt-6.1-sol/high" }, prompt: "Explain X." }] });
  const { runId } = await h.runner.start(plan, "thr_origin");
  assert.match(h.spawned[0]!.prompt, /Your final message is the result/);
  assert.equal((await h.runner.submit(h.worker(1), "x")).ok, false);
  await h.runner.onIdle(h.worker(1), "X works like this.");
  assert.deepEqual(h.runner.results(runId, "thr_origin").map((job) => [job.state, job.value]), [["succeeded", "X works like this."]]);
});

test("a text job whose worker idles with no final message is corrected, then fails, never succeeds empty", async () => {
  const h = harness();
  const plan = RunPlan.parse({ kind: "panel", title: "Explain", seats: [{ label: "Explainer", model: { tuple: "codex/gpt-6.1-sol/high" }, prompt: "Explain X." }] });
  const { runId } = await h.runner.start(plan, "thr_origin");
  await h.runner.onIdle(h.worker(1), null);
  assert.equal(h.runner.view(runId, "thr_origin").jobs[0]!.state, "running");
  const [correction] = h.toWorker(h.worker(1));
  assert.match(correction!.input[0].text, /final message/);
  assert.doesNotMatch(correction!.input[0].text, /pstack_result/, "a text job has no result tool");
  h.clock.now += 30_000;
  await h.runner.onIdle(h.worker(1), "  \n ");
  assert.equal(h.toWorker(h.worker(1)).length, 2);
  h.clock.now += 30_000;
  await h.runner.onIdle(h.worker(1), null);
  const [job] = h.runner.results(runId, "thr_origin");
  assert.deepEqual([job!.state, job!.value], ["failed", null]);
  assert.equal(h.runner.view(runId, "thr_origin").status, "failed");
});

test("a transient provider failure retries on a fresh thread after the backoff", async () => {
  const h = harness();
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  await h.runner.onFailed(h.worker(1), "Provider overloaded (HTTP 529)");
  assert.equal(h.runner.view(runId, "thr_origin").jobs[0]!.state, "queued");

  h.clock.now += 999;
  await h.runner.tick(runId);
  assert.equal(h.spawned.length, 1, "no spawn before the 1 s backoff");
  h.clock.now += 1;
  await h.runner.tick(runId);
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1]!.pluginMetadata.ordinal, 2);

  await h.runner.onFailed(h.worker(1), "Provider overloaded (HTTP 529)");
  assert.equal(h.runner.view(runId, "thr_origin").jobs[0]!.state, "running", "a stale attempt's failure is ignored");
});

test("a spawn that fails after creating its thread adopts that thread instead of spawning again", async () => {
  const h = harness();
  h.failures.spawn.push({ error: new Error("socket hang up"), create: true });
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  assert.equal(h.spawned.length, 1);
  assert.equal(h.runner.view(runId, "thr_origin").jobs[0]!.threadId, h.worker(1));

  const blind = harness();
  blind.failures.spawn.push({ error: new Error("socket hang up"), create: true });
  (blind.bb.sdk.threads as { list: unknown }).list = async () => {
    throw new Error("bb is restarting");
  };
  const third = await blind.runner.start(SWARM(["a"]), "thr_origin");
  assert.equal(blind.runner.view(third.runId, "thr_origin").jobs[0]!.state, "uncertain", "an unverifiable spawn is never repeated");
  await blind.runner.tick(third.runId);
  assert.equal(blind.spawned.length, 1);
});

test("a spawn error with no thread found leaves the job uncertain until its thread turns up, never spawning again", async () => {
  const h = harness();
  h.failures.spawn.push({ error: new Error("HTTP 400: invalid model"), create: false });
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  const job = h.runner.view(runId, "thr_origin").jobs[0]!;
  assert.deepEqual([job.state, job.error], ["uncertain", "the worker may not have started: HTTP 400: invalid model"]);
  h.clock.now += 60_000;
  await h.runner.tick(runId);
  assert.equal(h.spawned.length, 1);

  const metadata = h.spawned[0]!.pluginMetadata;
  h.threads.set("thr_late", h.thread({ id: "thr_late", status: "idle", metadata }));
  await h.runner.onIdle("thr_late", JSON.stringify({ slice: "a", status: "PASS", summary: "ok", evidence: [], issues: [] }));
  const adopted = h.runner.view(runId, "thr_origin");
  assert.deepEqual([adopted.status, adopted.jobs[0]!.threadId, adopted.jobs[0]!.error], ["succeeded", "thr_late", null]);
  assert.equal(h.spawned.length, 1);
});

test("a tick adopts an uncertain spawn's thread when its events are missed", async () => {
  const h = harness();
  h.failures.spawn.push({ error: new Error("socket hang up"), create: false });
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  const metadata = h.spawned[0]!.pluginMetadata;
  const output = JSON.stringify({ slice: "a", status: "PASS", summary: "ok", evidence: [], issues: [] });
  h.threads.set("thr_late", h.thread({ id: "thr_late", status: "idle", output, metadata }));
  await h.runner.tick(runId);
  assert.deepEqual(h.runner.results(runId, "thr_origin").map((job) => job.state), ["succeeded"]);
  assert.equal(h.spawned.length, 1);
});

test("a thread that turns up after its attempt is no longer live is stopped, not run hidden", async () => {
  const h = harness();
  h.failures.spawn.push({ error: new Error("socket hang up"), create: false });
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  h.clock.now += 4 * 60 * 60 * 1_000;
  await h.runner.tick(runId);
  assert.equal(h.runner.view(runId, "thr_origin").jobs[0]!.state, "failed");

  const metadata = h.spawned[0]!.pluginMetadata;
  h.threads.set("thr_late", h.thread({ id: "thr_late", metadata }));
  h.failures.stop.push(new Error("bb is restarting"));
  await h.runner.onIdle("thr_late", "anything");
  assert.deepEqual(h.stopped, []);
  await h.runner.tick(runId);
  assert.deepEqual(h.stopped, ["thr_late"], "a failed stop of a late thread is retried");
  assert.deepEqual(h.runner.results(runId, "thr_origin").map((job) => job.state), ["failed"]);
});

test("the swarm engine keeps at most 8 workers running and releases each verifier with its own slice", async () => {
  const h = harness();
  const slices = Array.from({ length: 10 }, (_, index) => `p${index + 1}`);
  const { runId } = await h.runner.start(SWARM(slices, true), "thr_origin");
  assert.equal(h.spawned.length, 8);
  await h.runner.submit(h.worker(1), { slice: "p1", status: "PASS", summary: "ok", evidence: ["ran"], issues: [] });
  assert.equal(h.spawned.length, 9);
  assert.equal(h.spawned[8]!.pluginMetadata.job, "verify-1", "the verifier goes before unstarted slices");
  assert.match(h.spawned[8]!.prompt, /^Re-run it\.[\s\S]*"status": "PASS"[\s\S]*Set "slice" to "p1"/);
  const view = h.runner.view(runId, "thr_origin");
  assert.deepEqual(view.jobs.filter((job) => job.slice === "p1").map((job) => [job.kind, job.state]), [["slice", "succeeded"], ["verifier", "running"]]);
});

test("a report or verdict for another slice is rejected, by the tool and in the final message", async () => {
  const h = harness();
  const { runId } = await h.runner.start(SWARM(["a"], true), "thr_origin");
  const report = (slice: string) => ({ slice, status: "PASS", summary: "ok", evidence: [], issues: [] });
  const submitted = await h.runner.submit(h.worker(1), report("other"));
  assert.equal(submitted.ok, false);
  assert.match((submitted as { error: string }).error, /"other"[\s\S]*"a"/);
  await h.runner.onIdle(h.worker(1), JSON.stringify(report("other")));
  assert.equal(h.toWorker(h.worker(1)).length, 1, "a wrong slice in the final message spends a corrective turn");
  assert.equal(h.spawned.length, 1, "the verifier is not released on another slice's report");

  assert.deepEqual(await h.runner.submit(h.worker(1), report("a")), { ok: true });
  const verdict = (slice: string) => ({ slice, verdict: "VERIFIED", notes: "" });
  assert.equal((await h.runner.submit(h.worker(2), verdict("other"))).ok, false);
  assert.deepEqual(await h.runner.submit(h.worker(2), verdict("a")), { ok: true });
  assert.equal(h.runner.view(runId, "thr_origin").status, "succeeded");
});

test("restart: an issued attempt is adopted through its metadata, or marked uncertain and never spawned again", async () => {
  const h = harness();
  const plan = SWARM(["a", "b", "c"]);
  const origin = { threadId: "thr_origin", projectId: "prj_1", environmentId: "env_1", hostId: "host_home", pin: null, providerId: "claude-code", model: "m", reasoningLevel: "high", permissionMode: "auto" };
  const compiled = compile(plan, resolveRole, origin);
  assert.ok(compiled.ok);
  const runId = "psr_33333333-3333-3333-3333-333333333333" as RunId;
  h.store.createRun({ id: runId, origin, requestKey: null, planHash: "h", kind: "swarm", title: "check.sh", deadline: h.clock.now + 60_000, jobs: compiled.jobs });
  for (const key of ["slice-1", "slice-2", "slice-3"]) {
    h.store.transitionJobAndAttempt(runId, key, "queued", "running");
    h.store.claimAttempt(runId, key, 1, h.clock.now, HOSTS[0]!);
  }
  h.store.transitionJobAndAttempt(runId, "slice-3", "running", "failed", { error: "the worker thread failed" });
  h.threads.set("thr_stray", h.thread({ id: "thr_stray", metadata: { pstackWorker: 1, runId, job: "slice-3", ordinal: 1, originThreadId: "thr_origin" } }));
  h.threads.set("thr_lost", h.thread({
    id: "thr_lost",
    status: "idle",
    output: JSON.stringify({ slice: "a", status: "PASS", summary: "ok", evidence: [], issues: [] }),
    metadata: { pstackWorker: 1, runId, job: "slice-1", ordinal: 1, originThreadId: "thr_origin" },
  }));

  const stopped = new AbortController();
  stopped.abort();
  await h.runner.serve(stopped.signal);
  let jobs = h.runner.view(runId, "thr_origin").jobs;
  assert.deepEqual(jobs.map((job) => [job.key, job.state, job.threadId]), [
    ["slice-1", "running", "thr_lost"],
    ["slice-2", "uncertain", null],
    ["slice-3", "failed", "thr_stray"],
  ]);
  assert.deepEqual(h.stopped, ["thr_stray"], "a thread for an attempt that already failed is stopped");

  await h.runner.tick(runId);
  jobs = h.runner.view(runId, "thr_origin").jobs;
  assert.deepEqual(jobs.map((job) => job.state), ["succeeded", "uncertain", "failed"], "the tick polls the adopted worker");
  assert.equal(h.spawned.length, 0);

  h.clock.now += 60_000;
  await h.runner.tick(runId);
  jobs = h.runner.view(runId, "thr_origin").jobs;
  assert.deepEqual([jobs[1]!.state, jobs[1]!.error], ["failed", "the run deadline passed"]);
  assert.equal(h.runner.view(runId, "thr_origin").status, "partial");
  assert.equal(h.spawned.length, 0);
});

test("the tick polls attached workers so a missed idle event cannot strand a run", async () => {
  const h = harness();
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  const thread = h.threads.get(h.worker(1))!;
  thread.status = "idle";
  thread.output = JSON.stringify({ slice: "a", status: "ISSUES", summary: "1 failing", evidence: [], issues: ["x"] });
  await h.runner.tick(runId);
  assert.equal(h.runner.view(runId, "thr_origin").status, "succeeded");
  assert.equal(h.toOrigin().length, 1);
});

test("stop cancels open jobs, stops their workers, and reports the cancelled run", async () => {
  const h = harness();
  const { runId } = await h.runner.start(PANEL, "thr_origin");
  assert.equal(await h.runner.stop(runId, "thr_origin"), true);
  assert.equal(await h.runner.stop(runId, "thr_origin"), false);
  assert.deepEqual(h.stopped.sort(), [h.worker(1), h.worker(2)]);
  const view = h.runner.view(runId, "thr_origin");
  assert.deepEqual([view.status, ...view.jobs.map((job) => job.state)], ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.match(h.toOrigin()[0]!.input[0].text, /finished: cancelled/);
  assert.throws(() => h.runner.view(runId, "thr_other"), { code: "run_not_found" });
});

test("a worker whose stop fails after cancel is stopped again by later ticks, across a restart, until it is confirmed", async () => {
  const h = harness();
  const { runId } = await h.runner.start(SWARM(["a", "b"]), "thr_origin");
  h.failures.stop.push(new Error("bb is restarting"), new Error("bb is restarting"));
  assert.equal(await h.runner.stop(runId, "thr_origin"), true);
  const view = h.runner.view(runId, "thr_origin");
  assert.deepEqual([view.status, ...view.jobs.map((job) => job.state)], ["cancelled", "cancelled", "cancelled"]);
  assert.deepEqual(h.stopped, []);
  assert.ok(h.store.dueRuns(h.clock.now).includes(runId), "a cancelled run with live workers stays due");

  const restarted = h.restart();
  await restarted.tick(runId);
  assert.deepEqual(h.stopped.sort(), [h.worker(1), h.worker(2)]);
  await restarted.tick(runId);
  assert.equal(h.stopped.length, 2, "a confirmed stop is not repeated");
  assert.ok(!h.store.dueRuns(h.clock.now).includes(runId));
});

test("a deadline failure and an accepted final message both stop their worker, retrying a failed stop", async () => {
  const h = harness();
  const plan = RunPlan.parse({ kind: "panel", title: "Explain", seats: ["A", "B"].map((label) => ({ label, model: { tuple: "codex/gpt-6.1-sol/high" }, prompt: "Explain X." })) });
  const { runId } = await h.runner.start(plan, "thr_origin");
  await h.runner.onIdle(h.worker(1), "X works like this.");
  assert.deepEqual(h.stopped, [h.worker(1)]);

  h.failures.stop.push(new Error("bb is restarting"));
  h.clock.now += 4 * 60 * 60 * 1_000;
  await h.runner.tick(runId);
  assert.deepEqual(h.runner.view(runId, "thr_origin").jobs.map((job) => job.state), ["succeeded", "failed"]);
  assert.deepEqual(h.stopped, [h.worker(1)]);
  await h.runner.tick(runId);
  assert.deepEqual(h.stopped, [h.worker(1), h.worker(2)]);
});

test("completion delivery retries with backoff, and is abandoned when the origin is archived", async () => {
  const h = harness();
  h.failures.send.push(new Error("bb is restarting"));
  const { runId } = await h.runner.start(SWARM(["a"]), "thr_origin");
  await h.runner.onIdle(h.worker(1), JSON.stringify({ slice: "a", status: "PASS", summary: "ok", evidence: [], issues: [] }));
  assert.equal(h.toOrigin().length, 0);
  await h.runner.tick(runId);
  assert.equal(h.toOrigin().length, 0, "not before the backoff");
  h.clock.now += 1_000;
  await h.runner.tick(runId);
  assert.equal(h.toOrigin().length, 1);

  const other = harness();
  const second = await other.runner.start(SWARM(["a"]), "thr_origin");
  other.threads.get("thr_origin")!.archivedAt = other.clock.now;
  await other.runner.onGone("thr_origin");
  assert.equal(other.runner.view(second.runId, "thr_origin").status, "cancelled");
  assert.deepEqual(other.stopped, [other.worker(1)]);
  assert.equal(other.toOrigin().length, 0);
  assert.equal(other.store.info(second.runId)!.notify.state, "abandoned");
});

test("workerResult names a worker's contract from its metadata before attach and its attempt after", async () => {
  const h = harness();
  const { runId } = await h.runner.start(PANEL, "thr_origin");
  assert.equal(h.runner.workerResult(h.worker(1), {}), "review");
  assert.equal(h.runner.workerResult("thr_unattached", { pstackWorker: 1, runId, job: "judge", ordinal: 1, originThreadId: "thr_origin" }), "grouping");
  assert.equal(h.runner.workerResult("thr_origin", {}), null);
  assert.equal(h.runner.workerResult("thr_x", { pstackWorker: 1 }), null);
  assert.deepEqual(h.runner.activeRuns("thr_origin"), [runId]);
});

test("start rejects a plan whose models the origin's machine does not offer, before any spawn", async () => {
  const h = harness();
  const checked: { tuples: readonly string[]; environmentId: string }[] = [];
  const runner = createRunner(h.bb, h.store, {
    resolveRole,
    placement: createPlacement(h.bb, { exec: async () => "{}" }),
    clock: () => h.clock.now,
    async modelProblems(tuples, environmentId) {
      checked.push({ tuples, environmentId });
      return tuples.filter((tuple) => tuple.startsWith("codex/")).map((tuple) => `${tuple}: codex has no such model`);
    },
  });
  await assert.rejects(runner.start(PANEL, "thr_origin"), (error: Error & { code?: string }) =>
    error.code === "plan_invalid" && /models not available on this thread's machine: codex\//.test(error.message));
  assert.equal(h.spawned.length, 0);
  assert.equal(checked[0]?.environmentId, "env_1");
  assert.ok(checked[0]!.tuples.length >= 2);
});

const CLAUDE = "claude-code/claude-opus-5-5/high";
const explore = (seats: [label: string, reads: string][], prompt = "Read-only. Explore src/runner.ts.") =>
  RunPlan.parse({ kind: "panel", title: "Explore", seats: seats.map(([label, reads]) => ({ label, model: { tuple: CLAUDE }, prompt, reads })) });

test("a commit job stays home while home has room and leaves for a worktree at the pinned commit when it is full", async () => {
  const h = harness({ homeLimit: 3 });
  const { runId } = await h.runner.start(explore([["Here", "origin"], ["A", "commit"], ["B", "commit"]]), "thr_origin");
  assert.deepEqual(h.spawned.map((args) => args.environment), [
    { type: "reuse", environmentId: "env_1" },
    { type: "reuse", environmentId: "env_1" },
    { type: "host", hostId: "host_box", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature" } } },
  ]);
  assert.deepEqual(h.hosts(runId), ["Mac Mini", "Mac Mini", "box"]);
  assert.doesNotMatch(h.spawned[1]!.prompt, new RegExp(WORKSPACE_MISMATCH), "a commit job at home reads the origin worktree");
  assert.match(h.spawned[2]!.prompt, /^This job runs on another machine[\s\S]*`feature`[\s\S]*c0ffee[\s\S]*WORKSPACE_MISMATCH[\s\S]*Read-only\. Explore/);

  await h.runner.onIdle(h.worker(3), "It works like this.");
  assert.equal(h.runner.view(runId, "thr_origin").jobs[2]!.state, "succeeded", "a worker at the pinned HEAD is accepted");
});

test("an origin job stays home when home is full", async () => {
  const h = harness({ homeLimit: 1 });
  const { runId } = await h.runner.start(explore([["Here", "origin"]]), "thr_origin");
  assert.deepEqual(h.spawned[0]!.environment, { type: "reuse", environmentId: "env_1" });
  assert.deepEqual(h.hosts(runId), ["Mac Mini"]);
});

test("commit jobs stay home without a clean, pushed origin checkout, and prompt jobs need no pin", async () => {
  for (const origin of [
    checkout({ sha: PIN.sha, state: "dirty_uncommitted", mergeBase: `origin/${PIN.branch}` }),
    checkout({ sha: PIN.sha, mergeBase: `origin/${PIN.branch}`, pushed: null }),
  ]) {
    const h = harness({ homeLimit: 1, origin });
    await h.runner.start(explore([["A", "commit"], ["B", "prompt"]]), "thr_origin");
    assert.deepEqual(h.spawned.map((args) => args.environment), [
      { type: "reuse", environmentId: "env_1" },
      { type: "host", hostId: "host_box", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    ]);
    assert.doesNotMatch(h.spawned[1]!.prompt, new RegExp(WORKSPACE_MISMATCH));
  }
});

test("start rejects a plan whose commit job names a local path, before any spawn", async () => {
  const h = harness();
  await assert.rejects(h.runner.start(explore([["A", "commit"]], "Your brief is at /Users/me/brief.md."), "thr_origin"), (error: Error & { code?: string }) =>
    error.code === "plan_invalid" && error.message.includes("/Users/me/brief.md"));
  assert.equal(h.spawned.length, 0);
});

test("a judge whose materialized prompt names a local path stays home, and one without leaves", async () => {
  for (const [answer, type] of [["I wrote /tmp/explore/notes.md.", "reuse"], ["It works like this.", "host"]] as const) {
    const h = harness({ homeLimit: 1 });
    await h.runner.start(RunPlan.parse({
      kind: "panel",
      title: "Explore",
      seats: [{ label: "Explorer", model: { tuple: CLAUDE }, prompt: "Explore." }],
      judge: { model: { tuple: CLAUDE }, prompt: "Explain from the findings.", reads: "prompt" },
    }), "thr_origin");
    await h.runner.onIdle(h.worker(1), answer);
    assert.equal(h.spawned[1]!.environment.type, type, answer);
  }
});

test("a remote commit worker at another HEAD fails as transient and its retry runs home", async () => {
  const h = harness({ homeLimit: 1 });
  const { runId } = await h.runner.start(explore([["A", "commit"]]), "thr_origin");
  assert.equal(h.spawned[0]!.environment.hostId, "host_box");
  h.statuses.set(`env_${h.worker(1)}`, checkout({ sha: "beef" }));
  await h.runner.onIdle(h.worker(1), "It works like this.");
  const job = h.runner.view(runId, "thr_origin").jobs[0]!;
  assert.equal(job.state, "queued");
  assert.match(job.error!, /workspace mismatch: the worker's HEAD on box is beef, not the pinned c0ffee/);

  h.clock.now += 1_000;
  await h.runner.tick(runId);
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: "env_1" }, "the retry stays home though home is full");
  assert.doesNotMatch(h.spawned[1]!.prompt, new RegExp(WORKSPACE_MISMATCH));
  await h.runner.onIdle(h.worker(2), "It works like this.");
  assert.deepEqual(h.runner.results(runId, "thr_origin").map((result) => [result.state, result.value]), [["succeeded", "It works like this."]]);
  assert.deepEqual(h.hosts(runId), ["Mac Mini"]);

  const structured = harness({ homeLimit: 1 });
  const review = await structured.runner.start(RunPlan.parse({ kind: "panel", title: "Review", seats: [{ label: "A", model: { tuple: CLAUDE }, prompt: "Review it.", reads: "commit", result: "review" }] }), "thr_origin");
  structured.statuses.set(`env_${structured.worker(1)}`, checkout({ sha: "beef" }));
  const submitted = await structured.runner.submit(structured.worker(1), { findings: [] });
  assert.equal(submitted.ok, false);
  assert.equal(structured.runner.view(review.runId, "thr_origin").jobs[0]!.state, "queued", "pstack_result is not accepted from the wrong HEAD");
});

test("an away spawn that may not have started keeps its machine and is never placed again, across a restart", async () => {
  const h = harness({ homeLimit: 1 });
  h.failures.spawn.push({ error: new Error("socket hang up"), create: false });
  const { runId } = await h.runner.start(explore([["A", "commit"]]), "thr_origin");
  assert.deepEqual([h.runner.view(runId, "thr_origin").jobs[0]!.state, ...h.hosts(runId)], ["uncertain", "box"]);

  const restarted = h.restart();
  h.clock.now += 60_000;
  await restarted.tick(runId);
  assert.equal(h.spawned.length, 1);

  h.threads.set("thr_late", h.thread({ id: "thr_late", status: "idle", metadata: h.spawned[0]!.pluginMetadata, hostId: "host_box" }));
  h.statuses.set("env_thr_late", checkout({ sha: PIN.sha }));
  await restarted.onIdle("thr_late", "It works like this.");
  const view = restarted.view(runId, "thr_origin");
  assert.deepEqual([view.status, view.jobs[0]!.threadId, view.jobs[0]!.host?.name], ["succeeded", "thr_late", "box"]);
  assert.equal(h.spawned.length, 1);
});
