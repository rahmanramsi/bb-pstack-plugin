/**
 * The plugin's SQLite schema. Runs, jobs and attempts are owned by run-store.ts; checklists and steps by
 * checklist-store.ts. Every state change is a conditional (compare-and-set) transaction, so a repeated
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
];

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Opens the plugin database and applies MIGRATIONS. */
export function openDatabase(bb: BbPluginApi): Db {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  return db;
}
