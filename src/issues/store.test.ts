import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store.ts";
import { CONCURRENCY, RESTING_STATES, TERMINAL, TRANSIT, enter, type Change, type Effect, type JobId, type RepoName, type Sha } from "./job.ts";
import { openIssueStore, type NewJob } from "./store.ts";

const REPO = "acme/web" as RepoName;
let ids = 0;
const nextId = () => `psi_00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}` as JobId;

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, store: openIssueStore(db) };
}

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    id: nextId(),
    repo: REPO,
    issue: 41,
    trigger: { eventId: ids * 100, actor: "maya", at: 1 },
    snapshot: { title: "Submit button hides", body: "b", url: "https://github.com/acme/web/issues/41", author: "maya" },
    projectId: "prj_1",
    hostId: "host_1",
    baseBranch: "main",
    state: "queued",
    error: null,
    ...overrides,
  };
}

const spawn: Effect = { op: "spawn", key: "spawn:x", spec: { title: "t", prompt: "p", providerId: "codex", model: "m", reasoningLevel: "high", permissionMode: null } };

test("a write is guarded by version: the stale writer gets null and the row is unchanged", () => {
  const { store } = setup();
  const job = store.insert(newJob(), 10)!;
  assert.equal(job.version, 0);
  const won = store.write(job.id, 0, { error: "first" }, 20)!;
  assert.equal(won.version, 1);
  assert.equal(won.updatedAt, 20);
  assert.equal(store.write(job.id, 0, { error: "second" }, 30), null);
  assert.equal(store.get(job.id)!.error, "first");
});

test("the phase round-trips with its outbox and bookkeeping, and a resting phase clears them", () => {
  const { store } = setup();
  const job = store.insert(newJob(), 10)!;
  const phase = { ...enter("starting", [spawn]), tries: 2, firstAt: 11, leaseUntil: 12, nextAt: 13 } as const;
  const starting = store.write(job.id, 0, { phase }, 20)!;
  assert.deepEqual(starting.phase, phase);
  const working = store.write(job.id, 1, { phase: { state: "working" }, threadId: "thr_w" }, 30)!;
  assert.deepEqual(working.phase, { state: "working" });
  assert.equal(store.byThread("thr_w")!.id, job.id);
});

test("SQL CHECKs refuse rows the job type makes unrepresentable", () => {
  const { db, store } = setup();
  const job = store.insert(newJob(), 10)!;
  assert.throws(() => db.prepare("UPDATE issue_jobs SET state = 'starting' WHERE id = ?").run(job.id), /CHECK/);
  assert.throws(() => store.write(job.id, 0, { phase: { state: "working" } }, 20), /CHECK/);
  assert.throws(() => store.write(job.id, 0, { phase: { state: "review" }, threadId: "thr_w" }, 20), /CHECK/);
  const review = store.write(job.id, 0, { phase: { state: "review" }, threadId: "thr_w", pushedSha: "a".repeat(40) as Sha, pr: { number: 3, url: "u" } }, 20);
  assert.equal(review?.phase.state, "review");
});

test("one open job per issue; a label event is recorded once; a re-label after a terminal job starts generation 2", () => {
  const { store } = setup();
  const first = store.insert(newJob({ trigger: { eventId: 1, actor: "maya", at: 1 } }), 10)!;
  assert.equal(first.generation, 1);
  assert.equal(first.branch, "agent/issue-41-submit-button-hides");
  assert.equal(store.insert(newJob({ trigger: { eventId: 1, actor: "maya", at: 1 } }), 11), null, "same event");
  assert.equal(store.insert(newJob({ trigger: { eventId: 2, actor: "maya", at: 2 } }), 11), null, "open job holds the issue");

  const ignored = store.insert(newJob({ trigger: { eventId: 3, actor: "drive-by", at: 3 }, state: "ignored", error: "drive-by has read permission" }), 12)!;
  assert.equal(ignored.phase.state, "ignored");

  store.write(first.id, 0, { phase: { state: "stopped" } }, 20);
  const second = store.insert(newJob({ trigger: { eventId: 4, actor: "maya", at: 4 } }), 30)!;
  assert.equal(second.generation, 2);
  assert.equal(second.branch, "agent/issue-41-submit-button-hides-2");
  assert.equal(store.open(REPO, 41)!.id, second.id);
  assert.deepEqual(store.due(30), [second.id]);
  assert.deepEqual(store.list({ all: true }).map((job) => job.id), [second.id, ignored.id, first.id]);
  assert.deepEqual(store.list({ all: false }).map((job) => job.id), [second.id]);
});

