/**
 * The checklist's shell: CLI commands, the session-instruction block, the footer every pstack command
 * prints, and the idle nudge. Pure decisions come from checklist.ts; state from checklist-store.ts.
 */
import type { BbPluginApi, PluginCliCommand, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { activatesPoteto, isPotetoUser, potetoControl, potetoCharter, revivalDecision, type PotetoDispatch } from "./poteto.ts";
import { auditPage } from "./poteto-audit.ts";
import {
  extractSteps, gate, parseEvidence, parseReason, playbookSources, renderOpenSteps, shouldNudge,
  closeStep, type Evidence, type Resolution,
} from "./checklist.ts";
import type { ChecklistStore } from "./checklist-store.ts";

const AUDIT_PAGE_SIZE = 100;

export type ChecklistFeature = {
  /** `checklist begin <playbook>`, `checklist show`, `checklist done <id> --evidence …`, `checklist skip <id> --reason …`, `checklist add <text> [--after <id>]`, `gate pr`, `gate done`. */
  commands: Record<string, PluginCliCommand>;
  /** Open steps, bounded, appended to every pstack command's stdout. Empty when the thread has no checklist. */
  footer(threadId: string): string;
  /** Block for session instructions (synchronous, bounded), or null. */
  instructions(threadId: string): string | null;
  /** thread.idle handler for origin threads: sends at most one agent-only nudge per checklist revision. */
  onIdle(threadId: string): Promise<void>;
  dispatch(context: PotetoDispatch): MessageDispatchHookDecision;
  reconcile(threadId: string, idle?: boolean): Promise<void>;
  serve(signal: AbortSignal): Promise<void>;
};

export function createChecklistFeature(deps: {
  bb: BbPluginApi;
  store: ChecklistStore;
  /** Absolute path of the plugin's skills directory. */
  skillsDir: string;
  /** Live work that suppresses the nudge: active pstack runs and active child threads. */
  activeWork(threadId: string): Promise<{ activeRuns: number; activeChildren: number }>;
  /** Called after every committed change so the UI refetches. */
  publish(threadId: string): void;
  evidenceError(evidence: Evidence, threadId: string, openedAt: number): Promise<string | null>;
  clock?: () => number;
}): ChecklistFeature {
  const { bb, store, publish } = deps;
  const sources = playbookSources(deps.skillsDir);
  const clock = deps.clock ?? Date.now;
  const charter = potetoCharter(join(deps.skillsDir, "poteto-mode", "SKILL.md"));
  const reconciling = new Set<string>();
  const pendingPublications = new Set<string>();
  const auditing = new Map<string, Promise<boolean>>();
  function audit(id: string): Promise<boolean> {
    const current = auditing.get(id);
    if (current) return current;
    const work = (async () => {
      for (let page = 0; page < 20; page++) {
        const state = store.poteto(id);
        if (!state) return true;
        const rows = await bb.sdk.threads.events.list({ threadId: id, afterSeq: state.auditCursor ?? "0", order: "asc", limit: String(AUDIT_PAGE_SIZE) });
        const checklist = store.checklist(id);
        const result = auditPage(rows, { activatedAt: state.activatedAt, checklistAt: checklist?.createdAt ?? null, prGateAt: checklist?.prGatePassedAt ?? null }, clock());
        if (!store.recordAudit(id, state.auditCursor, result.cursor, result.violations)) continue;
        if (result.violations.length > 0) publish(id);
        if (rows.length < AUDIT_PAGE_SIZE) return true;
        if (result.cursor === null || result.cursor === state.auditCursor) return false;
      }
      return false;
    })().finally(() => auditing.delete(id));
    auditing.set(id, work);
    return work;
  }
  function violationStatus(id: string): string {
    const violations = store.violations(id).filter((violation) => violation.acknowledgedAt === null);
    return violations.length ? `Poteto violations (${violations.length}) hold gate done.\n${violations.map((violation) => `${violation.key}: ${violation.detail}\nUser acknowledgement: /poteto-mode ack ${violation.key}`).join("\n")}` : "";
  }
  function potetoStatus(id: string): string {
    const state = store.poteto(id);
    if (!state) return "";
    return state.phase === "stalled"
      ? "Poteto-mode stalled. Begin a checklist with bb pstack checklist begin <playbook> to continue."
      : `Poteto-mode ${state.phase}.`;
  }
  async function reconcile(id: string, idle = false): Promise<void> {
    if (reconciling.has(id)) return;
    reconciling.add(id);
    try {
      if (pendingPublications.delete(id)) publish(id);
      const state = store.poteto(id);
      if (!state) return;
      const decision = revivalDecision(state, idle);
      if (decision === "stall") {
        if (store.stall(id, clock())) publish(id);
      }
      if (decision === "revive") store.queueRevival(id, state.revivals);
      const attempt = store.claimCharter(id, clock());
      if (attempt !== null) {
        await bb.sdk.threads.send({ threadId: id, mode: "steer-if-active", input: [{ type: "text", text: charter, mentions: [], visibility: "agent-only" }] });
        if (store.charterSent(id, attempt)) publish(id);
      }
      await audit(id);
      for (const violation of store.violations(id)) {
        const attempt = store.claimViolation(id, violation.key, clock());
        if (attempt === null) continue;
        await bb.sdk.threads.send({ threadId: id, mode: "steer-if-active", input: [{ type: "text", visibility: "agent-only", mentions: [],
          text: `Poteto violation ${violation.key}. ${violation.detail} Gate done is held. Only the user can acknowledge it with /poteto-mode ack ${violation.key}.` }] });
        store.violationNotified(id, violation.key, attempt, clock());
      }
    } finally { reconciling.delete(id); }
  }
  const threadOption = { type: "string", description: "Thread to use instead of the invoking thread" } as const;
  function threadId(override: string | undefined, current: string | undefined): string {
    const id = override ?? current;
    if (!id?.trim()) throw new PluginCliError("A thread is required.", { hint: "Pass --thread <thread-id>." });
    return id;
  }
  function stepId(raw: string): number | { error: string } {
    const id = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : { error: "Step id must be a positive integer." };
  }
  function evidenceText(evidence: Evidence): string {
    switch (evidence.kind) {
      case "thread": case "run": return `${evidence.kind}:${evidence.id}`;
      case "commit": return `commit:${evidence.sha}`;
      case "path": return `path:${evidence.path}`;
      case "pr": return `pr:${evidence.url}`;
    }
  }
  function footer(id: string): string {
    const text = [potetoStatus(id), violationStatus(id).slice(0, 1400), renderOpenSteps(store.checklist(id), 2400)].filter(Boolean).join("\n");
    return text ? `${text}\n` : "";
  }
  function output(id: string, text: string, exitCode = 0) {
    return { exitCode, stdout: `${text}\n${footer(id)}` };
  }
  function resolve(id: string, rawId: string, resolution: Exclude<Resolution, { kind: "open" }>) {
    const parsed = stepId(rawId);
    if (typeof parsed !== "number") return output(id, parsed.error, 1);
    const result = store.resolveStep(id, parsed, resolution);
    if ("error" in result) return output(id, result.error, 1);
    if (result.changed) publish(id);
    return output(id, `Step ${parsed} ${result.changed ? "closed" : "already closed"}.`);
  }
  const commands: Record<string, PluginCliCommand> = {
    "checklist begin": cliCommand({
      summary: "Snapshot a playbook and its Opening a PR steps once for this thread",
      options: { thread: threadOption },
      positionals: [{ name: "playbook", description: "Bundled playbook name", required: true }],
      run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        const existing = store.checklist(id);
        if (existing) return output(id, `Checklist already uses ${existing.playbook}.`);
        const name = input.positionals.playbook;
        const source = [...sources].find(([key]) => key === name)?.[1];
        if (!source) return output(id, `Unknown playbook "${name}". Choose ${[...sources.keys()].join(", ")}.`, 1);
        const prSource = [...sources].find(([key]) => key === "opening-a-pr")?.[1];
        try {
          const steps = extractSteps(readFileSync(source.file, "utf8"), source.extractor, name === "opening-a-pr" ? "pr" : "playbook");
          if (steps.length === 0) return output(id, `No steps found in ${source.file}.`, 1);
          if (name !== "opening-a-pr") {
            if (!prSource) return output(id, "Opening a PR source is missing.", 1);
            const prSteps = extractSteps(readFileSync(prSource.file, "utf8"), prSource.extractor, "pr");
            if (prSteps.length === 0) return output(id, `No steps found in ${prSource.file}.`, 1);
            steps.push(...prSteps);
          }
          const result = store.createChecklist(id, name, steps, clock());
          if (result.created) publish(id);
          return output(id, result.created ? `Checklist begun with ${steps.length} steps.` : "Checklist already exists.");
        } catch (error) {
          return output(id, error instanceof Error ? error.message : String(error), 1);
        }
      },
    }),
    "checklist show": cliCommand({
      summary: "Show every snapshotted step and its evidence or skip reason",
      options: { thread: threadOption },
      run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        const checklist = store.checklist(id);
        if (!checklist) return output(id, "Begin a playbook checklist first.", 1);
        const text = checklist.steps.map((step) => {
          const resolution = step.resolution;
          const detail = resolution.kind === "done" ? `\nEvidence: ${resolution.evidence.map(evidenceText).join(", ")}`
            : resolution.kind === "skipped" ? `\nReason: ${resolution.reason}` : "";
          return `${step.id}. [${resolution.kind}; ${step.section}${step.afterPr ? "; after PR" : ""}] ${step.text}${detail}`;
        }).join("\n\n");
        return output(id, `${checklist.playbook}, revision ${checklist.revision}\n\n${text}`);
      },
    }),
    "checklist done": cliCommand({
      summary: "Close a step with one or more evidence references",
      options: { thread: threadOption, evidence: { type: "string", repeatable: true, required: true, description: "thread:, run:, commit:, path:, or pr: reference" } },
      positionals: [{ name: "id", description: "Step id", required: true }],
      async run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        const references = input.options.evidence.map(parseEvidence);
        const invalid = references.find((reference) => "error" in reference);
        if (invalid && "error" in invalid) return output(id, invalid.error, 1);
        const evidence = references.filter((reference): reference is Evidence => !("error" in reference));
        const parsedId = stepId(input.positionals.id);
        if (typeof parsedId !== "number") return output(id, parsedId.error, 1);
        const checklist = store.checklist(id);
        if (!checklist) return output(id, "Begin a playbook checklist first.", 1);
        const [first, ...rest] = evidence;
        if (!first) return output(id, "At least one evidence reference is required.", 1);
        const check = closeStep(checklist, parsedId, { kind: "done", evidence: [first, ...rest] });
        if (!check.ok) return output(id, check.error, 1);
        if (!check.changed) return output(id, `Step ${parsedId} already closed.`);
        const step = checklist.steps.find((step) => step.id === parsedId);
        if (!step || step.openedAt === null) return output(id, "This step is not open yet. Close the earlier playbook steps first.", 1);
        for (const reference of evidence) {
          const problem = await deps.evidenceError(reference, id, step.openedAt);
          if (problem) return output(id, problem, 1);
        }
        return resolve(id, input.positionals.id, { kind: "done", evidence: [first, ...rest] });
      },
    }),
    "checklist skip": cliCommand({
      summary: "Close a step with a reason of at most 500 characters",
      options: { thread: threadOption, reason: { type: "string", required: true, description: "Why this step does not apply" } },
      positionals: [{ name: "id", description: "Step id", required: true }],
      run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        const reason = parseReason(input.options.reason);
        return typeof reason === "string" ? resolve(id, input.positionals.id, { kind: "skipped", reason }) : output(id, reason.error, 1);
      },
    }),
    "checklist add": cliCommand({
      summary: "Add a task-specific step without changing copied steps",
      options: { thread: threadOption, after: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, description: "Insert after this step id; default appends" } },
      positionals: [{ name: "text", description: "Step text", required: true }],
      run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        const result = store.addStep(id, input.positionals.text, input.options.after ?? null);
        if ("error" in result) return output(id, result.error, 1);
        publish(id);
        return output(id, `Added step ${result.id}. To add the next step after it, pass --after ${result.id}.`);
      },
    }),
  };
  for (const kind of ["pr", "done"] as const) {
    commands[`gate ${kind}`] = cliCommand({
      summary: `Check that the ${kind} gate has no open steps`,
      options: { thread: threadOption },
      async run(input, ctx) {
        const id = threadId(input.options.thread, ctx.threadId);
        try {
          if (!await audit(id)) return output(id, "The poteto timeline audit is still catching up. Run this gate again before continuing.", 1);
        } catch (error) {
          return output(id, `The poteto timeline audit failed. Retry this gate before continuing. ${error instanceof Error ? error.message : String(error)}`, 1);
        }
        const state = store.checklist(id);
        const result = gate(kind, state, store.violations(id));
        if (result.pass && state) {
          if (!store.passGate(id, kind, state.revision, clock())) return output(id, "The checklist changed during the gate. Run this gate again.", 1);
          publish(id);
        }
        return result.pass ? output(id, `${kind} gate passed.`)
          : output(id, `${result.reason}\n${result.open.map((step) => `${step.id}. [${step.section}] ${step.text}`).join("\n\n")}`, 1);
      },
    });
  }
  return {
    commands, footer, reconcile,
    dispatch(context) {
      if (!isPotetoUser(context, bb.pluginId)) return { action: "proceed" };
      const control = potetoControl(context.input.text);
      if (control) {
        if (control.kind === "invalid") return { action: "reject", message: "Use /poteto-mode waive <step> <reason> or /poteto-mode ack <key>. A waiver reason needs 1 to 500 characters." };
        if (control.kind === "ack") {
          const found = store.acknowledge(context.thread.id, control.key, clock());
          if (found) pendingPublications.add(context.thread.id);
          return { action: "reject", message: found ? `Acknowledged ${control.key}. Run bb pstack gate done again after closing the remaining steps.` : `Unknown violation ${control.key}. Run bb pstack checklist show to see this thread's violations.` };
        }
        const result = store.resolveStep(context.thread.id, control.stepId, { kind: "skipped", reason: control.reason }, "user");
        if (!("error" in result) && result.changed) pendingPublications.add(context.thread.id);
        return { action: "reject", message: "error" in result ? result.error : `Step ${control.stepId} waived. Run bb pstack checklist show to see the next step.` };
      }
      if (activatesPoteto(context, bb.pluginId) && store.activate(context.thread.id, `poteto:${context.thread.id}`, clock())) pendingPublications.add(context.thread.id);
      return { action: "proceed" };
    },
    async serve(signal) {
      while (!signal.aborted) {
        for (const id of pendingPublications) { pendingPublications.delete(id); publish(id); }
        for (const id of store.potetoThreads()) {
          if (signal.aborted) break;
          try {
            const thread = await bb.sdk.threads.get({ threadId: id });
            if (thread.archivedAt !== null || thread.deletedAt !== null || !["active", "starting", "idle", "pending"].includes(thread.status)) continue;
            await reconcile(id, thread.status === "idle");
          } catch (error) { bb.log.error(`pstack poteto ${id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        await sleep(15_000, undefined, { signal }).catch(() => undefined);
      }
    },
    instructions(id) {
      const checklist = store.checklist(id);
      if (!checklist) return store.poteto(id) ? `${potetoStatus(id)}\n${charter}` : null;
      const prefix = "Close each playbook step with evidence or a skip reason. Run bb pstack gate pr before creating a PR and bb pstack gate done before the final reply.\n";
      const status = violationStatus(id).slice(0, 700);
      return `${status}${status ? "\n" : ""}${prefix}${renderOpenSteps(checklist, 1500 - prefix.length - status.length - 1)}`;
    },
    async onIdle(id) {
      if (store.poteto(id)) await reconcile(id, true);
      const checklist = store.checklist(id);
      if (!checklist || !shouldNudge(checklist, await deps.activeWork(id))) return;
      if (!store.markNudged(id, checklist.revision)) return;
      publish(id);
      await bb.sdk.threads.send({ threadId: id, mode: "steer-if-active", input: [{
        type: "text", text: `Your playbook checklist has open steps. Close them with evidence or a skip reason.\n${renderOpenSteps(checklist, 1400)}`,
        mentions: [], visibility: "agent-only",
      }] });
    },
  };
}
