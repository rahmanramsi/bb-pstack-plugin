import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createPlacementCommands, needFromFlags, parseSpawnFlags } from "./placement-commands.ts";
import { createPlacement, hostId, type Need } from "./placement.ts";

const HERE = hostId.parse("host_here");
const AWAY = hostId.parse("host_away");
const invoking = { projectId: "p1", environmentId: "env_here", hostId: HERE, model: "codex/m" };

test("fresh worktree flags build a spread Need with the requested project, model, and base branch", () => {
  assert.deepEqual(needFromFlags(parseSpawnFlags({ project: "p2", "new-environment": "worktree", provider: "other", model: "model", "base-branch": "release" }), invoking, null), {
    projectId: "p2", home: { kind: "worktree", hostId: HERE, baseBranch: "release" },
    away: { kind: "worktree", baseBranch: "release", pin: null }, affinity: "spread", model: "other/model",
  });
  assert.equal(needFromFlags(parseSpawnFlags({ "new-environment": "worktree", machine: "auto" }), invoking, null).affinity, "spread");
  assert.equal(needFromFlags(parseSpawnFlags({ model: "new" }), invoking, null).model, "codex/new");
  assert.equal(needFromFlags(parseSpawnFlags({ provider: "other" }), invoking, null).model, null);
});

test("named machines, here, existing environments, and personal workspaces are pinned", () => {
  for (const flags of [{ "new-environment": "worktree", machine: "box" }, { "new-environment": "worktree", machine: "here" }, { environment: "env_fixed" }, { "new-environment": "personal" }, {}]) {
    const request = needFromFlags(parseSpawnFlags(flags), invoking, flags.machine === "box" || flags.environment ? AWAY : HERE);
    assert.equal(request.away, null);
    assert.equal(request.affinity, "home");
    if (flags.environment) assert.deepEqual(request.home, { kind: "reuse", environmentId: "env_fixed", hostId: AWAY });
  }
});

test("auto without a fresh worktree and conflicting placement flags fail at the boundary", () => {
  for (const flags of [{ machine: "auto" }, { machine: "auto", environment: "env" }, { "new-environment": "worktree", environment: "env" }, { "base-branch": "main" }, { prompt: "x", "prompt-file": "p" }]) {
    assert.throws(() => parseSpawnFlags(flags));
  }
});

type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
function harness(options: { failSpawn?: boolean; nullDefaults?: boolean } = {}) {
  const spawns: SpawnArgs[] = [];
  const reads: { path: string; hostId?: string }[] = [];
  const requested: Need[] = [];
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ projectId: "p1", providerId: "codex", environmentId: "env_here" }),
        defaultExecutionOptions: async () => options.nullDefaults ? null : { model: "m", reasoningLevel: "high", permissionMode: "full" },
        listRunning: async () => [{ id: "origin", hostId: HERE }],
        spawn: async (args: SpawnArgs) => {
          if (options.failSpawn) throw new Error("provider offline");
          spawns.push(args);
          return { id: "thr_created" };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ hostId: environmentId === "env_fixed" ? AWAY : HERE }),
        listProviders: async () => [{ id: "git-worktree", availability: { status: "available" } }],
      },
      hosts: { list: async () => [HERE, AWAY].map((id) => ({ id, name: id === HERE ? "Laptop" : "Box", status: "connected", lifecycle: { phase: "active" } })) },
      providers: {
        list: async () => [{ id: "codex", available: true }],
        models: async () => ({ models: [{ model: "m", supportedReasoningEfforts: [] }] }),
      },
      files: { read: async (args: { path: string; hostId?: string }) => {
        reads.push(args);
        if (args.path.includes("missing")) throw new Error("ENOENT");
        return { contentEncoding: "base64", content: Buffer.from("file prompt").toString("base64") };
      } },
    },
    log: { warn() {} },
  } as unknown as BbPluginApi;
  const service = createPlacement(bb, { exec: async () => JSON.stringify({ globalLimit: null, hosts: [{ id: HERE, effectiveLimit: 1 }, { id: AWAY, effectiveLimit: 2 }] }) });
  const placement = { ...service, place: (need: Need, issue: Parameters<typeof service.place>[1]) => { requested.push(need); return service.place(need, issue); } };
  const commands = createPlacementCommands({ bb, placement });
  const cli = defineCli({ name: "pstack", summary: "pstack", commands });
  return { spawns, reads, requested, commands, service, run: (argv: string[], ctx = { threadId: "thr_origin", cwd: "/repo" }) => cli.run(argv, ctx) };
}

test("CLI spawns once with parent identity, inherited execution, permission, and chosen environment", async () => {
  const h = harness();
  const result = await h.run(["spawn", "--parent-self", "--new-environment", "worktree", "--prompt", "brief", "--json"]);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout!).threadId, "thr_created");
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0], {
    projectId: "p1", environment: { type: "host", hostId: AWAY, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    prompt: "brief", parentThreadId: "thr_origin", startedOnBehalfOf: { initiator: "agent", senderThreadId: "thr_origin" },
    providerId: "codex", model: "m", reasoningLevel: "high", permissionMode: "full", serviceTier: undefined, title: undefined,
  });
});

