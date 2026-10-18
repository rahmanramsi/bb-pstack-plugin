import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { loadCatalog } from "./doctor.ts";

export type HostId = string & { readonly __brand: "HostId" };
export const hostId = z.string().min(1).transform((value) => value as HostId);
type CreateThreadEnvironmentArgs = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"]>;

export interface Need {
  projectId: string | null;
  home: Home;
  away: Away | null;
  affinity: "home" | "spread";
  model: string | null;
}
export type Home =
  | { kind: "reuse"; environmentId: string; hostId: HostId }
  | { kind: "worktree"; hostId: HostId; baseBranch: string | null };
export type Away = { kind: "worktree"; baseBranch: string | null; pin: { sha: string; branch: string } | null };
export interface Target {
  hostId: HostId;
  hostName: string;
  where: "home" | "away";
  environment: CreateThreadEnvironmentArgs;
  why: string;
}
export interface HostRow {
  id: HostId;
  name: string;
  running: number;
  held: number;
  limit: number | null;
  free: number;
  blocker: string | null;
  /** Eligible except that it has no checkout of the project, so a clone would open it up. */
  onlyNeedsCheckout: boolean;
}
export interface Board {
  hosts: HostRow[];
  global: { running: number; limit: number | null };
  next: HostId | null;
}
export interface Occupancy {
  requestedAt: number;
  threads: readonly { id: string; hostId: string | null }[];
}
export interface Hold {
  hostId: HostId;
  threadId: string | null;
  settledAt: number | null;
}
export interface Facts {
  hosts: readonly { id: HostId; name: string; connected: boolean; phase: string }[];
  limits: { perHost: ReadonlyMap<HostId, number>; global: number | null } | null;
  occupancy: Occupancy;
  /** Hosts with a source of the project; null when unknown. */
  checkouts: ReadonlySet<HostId> | null;
  worktrees: ReadonlyMap<HostId, string | null>;
  models: ReadonlyMap<HostId, string | null>;
  branches: ReadonlyMap<HostId, { name: string; sha: string | null }>;
}
export const HOLD_GRACE_MS = 60_000;
export const NO_CHECKOUT = "no checkout of this project";
const FACT_TTL_MS = 30_000;
export const REFRESH_MS = 30_000;
const WARM_MS = 2 * REFRESH_MS;
const WATCH_MS = 10 * 60_000;

function environment(home: Home | Away, id: HostId): CreateThreadEnvironmentArgs {
  if (home.kind === "reuse") return { type: "reuse", environmentId: home.environmentId };
  const baseBranch = "pin" in home && home.pin ? home.pin.branch : home.baseBranch;
  return {
    type: "host", hostId: id,
    workspace: { type: "managed-worktree", baseBranch: baseBranch === null ? { kind: "default" } : { kind: "named", name: baseBranch } },
  };
}

/** One host's row before ranking. `ineligible` is the blocker without capacity, which only ranks a host for pickHost. */
type Row = HostRow & { ineligible: string | null; headroom: number };

/**
 * The per-host rows choose() and pickHost() share. With `home` null no host is exempt from the checkout and model checks.
 * `headroom` is limit − running − held without the floor at 0, so a full fleet keeps spreading instead of piling onto
 * the first host by name.
 */
