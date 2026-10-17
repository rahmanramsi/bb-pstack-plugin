import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createChecklistFeature } from "./checklist-commands.ts";
import { openChecklistStore } from "./checklist-store.ts";
import { STATE_CHANNEL } from "./contract.ts";
import { rpcContract } from "./rpc.ts";
import { createRunFeature } from "./run-commands.ts";
import { openRunStore } from "./run-store.ts";
import { RunnerError, createRunner, type RunId } from "./runner.ts";
import { openDatabase } from "./store.ts";
import { createPlacement } from "./placement.ts";
import { createPlacementCommands } from "./placement-commands.ts";
import { registerDispatchGuard } from "./dispatch-guard.ts";
import { createCheckouts, parseCheckouts } from "./checkouts.ts";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ROLES,
  effectiveRoles,
  findRole,
  parseChoice,
  parseModelConfig,
  type ModelChoice,
  renderTable,
  type ModelConfig,
} from "./models.ts";
import {
  checkRoles,
  checkTuple,
  failedChecks,
  loadCatalog,
  providerIds,
  renderChecks,
  type Check,
} from "./doctor.ts";

const EMPTY_CONFIG: ModelConfig = { budget: null, roles: new Map() };

const modelsSchema = z.string().superRefine((value, ctx) => {
  const parsed = parseModelConfig(value);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.errors.join("; ") });
});

const checkoutsSchema = z.string().superRefine((value, ctx) => {
  const parsed = parseCheckouts(value);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.errors.join("; ") });
});

function toConfig(text: string): ModelConfig {
  const parsed = parseModelConfig(text);
  return parsed.ok ? parsed.config : EMPTY_CONFIG;
}

const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

function skillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const name = /^name:\s*"?([^"\n]+?)"?\s*$/m.exec(readFileSync(`${SKILLS_DIR}${entry.name}/SKILL.md`, "utf8"))?.[1];
        return name ? [name] : [];
      } catch {
        return [];
      }
    });
}

const INSTRUCTIONS_MAX = 4000;

function evidenceLabel(evidence: { kind: string } & Record<string, string>): string {
  const value = evidence.id ?? evidence.sha ?? evidence.path ?? evidence.url;
  return `${evidence.kind}:${value}`;
}

