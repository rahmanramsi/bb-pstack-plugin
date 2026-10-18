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
  // #6 to #13 come from pstack/poteto-audit (#5). An install of that branch already recorded them in
  // existing databases, and bb checks each migration by index, so they stay here byte for byte.
  `CREATE TABLE poteto_threads (
     thread_id TEXT PRIMARY KEY,
     activated_at INTEGER NOT NULL,
     activation_seq_key TEXT NOT NULL UNIQUE,
     phase TEXT NOT NULL DEFAULT 'activated' CHECK (phase IN ('activated','routed','stalled','complete')),
     charter_state TEXT NOT NULL DEFAULT 'pending' CHECK (charter_state IN ('pending','sent')),
     charter_attempts INTEGER NOT NULL DEFAULT 0,
     charter_next_at INTEGER NOT NULL DEFAULT 0,
     revivals INTEGER NOT NULL DEFAULT 0,
     stalled_at INTEGER
   )`,
  `ALTER TABLE steps ADD COLUMN skip_policy TEXT NOT NULL DEFAULT 'agent' CHECK (skip_policy IN ('agent','user','never'))`,
  `ALTER TABLE steps ADD COLUMN opened_at INTEGER`,
  `UPDATE steps SET opened_at = (SELECT created_at FROM checklists WHERE checklists.thread_id = steps.thread_id)
   WHERE status = 'open' AND (section = 'pr' OR id = (SELECT s.id FROM steps s WHERE s.thread_id = steps.thread_id AND s.section = 'playbook' AND s.status = 'open' ORDER BY s.position, s.id LIMIT 1))`,
  `UPDATE steps SET skip_policy = CASE WHEN id = 4 THEN 'never' ELSE 'user' END
   WHERE section = 'playbook' AND id IN (1,2,4) AND thread_id IN (SELECT thread_id FROM checklists WHERE playbook = 'feature')`,
  `ALTER TABLE checklists ADD COLUMN pr_gate_passed_at INTEGER`,
  `ALTER TABLE poteto_threads ADD COLUMN audit_cursor TEXT`,
  `CREATE TABLE poteto_violations (
     thread_id TEXT NOT NULL,
     key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('pr-before-gate','work-before-checklist','audit-unreadable')),
     detail TEXT NOT NULL,
     observed_at INTEGER NOT NULL,
     acknowledged_at INTEGER,
     notified_at INTEGER,
     notify_attempts INTEGER NOT NULL DEFAULT 0,
     notify_next_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (thread_id, key)
   )`,
  `ALTER TABLE attempts ADD COLUMN host_id TEXT`,
  `ALTER TABLE attempts ADD COLUMN host_name TEXT`,
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
  // Sub-issues add a parent's states and a child job with no label event, so issue_jobs is rebuilt again.
  `CREATE TABLE issue_jobs_next (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL DEFAULT 0,
     repo TEXT NOT NULL,
     issue INTEGER NOT NULL,
     generation INTEGER NOT NULL,
     trigger_event_id INTEGER UNIQUE,
     triggered_by TEXT NOT NULL,
     triggered_at INTEGER NOT NULL,
     issue_json TEXT NOT NULL,
     project_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     branch TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'ignored','queued','working','needs-info','review','addressing','tracking','done','stopped','stuck',
       'starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying','updating')),
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
     round_base TEXT,
     parent_id TEXT,
     progress TEXT,
     CHECK ((state IN ('starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying','updating')) = (effects_json IS NOT NULL)),
     CHECK (state NOT IN ('working','needs-info','review','addressing','sending') OR thread_id IS NOT NULL),
     CHECK (state NOT IN ('review','addressing','sending','respawning','republishing','replying') OR (pr_number IS NOT NULL AND pushed_sha IS NOT NULL)),
     CHECK ((parent_id IS NULL) = (trigger_event_id IS NOT NULL))
   )`,
  `INSERT INTO issue_jobs_next SELECT *, NULL, NULL FROM issue_jobs`,
  `DROP TABLE issue_jobs`,
  `ALTER TABLE issue_jobs_next RENAME TO issue_jobs`,
  `CREATE UNIQUE INDEX issue_jobs_open ON issue_jobs (repo, issue)
     WHERE state NOT IN ('ignored','done','stopped','stuck')`,
  `CREATE INDEX issue_jobs_due ON issue_jobs (state, created_at)`,
  // A sub-issue gets at most one child job per parent, so a stuck child is never recreated in a loop.
  `CREATE UNIQUE INDEX issue_jobs_child ON issue_jobs (parent_id, issue) WHERE parent_id IS NOT NULL`,
  `ALTER TABLE issue_job_polls ADD COLUMN children_json TEXT`,
  // Manual starts have neither a GitHub label event nor a parent job.
  `CREATE TABLE issue_jobs_next (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL DEFAULT 0,
     repo TEXT NOT NULL,
     issue INTEGER NOT NULL,
     generation INTEGER NOT NULL,
     trigger_event_id INTEGER UNIQUE,
     triggered_by TEXT NOT NULL,
     triggered_at INTEGER NOT NULL,
     issue_json TEXT NOT NULL,
     project_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     branch TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'ignored','queued','working','needs-info','review','addressing','tracking','done','stopped','stuck',
       'starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying','updating')),
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
     round_base TEXT,
     parent_id TEXT,
     progress TEXT,
     CHECK ((state IN ('starting','publishing','asking','closing','stopping','sticking','sending','respawning','republishing','replying','updating')) = (effects_json IS NOT NULL)),
     CHECK (state NOT IN ('working','needs-info','review','addressing','sending') OR thread_id IS NOT NULL),
     CHECK (state NOT IN ('review','addressing','sending','respawning','republishing','replying') OR (pr_number IS NOT NULL AND pushed_sha IS NOT NULL)),
     CHECK (parent_id IS NULL OR trigger_event_id IS NULL)
   )`,
  `INSERT INTO issue_jobs_next SELECT * FROM issue_jobs`,
  `DROP TABLE issue_jobs`,
  `ALTER TABLE issue_jobs_next RENAME TO issue_jobs`,
  `CREATE UNIQUE INDEX issue_jobs_open ON issue_jobs (repo, issue)
     WHERE state NOT IN ('ignored','done','stopped','stuck')`,
  `CREATE INDEX issue_jobs_due ON issue_jobs (state, created_at)`,
  `CREATE UNIQUE INDEX issue_jobs_child ON issue_jobs (parent_id, issue) WHERE parent_id IS NOT NULL`,
  `CREATE TABLE issue_legacy_archive AS SELECT * FROM issue_jobs;
CREATE TABLE issue_jobs_unattended (
     id TEXT PRIMARY KEY,
     version INTEGER NOT NULL DEFAULT 0,
     repo TEXT NOT NULL,
     issue INTEGER NOT NULL,
     generation INTEGER NOT NULL,
     trigger_event_id INTEGER UNIQUE,
     triggered_by TEXT NOT NULL,
     triggered_at INTEGER NOT NULL,
     issue_json TEXT NOT NULL,
     project_id TEXT NOT NULL,
     host_id TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     branch TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN (
       'ignored','queued','working','checking','review','addressing','tracking','done','stopped','stuck',
       'starting','publishing','recovering','repairing','readifying','drafting','closing','stopping','sticking','sending','respawning','republishing','replying','updating')),
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
     round_base TEXT,
     parent_id TEXT,
     progress TEXT,
     control_json TEXT NOT NULL DEFAULT '{}',
     runtime_protocol INTEGER NOT NULL DEFAULT 0 CHECK (runtime_protocol = 1),
     runtime_revision INTEGER NOT NULL DEFAULT 0,
     CHECK ((state IN ('starting','publishing','recovering','repairing','readifying','drafting','closing','stopping','sticking','sending','respawning','republishing','replying','updating')) = (effects_json IS NOT NULL)),
     CHECK (state NOT IN ('working','checking','review','addressing','sending') OR thread_id IS NOT NULL),
     CHECK (state NOT IN ('review','addressing','sending','respawning','republishing','replying') OR (pr_number IS NOT NULL AND pushed_sha IS NOT NULL)),
     CHECK (parent_id IS NULL OR trigger_event_id IS NULL)
   );
   INSERT INTO issue_jobs_unattended (id, version, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json, project_id, host_id, base_branch, branch, state, effects_json, effect_tries, effect_first_at, effect_lease_until, effect_next_at, thread_id, deadline, rejections, nudges, report_json, pushed_sha, pr_number, pr_url, error, created_at, updated_at, round, worker_json, round_base, parent_id, progress, control_json, runtime_protocol)
     SELECT id, version + 1, repo, issue, generation, trigger_event_id, triggered_by, triggered_at, issue_json, project_id, host_id, base_branch, branch, CASE WHEN state IN ('asking','needs-info') THEN 'recovering' WHEN state = 'review' THEN 'checking' ELSE state END, CASE WHEN state IN ('asking','needs-info') THEN json_array(json_object('op','stop-thread','key','recover-stop:' || id || ':1'), json_object('op','recover-worker','key','recover:' || id || ':1','epoch',1)) ELSE effects_json END, effect_tries, effect_first_at, effect_lease_until, effect_next_at, thread_id, NULL, rejections, nudges, report_json, pushed_sha, pr_number, pr_url, error, created_at, updated_at, round, worker_json, round_base, parent_id, progress, json_object('feedbackRounds', max(round - 1, 0), 'epoch', CASE WHEN state IN ('asking','needs-info') THEN 1 ELSE 0 END, 'workspace', NULL, 'recoveries', CASE WHEN state IN ('asking','needs-info') THEN 1 ELSE 0 END, 'invalid', 0, 'bestReasons', NULL, 'milestones', json('[]'), 'readiness', NULL, 'repair', NULL, 'disposition', CASE WHEN state = 'stopped' THEN 'stopped' WHEN state = 'stuck' THEN 'failure' ELSE NULL END, 'preservation', NULL), 1 FROM issue_jobs;
   DROP TABLE issue_jobs;
   ALTER TABLE issue_jobs_unattended RENAME TO issue_jobs;
   CREATE UNIQUE INDEX issue_jobs_open ON issue_jobs (repo, issue) WHERE state NOT IN ('ignored','done','stopped','stuck');
   CREATE INDEX issue_jobs_due ON issue_jobs (state, created_at);
   CREATE UNIQUE INDEX issue_jobs_child ON issue_jobs (parent_id, issue) WHERE parent_id IS NOT NULL;
   CREATE TRIGGER issue_runtime_gate BEFORE UPDATE ON issue_jobs
     WHEN NEW.version > OLD.version AND NEW.runtime_revision = OLD.runtime_revision
     BEGIN SELECT RAISE(ABORT, 'incompatible issue runtime; reload the plugin'); END;
   ALTER TABLE issue_rounds ADD COLUMN cause TEXT;
   ALTER TABLE issue_rounds ADD COLUMN target_json TEXT;
   ALTER TABLE issue_rounds ADD COLUMN outcome_json TEXT;
   UPDATE issue_rounds SET cause = kind;
   CREATE TABLE issue_submissions (
     id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, epoch INTEGER NOT NULL, round INTEGER NOT NULL,
     thread_id TEXT NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL, submitted_at INTEGER NOT NULL,
     evaluated_at INTEGER, result TEXT, snapshot_json TEXT, UNIQUE(job_id, epoch, round, thread_id, hash)
   );
   CREATE INDEX issue_submissions_pending ON issue_submissions (evaluated_at, job_id);
   CREATE TABLE issue_status (
     repo TEXT NOT NULL, issue INTEGER NOT NULL, job_id TEXT NOT NULL, generation INTEGER NOT NULL,
     revision INTEGER NOT NULL, body TEXT NOT NULL, delivered_revision INTEGER NOT NULL DEFAULT 0,
     lease_until INTEGER, next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
     decorations_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(repo, issue)
   );
   INSERT INTO issue_status (repo, issue, job_id, generation, revision, body)
     SELECT j.repo, j.issue, j.id, j.generation, 1, 'Issue #' || j.issue || ': ' || j.state
     FROM issue_jobs j WHERE j.state != 'ignored' AND NOT EXISTS (
       SELECT 1 FROM issue_jobs newer WHERE newer.repo = j.repo AND newer.issue = j.issue AND newer.state != 'ignored'
         AND (newer.generation > j.generation OR (newer.generation = j.generation AND newer.created_at > j.created_at))
     );`,
  `ALTER TABLE issue_submissions ADD COLUMN intended_sha TEXT`,
  `UPDATE issue_jobs SET
     control_json = json_set(control_json, '$.disposition', CASE
       WHEN (SELECT pr_state FROM issue_job_polls WHERE job_id = issue_jobs.id) = 'merged' THEN 'merged'
       WHEN (SELECT pr_state FROM issue_job_polls WHERE job_id = issue_jobs.id) = 'closed' THEN 'closed'
       WHEN json_extract(report_json, '$.outcome') = 'no-change' THEN 'no-change'
     END), version = version + 1, runtime_revision = runtime_revision + 1
   WHERE state = 'done' AND json_extract(control_json, '$.disposition') IS NULL
     AND ((SELECT pr_state FROM issue_job_polls WHERE job_id = issue_jobs.id) IN ('merged','closed')
       OR json_extract(report_json, '$.outcome') = 'no-change')`,
];

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Opens the plugin database and applies MIGRATIONS. */
export function openDatabase(bb: BbPluginApi): Db {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  return db;
}
