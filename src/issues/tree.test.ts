import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MEMBERS, createTreeActivity, type RunJob, type TreeThread } from "./tree.ts";

const NOW = 50_000_000;
const MIN = 60_000;

type Fake = { status?: string; parent?: string; archived?: boolean; progress?: number | null; runs?: RunJob[]; missing?: boolean };

function tree(threads: Record<string, Fake>, now = NOW) {
  const reads: string[] = [];
  const view = (id: string): TreeThread => ({ id, status: threads[id]!.status ?? "idle", archivedAt: threads[id]!.archived ? 1 : null, deletedAt: null });
  const missing = (id: string) => {
    if (!threads[id] || threads[id].missing) throw Object.assign(new Error("thread not found"), { status: 404 });
  };
  const activity = createTreeActivity({
    async thread(id) {
      missing(id);
      return view(id);
    },
    async children(id) {
      missing(id);
      return Object.keys(threads).filter((child) => threads[child]!.parent === id).map(view);
    },
    async lastProgress(id) {
      missing(id);
      reads.push(id);
      return threads[id]!.progress ?? null;
    },
    runJobs: (id) => threads[id]?.runs ?? [],
    clock: () => now,
  });
  return { activity, reads };
}

const run = (state: string, threadIds: string[], nextActionAt: number | null = null): RunJob => ({ state, nextActionAt, attempts: threadIds.map((threadId) => ({ threadId })) });

test("the newest progress anywhere in the tree counts, at any depth, and archived children are left out", async () => {
  const { activity, reads } = tree({
    w: { progress: NOW - 30 * MIN },
    a: { parent: "w", progress: NOW - 25 * MIN },
    b: { parent: "a", progress: NOW - 2 * MIN },
    old: { parent: "w", archived: true, progress: NOW },
  });
  assert.deepEqual(await activity("w"), { lastActiveAt: NOW - 2 * MIN, queued: false });
  assert.deepEqual(reads.sort(), ["a", "b", "w"]);
});

test("the hidden threads of a member's running pstack runs are part of the tree", async () => {
  const { activity } = tree({
    w: { progress: NOW - 40 * MIN },
    child: { parent: "w", progress: NOW - 40 * MIN, runs: [run("running", ["seat1"]), run("succeeded", ["seat2"])] },
    seat1: { status: "active", progress: NOW - MIN },
    seat2: { progress: NOW - 30 * MIN },
  });
  assert.deepEqual(await activity("w"), { lastActiveAt: NOW - MIN, queued: false });
});

test("a held member or a run job waiting for a slot makes the tree queued; a blocked job or one backing off does not", async () => {
  for (const status of ["pending", "starting"]) {
    const { activity } = tree({ w: { progress: NOW - 40 * MIN }, child: { parent: "w", status } });
    assert.equal((await activity("w"))?.queued, true, `a ${status} child`);
  }
  const cases: [RunJob, boolean][] = [
    [run("queued", []), true],
    [run("queued", [], NOW), true],
    [run("queued", [], NOW + MIN), false],
    [run("blocked", []), false],
  ];
  for (const [job, queued] of cases) {
    const { activity } = tree({ w: { progress: NOW - 40 * MIN, runs: [job] } });
    assert.equal((await activity("w"))?.queued, queued, `${job.state} until ${job.nextActionAt}`);
  }
});

test("a member that is gone is skipped, but a worker that cannot be read gives no verdict", async () => {
  const { activity } = tree({ w: { progress: NOW - 40 * MIN, runs: [run("running", ["lost"])] }, child: { parent: "w", progress: NOW - 3 * MIN, missing: true } });
  assert.deepEqual(await activity("w"), { lastActiveAt: NOW - 40 * MIN, queued: false });
  assert.equal(await tree({ w: { missing: true } }).activity("w"), null);
});

test("a tree larger than the member limit gives no verdict", async () => {
  const threads: Record<string, Fake> = { w: { progress: NOW } };
  for (let index = 0; index < MAX_MEMBERS - 1; index++) threads[`c${index}`] = { parent: "w" };
  assert.notEqual(await tree(threads).activity("w"), null, "exactly at the limit");
  threads.extra = { parent: "w" };
  assert.equal(await tree(threads).activity("w"), null);
});
