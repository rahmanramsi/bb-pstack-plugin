import type { Db } from "./store.ts";
import type { Checklist, Resolution, StepDraft } from "./checklist.ts";
import { addStep, closeStep, gate, type PlaybookName } from "./checklist.ts";
import { z } from "zod";
import type { PotetoThread } from "./poteto.ts";
import type { PotetoViolation, ViolationDraft } from "./poteto-audit.ts";

export type ChecklistStore = {
  activate(threadId: string, dispatchKey: string, now: number): boolean;
  poteto(threadId: string): PotetoThread | null;
  inProgressPotetoThreads(): string[];
  queueRevival(threadId: string, revivals: number): boolean;
  stall(threadId: string, now: number): boolean;
  claimCharter(threadId: string, now: number): number | null;
  charterSent(threadId: string, attempt: number): boolean;
  violations(threadId: string): PotetoViolation[];
  recordAudit(threadId: string, expectedCursor: string | null, cursor: string | null, violations: readonly ViolationDraft[]): boolean;
  acknowledge(threadId: string, key: string, now: number): boolean;
  claimViolation(threadId: string, key: string, now: number): number | null;
  violationNotified(threadId: string, key: string, attempt: number, now: number): void;
  passGate(threadId: string, kind: "pr" | "done", revision: number, now: number): boolean;
  /** Idempotent: a thread keeps its first checklist; beginning again returns it unchanged. */
  createChecklist(threadId: string, playbook: string, steps: readonly StepDraft[], now: number): { created: boolean };
  checklist(threadId: string): Checklist | null;
  /** CAS on the step's current resolution; bumps the checklist revision when it changes. */
  resolveStep(threadId: string, stepId: number, resolution: Exclude<Resolution, { kind: "open" }>, actor?: "agent" | "user"): { changed: boolean } | { error: string };
  addStep(threadId: string, text: string, afterId: number | null): { id: number } | { error: string };
  /** Records the nudge for the current revision; returns false if another caller already did. */
  markNudged(threadId: string, revision: number): boolean;
};

