import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLONE_BACKOFF_MS, createCheckouts, type AppClone, decide, parseCheckouts, pressured } from "./checkouts.ts";
import { hostId, type Board, type HostRow, type Need } from "./placement.ts";

const HOME = hostId.parse("host_home");
const BOX = hostId.parse("host_box");
const VPS = hostId.parse("host_vps");

function book(text: string) {
  const parsed = parseCheckouts(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  return parsed.book;
}

test("checkout rules reject anything but <project|*> allow|deny <host|*>", () => {
  assert.ok(parseCheckouts("# comment\n\n* deny *\np1 allow host_box").ok);
  for (const text of ["p1 allow", "p1 maybe host_box", "p1 allow host_box extra", "allow"]) {
    assert.equal(parseCheckouts(text).ok, false, text);
  }
});

test("the most specific rule wins and deny beats allow at equal specificity", () => {
  const rules = book("* allow *\np1 deny *\np1 allow host_box\n* deny host_vps");
  assert.equal(decide(rules, "p2", BOX), "allow");
  assert.equal(decide(rules, "p1", HOME), "deny");
  assert.equal(decide(rules, "p1", BOX), "allow");
  assert.equal(decide(rules, "p1", VPS), "deny");
  assert.equal(decide(book("p1 allow *\n* deny host_box"), "p1", BOX), "deny");
  assert.equal(decide(book("p1 allow host_box\np1 deny host_box"), "p1", BOX), "deny");
});

test("with no matching rule cloning is allowed", () => {
  assert.equal(decide(book("p1 deny host_box"), "p2", BOX), "allow");
  assert.equal(decide(book(""), "p1", BOX), "allow");
});

const row = (id: typeof HOME, overrides: Partial<HostRow> = {}): HostRow => ({ id, name: id, running: 0, held: 0, limit: 4, free: 4, blocker: null, onlyNeedsCheckout: false, ...overrides });
const need: Need = { projectId: "p1", home: { kind: "worktree", hostId: HOME, baseBranch: null }, away: { kind: "worktree", baseBranch: null, pin: null }, affinity: "spread", model: null };

test("pressure needs a full home and a machine that lacks only a checkout", () => {
  const board = (homeFree: number): Board => ({
    hosts: [row(HOME, { free: homeFree, running: 4 - homeFree }), row(BOX, { blocker: "no checkout of this project", onlyNeedsCheckout: true }), row(VPS, { blocker: "disconnected" })],
    global: { running: 4, limit: null }, next: null,
  });
  assert.deepEqual(pressured(board(0), need), [{ id: BOX, name: BOX }]);
  assert.deepEqual(pressured(board(1), need), []);
  assert.deepEqual(pressured(board(0), { ...need, away: null }), []);
});

const REMOTE = "https://example.com/p1.git";
type Repo = { path: string; originUrl: string | null };

function fake(options: { setting?: string; sources?: string[]; addFailures?: number; addCreatesSource?: boolean; gitRemoteUrl?: string | null; repos?: Repo[]; appClone?: AppClone } = {}) {
  const setting = options.setting ?? "";
  let now = 1_000_000;
  const sources = new Set(options.sources ?? [HOME]);
  const adds: unknown[] = [];
  const sleeps: number[] = [];
  const gets: number[] = [];
  let failures = options.addFailures ?? 0;
  const bb = {
    sdk: {
      hosts: {
        experimental_discoverRepos: async ({ hostId }: { hostId: string }) => ({ repos: hostId === HOME ? options.repos ?? [] : [], truncated: false }),
        list: async () => [HOME, BOX, VPS].map((id) => ({ id, name: `${id} name`, status: id === VPS ? "disconnected" : "connected", lifecycle: { phase: "active" } })),
      },
      projects: {
        get: async () => {
          gets.push(now);
          const gitRemoteUrl = options.gitRemoteUrl === undefined ? REMOTE : options.gitRemoteUrl;
          return { name: "Project One", gitRemoteUrl, sources: [...sources].map((id) => ({ hostId: id, path: `/src/${id}`, isDefault: id === HOME })) };
        },
        sources: {
          add: async (args: { hostId: string }) => {
            adds.push(args);
            if (failures > 0) {
              failures--;
              if (options.addCreatesSource) sources.add(args.hostId);
              throw new Error("clone timed out");
            }
            sources.add(args.hostId);
            return {};
          },
        },
      },
    },
    log: { warn() {}, info() {} },
  } as unknown as BbPluginApi;
  const checkouts = createCheckouts(bb, async () => setting, {
    clock: () => now, sleep: async (ms) => { sleeps.push(ms); }, ...(options.appClone ? { appClone: options.appClone } : {}),
  });
  return { checkouts, adds, sleeps, gets, advance: (ms: number) => { now += ms; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const CLONE = { projectId: "p1", type: "clone", hostId: BOX, remoteUrl: REMOTE };

test("a machine with no rule is cloned onto without asking", async () => {
  const h = fake();
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.deepEqual(h.adds, [CLONE]);
});

test("a deny rule stops the clone", async () => {
  for (const setting of ["p1 deny host_box", "* deny *", "p1 deny *"]) {
    const h = fake({ setting });
    h.checkouts.clone("p1", [BOX]);
    await settle();
    assert.deepEqual(h.adds, [], setting);
  }
});

test("a project and machine clone once however often they are asked for", async () => {
  const h = fake();
  for (let i = 0; i < 3; i++) h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.deepEqual(h.adds, [CLONE]);
});

test("a failed clone re-reads sources and retries with back-off", async () => {
  const h = fake({ addFailures: 2 });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.equal(h.adds.length, 3);
  assert.deepEqual(h.sleeps, CLONE_BACKOFF_MS.slice(0, 2));
  assert.equal(h.gets.length, 3);
});

test("a clone that errored but created the source is not cloned again", async () => {
  const h = fake({ addFailures: 1, addCreatesSource: true });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.equal(h.adds.length, 1);
  assert.equal(h.gets.length, 2);
});

test("a clone gives up after its back-off runs out and stays quiet for an hour", async () => {
  const h = fake({ addFailures: 99 });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.equal(h.adds.length, CLONE_BACKOFF_MS.length + 1);
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.equal(h.adds.length, CLONE_BACKOFF_MS.length + 1);
  h.advance(60 * 60 * 1000);
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.equal(h.adds.length, 2 * (CLONE_BACKOFF_MS.length + 1));
});

test("cloning everywhere targets connected machines with no checkout that no rule denies", async () => {
  assert.deepEqual(await fake().checkouts.cloneEverywhere("p1"), [{ id: BOX, name: `${BOX} name` }]);
  const denied = fake({ setting: "p1 deny host_box" });
  assert.deepEqual(await denied.checkouts.cloneEverywhere("p1"), []);
  await settle();
  assert.deepEqual(denied.adds, []);
});

async function clonedFrom(options: Parameters<typeof fake>[0]) {
  const h = fake(options);
  h.checkouts.clone("p1", [BOX]);
  await settle();
  return h.adds.map((add) => (add as { remoteUrl?: string }).remoteUrl);
}
test("a clone uses the project's git remote when it has one", async () => {
  assert.deepEqual(await clonedFrom({ repos: [{ path: "/src/host_home", originUrl: "https://example.com/other.git" }] }), [REMOTE]);
});

test("without a project remote a clone uses the origin of the default checkout", async () => {
  const origin = "https://github.com/owner/repo.git";
  assert.deepEqual(await clonedFrom({ gitRemoteUrl: null, repos: [{ path: "/src/host_home", originUrl: origin }] }), [origin]);
});

test("the default checkout's origin comes only from a repo at exactly its path", async () => {
  const exact = "https://example.com/exact.git";
  const nearMisses = [
    { path: "/src/host_home/", originUrl: "https://example.com/slash.git" },
    { path: "/src/host_home-old", originUrl: "https://example.com/old.git" },
    { path: "/src", originUrl: "https://example.com/parent.git" },
  ];
  assert.deepEqual(await clonedFrom({ gitRemoteUrl: null, repos: [...nearMisses, { path: "/src/host_home", originUrl: exact }] }), [exact]);
  assert.deepEqual(await clonedFrom({ gitRemoteUrl: null, repos: nearMisses }), []);
});

test("with no git remote anywhere nothing is cloned or retried", async () => {
  for (const repos of [[], [{ path: "/src/host_home", originUrl: null }]]) {
    const h = fake({ gitRemoteUrl: null, repos });
    h.checkouts.clone("p1", [BOX]);
    await settle();
    assert.deepEqual(h.adds, []);
    assert.deepEqual(h.sleeps, []);
    assert.equal(await h.checkouts.remote("p1"), null);
  }
});

test("a repository the GitHub App can read is cloned by the App and added as a local path", async () => {
  const calls: unknown[] = [];
  const h = fake({ appClone: async (...args) => { calls.push(args); return "/bb/checkouts/Project-One"; } });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.deepEqual(calls, [[BOX, REMOTE, "Project One"]]);
  assert.deepEqual(h.adds, [{ projectId: "p1", type: "local_path", hostId: BOX, path: "/bb/checkouts/Project-One" }]);
});

test("a repository the GitHub App cannot reach falls back to bb's own clone", async () => {
  const h = fake({ appClone: async () => null });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.deepEqual(h.adds, [{ projectId: "p1", type: "clone", hostId: BOX, remoteUrl: REMOTE }]);
});

test("a failed App clone is retried with back-off and never handed to bb's clone", async () => {
  let failures = 1;
  const h = fake({ appClone: async () => { if (failures-- > 0) throw new Error("network"); return "/bb/checkouts/p1"; } });
  h.checkouts.clone("p1", [BOX]);
  await settle();
  assert.deepEqual(h.sleeps, CLONE_BACKOFF_MS.slice(0, 1));
  assert.deepEqual(h.adds, [{ projectId: "p1", type: "local_path", hostId: BOX, path: "/bb/checkouts/p1" }]);
});
