import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  parseModelConfig,
  renderTable,
  type ModelConfig,
} from "./models.ts";
import {
  checkRoles,
  failedRequired,
  providerIds,
  renderChecks,
  type Check,
  type ProviderCatalog,
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

const WORKFLOWS_DIR = fileURLToPath(new URL("../workflows/", import.meta.url));

function workflowNames(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.slice(0, -".js".length))
    .sort();
}

function workflowSource(name: string): string {
  const names = workflowNames();
  if (!names.includes(name)) {
    throw new PluginCliError(`unknown workflow "${name}"`, {
      code: "workflow_not_found",
      hint: `Bundled workflows: ${names.join(", ")}.`,
    });
  }
  return readFileSync(`${WORKFLOWS_DIR}${name}.js`, "utf8");
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
  });

  let modelsText = (await settings.get()).models;
  settings.onChange((next) => {
    modelsText = next.models;
  });

  async function workflowsRunning(): Promise<boolean> {
    const plugins = await bb.sdk.plugins.list();
    const workflows = plugins.plugins.find((plugin) => plugin.id === "workflows");
    return workflows?.enabled === true && workflows.status === "running";
  }

  bb.agents.contributeInstructions(() => instructionsFor(modelsText));

  bb.cli.register(
    defineCli({
      name: "pstack",
      summary: "pstack model roles and bundled bb workflows",
      commands: {
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
            "Check that every role's model exists in the live provider catalog, and that bb workflows are ready",
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
            const routing = environmentId ? { environmentId } : {};
            const providers = await bb.sdk.providers.list(routing);
            const entries = await Promise.all(
              providerIds(roles).map(async (id): Promise<[string, ProviderCatalog] | null> => {
                const info = providers.find((provider) => provider.id === id);
                if (!info) return null;
                if (!info.available) return [id, { state: "unavailable" }];
                try {
                  const result = await bb.sdk.providers.models({ ...routing, providerId: id });
                  if (result.modelLoadError) {
                    return [
                      id,
                      {
                        state: "error",
                        detail: result.modelLoadError.detail ?? result.modelLoadError.code,
                      },
                    ];
                  }
                  return [
                    id,
                    {
                      state: "ok",
                      models: result.models.map((entry) => ({
                        model: entry.model,
                        levels: entry.supportedReasoningEfforts.map(
                          (effort) => effort.reasoningEffort,
                        ),
                      })),
                    },
                  ];
                } catch (error) {
                  return [
                    id,
                    { state: "error", detail: error instanceof Error ? error.message : String(error) },
                  ];
                }
              }),
            );
            const catalog = new Map(entries.filter((entry) => entry !== null));
            const checks: Check[] = checkRoles(roles, catalog);

            const workflowsReady = await workflowsRunning();
            checks.push({
              ok: workflowsReady,
              required: false,
              subject: "workflows plugin",
              detail: workflowsReady
                ? "running, so panels can use pstack-panel and pstack-swarm"
                : "not running, so panels fall back to child threads (enable with `bb plugin enable workflows`)",
            });
            let bundled: string[] = [];
            try {
              bundled = workflowNames();
            } catch {
              bundled = [];
            }
            checks.push({
              ok: bundled.length > 0,
              required: true,
              subject: "bundled workflows",
              detail: bundled.length > 0 ? bundled.join(", ") : `none found in ${WORKFLOWS_DIR}`,
            });

            const failed = failedRequired(checks);
            return {
              exitCode: failed.length > 0 ? 1 : 0,
              stdout: input.options.json
                ? `${JSON.stringify({ environmentId: environmentId ?? null, checks }, null, 2)}\n`
                : `${renderChecks(checks)}\n`,
            };
          },
        }),
        "workflow list": cliCommand({
          summary: "List the bb workflows bundled with pstack",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          run(input) {
            const names = workflowNames();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? `${JSON.stringify(names)}\n`
                : `${names.join("\n")}\n`,
            };
          },
        }),
        "workflow ready": cliCommand({
          summary:
            "Exit 0 and print `ready` when bb workflows can run pstack's bundled workflows, else exit 1 and print why",
          async run() {
            if (!(await workflowsRunning())) {
              return {
                exitCode: 1,
                stdout:
                  "not ready: the workflows plugin is not running. Spawn child threads instead, or ask the user to run `bb plugin enable workflows`.\n",
              };
            }
            const names = workflowNames();
            return names.length > 0
              ? { exitCode: 0, stdout: `ready: ${names.join(", ")}\n` }
              : { exitCode: 1, stdout: `not ready: no bundled workflows in ${WORKFLOWS_DIR}\n` };
          },
        }),
        "workflow source": cliCommand({
          summary:
            "Print a bundled workflow's JavaScript, for `bb workflows run --script` or the bb_workflow_run tool's script field",
          positionals: [
            { name: "name", description: "Workflow name, e.g. pstack-panel", required: true },
          ],
          run(input) {
            return { exitCode: 0, stdout: workflowSource(input.positionals.name) };
          },
        }),
      },
    }),
  );
}