test("CLI forwards model, level, tier, permission, title and project flags", async () => {
  const h = harness();
  const result = await h.run(["spawn", "--new-environment", "personal", "--machine", "here", "--project", "p2", "--provider", "other", "--model", "new", "--reasoning-level", "max", "--service-tier", "fast", "--permission-mode", "auto", "--title", "Task", "--prompt", "brief"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const args = h.spawns[0];
  assert.equal(args.projectId, "p2");
  assert.equal(args.parentThreadId, undefined);
  assert.equal(args.model, "new");
  assert.equal(args.providerId, "other");
  assert.equal(args.reasoningLevel, "max");
  assert.equal(args.serviceTier, "fast");
  assert.equal(args.permissionMode, "auto");
  assert.equal(args.title, "Task");
  assert.deepEqual(args.environment, { type: "host", hostId: HERE, workspace: { type: "personal" } });
});

test("a provider override does not inherit a model or level from a different provider", async () => {
  const h = harness();
  const result = await h.run(["spawn", "--provider", "other", "--prompt", "brief"]);
  assert.equal(result.exitCode, 0);
  assert.equal(h.spawns[0].model, undefined);
  assert.equal(h.spawns[0].reasoningLevel, undefined);
  assert.equal(h.spawns[0].permissionMode, "full");
  assert.equal(h.requested[0].model, null);
});

test("a prompt file is read on the invoking host even when placement moves away", async () => {
  const h = harness();
  const result = await h.run(["spawn", "--new-environment", "worktree", "--prompt-file", "brief.txt"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(h.reads, [{ hostId: HERE, path: "/repo/brief.txt" }]);
  assert.equal(h.spawns[0].prompt, "file prompt");
  assert.equal(h.spawns[0].environment?.type, "host");
});

test("named and reused environments resolve their host and remain pinned", async () => {
  for (const argv of [["--new-environment", "worktree", "--machine", "Box"], ["--environment", "env_fixed"]]) {
    const h = harness();
    const result = await h.run(["spawn", ...argv, "--prompt", "brief"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(h.requested[0].home.hostId, AWAY);
    assert.equal(h.requested[0].away, null);
  }
});

test("dry-run prints the exact decision and spawn args without spawning or leaving a hold", async () => {
  const h = harness();
  const result = await h.run(["spawn", "--new-environment", "worktree", "--prompt", "brief", "--dry-run", "--json"]);
  assert.equal(result.exitCode, 0);
  const value = JSON.parse(result.stdout!);
  assert.equal(value.threadId, null);
  assert.equal(value.target.hostId, AWAY);
  assert.equal(value.spawnArgs.environment.hostId, AWAY);
  assert.equal(value.spawnArgs.prompt, "brief");
  assert.equal(h.spawns.length, 0);
  assert.equal((await h.service.board(h.requested[0])).hosts[1].held, 0);
});

test("failed spawn, invalid flags, missing prompt, file failure, and unknown machine all exit nonzero", async () => {
  for (const args of [["--machine", "auto"], ["--environment", "env", "--machine", "here"], ["--machine", "absent"], ["--prompt-file", "missing.txt"], ["--prompt", ""], ["--reasoning-level", "invalid"]]) {
    const h = harness();
    const result = await h.run(["spawn", ...args, ...(args.includes("--prompt") || args.includes("--prompt-file") ? [] : ["--prompt", "brief"]), "--json"]);
    assert.notEqual(result.exitCode, 0, JSON.stringify(args));
    assert.ok(JSON.parse(result.stdout!).error.message);
    assert.equal(h.spawns.length, 0);
  }
  const missing = await harness().run(["spawn", "--json"]);
  assert.notEqual(missing.exitCode, 0);
  const failure = await harness({ failSpawn: true }).run(["spawn", "--prompt", "brief", "--json"]);
  assert.notEqual(failure.exitCode, 0);
  assert.match(failure.stdout!, /provider offline/);
  assert.notEqual((await harness({ nullDefaults: true }).run(["spawn", "--prompt", "brief"])).exitCode, 0);
});

test("machines prints host and global load and validates model pairs", async () => {
  const h = harness();
  const result = await h.run(["machines", "--provider", "codex", "--model", "m", "--json"]);
  assert.equal(result.exitCode, 0);
  const board = JSON.parse(result.stdout!);
  assert.equal(board.next, AWAY);
  assert.deepEqual(board.global, { running: 1, limit: null });
  assert.equal(board.hosts[1].free, 2);
  assert.match((await h.run(["machines"])).stdout!, /host_here.*Laptop.*1\+0\/1/);
  assert.notEqual((await h.run(["machines", "--model", "m"])).exitCode, 0);
});

test("prompt exposes the SDK stdin option for --prompt-stdin transport rewriting", () => {
  assert.equal(harness().commands.spawn.options?.prompt.stdin, true);
});
