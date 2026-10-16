/**
 * The runner's shell: `run start --file <plan.json>`, `run status <id>`, `run stop <id>`, the worker-only
 * `pstack_result` tool (selected per thread through bb.agents.configure), lifecycle event wiring, and the
 * background service. Decisions come from runner.ts; state from run-store.ts.
 */
import type { BbPluginApi, PluginCliCommand } from "@get-bb/plugin-sdk";
import type { Runner } from "./runner.ts";

export type RunFeature = {
  commands: Record<string, PluginCliCommand>;
  /** Count of active runs for an origin thread (suppresses the checklist nudge). */
  activeRuns(threadId: string): number;
  /** Registers the pstack_result tool, the configure selection for worker threads, thread events, and the background service. */
  register(): void;
};

export function createRunFeature(deps: {
  bb: BbPluginApi;
  runner: Runner;
  /** Appended to every command's stdout. */
  footer(threadId: string): string;
}): RunFeature {
  throw new Error("not implemented");
}
