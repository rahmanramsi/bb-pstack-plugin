import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gate, renderOpenSteps } from "./checklist.ts";
import { createChecklistFeature } from "./checklist-commands.ts";
import { openChecklistStore } from "./checklist-store.ts";
import { STATE_CHANNEL } from "./contract.ts";
import { PUSH_TIMEOUT_MS, hostContract } from "./host-contract.ts";
import { ISSUE_SETTINGS, parseIssueRepos } from "./issues/commands.ts";
import { createIssues } from "./issues/engine.ts";
import { GitHubSetupError, createGitHub, decodePrivateKey } from "./issues/github.ts";
import { openIssueStore } from "./issues/store.ts";
import { rpcContract } from "./rpc.ts";
import { createRunFeature } from "./run-commands.ts";
import { openRunStore } from "./run-store.ts";
import { RunnerError, createRunner, type RunId } from "./runner.ts";
import { openDatabase } from "./store.ts";
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
    "Each value is `provider/model/level` for `bb thread spawn --provider --model --reasoning-level`, or `inherit-parent` to omit those flags. A role without a line keeps its skill default. `bb pstack models` prints the effective table.",
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
    ...ISSUE_SETTINGS,
  });

  let current = await settings.get();
  let modelsText = current.models;
  settings.onChange((next) => {
    current = next;
    modelsText = next.models;
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
  const checklistStore = openChecklistStore(db);
  const runner = createRunner(bb, runStore, resolveRole, Date.now, async (tuples, environmentId) => {
    const ids = [...new Set(tuples.map((tuple) => tuple.split("/")[0]!))];
    const catalog = await loadCatalog(bb, environmentId ? { environmentId } : {}, ids);
    return tuples.flatMap((tuple) => {
      const check = checkTuple(tuple, catalog);
      return check.ok ? [] : [`${tuple}: ${check.detail}`];
    });
  });

  const activeWork = async (threadId: string) => {
    const children = await bb.sdk.threads.list({ parentThreadId: threadId, limit: 100 });
    const activeChildren = children.filter((child) => child.status === "active" || child.status === "starting").length;
    return { activeRuns: runner.activeRuns(threadId).length, activeChildren };
  };

  const checklist = createChecklistFeature({
    bb,
    store: checklistStore,
    skillsDir: SKILLS_DIR,
    activeWork,
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

  const hosts = bb.hosts.experimental_client({ contract: hostContract });
  const issues = createIssues({
    bb,
    store: openIssueStore(db),
    github: createGitHub({
      credentials: () => {
        if (!current.githubAppId || !current.githubPrivateKey) return null;
        const key = decodePrivateKey(current.githubPrivateKey);
        if (!key.ok) throw new GitHubSetupError(key.error);
        return { appId: current.githubAppId, privateKey: key.pem };
      },
    }),
    hostPush: (hostId, input, signal) => hosts.call("push", input, { hostId, timeoutMs: PUSH_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
    repos: () => {
      if (!current.githubAppId || !current.githubPrivateKey) return [];
      const parsed = parseIssueRepos(current.issueRepos);
      return parsed.ok ? parsed.repos : [];
    },
    resolveRole,
    prGate: (threadId) => {
      const state = checklistStore.checklist(threadId);
      const result = gate("pr", state);
      return result.pass ? result : { pass: false, reason: [result.reason, renderOpenSteps(state, 1200)].filter(Boolean).join("\n") };
    },
    activeWork,
    checkWorker: async (hostId, tuple) => {
      const provider = tuple.split("/")[0]!;
      const catalog = await loadCatalog(bb, { hostId }, [provider]);
      const check = checkTuple(tuple, catalog);
      if (check.ok) return null;
      // A catalog that failed to load says nothing about the tuple, so the job waits instead of sticking.
      if (catalog.get(provider)?.state === "error") throw new Error(`${tuple}: ${check.detail}`);
      return `${tuple}: ${check.detail}`;
    },
  });
  issues.register();

  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) return;
    return checklist.onIdle(thread.id).catch((error) => bb.log.error(`pstack nudge: ${error instanceof Error ? error.message : String(error)}`));
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const parts = [issues.instructions(threadId), instructionsFor(modelsText), checklist.instructions(threadId)].filter((part): part is string => !!part);
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
  });

  bb.cli.register(
    defineCli({
      name: "pstack",
      summary: "pstack model roles, panel and swarm runs, playbook checklists, and GitHub issue workers",
      commands: {
        ...checklist.commands,
        ...runs.commands,
        ...issues.commands,
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
            const catalog = await loadCatalog(bb, environmentId ? { environmentId } : {}, providerIds(roles));
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