function instructionsFor(text: string): string | null {
  const configured = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && (!line.startsWith("#") || line.startsWith("# budget")));
  if (configured.length === 0) return null;
  return [
    "pstack model configuration (set with /setup-pstack, overrides the defaults in pstack skills).",
    "Each value is `provider/model/level` for `bb pstack spawn --provider --model --reasoning-level`, or `inherit-parent` to omit those flags. A role without a line keeps its skill default. `bb pstack models` prints the effective table.",
    "",
    ...configured,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    models: {
      type: "string",
      label: "Model roles",
      description:
        "One `role: provider/model/level` line per role, written by /setup-pstack. Panel roles take a comma-separated list. Empty keeps every skill default.",
      experimental_multiline: true,
      experimental_schema: modelsSchema,
      default: "",
    },
    placementGuard: {
      type: "boolean",
      label: "Placement guard",
      description:
        "Refuse an agent's plain `bb thread spawn` into a fresh worktree when its machine is full and another machine has room, and point the agent at `bb pstack spawn`.",
      default: true,
    },
    checkouts: {
      type: "string",
      label: "Checkouts",
      description:
        "Where pstack may clone a project so delegates can run there. One `<projectId|*> allow|deny <hostId|*>` line per rule. The most specific rule wins; deny wins a tie. A machine with no rule is asked about in the thread when it would help.",
      experimental_multiline: true,
      experimental_schema: checkoutsSchema,
      default: "",
    },
  });

  let { models: modelsText, placementGuard } = await settings.get();
  settings.onChange((next) => {
    modelsText = next.models;
    placementGuard = next.placementGuard;
  });

  const resolveRole = (role: string): ModelChoice[] => {
    const label = findRole(role);
    const entry = effectiveRoles(toConfig(modelsText)).find((candidate) => candidate.role === label);
    return (entry?.models ?? []).flatMap((value) => {
      const choice = parseChoice(value);
      return choice ? [choice] : [];
    });
  };

  const db = openDatabase(bb);
  const runStore = openRunStore(db);
  const isRunWorker = (threadId: string) => runStore.attemptByThread(threadId) !== null;
  const placement = createPlacement(bb);
  registerDispatchGuard(bb, placement, () => placementGuard);
  const checkouts = createCheckouts(bb, {
    get: async () => (await settings.get()).checkouts,
    set: async (text) => { await settings.experimental_set({ checkouts: text }); },
  });
  const checklistStore = openChecklistStore(db);
  const runner = createRunner(bb, runStore, {
    resolveRole,
    placement,
    async modelProblems(tuples, environmentId) {
      const ids = [...new Set(tuples.map((tuple) => tuple.split("/")[0]!))];
      const catalog = await loadCatalog(bb, environmentId, ids);
      return tuples.flatMap((tuple) => {
        const check = checkTuple(tuple, catalog);
        return check.ok ? [] : [`${tuple}: ${check.detail}`];
      });
    },
  });

  const checklist = createChecklistFeature({
    bb,
    store: checklistStore,
    skillsDir: SKILLS_DIR,
    activeWork: async (threadId) => {
      const children = await bb.sdk.threads.list({ parentThreadId: threadId, limit: 100 });
      const activeChildren = children.filter((child) => child.status === "active" || child.status === "starting").length;
      return { activeRuns: runner.activeRuns(threadId).length, activeChildren };
    },
    publish: (threadId) => bb.realtime.publish(STATE_CHANNEL, { threadId, revision: Date.now() }),
    evidenceError: async (evidence, threadId) => {
      if (evidence.kind === "thread") {
        const found = await bb.sdk.threads.get({ threadId: evidence.id }).then(() => true, () => false);
        return found ? null : `Thread ${evidence.id} does not exist.`;
      }
      if (evidence.kind === "run") {
        return runStore.info(evidence.id as RunId)?.origin.threadId === threadId ? null : `Run ${evidence.id} is not a run started from this thread.`;
      }
      return null;
    },
  });

  const runs = createRunFeature({ bb, runner, footer: checklist.footer, skills: skillNames() });
  runs.register();

  bb.events.on("thread.idle", ({ thread }) => {
    if (isRunWorker(thread.id)) return;
    return checklist.onIdle(thread.id).catch((error) => bb.log.error(`pstack nudge: ${error instanceof Error ? error.message : String(error)}`));
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const parts = [instructionsFor(modelsText), checklist.instructions(threadId)].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join("\n\n").slice(0, INSTRUCTIONS_MAX) : null;
  });

  bb.rpc.register(rpcContract, {
    pstackThreadView: async ({ threadId }) => {
      const state = checklistStore.checklist(threadId);
      return {
        revision: runStore.revision(threadId) + (state?.revision ?? 0),
        activeRuns: runner.activeRuns(threadId).map((id) => {
          const view = runner.view(id, threadId);
          return { id: view.id, kind: view.kind, title: view.title, status: view.status, jobs: view.jobs };
        }),
        checklist: state && {
          playbook: state.playbook,
          open: state.steps.filter((step) => step.resolution.kind === "open").length,
          steps: state.steps.map((step) => ({
            id: String(step.id),
            section: step.section,
            text: step.text,
            status: step.resolution.kind,
            evidence: step.resolution.kind === "done" ? step.resolution.evidence.map(evidenceLabel) : [],
            reason: step.resolution.kind === "skipped" ? step.resolution.reason : null,
          })),
        },
      };
    },
    pstackRunView: async ({ threadId, runId }) => {
      try {
        return runner.view(runId as RunId, threadId);
      } catch (error) {
        if (error instanceof RunnerError && error.code === "run_not_found") return null;
        throw error;
      }
    },
    pstackStopRun: async ({ threadId, runId }) => ({ stopped: await runner.stop(runId as RunId, threadId) }),
    pstackCheckoutProof: async ({ formId }) => ({ sent: checkouts.publishProof(formId) }),
  });

  bb.cli.register(
    defineCli({
      name: "pstack",
      summary: "pstack model roles, panel and swarm runs, and playbook checklists",
      commands: {
        ...checklist.commands,
        ...runs.commands,
        ...createPlacementCommands({ bb, placement, checkouts }),
        models: cliCommand({
          summary:
            "Print the effective role-to-model table (configured values merged over defaults)",
          description:
            'Change roles with /setup-pstack, or `bb plugin config pstack set models "<lines>"`. With --role, print only that role\'s values, one per line.',
          options: {
            role: {
              type: "string",
              description: `Print one role's values, one per line. Roles: ${ROLES.map((role) => role.label).join(" | ")}`,
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const config = toConfig((await settings.get()).models);
            const roles = effectiveRoles(config);
            if (input.options.role !== undefined) {
              const label = findRole(input.options.role);
              const role = roles.find((entry) => entry.role === label);
              if (!role) {
                throw new PluginCliError(`unknown role "${input.options.role}"`, {
                  code: "unknown_role",
                  hint: "Run `bb pstack models` to list every role.",
                });
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? `${JSON.stringify(role, null, 2)}\n`
                  : `${role.models.join("\n")}\n`,
              };
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({ budget: config.budget, roles }, null, 2)}\n`,
              };
            }
            return { exitCode: 0, stdout: `${renderTable(config)}\n` };
          },
        }),
        doctor: cliCommand({
          summary:
            "Check that every role's model exists in the live provider catalog",
          options: {
            environment: {
              type: "string",
              description:
                "Environment whose machine's model catalog to check (defaults to the invoking thread's environment)",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const roles = effectiveRoles(toConfig((await settings.get()).models));
            let environmentId = input.options.environment;
            if (environmentId === undefined && ctx.threadId) {
              const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
              environmentId = thread.environmentId ?? undefined;
            }
            const catalog = await loadCatalog(bb, environmentId, providerIds(roles));
            const checks: Check[] = checkRoles(roles, catalog);
            const failed = failedChecks(checks);
            return {
              exitCode: failed.length > 0 ? 1 : 0,
              stdout: input.options.json
                ? `${JSON.stringify({ environmentId: environmentId ?? null, checks }, null, 2)}\n`
                : `${renderChecks(checks)}\n`,
            };
          },
        }),
      },
    }),
  );
}
