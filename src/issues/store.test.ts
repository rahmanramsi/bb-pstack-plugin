import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store.ts";
import { CONCURRENCY, RESTING_STATES, TERMINAL, TRANSIT, enter, type AcceptedReport, type Change, type Effect, type Feedback, type JobId, type RepoName, type Sha } from "./job.ts";
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

const spawn: Effect = { op: "spawn", key: "spawn:x", spec: { title: "t", prompt: "p", providerId: "codex", model: "m", reasoningLevel: "high", permissionMode: null, baseRef: "origin/main" } };

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
  const latest = (pattern: RegExp) => MIGRATIONS.filter((statement) => pattern.test(statement)).at(-1)!;
  const sql = [latest(/^CREATE TABLE issue_jobs(_next)? \(/), latest(/^CREATE UNIQUE INDEX issue_jobs_open /)].join("\n");
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

const SHA = "a".repeat(40) as Sha;
const comment = (id: number, createdAt: number, kind: Feedback["kind"] = "review-comment"): Feedback => ({
  kind,
  id,
  author: "maya",
  body: `comment ${id}`,
  path: "src/a.ts",
  line: 3,
  diffHunk: "@@ -1 +1 @@",
  inReplyTo: null,
  reviewId: 500,
  createdAt,
});

/** A job resting in review on pull request 7, as step 1 leaves it. */
function inReview(store: ReturnType<typeof setup>["store"]) {
  const job = store.insert(newJob(), 10)!;
  store.write(job.id, 0, { phase: enter("starting", [spawn]), startRound: { ordinal: 1, kind: "initial", baseSha: null, feedback: [] } }, 11);
  return store.write(job.id, 1, { phase: { state: "review" }, threadId: "thr_r", pushedSha: SHA, pr: { number: 7, url: "u" } }, 12)!;
}

test("feedback is stored once per GitHub item, and only for the job it was polled for", () => {
  const { store } = setup();
  const job = inReview(store);
  const items = [comment(1, 100), comment(2, 90), comment(1, 100, "review")].map((feedback) => ({ jobId: job.id, pr: 7, feedback }));
  assert.equal(store.addFeedback(REPO, items), 3, "an inline comment and a review may share an id");
  assert.equal(store.addFeedback(REPO, items), 0, "a repeated poll adds nothing");
  assert.deepEqual(store.feedback(job.id).pending.map((item) => [item.kind, item.id]), [["review-comment", 2], ["review-comment", 1], ["review", 1]]);
  assert.deepEqual(store.feedback(job.id).pending[0], comment(2, 90));
  assert.deepEqual(store.withPullRequest(REPO).map((open) => open.id), [job.id]);
});

test("a round start writes the job, the round's row and its feedback in one transaction, and feedback that arrives later waits for the next round", () => {
  const { db, store } = setup();
  const job = inReview(store);
  store.addFeedback(REPO, [comment(1, 100), comment(2, 110)].map((feedback) => ({ jobId: job.id, pr: 7, feedback })));
  const listed = [{ kind: "review-comment", id: 1 }, { kind: "review-comment", id: 2 }] as const;

  const refused = { phase: { state: "stopped" }, startRound: { ordinal: 2, kind: "feedback", baseSha: SHA, feedback: [...listed, { kind: "review", id: 9 }] } } as const;
  assert.throws(() => store.write(job.id, job.version, refused, 200), /review 9 is not pending feedback/);
  assert.equal(store.get(job.id)!.version, job.version, "a failed round start leaves the job as it was");
  assert.equal(store.feedback(job.id).pending.length, 2);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM issue_rounds WHERE ordinal = 2").get(), { n: 0 });

  const started = store.write(job.id, job.version, { phase: { state: "addressing" }, startRound: { ordinal: 2, kind: "feedback", baseSha: SHA, feedback: listed } }, 200)!;
  assert.equal(started.round, 2);
  assert.deepEqual(store.feedback(job.id).pending, []);
  assert.deepEqual(store.roundFeedback(job.id, 2).map((item) => item.id), [1, 2]);
  assert.deepEqual(db.prepare("SELECT kind, started_at, base_sha FROM issue_rounds WHERE job_id = ? AND ordinal = 2").get(job.id), { kind: "feedback", started_at: 200, base_sha: SHA });

  store.addFeedback(REPO, [comment(3, 250)].map((feedback) => ({ jobId: job.id, pr: 7, feedback })));
  assert.deepEqual(store.feedback(job.id).pending.map((item) => item.id), [3], "feedback that arrives during a round waits for the next one");
  assert.deepEqual(store.roundFeedback(job.id, 2).map((item) => item.id), [1, 2]);
});

test("the current round's row records its report, its pushed commit, and when the job is back in review", () => {
  const { db, store } = setup();
  const job = inReview(store);
  const next = SHA.replace(/a/g, "b") as Sha;
  let current = store.write(job.id, job.version, { phase: { state: "addressing" }, startRound: { ordinal: 2, kind: "feedback", baseSha: SHA, feedback: [] } }, 200)!;
  const report: AcceptedReport = { outcome: "no-change", replies: [], verification: ["read it"], summary: "Explained the naming.", headSha: SHA, acceptedAt: 300 };
  current = store.write(job.id, current.version, { report }, 300)!;
  current = store.write(job.id, current.version, { pushedSha: next }, 310)!;
  store.write(job.id, current.version, { phase: { state: "review" } }, 320);
  assert.deepEqual(db.prepare("SELECT ordinal, pushed_sha, finished_at FROM issue_rounds WHERE job_id = ? ORDER BY ordinal").all(job.id), [
    { ordinal: 1, pushed_sha: SHA, finished_at: 12 },
    { ordinal: 2, pushed_sha: next, finished_at: 320 },
  ]);
  assert.deepEqual(store.feedback(job.id).rounds, [{ ordinal: 1, summary: null }, { ordinal: 2, summary: "Explained the naming." }]);
});

test("a step 1 database migrates its jobs to round 1 with their history", () => {
  const db = new Database(":memory:");
  const step1 = MIGRATIONS.findIndex((statement) => statement.startsWith("CREATE TABLE issue_jobs_next"));
  for (const statement of MIGRATIONS.slice(0, step1)) db.exec(statement);
  db.prepare(
    `INSERT INTO issue_jobs (id, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json, project_id, host_id, base_branch, branch,
       state, thread_id, pushed_sha, pr_number, pr_url, report_json, created_at, updated_at)
     VALUES ('psi_old', 'acme/web', 41, 1, 1, 'maya', 1, '{}', 'p', 'h', 'main', 'agent/issue-41-x', 'review', 'thr_old', ?, 7, 'u', '{"summary":"Fixed."}', 5, 6)`,
  ).run(SHA);
  for (const statement of MIGRATIONS.slice(step1)) db.exec(statement);
  const store = openIssueStore(db);
  const job = store.get("psi_old" as JobId)!;
  assert.equal(job.round, 1);
  assert.equal(job.phase.state, "review");
  assert.deepEqual(store.feedback(job.id).rounds, [{ ordinal: 1, summary: "Fixed." }]);
  assert.throws(() => db.prepare("UPDATE issue_jobs SET state = 'addressing', thread_id = NULL WHERE id = 'psi_old'").run(), /CHECK/);
});