function hostRows(facts: Facts, holds: readonly Hold[], need: Pick<Need, "away" | "model">, home: HostId | null, now: number) {
  const running = new Map(facts.occupancy.threads.map((thread) => [thread.id, thread.hostId]));
  const bound = new Set(running.keys());
  const extra = holds.filter((hold) => {
    if (hold.settledAt !== null && now - hold.settledAt >= HOLD_GRACE_MS) return false;
    if (hold.threadId === null) return true;
    if (bound.has(hold.threadId)) return false;
    bound.add(hold.threadId);
    return true;
  });
  const globalRunning = running.size + extra.length;
  const globalLimit = facts.limits?.global ?? null;
  const globalFree = globalLimit === null ? Infinity : Math.max(0, globalLimit - globalRunning);
  const hosts = [...facts.hosts];
  if (home !== null && !hosts.some((host) => host.id === home)) {
    hosts.push({ id: home, name: home, connected: false, phase: "unknown" });
  }
  const rows = hosts.map((host): Row => {
    const used = [...running.values()].filter((id) => id === host.id).length;
    const held = extra.filter((hold) => hold.hostId === host.id).length;
    const limit = facts.limits?.perHost.get(host.id) ?? null;
    const free = limit === null ? 0 : Math.max(0, limit - used - held);
    const isHome = host.id === home;
    const reach = !host.connected ? "disconnected"
      : host.phase !== "active" ? `phase ${host.phase}`
      : limit === null ? "unknown concurrency limit"
      : !isHome && need.away === null ? "pinned to home"
      : null;
    let checkout: string | null = null;
    if (!isHome && need.away !== null) {
      if (facts.checkouts !== null && !facts.checkouts.has(host.id)) checkout = NO_CHECKOUT;
      else {
        checkout = facts.worktrees.has(host.id) ? facts.worktrees.get(host.id)! : "worktree readiness unknown";
        const pin = need.away.pin;
        if (checkout === null && pin) {
          const branch = facts.branches.get(host.id);
          if (branch?.name !== pin.branch || branch.sha !== pin.sha) checkout = `branch ${pin.branch} is not verified at ${pin.sha}`;
        }
      }
    }
    const model = !isHome && need.model !== null ? facts.models.has(host.id) ? facts.models.get(host.id)! : "model catalog unknown" : null;
    const capacity = model
      ?? (globalFree === 0 ? "global limit reached" : null)
      ?? (free === 0 ? `full (${used + held}/${limit})` : null);
    const blocker = reach ?? checkout ?? capacity;
    const onlyNeedsCheckout = reach === null && checkout === NO_CHECKOUT && capacity === null;
    const headroom = limit === null ? -Infinity : limit - used - held;
    return { id: host.id, name: host.name, running: used, held, limit, free, blocker, onlyNeedsCheckout, ineligible: reach ?? checkout ?? model, headroom };
  });
  return { rows, global: { running: globalRunning, limit: globalLimit }, globalFree };
}

