import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openRunStore } from "./run-store.ts";
import type { JobDraft, Origin, RunId } from "./runner.ts";
import { MIGRATIONS } from "./store.ts";

const ORIGIN: Origin = {
  threadId: "thr_origin",
  projectId: "prj_1",
  environmentId: "env_1",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "high",
  permissionMode: "auto",
};

const MODEL = { kind: "tuple", provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" } as const;
const JOBS: JobDraft[] = [
  { key: "seat-1", kind: "seat", label: "A", model: MODEL, prompt: "p", result: "text", reads: "origin", after: [], quorum: 0, slice: null },
  { key: "judge", kind: "judge", label: "Judge", model: MODEL, prompt: "judge it", result: "text", reads: "origin", after: ["seat-1"], quorum: 1, slice: null },
];
const RUN = "psr_11111111-1111-1111-1111-111111111111" as RunId;

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  let now = 1_000;
  const store = openRunStore(db, () => now);
  const create = (overrides: Partial<Parameters<typeof store.createRun>[0]> = {}) =>
    store.createRun({ id: RUN, origin: ORIGIN, requestKey: "review-1", planHash: "h1", kind: "panel", title: "Review", deadline: 9_000, jobs: JOBS, ...overrides });
  return { store, create, tick: (ms: number) => (now += ms) };
}

test("createRun stores every job up front, ready or blocked", () => {
  const { store, create } = setup();
  assert.deepEqual(create(), { id: RUN, existing: false });
  const snapshot = store.snapshot(RUN)!;
  assert.equal(snapshot.status, "running");
  assert.deepEqual(snapshot.jobs.map((job) => [job.key, job.state, job.prompt]), [["seat-1", "queued", "p"], ["judge", "blocked", "judge it"]]);
  assert.deepEqual(store.info(RUN)!.origin, ORIGIN);
  assert.deepEqual(store.runsForThread("thr_origin", true), [RUN]);
});

test("createRun with the same request key returns the existing run, and a different plan conflicts", () => {
  const { create } = setup();
  create();
  assert.deepEqual(create({ id: "psr_22222222-2222-2222-2222-222222222222" as RunId }), { id: RUN, existing: true });
  assert.deepEqual(create({ id: "psr_22222222-2222-2222-2222-222222222222" as RunId, planHash: "h2" }), { conflict: true });
});

test("transitionJobAndAttempt is a compare-and-set, and releasing stores the materialized prompt", () => {
  const { store, create } = setup();
  create();
  assert.equal(store.transitionJobAndAttempt(RUN, "judge", "blocked", "queued", { releasedPrompt: "judge it with inputs" }), true);
  assert.equal(store.transitionJobAndAttempt(RUN, "judge", "blocked", "queued", { releasedPrompt: "again" }), false);
  assert.equal(store.snapshot(RUN)!.jobs[1]!.prompt, "judge it with inputs");
});

test("an attempt is claimed once per ordinal, only while its job runs, and attached once", () => {
  const { store, create } = setup();
  create();
  assert.equal(store.claimAttempt(RUN, "seat-1", 1, 5), false, "queued job cannot claim");
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  assert.equal(store.claimAttempt(RUN, "seat-1", 1, 5), true);
  assert.equal(store.claimAttempt(RUN, "seat-1", 1, 6), false);
  assert.deepEqual(store.snapshot(RUN)!.jobs[0]!.attempts, [{ ordinal: 1, state: "issued", threadId: null, issuedAt: 5, finishedAt: null }]);

  assert.equal(store.attachAttempt(RUN, "seat-1", 1, "thr_w1"), true);
  assert.equal(store.attachAttempt(RUN, "seat-1", 1, "thr_w2"), false);
  assert.deepEqual(store.attemptByThread("thr_w1"), { runId: RUN, key: "seat-1", ordinal: 1 });
  assert.equal(store.attemptByThread("thr_w2"), null);
});

