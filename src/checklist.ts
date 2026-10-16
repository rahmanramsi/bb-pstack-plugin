/**
 * Playbook checklists: pure domain. The plugin, not the agent, copies a playbook's steps from the
 * skill files; a step closes only as done-with-evidence or skip-with-reason; the PR gate and the
 * idle nudge are pure functions of stored state. Persistence lives in store.ts, wiring in server.ts.
 */

/** Every playbook name `bb pstack checklist begin` accepts, derived from skills/poteto-mode/playbooks/*.md plus figure-it-out. */
export type PlaybookName = string & { readonly __brand: "PlaybookName" };

export type StepSection = "playbook" | "pr";

/** Opening a PR paragraphs that can only be done once the PR exists. `gate pr` ignores them; `gate done` does not. A test fails if a label disappears from the source. */
export const AFTER_PR_LEADS = ["Readiness"] as const;

/** A step as extracted from source, before it is stored. `text` is the source Markdown, verbatim. */
export type StepDraft = { section: StepSection; text: string; afterPr: boolean };

export type Evidence =
  | { kind: "thread"; id: string }
  | { kind: "run"; id: string }
  | { kind: "commit"; sha: string }
  | { kind: "path"; path: string }
  | { kind: "pr"; url: string };

export type Resolution =
  | { kind: "open" }
  | { kind: "done"; evidence: readonly [Evidence, ...Evidence[]] }
  | { kind: "skipped"; reason: string };

export type Step = { id: number; section: StepSection; text: string; afterPr: boolean; resolution: Resolution };

export type Checklist = {
  threadId: string;
  playbook: PlaybookName;
  steps: readonly Step[];
  /** Bumped on every step mutation. */
  revision: number;
  /** The revision at which the one idle nudge was sent, or null. */
  nudgedAtRevision: number | null;
};

/** Where each playbook's steps come from and how to extract them. One table, no branching elsewhere. */
export type Extractor = "numbered" | "phases" | "paragraphs";

/**
 * Lists every playbook from the skills directory. `feature` → playbooks/feature.md (numbered),
 * `figure-it-out` → figure-it-out/SKILL.md (its Start item plus Phase A–E headings),
 * `opening-a-pr` → playbooks/opening-a-pr.md (bold-lead paragraphs, section "pr").
 * Every playbook except opening-a-pr gets the opening-a-pr steps appended in section "pr".
 */
export function playbookSources(skillsDir: string): Map<PlaybookName, { file: string; extractor: Extractor }> {
  throw new Error("not implemented");
}

/** Pure: Markdown in, ordered steps out. Sub-bullets fold into their parent step's text. */
export function extractSteps(markdown: string, extractor: Extractor, section: StepSection): StepDraft[] {
  throw new Error("not implemented");
}

/** Boundary parser for `--evidence thread:thr_x`, `run:psr_…`, `commit:<sha>`, `path:<p>`, `pr:<url>`. */
export function parseEvidence(raw: string): Evidence | { error: string } {
  throw new Error("not implemented");
}

/** Boundary parser for a skip reason: trimmed, non-blank, at most 500 chars. */
export function parseReason(raw: string): string | { error: string } {
  throw new Error("not implemented");
}

/** Closing the same step identically is a no-op; a different resolution on a closed step is a conflict. */
export function closeStep(
  checklist: Checklist,
  stepId: number,
  resolution: Exclude<Resolution, { kind: "open" }>,
): { ok: true; checklist: Checklist; changed: boolean } | { ok: false; error: string } {
  throw new Error("not implemented");
}

/**
 * `bb pstack checklist add "<text>" [--after <id>]`: task-specific steps (figure-it-out's designed units).
 * Added steps get the next id and close like any other; copied steps can never be removed or reworded.
 */
export function addStep(checklist: Checklist, text: string, afterId: number | null): { ok: true; checklist: Checklist; step: Step } | { ok: false; error: string } {
  throw new Error("not implemented");
}

export type GateResult = { pass: true } | { pass: false; open: readonly Step[]; reason: string };

/**
 * `bb pstack gate pr` (before creating the PR): fails with no checklist or any open step except `afterPr` ones.
 * `bb pstack gate done` (before the final reply): fails with any open step at all.
 */
export function gate(kind: "pr" | "done", checklist: Checklist | null): GateResult {
  throw new Error("not implemented");
}

/** One nudge per checklist revision: idle, open steps remain, no active run or child, not yet nudged at this revision. */
export function shouldNudge(checklist: Checklist, context: { activeRuns: number; activeChildren: number }): boolean {
  throw new Error("not implemented");
}

/** The footer every pstack CLI command prints and the session-instruction block (bounded to `maxChars`). */
export function renderOpenSteps(checklist: Checklist | null, maxChars: number): string {
  throw new Error("not implemented");
}
