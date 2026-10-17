import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { choose, createPlacement, HOLD_GRACE_MS, hostId, type Facts, type Hold, type Need, type Target } from "./placement.ts";

const HOME = hostId.parse("local");
const BOX = hostId.parse("box");
const need: Need = {
  projectId: "project", home: { kind: "worktree", hostId: HOME, baseBranch: null },
  away: { kind: "worktree", baseBranch: null, pin: null }, affinity: "spread", model: "codex/m",
};
const threads = (host: string | null, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${host}-${i}`, hostId: host }));
function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    hosts: [HOME, BOX].map((id) => ({ id, name: id, connected: true, phase: "active" })),
    limits: { perHost: new Map([[HOME, 4], [BOX, 4]]), global: null },
    occupancy: { requestedAt: 0, threads: [] },
    worktrees: new Map([[HOME, null], [BOX, null]]), models: new Map([[HOME, null], [BOX, null]]), branches: new Map(),
    ...overrides,
  };
}
const pick = (value: Facts, holds: Hold[] = [], request = need, now = 0) => choose(value, holds, request, now);

test("a full home is skipped for one with room", () => {
  const result = pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 4) } }));
  assert.equal(result.target.hostId, BOX);
  assert.equal(result.board.hosts[0].blocker, "full (4/4)");
  assert.deepEqual(result.target.environment, { type: "host", hostId: BOX, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
});

test("starting threads count on their intended host without an attached environment", () => {
  const result = pick(facts({ occupancy: { requestedAt: 0, threads: [{ id: "starting-1", hostId: HOME }, ...threads(HOME, 3)] } }));
  assert.equal(result.target.hostId, BOX);
  assert.equal(result.board.hosts[0].running, 4);
});

test("several spawns spread by remaining room", () => {
  const value = facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 2) } });
  const holds: Hold[] = [];
  const picks = Array.from({ length: 4 }, () => {
    const result = pick(value, holds);
    holds.push({ hostId: result.target.hostId, threadId: null, settledAt: null });
    return result.target.hostId;
  });
  assert.deepEqual(picks.sort(), [BOX, BOX, BOX, HOME].sort());
});

test("away hosts require this project's worktree and requested model", () => {
  for (const change of [
    { worktrees: new Map([[BOX, "no checkout"]]) },
    { models: new Map([[BOX, "codex has no m"]]) },
    { worktrees: new Map() },
    { models: new Map() },
  ]) {
    const result = pick(facts({ ...change, occupancy: { requestedAt: 0, threads: threads(HOME, 4) } }));
    assert.equal(result.target.where, "home");
    assert.notEqual(result.board.hosts[1].blocker, null);
    assert.equal(result.board.next, null);
  }
});

test("offline and suspended machines are not away candidates", () => {
  for (const host of [
    { id: BOX, name: BOX, connected: false, phase: "active" },
    { id: BOX, name: BOX, connected: true, phase: "suspended" },
  ]) {
    const result = pick(facts({ hosts: [host], occupancy: { requestedAt: 0, threads: threads(HOME, 4) } }));
    assert.equal(result.target.where, "home");
    assert.match(result.board.hosts[0].blocker!, /disconnected|suspended/);
  }
});

test("pinned requests exclude every away host even when home is full", () => {
  const result = pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 4) } }), [], { ...need, away: null });
  assert.equal(result.target.where, "home");
  assert.equal(result.board.hosts[1].blocker, "pinned to home");
});

test("the global limit caps picks even when machines have room", () => {
  const value = facts({ limits: { perHost: new Map([[HOME, 4], [BOX, 4]]), global: 2 }, occupancy: { requestedAt: 0, threads: threads(HOME, 1) } });
  const first = pick(value);
  assert.equal(first.target.hostId, BOX);
  assert.equal(first.board.hosts[1].free, 4);
  const next = pick(value, [{ hostId: BOX, threadId: null, settledAt: null }]);
  assert.equal(next.board.next, null);
  assert.equal(next.target.where, "home");
  assert.equal(next.board.global.running, 2);
});

test("unattributed and duplicate running rows count globally by identity", () => {
  const result = pick(facts({ limits: { perHost: new Map([[HOME, 4], [BOX, 4]]), global: 1 }, occupancy: { requestedAt: 0, threads: [{ id: "starting", hostId: null }, { id: "starting", hostId: null }] } }));
  assert.equal(result.board.global.running, 1);
  assert.equal(result.board.next, null);
});

test("a bound hold already in listRunning is counted once", () => {
  const result = pick(facts({ occupancy: { requestedAt: 0, threads: [{ id: "worker", hostId: BOX }] } }), [{ hostId: BOX, threadId: "worker", settledAt: 0 }]);
  assert.equal(result.board.hosts[1].running, 1);
  assert.equal(result.board.hosts[1].held, 0);
  assert.equal(result.board.global.running, 1);
});

test("unbound and not-yet-visible bound holds count, settled holds expire after 60 seconds", () => {
  const holds: Hold[] = [
    { hostId: BOX, threadId: null, settledAt: null },
    { hostId: BOX, threadId: "new", settledAt: 0 },
    { hostId: HOME, threadId: null, settledAt: 0 },
  ];
  assert.deepEqual(pick(facts(), holds).board.hosts.map((row) => row.held), [1, 2]);
  assert.deepEqual(pick(facts(), holds, need, HOLD_GRACE_MS).board.hosts.map((row) => row.held), [0, 1]);
});

test("home affinity stays while home has room and leaves when it is full", () => {
  const request: Need = { ...need, affinity: "home" };
  assert.equal(pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 3) } }), [], request).target.where, "home");
  assert.equal(pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 4) } }), [], request).target.where, "away");
});

test("spread affinity picks most free slots and home wins ties", () => {
  assert.equal(pick(facts()).target.where, "home");
  assert.equal(pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 1) } })).target.where, "away");
});

test("an unknown-limit host is never away and unreadable limits keep home", () => {
  assert.equal(pick(facts({ limits: { perHost: new Map([[HOME, 0]]), global: null } })).target.where, "home");
  assert.equal(pick(facts({ limits: null })).target.where, "home");
  assert.match(pick(facts({ limits: { perHost: new Map([[HOME, 0]]), global: null } })).board.hosts[1].blocker!, /unknown/);
});

test("personal away targets need no worktree and reuse home preserves the environment", () => {
  const request: Need = { ...need, home: { kind: "reuse", environmentId: "env", hostId: HOME }, away: { kind: "personal" }, affinity: "home" };
  assert.deepEqual(pick(facts(), [], request).target.environment, { type: "reuse", environmentId: "env" });
  assert.deepEqual(pick(facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 4) }, worktrees: new Map() }), [], request).target.environment, { type: "host", hostId: BOX, workspace: { type: "personal" } });
});

test("a pinned branch must be verified at the requested SHA", () => {
  const request: Need = { ...need, away: { kind: "worktree", baseBranch: "main", pin: { branch: "main", sha: "abc" } } };
  const value = facts({ occupancy: { requestedAt: 0, threads: threads(HOME, 4) } });
  assert.equal(pick(value, [], request).target.where, "home");
  assert.equal(pick({ ...value, branches: new Map([[BOX, { name: "main", sha: "other" }]]) }, [], request).target.where, "home");
  assert.equal(pick({ ...value, branches: new Map([[BOX, { name: "main", sha: "abc" }]]) }, [], request).target.where, "away");
});

function service(options: { badLimits?: boolean } = {}) {
  let now = 0;
  let rows: { id: string; hostId: string | null }[] = threads(HOME, 4);
  const execCalls: { file: string; args: readonly string[] }[] = [];
  const routes: unknown[] = [];
  const bb = {
    sdk: {
      hosts: { list: async () => [HOME, BOX].map((id) => ({ id, name: id, status: "connected", lifecycle: { phase: "active" } })) },
      threads: { listRunning: async () => rows },
      environments: { listProviders: async () => [{ id: "git-worktree", availability: { status: "available" } }] },
      providers: {
        list: async (route: unknown) => { routes.push(route); return [{ id: "codex", available: true }]; },
        models: async () => ({ models: [{ model: "m", supportedReasoningEfforts: [] }] }),
      },
    },
    log: { warn() {} },
  } as unknown as BbPluginApi;
  const placement = createPlacement(bb, {
    clock: () => now,
    exec: async (file, args) => {
      execCalls.push({ file, args });
      return options.badLimits ? '{"hosts": "invalid"}' : JSON.stringify({ hosts: [{ id: HOME, effectiveLimit: 4 }, { id: BOX, effectiveLimit: 1 }], globalLimit: null });
    },
  });
  return { placement, execCalls, routes, advance: (time: number) => { now = time; }, running: (threads: typeof rows) => { rows = threads; } };
}

test("concurrent place calls cannot both take the last away slot", async () => {
  const h = service();
  const targets: Target[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = h.placement.place(need, async (target) => { targets.push(target); await blocked; return "thread-one"; });
  const second = h.placement.place(need, async (target) => { targets.push(target); return "thread-two"; });
  await second;
  release();
  await first;
  assert.deepEqual(targets.map((target) => target.where), ["away", "home"]);
  assert.deepEqual(h.execCalls, [{ file: process.env.BB_CLI || "bb", args: ["concurrency-limit", "status", "--json"] }]);
  assert.deepEqual(h.routes, [{ hostId: HOME }, { hostId: BOX }]);
});

test("a spawn returning null releases its hold, a thrown spawn holds capacity for 60 seconds", async () => {
  const h = service();
  await h.placement.place(need, async () => null);
  assert.equal((await h.placement.board(need)).hosts[1].held, 0);
  await assert.rejects(h.placement.place(need, async () => { throw new Error("spawn uncertain"); }), /uncertain/);
  assert.equal((await h.placement.board(need)).hosts[1].held, 1);
  h.advance(HOLD_GRACE_MS);
  assert.equal((await h.placement.board(need)).hosts[1].held, 0);
});

test("a fresh occupancy read replaces bound holds without counting twice", async () => {
  const h = service();
  await h.placement.place(need, async () => "new-worker");
  h.running([...threads(HOME, 4), { id: "new-worker", hostId: BOX }]);
  const board = await h.placement.board(need);
  assert.deepEqual([board.hosts[1].running, board.hosts[1].held], [1, 0]);
  assert.equal(board.global.running, 5);
});

test("wouldMove uses only warm facts and fresh supplied occupancy, and expires", async () => {
  const h = service();
  const occupancy = { requestedAt: 0, threads: threads(HOME, 4) };
  assert.equal(h.placement.wouldMove(need, occupancy), null);
  await h.placement.board(need);
  assert.equal(h.placement.wouldMove(need, occupancy)?.hostId, BOX);
  h.advance(30_000);
  assert.equal(h.placement.wouldMove(need, occupancy), null);
});

test("malformed external limit data falls back home", async () => {
  const h = service({ badLimits: true });
  const result = await h.placement.place(need, async () => "worker");
  assert.equal(result.target.where, "home");
  assert.match(result.target.why, /unknown/);
});
