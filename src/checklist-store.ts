import type { Db } from "./store.ts";
import type { Checklist, Resolution, StepDraft } from "./checklist.ts";

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
  throw new Error("not implemented");
}
