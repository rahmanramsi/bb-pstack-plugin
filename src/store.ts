/**
 * The plugin's SQLite schema. Runs, jobs and attempts are owned by run-store.ts; checklists and steps by
 * checklist-store.ts; issue_repos, issue_jobs, issue_rounds, issue_feedback and issue_job_polls by issues/store.ts. Every state change is a conditional (compare-and-set) transaction, so a repeated
 * transition is a no-op.
 * Migrations are append-only: never edit or reorder a shipped statement, only push new ones.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     origin_thread_id TEXT NOT NULL,
     request_key TEXT,
     plan_hash TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('panel','swarm')),
     title TEXT NOT NULL,
     origin_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running','succeeded','partial','failed','cancelled')),
     deadline INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     finished_at INTEGER,
     notify_state TEXT NOT NULL DEFAULT 'pending' CHECK (notify_state IN ('pending','sent','abandoned')),
     notify_attempts INTEGER NOT NULL DEFAULT 0,
     notify_next_at INTEGER,
     UNIQUE (origin_thread_id, request_key)
   )`,
  `CREATE INDEX runs_origin ON runs (origin_thread_id, created_at)`,
  `CREATE TABLE jobs (
     run_id TEXT NOT NULL,
     key TEXT NOT NULL,
     ord INTEGER NOT NULL,
     draft_json TEXT NOT NULL,
     state TEXT NOT NULL,
     released_prompt TEXT,
     provider_retries INTEGER NOT NULL DEFAULT 0,
     repairs INTEGER NOT NULL DEFAULT 0,
     next_action_at INTEGER,
     value_json TEXT,
     error TEXT,
     PRIMARY KEY (run_id, key)
   )`,
  `CREATE TABLE attempts (
     run_id TEXT NOT NULL,
     job_key TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('issued','attached','finished')),
     thread_id TEXT UNIQUE,
     issued_at INTEGER NOT NULL,
     finished_at INTEGER,
     cleanup TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup IN ('pending','done')),
     PRIMARY KEY (run_id, job_key, ordinal)
   )`,
  `CREATE TABLE checklists (
     thread_id TEXT PRIMARY KEY,
     playbook TEXT NOT NULL,
     revision INTEGER NOT NULL DEFAULT 0,
     nudged_at_revision INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE steps (
     thread_id TEXT NOT NULL,
     id INTEGER NOT NULL,
     position REAL NOT NULL,
     section TEXT NOT NULL CHECK (section IN ('playbook','pr')),
     after_pr INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped')),
     evidence_json TEXT,
     reason TEXT,
     CHECK (status = 'open' OR (status = 'done' AND evidence_json IS NOT NULL) OR (status = 'skipped' AND length(trim(reason)) > 0)),
     PRIMARY KEY (thread_id, id)
   )`,
  // The issue_jobs state lists repeat issues/job.ts; issues/store.test.ts fails when they disagree.
  `CREATE TABLE issue_repos (
     repo TEXT PRIMARY KEY,
     poll_json TEXT,
     polled_at INTEGER,
     error TEXT
   )`,
  `CREATE TABLE issue_jobs (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL DEFAULT 0,
     repo TEXT NOT NULL,
     issue INTEGER NOT NULL,
     generation INTEGER NOT NULL,
     trigger_event_id INTEGER NOT NULL UNIQUE,
     triggered_by TEXT NOT NULL,
     triggered_at INTEGER NOT NULL,
     issue_json TEXT NOT NULL,
     project_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     branch TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'ignored','queued','working','needs-info','review','done','stopped','stuck',
       'starting','publishing','asking','closing','stopping','sticking')),
     effects_json TEXT,
     effect_tries INTEGER NOT NULL DEFAULT 0,
     effect_first_at INTEGER,
     effect_lease_until INTEGER,
     effect_next_at INTEGER,
     thread_id TEXT UNIQUE,
     deadline INTEGER,
     rejections INTEGER NOT NULL DEFAULT 0,
     nudges INTEGER NOT NULL DEFAULT 0,
     report_json TEXT,
     pushed_sha TEXT,
     pr_number INTEGER,
     pr_url TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     CHECK ((state IN ('starting','publishing','asking','closing','stopping','sticking')) = (effects_json IS NOT NULL)),
     CHECK (state NOT IN ('working','needs-info','review') OR thread_id IS NOT NULL),
     CHECK (state != 'review' OR (pr_number IS NOT NULL AND pushed_sha IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX issue_jobs_open ON issue_jobs (repo, issue)
     WHERE state NOT IN ('ignored','done','stopped','stuck')`,
  `CREATE INDEX issue_jobs_due ON issue_jobs (state, created_at)`,
  // Feedback rounds add states, so issue_jobs is rebuilt: SQLite cannot alter a CHECK.
  `CREATE TABLE issue_jobs_next (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL DEFAULT 0,
     repo TEXT NOT NULL,
     issue INTEGER NOT NULL,
     generation INTEGER NOT NULL,
     trigger_event_id INTEGER NOT NULL UNIQUE,
     triggered_by TEXT NOT NULL,
     triggered_at INTEGER NOT NULL,
     issue_json TEXT NOT NULL,
     project_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     branch TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'ignored','queued','working','needs-info','review','addressing','done','stopped','stuck',
       'starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying')),
     effects_json TEXT,
     effect_tries INTEGER NOT NULL DEFAULT 0,
     effect_first_at INTEGER,
     effect_lease_until INTEGER,
     effect_next_at INTEGER,
     thread_id TEXT UNIQUE,
     deadline INTEGER,
     rejections INTEGER NOT NULL DEFAULT 0,
     nudges INTEGER NOT NULL DEFAULT 0,
     report_json TEXT,
     pushed_sha TEXT,
     pr_number INTEGER,
     pr_url TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     round INTEGER NOT NULL DEFAULT 1,
     worker_json TEXT,
     CHECK ((state IN ('starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying')) = (effects_json IS NOT NULL)),
     CHECK (state NOT IN ('working','needs-info','review','addressing','sending') OR thread_id IS NOT NULL),
     CHECK (state NOT IN ('review','addressing','sending','respawning','republishing','replying') OR (pr_number IS NOT NULL AND pushed_sha IS NOT NULL))
   )`,
  `INSERT INTO issue_jobs_next SELECT *, 1, NULL FROM issue_jobs`,
  `DROP TABLE issue_jobs`,
  `ALTER TABLE issue_jobs_next RENAME TO issue_jobs`,
  `CREATE UNIQUE INDEX issue_jobs_open ON issue_jobs (repo, issue)
     WHERE state NOT IN ('ignored','done','stopped','stuck')`,
  `CREATE INDEX issue_jobs_due ON issue_jobs (state, created_at)`,
  `CREATE TABLE issue_rounds (
     job_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('initial','feedback')),
     started_at INTEGER NOT NULL,
     base_sha TEXT,
     report_json TEXT,
     pushed_sha TEXT,
     finished_at INTEGER,
     PRIMARY KEY (job_id, ordinal)
   )`,
  `INSERT INTO issue_rounds (job_id, ordinal, kind, started_at, report_json, pushed_sha)
     SELECT id, 1, 'initial', created_at, report_json, pushed_sha FROM issue_jobs WHERE state NOT IN ('ignored','queued')`,
  // One row per feedback item; the primary key is the dedupe of polled events. round is NULL while it waits.
  `CREATE TABLE issue_feedback (
     repo TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('review','review-comment','pr-comment')),
     github_id INTEGER NOT NULL,
     job_id TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     author TEXT NOT NULL,
     body TEXT NOT NULL,
     path TEXT,
     line INTEGER,
     diff_hunk TEXT,
     in_reply_to INTEGER,
     review_id INTEGER,
     created_at INTEGER NOT NULL,
     round INTEGER,
     PRIMARY KEY (repo, kind, github_id)
   )`,
  `CREATE INDEX issue_feedback_job ON issue_feedback (job_id, round)`,
  `ALTER TABLE issue_repos ADD COLUMN feedback_json TEXT`,
  // Feedback is polled per job, so one pull request's failure keeps no other job from its feedback or its state.
  // issue_repos.feedback_json is no longer read.
  `CREATE TABLE issue_job_polls (
     job_id TEXT PRIMARY KEY,
     cursor_json TEXT,
     pr_state TEXT CHECK (pr_state IN ('open','merged','closed')),
     polled_at INTEGER,
     error TEXT
   )`,
  `ALTER TABLE issue_feedback ADD COLUMN posted_at INTEGER`,
  `ALTER TABLE issue_feedback ADD COLUMN parent_author TEXT`,
  `ALTER TABLE issue_feedback ADD COLUMN parent_body TEXT`,
  `ALTER TABLE issue_jobs ADD COLUMN round_base TEXT`,
];

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Opens the plugin database and applies MIGRATIONS. */
export function openDatabase(bb: BbPluginApi): Db {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  return db;
}
