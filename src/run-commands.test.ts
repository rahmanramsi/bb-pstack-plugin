import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { RunPlan, RunView } from "./contract.ts";
import { createRunFeature } from "./run-commands.ts";
import { RunnerError, type RunId, type Runner } from "./runner.ts";

const RUN = "psr_44444444-4444-4444-4444-444444444444" as RunId;
const PLAN = { kind: "swarm", title: "check.sh", brief: "Run check.sh.", slices: ["packages/api"] };

const VIEW: RunView = {
  id: RUN,
  kind: "swarm",
  title: "check.sh",
  status: "running",
  createdAt: 1,
  finishedAt: null,
  jobs: [
    { key: "slice-1", kind: "slice", label: "packages/api", model: "codex/gpt-6.1-sol/high", state: "succeeded", attempt: 1, threadId: "thr_w1", startedAt: 1, finishedAt: 2, error: null, summary: "PASS", slice: "packages/api" },
    { key: "verify-1", kind: "verifier", label: "Verify packages/api", model: "codex/gpt-6.1-sol/high", state: "running", attempt: 1, threadId: "thr_w2", startedAt: 2, finishedAt: null, error: null, summary: null, slice: "packages/api" },
  ],
  findings: [],
  matrix: null,
};

function harness(options: { existing?: boolean; startError?: Error } = {}) {
  const started: { plan: RunPlan; threadId: string }[] = [];
  const submitted: { threadId: string; value: unknown }[] = [];
  const reads: { hostId?: string; path: string }[] = [];
  const handlers = new Map<string, (payload: any) => unknown>();
  const tools: Record<string, any>[] = [];
  let configure: ((context: any) => any) | null = null;
  const services: string[] = [];
  const observed: string[] = [];

  const runner = {
    async start(plan: RunPlan, threadId: string) {
      if (options.startError) throw options.startError;
      started.push({ plan, threadId });
      return { runId: RUN, existing: options.existing ?? false };
    },
    async stop(id: RunId) {
      return id === RUN;
    },
    async submit(threadId: string, value: unknown) {
      submitted.push({ threadId, value });
      return value === "bad" ? { ok: false as const, error: "status: expected PASS" } : { ok: true as const };
    },
    view(id: RunId, threadId: string) {
      if (threadId !== "thr_origin") throw new RunnerError("run_not_found", `no run ${id} on this thread`);
      return VIEW;
    },
    results: () => [{ key: "slice-1", kind: "slice" as const, label: "packages/api", state: "succeeded" as const, value: { status: "PASS" }, error: null }],
    activeRuns: () => [RUN],
    workerResult: (threadId: string) => (threadId === "thr_w1" ? ("report" as const) : threadId === "thr_text" ? ("text" as const) : null),
    async onIdle(threadId: string) {
      observed.push(`idle:${threadId}`);
    },
    async onFailed(threadId: string) {
      observed.push(`failed:${threadId}`);
    },
    async onGone(threadId: string) {
      observed.push(`gone:${threadId}`);
    },
    async tick() {},
    async serve() {},
  } satisfies Runner;

  const bb = {
    pluginId: "pstack",
    sdk: {
      threads: { get: async () => ({ environmentId: "env_1" }) },
      environments: { get: async () => ({ hostId: "host_laptop" }) },
      files: {
        async read(args: { hostId?: string; path: string }) {
          reads.push(args);
          if (args.path.endsWith("missing.json")) throw new Error("ENOENT");
          return { content: Buffer.from(JSON.stringify(PLAN)).toString("base64"), contentEncoding: "base64" };
        },
      },
    },
    agents: {
      registerTool: (tool: Record<string, any>) => tools.push(tool),
      configure: (provider: (context: any) => any) => (configure = provider),
    },
    events: { on: (event: string, handler: (payload: any) => unknown) => handlers.set(event, handler) },
    background: { service: (name: string) => services.push(name) },
    log: { error() {}, warn() {} },
  } as unknown as BbPluginApi;

  const feature = createRunFeature({ bb, runner, isRunWorker: (id) => id === "thr_w1", footer: (threadId) => `Open steps for ${threadId}: 2`, skills: ["poteto-mode", "swarm"] });
  const cli = defineCli({ name: "pstack", summary: "pstack", commands: feature.commands });
  const run = (argv: string[], ctx: { threadId?: string; cwd?: string } = { threadId: "thr_origin", cwd: "/work/repo" }) => cli.run(argv, ctx);
  return { feature, run, started, submitted, reads, handlers, tools, services, observed, configure: () => configure! };
}

test("run start --plan-json prints the run id, a summary, the directive on its own line, then the footer", async () => {
  const h = harness();
  const result = await h.run(["run", "start", "--plan-json", JSON.stringify(PLAN)]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout!.split("\n"), [
    RUN,
    'Started swarm "check.sh" with 1 slice, 1 verifier. One agent-only message arrives when it finishes.',
    `::pstack-run{run="${RUN}"}`,
    "Open steps for thr_origin: 2",
    "",
  ]);
  assert.equal(h.started[0]!.threadId, "thr_origin");
  assert.deepEqual(h.started[0]!.plan, { ...PLAN, model: { role: "swarm workers" } });

  const json = await h.run(["run", "start", "--plan-json", JSON.stringify(PLAN), "--json"]);
  const parsed = JSON.parse(json.stdout!);
  assert.deepEqual(parsed, { runId: RUN, existing: false, status: "running", directive: `::pstack-run{run="${RUN}"}` });
});

