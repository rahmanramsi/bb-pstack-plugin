import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store.ts";
import { issueBoard } from "./board.ts";
import type { JobId, RepoName } from "./job.ts";
import { openIssueStore, type NewJob } from "./store.ts";

const WEB = "acme/web" as RepoName;
const API = "acme/api" as RepoName;
const OLD = "acme/old" as RepoName;
let ids = 0;

function newJob(repo: RepoName, issue: number, title: string): NewJob {
  ids++;
  return {
    id: `psi_00000000-0000-0000-0000-${String(ids).padStart(12, "0")}` as JobId,
    repo,
    issue,
    trigger: { eventId: ids, actor: "maya", at: 1 },
    snapshot: { title, body: "", url: `https://github.com/${repo}/issues/${issue}`, author: "maya" },
    projectId: "prj_1",
    hostId: "host_1",
    baseBranch: "main",
    state: "queued",
    error: null,
  };
}

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = openIssueStore(db, () => {});
  const working = store.insert(newJob(WEB, 41, "Submit button hides behind the footer"), 10)!;
  store.write(working.id, working.version, { phase: { state: "working" }, threadId: "thr_worker" }, 11);
  store.recordPollError(working.id, "GitHub GET /repos/acme/web/issues/41: 502", 12);
  const stopped = store.insert(newJob(WEB, 42, "Dark mode"), 20)!;
  store.write(stopped.id, stopped.version, { phase: { state: "stopped" }, error: "stopped by the bb CLI" }, 21);
  const legacy = store.insert(newJob(OLD, 7, "Left from an older setting"), 30)!;
  store.saveRepoPoll(WEB, null, 40, "label poll failed");
  return { store, working, stopped, legacy };
}

test("the list board shows every configured repository, with or without jobs, and every repository that has open jobs", () => {
  const { store, working, legacy } = setup();
  const board = issueBoard(store, [WEB, API], { all: false });
  assert.deepEqual(board.repos, [
    { repo: WEB, polledAt: 40, error: "label poll failed" },
    { repo: API, polledAt: null, error: null },
    { repo: OLD, polledAt: null, error: null },
  ]);
  assert.deepEqual(board.jobs.map((job) => job.id), [legacy.id, working.id]);
  const job = board.jobs.find((candidate) => candidate.id === working.id)!;
  assert.equal(job.title, "Submit button hides behind the footer");
  assert.equal(job.state, "working");
  assert.equal(job.threadId, "thr_worker");
  assert.deepEqual(job.host, { id: "host_1", pinned: true });
  assert.deepEqual(job.poll, { polledAt: 12, error: "GitHub GET /repos/acme/web/issues/41: 502" });
});

test("ended jobs are listed only with all", () => {
  const { store, working, stopped, legacy } = setup();
  assert.deepEqual(issueBoard(store, [WEB], { all: true }).jobs.map((job) => job.id), [legacy.id, stopped.id, working.id]);
  assert.equal(issueBoard(store, [WEB], { all: true }).jobs.find((job) => job.id === stopped.id)!.error, "stopped by the bb CLI");
});

test("a repository filter keeps only that repository and its jobs", () => {
  const { store, working } = setup();
  const web = issueBoard(store, [WEB, API], { repo: WEB, all: false });
  assert.deepEqual(web.repos.map((repo) => repo.repo), [WEB]);
  assert.deepEqual(web.jobs.map((job) => job.id), [working.id]);
  assert.deepEqual(issueBoard(store, [WEB, API], { repo: API, all: true }), { repos: [{ repo: API, polledAt: null, error: null }], jobs: [] });
});

test("a worker thread's board holds its own job and repository, and any other thread's board is empty", () => {
  const { store, working } = setup();
  const board = issueBoard(store, [WEB, API], { threadId: "thr_worker" });
  assert.deepEqual(board.repos, [{ repo: WEB, polledAt: 40, error: "label poll failed" }]);
  assert.deepEqual(board.jobs.map((job) => [job.id, job.title]), [[working.id, "Submit button hides behind the footer"]]);
  assert.deepEqual(issueBoard(store, [WEB, API], { threadId: "thr_person" }), { repos: [], jobs: [] });
});

test("a stuck job stays on the list board until a newer job for its issue replaces it", () => {
  const { store, working, legacy } = setup();
  const stuck = store.insert(newJob(WEB, 43, "Crash on save"), 50)!;
  store.write(stuck.id, stuck.version, { phase: { state: "stuck" }, error: "no model is configured for the issue worker role" }, 51);
  const board = issueBoard(store, [WEB], { all: false });
  assert.deepEqual(board.jobs.map((job) => job.id), [stuck.id, legacy.id, working.id]);
  assert.equal(board.jobs[0]!.error, "no model is configured for the issue worker role");

  const retried = store.insert(newJob(WEB, 43, "Crash on save"), 60)!;
  assert.deepEqual(issueBoard(store, [WEB], { all: false }).jobs.map((job) => job.id), [retried.id, legacy.id, working.id]);
  assert.ok(issueBoard(store, [WEB], { all: true }).jobs.some((job) => job.id === stuck.id));
});