export function openChecklistStore(db: Db, clock: () => number = Date.now): ChecklistStore {
  function openCurrent(threadId: string, now: number) {
    db.prepare(`UPDATE steps SET opened_at = ? WHERE thread_id = ? AND opened_at IS NULL AND status = 'open'
      AND (section = 'pr' OR id = (SELECT id FROM steps WHERE thread_id = ? AND section = 'playbook' AND status = 'open' ORDER BY position, id LIMIT 1))`)
      .run(now, threadId, threadId);
  }
  const potetoSchema = z.object({
    thread_id: z.string(), activated_at: z.number(), phase: z.enum(["activated", "routed", "stalled", "complete"]),
    charter_state: z.enum(["pending", "sent"]), charter_attempts: z.number(), charter_next_at: z.number(), revivals: z.number(),
    audit_cursor: z.string().nullable(),
  });
  const violationSchema = z.object({
    key: z.string(), kind: z.enum(["pr-before-gate", "work-before-checklist", "audit-unreadable"]), detail: z.string(), observed_at: z.number(),
    acknowledged_at: z.number().nullable(), notified_at: z.number().nullable(),
  });
  function violations(threadId: string): PotetoViolation[] {
    return db.prepare("SELECT * FROM poteto_violations WHERE thread_id = ? ORDER BY observed_at, key").all(threadId).map((raw) => {
      const row = violationSchema.parse(raw);
      return { key: row.key, kind: row.kind, detail: row.detail, observedAt: row.observed_at, acknowledgedAt: row.acknowledged_at, notifiedAt: row.notified_at };
    });
  }
  const evidence = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), id: z.string() }),
    z.object({ kind: z.literal("run"), id: z.string() }),
    z.object({ kind: z.literal("commit"), sha: z.string() }),
    z.object({ kind: z.literal("path"), path: z.string() }),
    z.object({ kind: z.literal("pr"), url: z.string() }),
  ]);
  const rowSchema = z.object({
    thread_id: z.string(), playbook: z.string(), revision: z.number(), nudged_at_revision: z.number().nullable(),
    created_at: z.number(), pr_gate_passed_at: z.number().nullable(),
  });
  const stepSchema = z.object({
    id: z.number(), section: z.enum(["playbook", "pr"]), after_pr: z.number(), text: z.string(),
    status: z.enum(["open", "done", "skipped"]), evidence_json: z.string().nullable(), reason: z.string().nullable(),
    skip_policy: z.enum(["agent", "user", "never"]), opened_at: z.number().nullable(),
  });
  const doneEvidence = z.tuple([evidence], evidence);
  const reason = z.string().trim().min(1).max(500);
  const closedResolution = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("done"), evidence: doneEvidence }),
    z.object({ kind: z.literal("skipped"), reason }),
  ]);
  const read = db.transaction((threadId: string): Checklist | null => {
    const raw = db.prepare("SELECT * FROM checklists WHERE thread_id = ?").get(threadId);
    if (!raw) return null;
    const row = rowSchema.parse(raw);
    const steps = db.prepare("SELECT * FROM steps WHERE thread_id = ? ORDER BY position, id").all(threadId).map((raw) => {
      const step = stepSchema.parse(raw);
      const resolution: Resolution = step.status === "open" ? { kind: "open" }
        : step.status === "done" ? { kind: "done", evidence: doneEvidence.parse(JSON.parse(step.evidence_json ?? "null")) }
        : { kind: "skipped", reason: reason.parse(step.reason) };
      return { id: step.id, section: step.section, text: step.text, afterPr: step.after_pr !== 0, skipPolicy: step.skip_policy, openedAt: step.opened_at, resolution };
    });
    return { threadId, playbook: row.playbook as PlaybookName, revision: row.revision, nudgedAtRevision: row.nudged_at_revision,
      createdAt: row.created_at, prGatePassedAt: row.pr_gate_passed_at, steps };
  });
  return {
    activate(threadId, dispatchKey, now) {
      return db.prepare(`INSERT OR IGNORE INTO poteto_threads (thread_id, activation_seq_key, activated_at, phase)
        VALUES (?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM checklists WHERE thread_id = ?) THEN 'routed' ELSE 'activated' END)`)
        .run(threadId, dispatchKey, now, threadId).changes === 1;
    },
    poteto(threadId) {
      const raw = db.prepare("SELECT * FROM poteto_threads WHERE thread_id = ?").get(threadId);
      if (!raw) return null;
      const row = potetoSchema.parse(raw);
      return { threadId, activatedAt: row.activated_at, phase: row.phase, charterState: row.charter_state,
        charterAttempts: row.charter_attempts, charterNextAt: row.charter_next_at, revivals: row.revivals, auditCursor: row.audit_cursor };
    },
    inProgressPotetoThreads: () => db.prepare("SELECT thread_id FROM poteto_threads WHERE phase IN ('activated', 'routed')").all().map((row) => z.object({ thread_id: z.string() }).parse(row).thread_id),
    violations,
    recordAudit: db.transaction((threadId: string, expectedCursor: string | null, cursor: string | null, entries: readonly ViolationDraft[]) => {
      if (db.prepare("UPDATE poteto_threads SET audit_cursor = COALESCE(?, audit_cursor) WHERE thread_id = ? AND audit_cursor IS ?")
        .run(cursor, threadId, expectedCursor).changes !== 1) return false;
      const insert = db.prepare("INSERT OR IGNORE INTO poteto_violations (thread_id, key, kind, detail, observed_at) VALUES (?, ?, ?, ?, ?)");
      let added = false;
      for (const entry of entries) added = insert.run(threadId, entry.key, entry.kind, entry.detail, entry.observedAt).changes === 1 || added;
      if (added) db.prepare("UPDATE poteto_threads SET phase = 'routed' WHERE thread_id = ? AND phase = 'complete'").run(threadId);
      return true;
    }).immediate,
    acknowledge(threadId, key, now) {
      db.prepare("UPDATE poteto_violations SET acknowledged_at = ? WHERE thread_id = ? AND key = ? AND acknowledged_at IS NULL").run(now, threadId, key);
      return db.prepare("SELECT 1 FROM poteto_violations WHERE thread_id = ? AND key = ?").get(threadId, key) !== undefined;
    },
    claimViolation(threadId, key, now) {
      const row = db.prepare(`UPDATE poteto_violations SET notify_attempts = notify_attempts + 1, notify_next_at = ?
        WHERE thread_id = ? AND key = ? AND notified_at IS NULL AND acknowledged_at IS NULL AND notify_next_at <= ? RETURNING notify_attempts`)
        .get(now + 30_000, threadId, key, now);
      return row ? z.object({ notify_attempts: z.number() }).parse(row).notify_attempts : null;
    },
    violationNotified(threadId, key, attempt, now) {
      db.prepare("UPDATE poteto_violations SET notified_at = ? WHERE thread_id = ? AND key = ? AND notify_attempts = ? AND notified_at IS NULL")
        .run(now, threadId, key, attempt);
    },
    passGate: db.transaction((threadId: string, kind: "pr" | "done", revision: number, now: number) => {
      const checklist = read(threadId);
      if (!checklist || checklist.revision !== revision || !gate(kind, checklist, violations(threadId)).pass) return false;
      if (kind === "pr") db.prepare("UPDATE checklists SET pr_gate_passed_at = COALESCE(pr_gate_passed_at, ?) WHERE thread_id = ? AND revision = ?").run(now, threadId, revision);
      else db.prepare("UPDATE poteto_threads SET phase = 'complete' WHERE thread_id = ? AND phase = 'routed'").run(threadId);
      return true;
    }).immediate,
    queueRevival(threadId, revivals) {
      return db.prepare("UPDATE poteto_threads SET charter_state = 'pending', charter_next_at = 0, revivals = revivals + 1 WHERE thread_id = ? AND phase = 'activated' AND charter_state = 'sent' AND revivals = ?")
        .run(threadId, revivals).changes === 1;
    },
    stall(threadId, now) {
      return db.prepare("UPDATE poteto_threads SET phase = 'stalled', stalled_at = ? WHERE thread_id = ? AND phase = 'activated' AND charter_state = 'sent'")
        .run(now, threadId).changes === 1;
    },
    claimCharter(threadId, now) {
      const row = db.prepare(`UPDATE poteto_threads SET charter_attempts = charter_attempts + 1, charter_next_at = ?
        WHERE thread_id = ? AND phase IN ('activated','routed') AND charter_state = 'pending' AND charter_next_at <= ? RETURNING charter_attempts`)
        .get(now + 30_000, threadId, now);
      return row ? z.object({ charter_attempts: z.number() }).parse(row).charter_attempts : null;
    },
    charterSent(threadId, attempt) {
      return db.prepare("UPDATE poteto_threads SET charter_state = 'sent' WHERE thread_id = ? AND charter_state = 'pending' AND charter_attempts = ?")
        .run(threadId, attempt).changes === 1;
    },
    checklist: read,
    createChecklist: db.transaction((threadId: string, playbook: string, steps: readonly StepDraft[], now: number) => {
      const created = db.prepare("INSERT OR IGNORE INTO checklists (thread_id, playbook, created_at) VALUES (?, ?, ?)")
        .run(threadId, playbook, now).changes === 1;
      if (created) {
        const insert = db.prepare("INSERT INTO steps (thread_id, id, position, section, after_pr, text, skip_policy) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const [index, step] of steps.entries()) insert.run(threadId, index + 1, index, step.section, Number(step.afterPr), step.text, step.skipPolicy);
        openCurrent(threadId, now);
        db.prepare("UPDATE poteto_threads SET phase = 'routed', stalled_at = NULL WHERE thread_id = ? AND phase IN ('activated','stalled')").run(threadId);
      }
      return { created };
    }).immediate,
    resolveStep: db.transaction((threadId: string, stepId: number, resolution: Exclude<Resolution, { kind: "open" }>, actor: "agent" | "user" = "agent") => {
      const parsed = closedResolution.safeParse(resolution);
      if (!parsed.success) return { error: "A step needs evidence or a non-blank reason of at most 500 characters." };
      const checklist = read(threadId);
      if (!checklist) return { error: "Begin a playbook checklist first." };
      const result = closeStep(checklist, stepId, parsed.data, actor);
      if (!result.ok) return { error: result.error };
      if (!result.changed) return { changed: false };
      const changed = db.prepare("UPDATE steps SET status = ?, evidence_json = ?, reason = ? WHERE thread_id = ? AND id = ? AND status = 'open'")
        .run(parsed.data.kind, parsed.data.kind === "done" ? JSON.stringify(parsed.data.evidence) : null,
          parsed.data.kind === "skipped" ? parsed.data.reason : null, threadId, stepId).changes === 1;
      if (changed) db.prepare("UPDATE checklists SET revision = revision + 1 WHERE thread_id = ?").run(threadId);
      if (changed) openCurrent(threadId, clock());
      return { changed };
    }).immediate,
    addStep: db.transaction((threadId: string, text: string, afterId: number | null) => {
      const checklist = read(threadId);
      if (!checklist) return { error: "Begin a playbook checklist first." };
      const result = addStep(checklist, text, afterId);
      if (!result.ok) return { error: result.error };
      db.prepare("INSERT INTO steps (thread_id, id, position, section, after_pr, text) VALUES (?, ?, ?, ?, ?, ?)")
        .run(threadId, result.step.id, 0, result.step.section, Number(result.step.afterPr), result.step.text);
      const position = db.prepare("UPDATE steps SET position = ? WHERE thread_id = ? AND id = ?");
      for (const [index, step] of result.checklist.steps.entries()) position.run(index, threadId, step.id);
      openCurrent(threadId, clock());
      db.prepare("UPDATE checklists SET revision = revision + 1 WHERE thread_id = ?").run(threadId);
      return { id: result.step.id };
    }).immediate,
    markNudged(threadId, revision) {
      return db.prepare("UPDATE checklists SET nudged_at_revision = ? WHERE thread_id = ? AND revision = ? AND (nudged_at_revision IS NULL OR nudged_at_revision != ?)")
        .run(revision, threadId, revision, revision).changes === 1;
    },
  };
}