test("run start --file reads the plan on the invoking thread's host, resolving a relative path", async () => {
  const h = harness();
  const result = await h.run(["run", "start", "--file", "plan.json"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(h.reads, [{ hostId: "host_laptop", path: "/work/repo/plan.json" }]);
  assert.equal(h.started.length, 1);

  const missing = await h.run(["run", "start", "--file", "/tmp/missing.json", "--json"]);
  assert.equal(missing.exitCode, 1);
  assert.equal(JSON.parse(missing.stdout!).error.code, "plan_file_unreadable");
});

test("run start reports an existing run for a repeated request key", async () => {
  const h = harness({ existing: true });
  const result = await h.run(["run", "start", "--plan-json", JSON.stringify(PLAN)]);
  assert.match(result.stdout!.split("\n")[1]!, /^Already started: swarm "check\.sh" .*, running\.$/);
});

test("run start rejects a malformed plan, a plan the runner refuses, and a missing thread", async () => {
  const code = async (argv: string[], h = harness(), ctx?: { threadId?: string }) => {
    const result = await h.run([...argv, "--json"], ctx);
    assert.equal(result.exitCode, 1);
    return JSON.parse(result.stdout!).error.code;
  };
  assert.equal(await code(["run", "start", "--plan-json", "{"]), "plan_invalid");
  assert.equal(await code(["run", "start", "--plan-json", JSON.stringify({ ...PLAN, slices: [] })]), "plan_invalid");
  assert.equal(
    await code(["run", "start", "--plan-json", JSON.stringify(PLAN)], harness({ startError: new RunnerError("plan_invalid", 'unknown role "nope"') })),
    "plan_invalid",
  );
  assert.equal(await code(["run", "start", "--plan-json", JSON.stringify(PLAN)], harness(), {}), "thread_required");
  assert.equal((await harness().run(["run", "start"])).exitCode, 1, "needs --file or --plan-json");
});

test("run status prints jobs and results, or JSON with both", async () => {
  const h = harness();
  const text = await h.run(["run", "status", RUN]);
  assert.match(text.stdout!, /^psr_\S+ swarm "check\.sh": running\n  packages\/api\s+succeeded\s+codex\/gpt-6\.1-sol\/high\s+thr_w1\s+PASS/);
  assert.match(text.stdout!, /## packages\/api\n\n\{\n {2}"status": "PASS"\n\}/);
  const json = await h.run(["run", "status", RUN, "--json"]);
  const parsed = JSON.parse(json.stdout!);
  assert.equal(parsed.jobs.length, 2);
  assert.deepEqual(parsed.results[0].value, { status: "PASS" });

  const other = await h.run(["run", "status", RUN, "--json"], { threadId: "thr_other" });
  assert.equal(JSON.parse(other.stdout!).error.code, "run_not_found");
  const bad = await h.run(["run", "status", "psr_nope", "--json"]);
  assert.equal(JSON.parse(bad.stdout!).error.code, "invalid_run_id");
});

test("run stop reports whether it stopped the run", async () => {
  const h = harness();
  assert.match((await h.run(["run", "stop", RUN])).stdout!, new RegExp(`^Stopped ${RUN}\\.`));
  const other = "psr_55555555-5555-5555-5555-555555555555";
  assert.match((await h.run(["run", "stop", other])).stdout!, /already finished: running/);
});

test("register exposes pstack_result only to structured workers, wires events, and starts the service", async () => {
  const h = harness();
  h.feature.register();
  const configure = h.configure();
  const select = (threadId: string) => configure({ thread: { id: threadId }, pluginMetadata: {} });

  assert.deepEqual(select("thr_origin"), { tools: [], skills: ["poteto-mode", "swarm"] });
  assert.deepEqual(select("thr_text"), { tools: [], skills: ["poteto-mode", "swarm"] });
  const worker = select("thr_w1");
  assert.equal(worker.tools[0].name, "pstack_result");
  assert.deepEqual(worker.tools[0].parameters.required, ["value"]);
  assert.deepEqual(worker.tools[0].parameters.properties.value.properties.status.enum, ["PASS", "ISSUES", "BLOCKED"]);

  const tool = h.tools.find((candidate) => candidate.name === "pstack_result")!;
  assert.equal(typeof (await tool.execute({ value: { status: "PASS" } }, { threadId: "thr_w1" })), "string");
  assert.deepEqual(await tool.execute({ value: "bad" }, { threadId: "thr_w1" }), { content: [{ type: "text", text: "status: expected PASS" }], isError: true });
  assert.deepEqual(h.submitted.map((entry) => entry.threadId), ["thr_w1", "thr_w1"]);

  await h.handlers.get("thread.idle")!({ thread: { id: "thr_w1", originPluginId: "pstack" }, lastAssistantText: "done" });
  await h.handlers.get("thread.idle")!({ thread: { id: "thr_user", originPluginId: null }, lastAssistantText: "hi" });
  await h.handlers.get("thread.failed")!({ thread: { id: "thr_w1", originPluginId: "pstack" }, error: "boom" });
  await h.handlers.get("thread.idle")!({ thread: { id: "thr_delegate", originPluginId: "pstack" }, lastAssistantText: "done" });
  await h.handlers.get("thread.failed")!({ thread: { id: "thr_delegate", originPluginId: "pstack" }, error: "boom" });
  await h.handlers.get("thread.archived")!({ thread: { id: "thr_origin" } });
  await h.handlers.get("thread.deleted")!({ thread: { id: "thr_w2" } });
  assert.deepEqual(h.observed, ["idle:thr_w1", "failed:thr_w1", "gone:thr_origin", "gone:thr_w2"]);
  assert.deepEqual(h.services, ["pstack-runner"]);
  assert.equal(h.feature.activeRuns("thr_origin"), 1);
});
