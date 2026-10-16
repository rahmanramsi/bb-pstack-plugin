import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Playbook checklists: pure domain. The plugin, not the agent, copies a playbook's steps from the
 * skill files; a step closes only as done-with-evidence or skip-with-reason; the PR gate and the
 * idle nudge are pure functions of stored state. Persistence lives in store.ts, wiring in server.ts.
 */

/** Every playbook name `bb pstack checklist begin` accepts, derived from skills/poteto-mode/playbooks/*.md plus figure-it-out. */
export type PlaybookName = string & { readonly __brand: "PlaybookName" };

export type StepSection = "playbook" | "pr";
export type SkipPolicy = "agent" | "user" | "never";

/** Opening a PR paragraphs that can only be done once the PR exists. `gate pr` ignores them; `gate done` does not. A test fails if a label disappears from the source. */
export const AFTER_PR_LEADS = ["Readiness"] as const;

/** A playbook step that runs Opening a PR creates the PR, so it can only close once the PR exists. */
export const RUNS_OPENING_A_PR = /\bRun \*\*Opening a PR\*\*/;

/** A source step with policy markers removed from the displayed Markdown. */
export type StepDraft = { section: StepSection; text: string; afterPr: boolean; skipPolicy: SkipPolicy };

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

export type Step = StepDraft & { id: number; openedAt: number | null; resolution: Resolution };

export type Checklist = {
  threadId: string;
  playbook: PlaybookName;
  steps: readonly Step[];
  /** Bumped on every step mutation. */
  revision: number;
  /** The revision at which the one idle nudge was sent, or null. */
  nudgedAtRevision: number | null;
  createdAt: number;
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
  const dir = join(skillsDir, "poteto-mode", "playbooks");
  const sources = new Map<PlaybookName, { file: string; extractor: Extractor }>();
  for (const file of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
    const name = file.slice(0, -3) as PlaybookName;
    sources.set(name, { file: join(dir, file), extractor: name === "opening-a-pr" ? "paragraphs" : "numbered" });
  }
  sources.set("figure-it-out" as PlaybookName, { file: join(skillsDir, "figure-it-out", "SKILL.md"), extractor: "phases" });
  return sources;
}

/** Pure: Markdown in, ordered steps out. Sub-bullets fold into their parent step's text. */
export function extractSteps(markdown: string, extractor: Extractor, section: StepSection): StepDraft[] {
  const steps: StepDraft[] = [];
  const lines = markdown.split("\n");
  let current: string[] = [];
  let afterPr = false;
  let fence: string | null = null;
  function flush() {
    if (current.length > 0) {
      while (current.at(-1)?.trim() === "") current.pop();
      const parsed = parseSkipPolicy(current.join("\n"));
      steps.push({ section, ...parsed, afterPr: afterPr || (extractor === "numbered" && RUNS_OPENING_A_PR.test(parsed.text)) });
      current = [];
    }
  }
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      if (current.length > 0) current.push(line);
      continue;
    }
    if (fence !== null) {
      if (current.length > 0) current.push(line);
      continue;
    }
    const lead = line.match(/^\*\*([^*]+?)\.\*\*/);
    const starts = extractor === "numbered" ? /^\d+\.\s+\S/.test(line)
      : extractor === "phases" ? /^## (?:Start|Phase [A-E](?::.*)?)\r?$/.test(line)
      : lead !== null;
    if (starts) {
      flush();
      afterPr = extractor === "paragraphs" && AFTER_PR_LEADS.some((label) => label === lead?.[1]);
      current = [line];
    } else if (current.length > 0) {
      if ((extractor === "numbered" && line.trim() !== "" && !/^\s/.test(line)) ||
          (extractor === "phases" && /^#{1,2} /.test(line))) flush();
      else current.push(line);
    }
  }
  flush();
  return steps;
}

export function parseSkipPolicy(source: string): { text: string; skipPolicy: SkipPolicy } {
  let skipPolicy: SkipPolicy = "agent";
  const text = source.replace(/<!--\s*pstack:\s*skip=([^>]*?)\s*-->/g, (_marker, value: string) => {
    if (value !== "agent" && value !== "user" && value !== "never") throw new Error(`Unknown pstack skip policy "${value}".`);
    skipPolicy = value;
    return "";
  }).split("\n").map((line) => line.trimEnd()).join("\n").trimEnd();
  return { text, skipPolicy };
}

export function closureError(checklist: Checklist, step: Step, resolution: Exclude<Resolution, { kind: "open" }>, actor: "agent" | "user"): string | null {
  const first = checklist.steps.find((candidate) => candidate.section === "playbook" && candidate.resolution.kind === "open");
  if (step.section === "playbook" && first && first.id !== step.id) return `Step ${first.id} is still open. Close it before step ${step.id}. Run bb pstack checklist show.`;
  if (resolution.kind !== "skipped") return null;
  if (step.skipPolicy === "never") return `Step ${step.id} cannot be skipped. Complete it with evidence using bb pstack checklist done ${step.id} --evidence <reference>.`;
  if (step.skipPolicy === "user" && actor !== "user") return `Step ${step.id} needs a user waiver. The user must send /poteto-mode waive ${step.id} <reason>.`;
  return null;
}

export function evidenceFreshnessError(evidence: Evidence, createdAt: number, openedAt: number): string | null {
  if (createdAt >= openedAt) return null;
  const label = evidence.kind === "thread" || evidence.kind === "run" ? `${evidence.kind}:${evidence.id}` : evidence.kind;
  return `${label} predates this step. Start fresh work after the step opens, then close it with that new thread: or run: reference.`;
}

