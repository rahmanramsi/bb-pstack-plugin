/**
 * The runner's shell: `run start --file <plan.json>`, `run status <id>`, `run stop <id>`, the worker-only
 * `pstack_result` tool (selected per thread through bb.agents.configure), lifecycle event wiring, and the
 * background service. Decisions come from runner.ts; state from run-store.ts.
 */
import { PluginCliError, cliCommand, type BbPluginApi, type PluginCliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RUN_ID, RunPlan, runDirective, type RunView } from "./contract.ts";
import { RunnerError, resultToolParameters, type RunId, type Runner } from "./runner.ts";
import { readThreadFile } from "./thread-files.ts";

export type RunFeature = {
  commands: Record<string, PluginCliCommand>;
  /** Count of active runs for an origin thread (suppresses the checklist nudge). */
  activeRuns(threadId: string): number;
  /** Registers the pstack_result tool, the configure selection for worker threads, thread events, and the background service. */
  register(): void;
};

function requireThread(ctx: PluginCliContext): string {
  if (ctx.threadId) return ctx.threadId;
  throw new PluginCliError("run commands act for a thread, and this invocation has none", {
    code: "thread_required",
    hint: "Run it from an agent thread, where BB_THREAD_ID is set.",
  });
}

function runId(value: string): RunId {
  if (RUN_ID.test(value)) return value as RunId;
  throw new PluginCliError(`"${value}" is not a run id`, { code: "invalid_run_id", hint: 'Run ids look like psr_ followed by a UUID, as printed by `bb pstack run start`.' });
}

function cliError(error: unknown): never {
  if (error instanceof RunnerError) throw new PluginCliError(error.message, { code: error.code });
  throw error;
}

function parsePlan(text: string, source: string): RunPlan {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PluginCliError(`${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`, { code: "plan_invalid" });
  }
  const parsed = RunPlan.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new PluginCliError(`${source} is not a run plan:\n${z.prettifyError(parsed.error)}`, {
    code: "plan_invalid",
    hint: 'A plan is {"kind":"panel","title","seats":[…],"judge"?} or {"kind":"swarm","title","brief","slices":[…],"verify"?}.',
  });
}

function describe(view: RunView): string {
  const count = (kind: RunView["jobs"][number]["kind"], noun: string) => {
    const n = view.jobs.filter((job) => job.kind === kind).length;
    return n === 0 ? null : `${n} ${noun}${n === 1 ? "" : "s"}`;
  };
  const parts = [count("seat", "seat"), count("judge", "judge"), count("slice", "slice"), count("verifier", "verifier")].filter(Boolean);
  return `${view.kind} "${view.title}" with ${parts.join(", ")}`;
}

function formatStatus(view: RunView, results: ReturnType<Runner["results"]>): string {
  const width = Math.max(...view.jobs.map((job) => job.label.length));
  const rows = view.jobs.map((job) => {
    const detail = job.state === "succeeded" ? job.summary : job.error;
    return `  ${job.label.padEnd(width)}  ${job.state.padEnd(9)}  ${job.model}${job.host ? `  on ${job.host.name}` : ""}${job.threadId ? `  ${job.threadId}` : ""}${detail ? `  ${detail}` : ""}`;
  });
  const values = results
    .filter((result) => result.state === "succeeded")
    .map((result) => `## ${result.label}\n\n${typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}`);
  return [`${view.id} ${view.kind} "${view.title}": ${view.status}`, ...rows, ...values.map((value) => `\n${value}`)].join("\n");
}

