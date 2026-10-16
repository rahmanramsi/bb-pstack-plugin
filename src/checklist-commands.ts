/**
 * The checklist's shell: CLI commands, the session-instruction block, the footer every pstack command
 * prints, and the idle nudge. Pure decisions come from checklist.ts; state from checklist-store.ts.
 */
import type { BbPluginApi, PluginCliCommand } from "@get-bb/plugin-sdk";
import type { ChecklistStore } from "./checklist-store.ts";

export type ChecklistFeature = {
  /** `checklist begin <playbook>`, `checklist show`, `checklist done <id> --evidence …`, `checklist skip <id> --reason …`, `checklist add <text> [--after <id>]`, `gate pr`, `gate done`. */
  commands: Record<string, PluginCliCommand>;
  /** Open steps, bounded, appended to every pstack command's stdout. Empty when the thread has no checklist. */
  footer(threadId: string): string;
  /** Block for session instructions (synchronous, bounded), or null. */
  instructions(threadId: string): string | null;
  /** thread.idle handler for origin threads: sends at most one agent-only nudge per checklist revision. */
  onIdle(threadId: string): Promise<void>;
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
}): ChecklistFeature {
  throw new Error("not implemented");
}