/** Boundary parser for `--evidence thread:thr_x`, `run:psr_…`, `commit:<sha>`, `path:<p>`, `pr:<url>`. */
export function parseEvidence(raw: string): Evidence | { error: string } {
  const value = raw.trim();
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const payload = value.slice(colon + 1);
  if (colon < 0 || !payload.trim() || /[\r\n\0]/.test(payload)) return { error: "Evidence needs a kind and a non-blank value." };
  switch (kind) {
    case "thread":
      if (/^thr_[a-zA-Z0-9_-]+$/.test(payload)) return { kind, id: payload };
      break;
    case "run":
      if (/^psr_[0-9a-f-]{36}$/.test(payload)) return { kind, id: payload };
      break;
    case "commit":
      if (/^[0-9a-f]{7,40}$/i.test(payload)) return { kind, sha: payload };
      break;
    case "path": return { kind, path: payload };
    case "pr": {
      const url = URL.parse(payload);
      if (url && ["http:", "https:"].includes(url.protocol) && url.hostname) return { kind, url: payload };
      break;
    }
  }
  return { error: "Use thread:<id>, run:<id>, commit:<sha>, path:<path>, or pr:<http-url> as evidence." };
}

/** Boundary parser for a skip reason: trimmed, non-blank, at most 500 chars. */
export function parseReason(raw: string): string | { error: string } {
  const reason = raw.trim();
  return reason.length > 0 && reason.length <= 500 ? reason : { error: "A skip reason must contain 1 to 500 characters." };
}

/** Closing the same step identically is a no-op; a different resolution on a closed step is a conflict. */
export function closeStep(
  checklist: Checklist,
  stepId: number,
  resolution: Exclude<Resolution, { kind: "open" }>,
  actor: "agent" | "user" = "agent",
): { ok: true; checklist: Checklist; changed: boolean } | { ok: false; error: string } {
  const step = checklist.steps.find((step) => step.id === stepId);
  if (!step) return { ok: false, error: `Step ${stepId} does not exist.` };
  if (step.resolution.kind !== "open") {
    return isDeepStrictEqual(step.resolution, resolution)
      ? { ok: true, checklist, changed: false }
      : { ok: false, error: `Step ${stepId} already has a different resolution.` };
  }
  const problem = closureError(checklist, step, resolution, actor);
  if (problem) return { ok: false, error: problem };
  return { ok: true, changed: true, checklist: {
    ...checklist,
    revision: checklist.revision + 1,
    steps: checklist.steps.map((step) => step.id === stepId ? { ...step, resolution } : step),
  } };
}

/**
 * `bb pstack checklist add "<text>" [--after <id>]`: task-specific steps (figure-it-out's designed units).
 * Added steps get the next id and close like any other; copied steps can never be removed or reworded.
 */
export function addStep(checklist: Checklist, text: string, afterId: number | null): { ok: true; checklist: Checklist; step: Step } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: "Step text cannot be blank." };
  const index = afterId === null ? checklist.steps.length - 1 : checklist.steps.findIndex((step) => step.id === afterId);
  if (afterId !== null && index < 0) return { ok: false, error: `Step ${afterId} does not exist.` };
  const step: Step = {
    id: Math.max(0, ...checklist.steps.map((step) => step.id)) + 1,
    section: "playbook", text, afterPr: false, skipPolicy: "agent", openedAt: null, resolution: { kind: "open" },
  };
  const steps = [...checklist.steps];
  steps.splice(index + 1, 0, step);
  return { ok: true, step, checklist: { ...checklist, steps, revision: checklist.revision + 1 } };
}

export type GateResult = { pass: true } | { pass: false; open: readonly Step[]; reason: string };

/**
 * `bb pstack gate pr` (before creating the PR): fails with no checklist or any open step except `afterPr` ones.
 * `bb pstack gate done` (before the final reply): fails with any open step at all.
 */
export function gate(kind: "pr" | "done", checklist: Checklist | null): GateResult {
  if (!checklist) return { pass: false, open: [], reason: "Begin a playbook checklist first." };
  const open = checklist.steps.filter((step) => step.resolution.kind === "open" && (kind === "done" || !step.afterPr));
  return open.length === 0 ? { pass: true } : { pass: false, open, reason: `${open.length} open steps block the ${kind} gate.` };
}

/** One nudge per checklist revision: idle, open steps remain, no active run or child, not yet nudged at this revision. */
export function shouldNudge(checklist: Checklist, context: { activeRuns: number; activeChildren: number }): boolean {
  return checklist.steps.some((step) => step.resolution.kind === "open") &&
    context.activeRuns === 0 && context.activeChildren === 0 && checklist.nudgedAtRevision !== checklist.revision;
}

/** The footer every pstack CLI command prints and the session-instruction block (bounded to `maxChars`). */
export function renderOpenSteps(checklist: Checklist | null, maxChars: number): string {
  if (!checklist || maxChars <= 0) return "";
  const open = checklist.steps.filter((step) => step.resolution.kind === "open");
  const heading = `Open playbook steps (${checklist.playbook}): ${open.length}.`;
  const lines = open.map((step) => `${step.id}. [${step.section}${step.afterPr ? ", after PR" : ""}] ${step.text.replace(/\s+/g, " ").slice(0, 180)}`);
  let output = heading;
  for (const [index, line] of lines.entries()) {
    const remaining = lines.length - index - 1;
    const suffix = remaining > 0 ? `\n${remaining} more open steps. Run bb pstack checklist show.` : "";
    if (`${output}\n${line}${suffix}`.length > maxChars) {
      return `${output}\n${lines.length - index} more open steps. Run bb pstack checklist show.`.slice(0, maxChars);
    }
    output += `\n${line}`;
  }
  return output.slice(0, maxChars);
}