test("no write starts a job beyond CONCURRENCY busy jobs, and queued jobs see their place in line", () => {
  const { store } = setup();
  const jobs = Array.from({ length: CONCURRENCY + 1 }, (_, index) => store.insert(newJob({ issue: 41 + index }), 10 + index)!);
  const last = jobs.at(-1)!;
  assert.deepEqual(store.slots(last.id), { busy: 0, ahead: CONCURRENCY });
  for (const job of jobs.slice(0, -1)) assert.ok(store.write(job.id, 0, { phase: enter("starting", [spawn]) }, 20));
  assert.equal(store.write(last.id, 0, { phase: enter("starting", [spawn]) }, 20), null, "every slot is taken");
  assert.deepEqual(store.slots(last.id), { busy: CONCURRENCY, ahead: 0 });

  const claimed = store.write(jobs[0]!.id, 1, { phase: { ...enter("starting", [spawn]), tries: 1 } } as Change, 30);
  assert.ok(claimed, "a job that already holds a slot keeps writing its own phase");
  store.write(jobs[0]!.id, claimed.version, { phase: { state: "stopped" } }, 40);
  assert.ok(store.write(last.id, 0, { phase: enter("starting", [spawn]) }, 50), "a freed slot can be taken");
});

test("repository poll state is stored per repository", () => {
  const { store } = setup();
  assert.deepEqual(store.repoPoll(REPO), { poll: null, polledAt: null, error: null });
  store.saveRepoPoll(REPO, { since: 5, etag: "W/1" }, 99, null);
  store.saveRepoPoll(REPO, { since: 6, etag: "W/2" }, 100, "GitHub 502");
  assert.deepEqual(store.repoPoll(REPO), { poll: { since: 6, etag: "W/2" }, polledAt: 100, error: "GitHub 502" });
});

test("the migration's state lists match job.ts", () => {
  const sql = MIGRATIONS.filter((statement) => statement.includes(" issue_jobs ")).join("\n");
  const list = (pattern: RegExp) => new Set([...pattern.exec(sql)![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]));
  assert.deepEqual(list(/state IN \(\s*([^)]*)\)\),/), new Set([...RESTING_STATES, ...Object.keys(TRANSIT)]));
  assert.deepEqual(list(/CHECK \(\(state IN \(([^)]*)\)\) = \(effects_json/), new Set(Object.keys(TRANSIT)));
  assert.deepEqual(list(/issue_jobs_open[\s\S]*?state NOT IN \(([^)]*)\)/), new Set(TERMINAL));
});

test("due lists only jobs that can act now: not a job resting in review, nor an effect under a lease or a backoff", () => {
  const { store } = setup();
  const [queued, review, leased, backoff, ready] = [41, 42, 43, 44, 45].map((issue, index) => store.insert(newJob({ issue }), 10 + index)!);
  const sha = "a".repeat(40) as Sha;
  store.write(review!.id, 0, { phase: { state: "review" }, threadId: "thr_r", pushedSha: sha, pr: { number: 3, url: "u" } }, 20);
  store.write(leased!.id, 0, { phase: { ...enter("starting", [spawn]), tries: 1, leaseUntil: 200 } } as Change, 20);
  store.write(backoff!.id, 0, { phase: { ...enter("starting", [spawn]), tries: 1, nextAt: 200 } } as Change, 20);
  store.write(ready!.id, 0, { phase: { ...enter("starting", [spawn]), tries: 1, nextAt: 100 } } as Change, 20);
  assert.deepEqual(store.due(150), [queued!.id, ready!.id]);
  assert.deepEqual(store.due(200), [queued!.id, leased!.id, backoff!.id, ready!.id]);
});