export function choose(facts: Facts, holds: readonly Hold[], need: Need, now: number): { target: Target; board: Board } {
  const { rows, global, globalFree } = hostRows(facts, holds, need, need.home.hostId, now);
  const home = rows.find((row) => row.id === need.home.hostId)!;
  const away = rows.filter((row) => row.id !== home.id && row.blocker === null)
    .sort((a, b) => b.free - a.free || b.free / b.limit! - a.free / a.limit! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
  const move = need.away !== null && facts.limits !== null && home.limit !== null && globalFree > 0 && away &&
    (need.affinity === "home" ? home.free === 0 : away.free > home.free);
  const picked = move ? away : home;
  const where = picked.id === home.id ? "home" : "away";
  const why = need.away === null ? `pinned to ${home.name}`
    : facts.limits === null || home.limit === null ? `${home.name}; concurrency limits unknown, staying home`
    : where === "away" ? `${home.name} has ${home.free} free; ${picked.name} has ${picked.free} free`
    : home.free > 0 ? `${home.name} has ${home.free} free`
    : `${home.name}; no eligible free slot, bb will queue the thread`;
  return {
    target: { hostId: picked.id, hostName: picked.name, where, environment: environment(where === "away" && need.away ? need.away : need.home, picked.id), why },
    board: { hosts: rows.map(({ ineligible: _, headroom: __, ...row }) => row), global, next: picked.blocker === null ? picked.id : null },
  };
}

/** A fresh worktree of the project's default checkout, on any host that has one. */
const ANY_WORKTREE: Away = { kind: "worktree", baseBranch: null, pin: null };

export type HostPick = { hostId: HostId } | { hostId: null; why: string };

/**
 * The host for a worker that may run anywhere: connected, active, with a known limit, a ready worktree of the project
 * and the model in its catalog, and not in `exclude`. A full host stays eligible, since bb queues the thread; capacity
 * only ranks: most headroom, then free ratio, then name and id. With no eligible host, `why` names each host's first
 * problem.
 */
export function pickHost(facts: Facts, holds: readonly Hold[], need: { model: string }, exclude: ReadonlyMap<HostId, string>, now: number): HostPick {
  const { rows } = hostRows(facts, holds, { away: ANY_WORKTREE, model: need.model }, null, now);
  const problem = (row: Row) => exclude.get(row.id) ?? row.ineligible;
  const ratio = (row: Row) => (row.limit ? row.headroom / row.limit : -Infinity);
  const [best] = rows.filter((row) => problem(row) === null)
    .sort((a, b) => b.headroom - a.headroom || ratio(b) - ratio(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (best) return { hostId: best.id };
  if (rows.length === 0) return { hostId: null, why: "bb lists no machine" };
  return { hostId: null, why: `no machine is eligible: ${rows.map((row) => `${row.name}: ${problem(row)}`).join("; ")}` };
}

export type ExecLimits = (file: string, args: readonly string[]) => Promise<string>;
const execAsync = promisify(execFile);
const execLimits: ExecLimits = async (file, args) => (await execAsync(file, [...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const limit = z.number().int().nonnegative().safe();
const LimitsStatus = z.object({
  globalLimit: limit.nullable(),
  hosts: z.array(z.object({ id: hostId, effectiveLimit: limit.nullable() })),
});

/** What factsFor reads from a Need. `level`, when set, must also be in the host's catalog for `model`. */
type FactQuery = Pick<Need, "projectId" | "away" | "model"> & { level?: string };

export interface Placement {
  place(need: Need, issue: (target: Target) => Promise<string | null>): Promise<{ target: Target; threadId: string | null; board: Board }>;
  board(need: Need): Promise<Board>;
  wouldMove(need: Need, occupancy: Occupancy): Target | null;
  /** Reloads facts for every need wouldMove was asked about in the last ten minutes. */
  refresh(): Promise<void>;
  /** Fresh facts for a worker on any host with a worktree of `projectId` and `provider/model` at `level`, for pickHost. */
  facts(query: { projectId: string; model: string; level: string }): Promise<Facts>;
}

export function createPlacement(bb: BbPluginApi, deps: { exec?: ExecLimits; clock?: () => number } = {}): Placement {
  const clock = deps.clock ?? Date.now;
  const exec = deps.exec ?? execLimits;
  const holds: Hold[] = [];
  const cache = new Map<string, { at: number; facts: Facts }>();
  const loading = new Map<string, Promise<Facts>>();
  let limitsCache: { at: number; value: Facts["limits"] } | null = null;
  let limitsPending: Promise<Facts["limits"]> | null = null;
  let occupancyPending: Promise<Occupancy> | null = null;
  const watched = new Map<string, { need: Need; at: number }>();
  const key = (need: FactQuery) => JSON.stringify([need.projectId, need.away && { kind: need.away.kind, pin: need.away.pin }, need.model, need.level ?? null]);

  async function limits(force = false): Promise<Facts["limits"]> {
    if (!force && limitsCache && clock() - limitsCache.at < FACT_TTL_MS) return limitsCache.value;
    if (limitsPending) return limitsPending;
    limitsPending = (async () => {
      let value: Facts["limits"] = null;
      try {
        const parsed = LimitsStatus.parse(JSON.parse(await exec(process.env.BB_CLI || "bb", ["concurrency-limit", "status", "--json"])));
        value = { global: parsed.globalLimit, perHost: new Map(parsed.hosts.flatMap((host) => host.effectiveLimit === null ? [] : [[host.id, host.effectiveLimit]])) };
      } catch (error) {
        bb.log.warn(`pstack placement limits unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      limitsCache = { at: clock(), value };
      return value;
    })().finally(() => { limitsPending = null; });
    return limitsPending;
  }

  function occupancy(): Promise<Occupancy> {
    if (occupancyPending) return occupancyPending;
    const requestedAt = clock();
    occupancyPending = bb.sdk.threads.listRunning().then((threads) => ({ requestedAt, threads }))
      .finally(() => { occupancyPending = null; });
    return occupancyPending;
  }

  async function sources(need: FactQuery): Promise<Set<HostId> | null> {
    if (!need.projectId || need.away === null) return null;
    try { return new Set((await bb.sdk.projects.get({ projectId: need.projectId })).sources.map((source) => hostId.parse(source.hostId))); }
    catch (error) {
      bb.log.warn(`pstack placement checkouts unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function factsFor(need: FactQuery, force = false): Promise<Facts> {
    const id = key(need);
    const cached = cache.get(id);
    if (!force && cached && clock() - cached.at < FACT_TTL_MS) return cached.facts;
    const pending = loading.get(id);
    if (pending) return pending;
    const promise = (async (): Promise<Facts> => {
      const [hosts, capacity, checkouts] = await Promise.all([bb.sdk.hosts.list(), limits(force), sources(need)]);
      const facts: Facts = {
        hosts: hosts.map((host) => ({ id: hostId.parse(host.id), name: host.name, connected: host.status === "connected", phase: host.lifecycle.phase })),
        limits: capacity, occupancy: { requestedAt: clock(), threads: [] },
        checkouts, worktrees: new Map(), models: new Map(), branches: new Map(),
      };
      const worktrees = new Map<HostId, string | null>();
      const models = new Map<HostId, string | null>();
      const branches = new Map<HostId, { name: string; sha: string | null }>();
      await Promise.all(facts.hosts.filter((host) => host.connected && host.phase === "active").map(async (host) => {
        if (need.projectId && need.away?.kind === "worktree" && (checkouts === null || checkouts.has(host.id))) {
          try {
            const providers = await bb.sdk.environments.listProviders({ projectId: need.projectId, hostId: host.id });
            const provider = providers.find((entry) => entry.id === "git-worktree");
            worktrees.set(host.id, provider?.availability?.status === "available" ? null : provider?.availability?.message ?? "no checkout with an available worktree provider");
            if (need.away.pin) {
              const result = await bb.sdk.projects.branches({ projectId: need.projectId, hostId: host.id, selectedBranch: need.away.pin.branch });
              if (result.checkout.kind === "branch") branches.set(host.id, { name: result.checkout.branchName, sha: result.checkout.headSha });
            }
          } catch (error) { worktrees.set(host.id, `worktree unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (need.model) {
          const slash = need.model.indexOf("/");
          const provider = need.model.slice(0, slash);
          const model = need.model.slice(slash + 1);
          try {
            const entry = (await loadCatalog(bb, { hostId: host.id }, [provider])).get(provider);
            const listed = entry?.state === "ok" && entry.models.some((item) => item.model === model && (need.level === undefined || item.levels.includes(need.level)));
            models.set(host.id, listed ? null : `${need.level === undefined ? need.model : `${need.model}/${need.level}`} unavailable`);
          } catch (error) { models.set(host.id, `model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }));
      const result = { ...facts, worktrees, models, branches };
      cache.set(id, { at: clock(), facts: result });
      return result;
    })().catch((error): Facts => {
      bb.log.warn(`pstack placement facts unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return { hosts: [], limits: null, occupancy: { requestedAt: clock(), threads: [] }, checkouts: null, worktrees: new Map(), models: new Map(), branches: new Map() };
    }).finally(() => { loading.delete(id); });
    loading.set(id, promise);
    return promise;
  }

  async function fresh(need: FactQuery): Promise<Facts> {
    const facts = await factsFor(need);
    try { return { ...facts, occupancy: await occupancy() }; }
    catch { return { ...facts, limits: null }; }
  }

  return {
    async place(need, issue) {
      const facts = await fresh(need);
      const now = clock();
      for (let i = holds.length - 1; i >= 0; i--) {
        const settled = holds[i].settledAt;
        if (settled !== null && now - settled >= HOLD_GRACE_MS) holds.splice(i, 1);
      }
      const { target, board } = choose(facts, holds, need, now);
      // No await here. The next caller must see this hold before it chooses.
      const hold: Hold = { hostId: target.hostId, threadId: null, settledAt: null };
      holds.push(hold);
      try {
        hold.threadId = await issue(target);
        if (hold.threadId === null) holds.splice(holds.indexOf(hold), 1);
        return { target, threadId: hold.threadId, board };
      } finally { hold.settledAt = clock(); }
    },
    async board(need) { return choose(await fresh(need), holds, need, clock()).board; },
    wouldMove(need, occupancy) {
      try {
        const id = key(need);
        watched.set(id, { need, at: clock() });
        const cached = cache.get(id);
        if (!cached || clock() - cached.at >= WARM_MS) {
          void factsFor(need);
          return null;
        }
        const { target } = choose({ ...cached.facts, occupancy }, holds, need, clock());
        return target.where === "away" ? target : null;
      } catch { return null; }
    },
    async refresh() {
      for (const [id, { at }] of watched) if (clock() - at >= WATCH_MS) watched.delete(id);
      await Promise.all([...watched.values()].map(({ need }) => factsFor(need, true)));
    },
    facts(query) { return fresh({ ...query, away: ANY_WORKTREE }); },
  };
}