test("leaving the live states finishes the open attempt; uncertain keeps it open", () => {
  const { store, create, tick } = setup();
  create();
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  store.claimAttempt(RUN, "seat-1", 1, 5);
  store.transitionJobAndAttempt(RUN, "seat-1", "running", "uncertain");
  assert.equal(store.snapshot(RUN)!.jobs[0]!.attempts[0]!.state, "issued");
  tick(500);
  store.transitionJobAndAttempt(RUN, "seat-1", "uncertain", "failed", { error: "the run deadline passed" });
  const job = store.snapshot(RUN)!.jobs[0]!;
  assert.deepEqual([job.state, job.error, job.attempts[0]!.state, job.attempts[0]!.finishedAt], ["failed", "the run deadline passed", "finished", 1_500]);
});

test("one thread cannot be attached to two attempts", () => {
  const { store, create } = setup();
  create();
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  store.claimAttempt(RUN, "seat-1", 1, 5);
  store.attachAttempt(RUN, "seat-1", 1, "thr_w1");
  store.transitionJobAndAttempt(RUN, "seat-1", "running", "queued", { providerRetries: 1 });
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  store.claimAttempt(RUN, "seat-1", 2, 6);
  assert.equal(store.attachAttempt(RUN, "seat-1", 2, "thr_w1"), false);
});

test("a finished run stays due until its completion message is settled", () => {
  const { store, create } = setup();
  create();
  assert.deepEqual(store.dueRuns(2_000), [RUN]);
  assert.equal(store.settleNotification(RUN, "sent"), false, "a running run has nothing to send");
  assert.equal(store.finishRun(RUN, "succeeded", 2_000), true);
  assert.equal(store.finishRun(RUN, "failed", 2_001), false);
  assert.deepEqual(store.runsForThread("thr_origin", true), []);
  assert.deepEqual(store.dueRuns(2_000), [RUN]);

  store.deferNotification(RUN, 3_000);
  assert.deepEqual(store.dueRuns(2_500), []);
  assert.deepEqual(store.dueRuns(3_000), [RUN]);
  assert.deepEqual(store.info(RUN)!.notify, { state: "pending", attempts: 1, nextAt: 3_000 });

  assert.equal(store.settleNotification(RUN, "sent"), true);
  assert.equal(store.settleNotification(RUN, "abandoned"), false);
  assert.deepEqual(store.dueRuns(10_000), []);
  assert.equal(store.info(RUN)!.status, "succeeded");
});

test("cancelRun cancels the run, its open jobs and their attempts together, and their workers stay due until cleaned", () => {
  const { store, create } = setup();
  create();
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  store.claimAttempt(RUN, "seat-1", 1, 5);
  store.attachAttempt(RUN, "seat-1", 1, "thr_w1");
  assert.deepEqual(store.pendingCleanup(RUN), [], "a live attempt is not cleaned up");

  assert.equal(store.cancelRun(RUN, 2_000), true);
  assert.equal(store.cancelRun(RUN, 2_001), false);
  const snapshot = store.snapshot(RUN)!;
  assert.deepEqual([snapshot.status, ...snapshot.jobs.map((job) => job.state)], ["cancelled", "cancelled", "cancelled"]);
  assert.deepEqual(snapshot.jobs[0]!.attempts.map((attempt) => [attempt.state, attempt.finishedAt]), [["finished", 2_000]]);

  store.settleNotification(RUN, "sent");
  assert.deepEqual(store.pendingCleanup(RUN), ["thr_w1"]);
  assert.deepEqual(store.dueRuns(2_000), [RUN]);
  store.markCleaned("thr_w1");
  assert.deepEqual(store.pendingCleanup(RUN), []);
  assert.deepEqual(store.dueRuns(2_000), []);
});

test("cancelRun leaves a finished run alone", () => {
  const { store, create } = setup();
  create();
  store.finishRun(RUN, "failed", 2_000);
  assert.equal(store.cancelRun(RUN, 2_001), false);
  assert.deepEqual(store.snapshot(RUN)!.jobs.map((job) => job.state), ["queued", "blocked"]);
});

test("revision moves on every change and not on a no-op", () => {
  const { store, create } = setup();
  const before = store.revision("thr_origin");
  create();
  const created = store.revision("thr_origin");
  assert.ok(created > before);
  store.transitionJobAndAttempt(RUN, "judge", "running", "succeeded");
  assert.equal(store.revision("thr_origin"), created);
  store.transitionJobAndAttempt(RUN, "seat-1", "queued", "running");
  assert.ok(store.revision("thr_origin") > created);
});
