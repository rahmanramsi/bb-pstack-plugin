import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { decide, registerDispatchGuard } from "./dispatch-guard.ts";
import { choose, createPlacement, hostId, REFRESH_MS, type Facts, type Need } from "./placement.ts";

const HOME = hostId.parse("host_hw5y7kzjg8");
const BOX = hostId.parse("host_j3wez3cshx");
const worktreeIntent = (hostId: string, branch: object = { kind: "default" }) =>
  ({ kind: "provider", environmentProviderId: "git-worktree", machine: { type: "existing", hostId }, inputs: { branch } });

// The context bb handed the hook for `bb thread spawn --parent-self --new-environment worktree`.
const thread = { id: "thr_child", parentThreadId: "thr_parent", originPluginId: null, originKind: null, status: "pending", environmentId: null };
const plainSpawn = {
  thread, project: { id: "proj_1" }, environment: null, host: { id: HOME, name: "Vantage Mac Mini" },
  environmentIntent: worktreeIntent(HOME),
  attempt: "start-turn", initiator: "user", senderThreadId: null,
  origin: "cli", originPluginId: null, parentThreadId: "thr_parent", queuedMessages: [],
  requestedExecution: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "low", serviceTier: "default", permissionMode: "full" },
};
type Shape = Omit<typeof plainSpawn, "thread"> & { thread: Record<string, unknown> };
const context = (change: Partial<Record<keyof Shape, unknown>> = {}) => ({ ...plainSpawn, ...change }) as unknown as MessageDispatchHookContext;