export function createRunFeature(deps: {
  bb: BbPluginApi;
  runner: Runner;
  /** Appended to every command's stdout. */
  footer(threadId: string): string;
  /** Frontmatter names of the plugin's skills; configure must select them for every thread once it is registered. */
  skills: readonly string[];
}): RunFeature {
  const { bb, runner } = deps;

  const output = (threadId: string, text: string) => {
    const footer = deps.footer(threadId);
    return { exitCode: 0, stdout: `${text}\n${footer ? `${footer}\n` : ""}` };
  };
  const json = (value: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });

  const commands: Record<string, PluginCliCommand> = {
    "run start": cliCommand({
      summary: "Start a panel or swarm run from a plan and print its chat directive",
      description:
        "Workers run as hidden threads owned by this thread. Copy the printed directive into your reply once, on its own line. When the run ends, this thread gets one agent-only message with every job's outcome.",
      options: {
        file: { type: "string", description: "Plan JSON on this thread's machine; a relative path resolves against the current directory" },
        "plan-json": { type: "string", description: "The plan as inline JSON, for small plans" },
        json: { type: "boolean", description: "Emit {runId, existing, status, directive} as JSON" },
      },
      constraints: [{ kind: "exactly-one", options: ["file", "plan-json"] }],
      async run(input, ctx) {
        const threadId = requireThread(ctx);
        const plan =
          input.options.file !== undefined
            ? parsePlan(await readThreadFile(bb, { threadId, cwd: ctx.cwd, path: input.options.file, errorCode: "plan_file_unreadable" }), input.options.file)
            : parsePlan(input.options["plan-json"]!, "--plan-json");
        const started = await runner.start(plan, threadId).catch(cliError);
        const view = runner.view(started.runId, threadId);
        if (input.options.json) {
          return json({ runId: started.runId, existing: started.existing, status: view.status, directive: runDirective(started.runId) });
        }
        const summary = started.existing
          ? `Already started: ${describe(view)}, ${view.status}.`
          : `Started ${describe(view)}. One agent-only message arrives when it finishes.`;
        return output(threadId, [started.runId, summary, runDirective(started.runId)].join("\n"));
      },
    }),
    "run status": cliCommand({
      summary: "Print a run's jobs and every result so far",
      positionals: [{ name: "id", description: "Run id (psr_…)", required: true }],
      options: { json: { type: "boolean", description: "Emit the run view and results as JSON" } },
      async run(input, ctx) {
        const threadId = requireThread(ctx);
        const id = runId(input.positionals.id);
        try {
          const view = runner.view(id, threadId);
          const results = runner.results(id, threadId);
          return input.options.json ? json({ ...view, results }) : output(threadId, formatStatus(view, results));
        } catch (error) {
          cliError(error);
        }
      },
    }),
    "run stop": cliCommand({
      summary: "Stop a running run: cancel open jobs and stop their workers",
      positionals: [{ name: "id", description: "Run id (psr_…)", required: true }],
      async run(input, ctx) {
        const threadId = requireThread(ctx);
        const id = runId(input.positionals.id);
        const stopped = await runner.stop(id, threadId).catch(cliError);
        const text = stopped ? `Stopped ${id}.` : `${id} already finished: ${runner.view(id, threadId).status}.`;
        return output(threadId, text);
      },
    }),
  };

  function register(): void {
    bb.agents.registerTool({
      name: "pstack_result",
      presentation: { label: { pending: "Returning result", completed: "Returned result" }, suppress: true },
      description:
        'Return your result to the pstack run that started this thread. Call it exactly once with {"value": ...} matching the result contract at the end of your prompt.',
      parameters: z.object({ value: z.unknown() }),
      async execute({ value }, ctx) {
        const result = await runner.submit(ctx.threadId, value);
        return result.ok ? "Result accepted. Your work for this run is done." : { content: [{ type: "text", text: result.error }], isError: true };
      },
    });

    bb.agents.configure((context) => {
      const kind = runner.workerResult(context.thread.id, context.pluginMetadata);
      const tools = kind === null || kind === "text" ? [] : [{ name: "pstack_result", parameters: resultToolParameters(kind) }];
      return { tools, skills: [...deps.skills] };
    });

    const logged = (label: string, work: Promise<void>) =>
      work.catch((error) => bb.log.error(`pstack ${label}: ${error instanceof Error ? error.message : String(error)}`));
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
      if (thread.originPluginId === bb.pluginId) return logged("idle", runner.onIdle(thread.id, lastAssistantText));
    });
    bb.events.on("thread.failed", ({ thread, error }) => {
      if (thread.originPluginId === bb.pluginId) return logged("failed", runner.onFailed(thread.id, error));
    });
    bb.events.on("thread.archived", ({ thread }) => logged("archived", runner.onGone(thread.id)));
    bb.events.on("thread.deleted", ({ thread }) => logged("deleted", runner.onGone(thread.id)));

    bb.background.service("pstack-runner", { start: (signal) => runner.serve(signal) });
  }

  return {
    commands,
    activeRuns: (threadId) => runner.activeRuns(threadId).length,
    register,
  };
}
