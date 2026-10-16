import type { Db } from "./store.ts";
import type { Checklist, Resolution, StepDraft } from "./checklist.ts";
import { addStep, closeStep, type PlaybookName } from "./checklist.ts";
import { z } from "zod";

export type ChecklistStore = {
  /** Idempotent: a thread keeps its first checklist; beginning again returns it unchanged. */
  createChecklist(threadId: string, playbook: string, steps: readonly StepDraft[], now: number): { created: boolean };
  checklist(threadId: string): Checklist | null;
  /** CAS on the step's current resolution; bumps the checklist revision when it changes. */
  resolveStep(threadId: string, stepId: number, resolution: Exclude<Resolution, { kind: "open" }>): { changed: boolean } | { error: string };
  addStep(threadId: string, text: string, afterId: number | null): { id: number } | { error: string };
  /** Records the nudge for the current revision; returns false if another caller already did. */
  markNudged(threadId: string, revision: number): boolean;
};

export function openChecklistStore(db: Db): ChecklistStore {
  const evidence = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), id: z.string() }),
    z.object({ kind: z.literal("run"), id: z.string() }),
    z.object({ kind: z.literal("commit"), sha: z.string() }),
    z.object({ kind: z.literal("path"), path: z.string() }),
    z.object({ kind: z.literal("pr"), url: z.string() }),
  ]);
  const rowSchema = z.object({
    thread_id: z.string(), playbook: z.string(), revision: z.number(), nudged_at_revision: z.number().nullable(),
  });
  const stepSchema = z.object({
    id: z.number(), section: z.enum(["playbook", "pr"]), after_pr: z.number(), text: z.string(),
    status: z.enum(["open", "done", "skipped"]), evidence_json: z.string().nullable(), reason: z.string().nullable(),
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
      return { id: step.id, section: step.section, text: step.text, afterPr: step.after_pr !== 0, resolution };
    });
    return { threadId, playbook: row.playbook as PlaybookName, revision: row.revision, nudgedAtRevision: row.nudged_at_revision, steps };
  });
  return {
    checklist: read,
    createChecklist: db.transaction((threadId: string, playbook: string, steps: readonly StepDraft[], now: number) => {
      const created = db.prepare("INSERT OR IGNORE INTO checklists (thread_id, playbook, created_at) VALUES (?, ?, ?)")
        .run(threadId, playbook, now).changes === 1;
      if (created) {
        const insert = db.prepare("INSERT INTO steps (thread_id, id, position, section, after_pr, text) VALUES (?, ?, ?, ?, ?, ?)");
        for (const [index, step] of steps.entries()) insert.run(threadId, index + 1, index, step.section, Number(step.afterPr), step.text);
      }
      return { created };
    }).immediate,
    resolveStep: db.transaction((threadId: string, stepId: number, resolution: Exclude<Resolution, { kind: "open" }>) => {
      const parsed = closedResolution.safeParse(resolution);
      if (!parsed.success) return { error: "A step needs evidence or a non-blank reason of at most 500 characters." };
      const checklist = read(threadId);
      if (!checklist) return { error: "Begin a playbook checklist first." };
      const result = closeStep(checklist, stepId, parsed.data);
      if (!result.ok) return { error: result.error };
      if (!result.changed) return { changed: false };
      const changed = db.prepare("UPDATE steps SET status = ?, evidence_json = ?, reason = ? WHERE thread_id = ? AND id = ? AND status = 'open'")
        .run(parsed.data.kind, parsed.data.kind === "done" ? JSON.stringify(parsed.data.evidence) : null,
          parsed.data.kind === "skipped" ? parsed.data.reason : null, threadId, stepId).changes === 1;
      if (changed) db.prepare("UPDATE checklists SET revision = revision + 1 WHERE thread_id = ?").run(threadId);
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
      db.prepare("UPDATE checklists SET revision = revision + 1 WHERE thread_id = ?").run(threadId);
      return { id: result.step.id };
    }).immediate,
    markNudged(threadId, revision) {
      return db.prepare("UPDATE checklists SET nudged_at_revision = ? WHERE thread_id = ? AND revision = ? AND (nudged_at_revision IS NULL OR nudged_at_revision != ?)")
        .run(revision, threadId, revision, revision).changes === 1;
    },
  };
}
