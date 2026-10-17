import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { defineCli, type BbPluginApi, type MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { ThreadView } from "./contract.ts";
import type { PotetoDispatch } from "./poteto.ts";
import plugin from "./server.ts";

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let hook: ((context: PotetoDispatch) => MessageDispatchHookDecision) | null = null;
  let instructions: ((context: { threadId: string }) => string | null) | null = null;
  let cli: ReturnType<typeof defineCli> | null = null;
  let view: ((input: { threadId: string }) => Promise<unknown>) | null = null;
  const sends: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0][] = [];
  const publications: unknown[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  const services: string[] = [];
  const timeline: { seq: number; [field: string]: unknown }[] = [];
  type Event = { thread: { id: string; originPluginId: null }; lastAssistantText: string | null };
  const events = new Map<string, ((event: Event) => unknown)[]>();
  const bb = {
    pluginId: "pstack",
    settings: { define: () => ({ get: async () => ({ models: "" }), onChange() {} }) },
    storage: { database: () => db, migrate: (_db: unknown, migrations: string[]) => { for (const migration of migrations) db.exec(migration); } },
    agents: { registerTool() {}, configure() {}, contributeInstructions(provider: typeof instructions) { instructions = provider; } },
    events: { on(name: string, handler: (event: Event) => unknown) { events.set(name, [...events.get(name) ?? [], handler]); } },
    background: { service(name: string) { services.push(name); } },
    experimental_hooks: { on(_name: string, handler: typeof hook) { hook = handler; } },
    hosts: { experimental_client: () => ({}) },
    realtime: { publish(...args: unknown[]) { publications.push(args); } },
    log: { error(message: string) { errors.push(message); } },
    rpc: { register(_contract: unknown, handlers: { pstackThreadView: NonNullable<typeof view> }) { view = handlers.pstackThreadView; } },
    cli: { register(registration: NonNullable<typeof cli>) { cli = registration; } },
    sdk: { threads: {
      events: { async list({ afterSeq, limit }: { afterSeq: string; limit: string }) {
        calls.push("events.list");
        if (Number(limit) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
        return timeline.filter((row) => row.seq > Number(afterSeq)).slice(0, Number(limit));
      } },
      async send(input: typeof sends[number]) { calls.push("send"); sends.push(input); },
      async get() { calls.push("get"); return { id: "thr_old", createdAt: 1 }; },
    } },
  } as unknown as BbPluginApi;
  return {
    bb, sends, publications, calls, errors, services, timeline,
    dispatch(text: string) {
      assert.ok(hook);
      return hook({ thread: { id: "thr_integration", originPluginId: null }, initiator: "user", senderThreadId: null, originPluginId: null,
        input: { text, blocks: [{ type: "text", text, mentions: [] }] } });
    },
    instructions() { assert.ok(instructions); return instructions({ threadId: "thr_integration" }); },
    async emit(name: string) {
      for (const handler of events.get(name) ?? []) await handler({ thread: { id: "thr_integration", originPluginId: null }, lastAssistantText: "Finished." });
    },
    async run(argv: string[]) { assert.ok(cli); return cli.run(argv, { threadId: "thr_integration" }); },
    async view() { assert.ok(view); return ThreadView.parse(await view({ threadId: "thr_integration" })); },
  };
}

test("registered dispatch, lifecycle events, CLI and RPC expose activation, charter delivery and stalled recovery", async (t) => {
  const f = fixture(t);
  await plugin(f.bb);
  assert.deepEqual(await f.dispatch("build /poteto-mode this"), { action: "proceed" });
  assert.deepEqual(await f.dispatch("build /poteto-mode this"), { action: "proceed" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.publications.length, 0);
  assert.equal((await f.view()).poteto, "activated");
  assert.match(f.instructions() ?? "", /checklist begin <playbook>/);
  await f.emit("thread.active");
  assert.equal(f.sends.length, 1);
  for (let count = 0; count < 4; count++) await f.emit("thread.idle");
  assert.deepEqual(f.errors, []);
  assert.equal(f.sends.length, 4);
  assert.equal((await f.view()).poteto, "stalled");
  assert.equal((await f.run(["checklist", "begin", "feature"])).exitCode, 0);
  assert.equal((await f.view()).poteto, "routed");
  assert.ok(f.services.includes("pstack-runner"));
  assert.ok(f.services.includes("pstack-poteto"));
});

test("server evidence validation rejects old threads and unowned runs with recovery instructions", async (t) => {
  const f = fixture(t);
  await plugin(f.bb);
  await f.run(["checklist", "begin", "feature"]);
  const stale = await f.run(["checklist", "done", "1", "--evidence", "thread:thr_old"]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stdout ?? "", /predates this step.*Start fresh work/);
  const wrongOrigin = await f.run(["checklist", "done", "1", "--evidence", "run:psr_12345678-1234-1234-1234-123456789abc"]);
  assert.equal(wrongOrigin.exitCode, 1);
  assert.match(wrongOrigin.stdout ?? "", /not a run started from this thread.*Start a run here/);
});

test("a Codex-wrapped PR create before gate pr holds gate done through the registered server until the user acknowledges it", async (t) => {
  const f = fixture(t);
  await plugin(f.bb);
  assert.deepEqual(await f.dispatch("ship the fix /poteto-mode"), { action: "proceed" });
  await f.emit("thread.active");
  assert.equal((await f.run(["checklist", "begin", "feature"])).exitCode, 0);
  for (const id of [1, 2]) assert.equal((await f.dispatch(`/poteto-mode waive ${id} Grounded in the review.`)).action, "reject");
  const command = '/bin/zsh -lc "gh pr create --repo o/r --base main --head fix --title \\"fix: detect codex\\" --body-file /tmp/pr.md"';
  f.timeline.push({ id: "evt_1", threadId: "thr_integration", seq: 1, createdAt: Date.now(), type: "item/completed",
    data: { item: { type: "commandExecution", id: "codex-pr", command, status: "completed", exitCode: 0 } } });
  let gatePr = await f.run(["gate", "pr"]);
  for (const step of (await f.view()).checklist?.steps ?? []) {
    if (step.status !== "open") continue;
    const evidence = gatePr.exitCode === 0 ? "pr:https://example.com/pull/1" : "path:src/poteto-audit.ts";
    assert.equal((await f.run(["checklist", "done", step.id, "--evidence", evidence])).exitCode, 0);
    if (gatePr.exitCode !== 0) gatePr = await f.run(["gate", "pr"]);
  }
  assert.equal(gatePr.exitCode, 0);
  const held = await f.run(["gate", "done"]);
  assert.equal(held.exitCode, 1);
  assert.match(held.stdout ?? "", /pr-before-gate:codex-pr/);
  await f.emit("thread.idle");
  assert.equal(f.sends.filter((send) => send.input?.some((block) => block.type === "text" && block.text.includes("pr-before-gate:codex-pr"))).length, 1);
  assert.equal((await f.dispatch("/poteto-mode ack pr-before-gate:codex-pr")).action, "reject");
  assert.equal((await f.run(["gate", "done"])).exitCode, 0);
  assert.equal((await f.view()).poteto, "complete");
});