const running = (host: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${host}-${i}`, hostId: host }));
const facts = (homeRunning: number): Facts => ({
  hosts: [{ id: HOME, name: "Vantage Mac Mini", connected: true, phase: "active" }, { id: BOX, name: "instabox-agentbb-2", connected: true, phase: "active" }],
  limits: { perHost: new Map([[HOME, 10], [BOX, 4]]), global: null },
  occupancy: { requestedAt: 0, threads: running(HOME, homeRunning) },
  checkouts: new Set([HOME, BOX]),
  worktrees: new Map([[HOME, null], [BOX, null]]), models: new Map([[HOME, null], [BOX, null]]), branches: new Map(),
});
const placed = (homeRunning: number) => (need: Need) => {
  const { target } = choose(facts(homeRunning), [], need, 0);
  return target.where === "away" ? target : null;
};

const rows: { name: string; context: MessageDispatchHookContext; homeRunning?: number; action: MessageDispatchHookDecision["action"] }[] = [
  { name: "an agent's plain worktree spawn onto a full machine", context: context(), action: "reject" },
  { name: "the same spawn re-attempted from the queue", context: context({ queuedMessages: [{ initiator: "user", senderThreadId: null, origin: "cli", originPluginId: null }] }), action: "reject" },
  { name: "an agent's spawn with a named base branch", context: context({ environmentIntent: worktreeIntent(HOME, { kind: "named", name: "release" }) }), action: "reject" },
  { name: "a spawn while its machine has a free slot, even with more room elsewhere", context: context(), homeRunning: 9, action: "proceed" },
  { name: "a message joining a running turn", context: context({ attempt: "join-turn" }), action: "proceed" },
  {
    name: "a follow-up sent to an existing delegate",
    context: context({ initiator: "agent", senderThreadId: "thr_parent", origin: null, environment: { id: "env_1" }, environmentIntent: { kind: "environment", environmentId: "env_1" } }),
    action: "proceed",
  },
  { name: "a fork into a fresh worktree", context: context({ parentThreadId: null, thread: { ...thread, parentThreadId: null, originKind: "fork" } }), action: "proceed" },
  { name: "a fork that keeps a parent", context: context({ thread: { ...thread, originKind: "fork" } }), action: "proceed" },
  { name: "a person starting a thread in the app", context: context({ origin: "app", parentThreadId: null, thread: { ...thread, parentThreadId: null } }), action: "proceed" },
  { name: "a person spawning from a terminal with no parent", context: context({ parentThreadId: null, thread: { ...thread, parentThreadId: null } }), action: "proceed" },
  { name: "a thread pstack spawned", context: context({ origin: "plugin", originPluginId: "pstack", thread: { ...thread, originPluginId: "pstack" } }), action: "proceed" },
  { name: "a thread another plugin spawned", context: context({ origin: "plugin", originPluginId: "other" }), action: "proceed" },
  { name: "a spawn that reuses an environment", context: context({ environment: { id: "env_1" }, environmentIntent: { kind: "environment", environmentId: "env_1" } }), action: "proceed" },
  { name: "a queued spawn that will reuse an environment", context: context({ environmentIntent: { kind: "environment", environmentId: "env_1" } }), action: "proceed" },
  { name: "a spawn into another environment provider", context: context({ environmentIntent: { ...worktreeIntent(HOME), environmentProviderId: "modal-sandbox" } }), action: "proceed" },
  { name: "a spawn onto a new machine", context: context({ environmentIntent: { ...worktreeIntent(HOME), machine: { type: "new", machineProviderId: "instabox", inputs: null } } }), action: "proceed" },
  { name: "a queued group with mixed origins", context: context({ origin: "mixed" }), action: "proceed" },
  { name: "a spawn whose model is not resolved yet", context: context({ requestedExecution: { ...plainSpawn.requestedExecution, model: null } }), action: "proceed" },
];

for (const row of rows) {
  test(`dispatch guard: ${row.name} → ${row.action}`, () => {
    assert.equal(decide(row.context, placed(row.homeRunning ?? 10)).action, row.action);
  });
}

test("the refusal names the full machine, the free one, and both ways to spawn again", () => {
  const decision = decide(context(), placed(10));
  assert.equal(decision.action, "reject");
  const { message } = decision as { message: string };
  assert.match(message, /Vantage Mac Mini has 0 free/);
  assert.match(message, /instabox-agentbb-2 has 4 free/);
  assert.match(message, /`bb pstack spawn`/);
  assert.match(message, /`--machine host_hw5y7kzjg8`/);
});

test("the guard proceeds when placement facts are cold", () => {
  assert.equal(decide(context(), () => null).action, "proceed");
});

function harness(options: { listRunning?: () => Promise<{ id: string; hostId: string | null }[]> } = {}) {
  let hook!: (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision>;
  let service!: { start(signal: AbortSignal): Promise<void> };
  let enabled = true;
  let now = 0;
  const bb = {
    experimental_hooks: { on: (_name: string, handler: typeof hook) => { hook = handler; } },
    background: { service: (_name: string, value: typeof service) => { service = value; } },
    sdk: {
      hosts: { list: async () => facts(0).hosts.map(({ id, name }) => ({ id, name, status: "connected", lifecycle: { phase: "active" } })) },
      threads: { listRunning: options.listRunning ?? (async () => running(HOME, 10)) },
      environments: { listProviders: async () => [{ id: "git-worktree", availability: { status: "available" } }] },
      providers: {
        list: async () => [{ id: "claude-code", available: true }],
        models: async () => ({ models: [{ model: "claude-opus-5-5", supportedReasoningEfforts: [] }] }),
      },
    },
    log: { warn() {} },
  } as unknown as BbPluginApi;
  const placement = createPlacement(bb, {
    clock: () => now,
    exec: async () => JSON.stringify({ globalLimit: null, hosts: [{ id: HOME, effectiveLimit: 10 }, { id: BOX, effectiveLimit: 4 }] }),
  });
  registerDispatchGuard(bb, placement, () => enabled);
  const controller = new AbortController();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    dispatch: (value = context()) => hook(value).then((decision) => decision.action),
    settle,
    async serve() {
      void service.start(controller.signal);
      await settle();
    },
    stop: () => controller.abort(),
    advance: (time: number) => { now = time; },
    setEnabled: (value: boolean) => { enabled = value; },
  };
}

test("a spawn that finds the facts cold proceeds and warms them for the next one", async () => {
  const h = harness();
  assert.equal(await h.dispatch(), "proceed");
  await h.settle();
  assert.equal(await h.dispatch(), "reject");
});

test("the background service keeps the facts warm", async (t) => {
  const h = harness();
  t.after(h.stop);
  await h.dispatch();
  await h.settle();
  h.advance(2 * REFRESH_MS);
  await h.serve();
  assert.equal(await h.dispatch(), "reject");
});

test("the placementGuard setting turns the guard off and on", async () => {
  const h = harness();
  await h.dispatch();
  await h.settle();
  assert.equal(await h.dispatch(), "reject");
  h.setEnabled(false);
  assert.equal(await h.dispatch(), "proceed");
  h.setEnabled(true);
  assert.equal(await h.dispatch(), "reject");
});

test("the guard proceeds when it cannot read occupancy", async () => {
  let fail = false;
  const h = harness({ listRunning: async () => { if (fail) throw new Error("database is locked"); return running(HOME, 10); } });
  await h.dispatch();
  await h.settle();
  assert.equal(await h.dispatch(), "reject");
  fail = true;
  assert.equal(await h.dispatch(), "proceed");
});

test("the guard counts the occupancy it reads at dispatch, not the cached one", async () => {
  let count = 10;
  const h = harness({ listRunning: async () => running(HOME, count) });
  await h.dispatch();
  await h.settle();
  count = 9;
  assert.equal(await h.dispatch(), "proceed");
  count = 10;
  assert.equal(await h.dispatch(), "reject");
});
