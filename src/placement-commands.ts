import { isAbsolute, join } from "node:path";
import { cliCommand, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NO_REMOTE, pressured, type Checkouts } from "./checkouts.ts";
import type { RemoteBase } from "./remote-base.ts";
import { hostId, NO_CHECKOUT, type HostId, type Need, type Placement, type Target } from "./placement.ts";

const Flags = z.object({
  "parent-self": z.boolean().default(false),
  project: z.string().min(1).optional(),
  "new-environment": z.literal("worktree").optional(),
  environment: z.string().min(1).optional(),
  machine: z.string().min(1).optional(),
  "base-branch": z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  "reasoning-level": z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).optional(),
  "service-tier": z.string().min(1).optional(),
  "permission-mode": z.enum(["auto", "accept-edits", "full", "workspace-write"]).transform((value) => value === "workspace-write" ? "accept-edits" : value).optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  "prompt-file": z.string().min(1).optional(),
  json: z.boolean().default(false),
  "dry-run": z.boolean().default(false),
}).superRefine((flags, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (flags.environment && (flags.machine || flags["new-environment"])) fail("--environment cannot be combined with --machine or --new-environment");
  if (flags.machine === "auto" && flags["new-environment"] !== "worktree") fail("--machine auto needs --new-environment worktree");
  if (flags["base-branch"] && flags["new-environment"] !== "worktree") fail("--base-branch needs --new-environment worktree");
  if (flags.prompt !== undefined && flags["prompt-file"] !== undefined) fail("choose one of --prompt, --prompt-stdin, or --prompt-file");
});
export type SpawnFlags = z.infer<typeof Flags>;
export function parseSpawnFlags(value: unknown): SpawnFlags {
  const parsed = Flags.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new PluginCliError(z.prettifyError(parsed.error), { code: "invalid_spawn_flags" });
}
export interface Invoking {
  projectId: string;
  environmentId: string;
  hostId: HostId;
  model: string | null;
}

export function needFromFlags(flags: SpawnFlags, invoking: Invoking, pinnedHost: HostId | null): Need {
  const id = pinnedHost ?? invoking.hostId;
  const kind = flags["new-environment"];
  const baseBranch = flags["base-branch"] ?? null;
  const home: Need["home"] = flags.environment
    ? { kind: "reuse", environmentId: flags.environment, hostId: id }
    : kind === "worktree" || pinnedHost !== null && id !== invoking.hostId
      ? { kind: "worktree", hostId: id, baseBranch }
      : { kind: "reuse", hostId: id, environmentId: invoking.environmentId };
  const movable = kind === "worktree" && !flags.environment && (!flags.machine || flags.machine === "auto");
  const slash = invoking.model?.indexOf("/") ?? -1;
  const inheritedProvider = slash >= 0 ? invoking.model!.slice(0, slash) : null;
  const provider = flags.provider ?? inheritedProvider;
  const model = flags.model ?? (!flags.provider || flags.provider === inheritedProvider ? invoking.model?.slice(slash + 1) : null);
  return {
    projectId: flags.project ?? invoking.projectId,
    home,
    away: movable ? { kind: "worktree", baseBranch, pin: null } : null,
    affinity: movable ? "spread" : "home",
    model: provider && model ? `${provider}/${model}` : null,
  };
}

export function createPlacementCommands({ bb, placement, checkouts, remoteBase }: { bb: BbPluginApi; placement: Placement; checkouts: Checkouts; remoteBase?: RemoteBase }) {
  /**
   * A fresh worktree on `origin/<branch>` or the default branch starts from the ref remoteBase fetched through the
   * GitHub App. When that fetch fails, bb fetches as before.
   */
  async function throughApp(projectId: string, environment: Target["environment"]): Promise<Target["environment"]> {
    if (!remoteBase || environment.type !== "host" || !environment.hostId || environment.workspace?.type !== "managed-worktree") return environment;
    const named = environment.workspace.baseBranch?.kind === "named" ? environment.workspace.baseBranch.name : null;
    try {
      const ref = await remoteBase({ projectId, hostId: environment.hostId, base: named });
      return ref === null || ref === named ? environment : { ...environment, workspace: { ...environment.workspace, baseBranch: { kind: "named", name: ref } } };
    } catch (error) {
      bb.log.warn(`pstack spawn: ${error instanceof Error ? error.message : String(error)}; bb fetches the base itself`);
      return environment;
    }
  }

  async function origin(ctx: PluginCliContext) {
    if (!ctx.threadId) throw new PluginCliError("placement commands need an invoking thread", { code: "thread_required" });
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (!thread.environmentId) throw new PluginCliError("the invoking thread has no environment", { code: "environment_required" });
    const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const defaults = await bb.sdk.threads.defaultExecutionOptions({ threadId: ctx.threadId });
    return { thread, defaults, invoking: {
      projectId: thread.projectId, environmentId: thread.environmentId, hostId: hostId.parse(env.hostId),
      model: defaults?.model ? `${thread.providerId}/${defaults.model}` : null,
    } };
  }
  async function pin(flags: SpawnFlags, invoking: Invoking): Promise<HostId | null> {
    if (flags.environment) return hostId.parse((await bb.sdk.environments.get({ environmentId: flags.environment })).hostId);
    if (!flags.machine || flags.machine === "auto") return null;
    if (flags.machine === "here") return invoking.hostId;
    const hosts = await bb.sdk.hosts.list();
    const exact = hosts.find((host) => host.id === flags.machine);
    if (exact) return hostId.parse(exact.id);
    const matches = hosts.filter((host) => host.name === flags.machine);
    if (matches.length !== 1) throw new PluginCliError(`machine "${flags.machine}" ${matches.length ? "is ambiguous" : "does not exist"}`, { code: "machine_invalid" });
    return hostId.parse(matches[0].id);
  }
  async function prompt(flags: SpawnFlags, invoking: Invoking, ctx: PluginCliContext): Promise<string> {
    let text = flags.prompt;
    const path = flags["prompt-file"];
    if (path !== undefined) {
      const absolute = isAbsolute(path) ? path : ctx.cwd ? join(ctx.cwd, path) : null;
      if (absolute === null) throw new PluginCliError(`cannot resolve ${path} without a working directory`, { code: "prompt_file_unreadable" });
      try {
        const file = await bb.sdk.files.read({ hostId: invoking.hostId, path: absolute });
        text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      } catch (error) {
        throw new PluginCliError(`cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { code: "prompt_file_unreadable" });
      }
    }
    if (!text?.trim()) throw new PluginCliError("a nonempty --prompt, --prompt-stdin, or --prompt-file is required", { code: "prompt_required" });
    return text;
  }
  return {
    spawn: cliCommand({
      summary: "Spawn a delegate on a machine with free capacity",
      options: {
        "parent-self": { type: "boolean", description: "Make the invoking thread the parent" },
        project: { type: "string", description: "Project id; defaults to the invoking thread's project" },
        "new-environment": { type: "enum", values: ["worktree"], description: "Create a fresh worktree" },
        environment: { type: "string", description: "Reuse this environment and pin its machine" },
        machine: { type: "string", description: "Pin an id, name, or here; auto spreads fresh worktrees" },
        "base-branch": { type: "string", description: "Base branch for a fresh worktree" },
        provider: { type: "string", description: "Provider id; defaults to the invoking thread's provider" },
        model: { type: "string", description: "Model id; defaults to the invoking thread's model when the provider is unchanged" },
        "reasoning-level": { type: "enum", values: ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"], description: "Model reasoning level" },
        "service-tier": { type: "string", description: "Provider service tier" },
        "permission-mode": { type: "enum", values: ["auto", "accept-edits", "full", "workspace-write"], description: "Permission mode; defaults to the invoking thread's mode" },
        title: { type: "string", description: "Thread title" },
        prompt: { type: "string", stdin: true, description: "Prompt text; --prompt-stdin reads standard input" },
        "prompt-file": { type: "string", description: "Prompt file on the invoking thread's machine" },
        json: { type: "boolean", description: "Emit the placement and thread id as JSON" },
        "dry-run": { type: "boolean", description: "Print the placement and spawn arguments without spawning" },
      },
      async run(input, ctx) {
        try {
          const flags = parseSpawnFlags(input.options);
          const { invoking, thread, defaults } = await origin(ctx);
          if (!defaults) throw new PluginCliError("the invoking thread has no resolved execution options to inherit", { code: "execution_unavailable" });
          const text = await prompt(flags, invoking, ctx);
          const sameProvider = !flags.provider || flags.provider === thread.providerId;
          const model = flags.model ?? (sameProvider ? defaults?.model ?? undefined : undefined);
          const providerId = flags.provider ?? thread.providerId;
          const need = needFromFlags(flags, { ...invoking, model: model ? `${providerId}/${model}` : null }, await pin(flags, invoking));
          let spawnArgs: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0] | null = null;
          const result = await placement.place(need, async (target) => {
            spawnArgs = {
              projectId: need.projectId!, environment: flags["dry-run"] ? target.environment : await throughApp(need.projectId!, target.environment), prompt: text,
              parentThreadId: flags["parent-self"] ? ctx.threadId : undefined,
              providerId, model,
              reasoningLevel: flags["reasoning-level"] ?? (sameProvider && (!flags.model || flags.model === defaults?.model) ? defaults?.reasoningLevel : undefined),
              permissionMode: flags["permission-mode"] ?? defaults?.permissionMode,
              serviceTier: flags["service-tier"], title: flags.title,
            };
            if (flags["dry-run"]) return null;
            const created = await bb.sdk.threads.spawn(spawnArgs);
            if (!created.id) throw new PluginCliError("spawn returned no thread id", { code: "spawn_failed" });
            return created.id;
          });
          if (!flags["dry-run"] && !result.threadId) throw new PluginCliError("no thread was spawned", { code: "spawn_failed" });
          const clonable = flags["dry-run"] ? [] : pressured(result.board, need);
          if (clonable.length > 0) checkouts.clone(need.projectId!, clonable.map((host) => host.id));
          const value = { threadId: result.threadId, target: result.target, ...(flags["dry-run"] ? { spawnArgs } : {}) };
          return {
            exitCode: 0,
            stdout: flags.json ? `${JSON.stringify(value, null, 2)}\n`
              : flags["dry-run"] ? `${result.target.why}\n${JSON.stringify(spawnArgs, null, 2)}\n`
              : `${result.threadId}\nplaced on ${result.target.hostName} (${result.target.hostId}); ${result.target.why}\n`,
          };
        } catch (error) {
          if (error instanceof PluginCliError) throw error;
          throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "spawn_failed" });
        }
      },
    }),
    machines: cliCommand({
      summary: "Show machine capacity and placement blockers",
      options: {
        provider: { type: "string", description: "Provider whose model catalog to check" },
        model: { type: "string", description: "Model required on each away machine" },
        json: { type: "boolean", description: "Emit the placement board as JSON" },
        clone: { type: "boolean", description: "Clone the project onto every connected machine without a checkout that no checkouts rule denies" },
      },
      async run(input, ctx) {
        try {
          if (!!input.options.provider !== !!input.options.model) throw new PluginCliError("use --provider and --model together", { code: "invalid_value" });
          const { invoking } = await origin(ctx);
          const flags = parseSpawnFlags({ "new-environment": "worktree", provider: input.options.provider, model: input.options.model });
          const board = await placement.board(needFromFlags(flags, { ...invoking, model: null }, null));
          const cloning = input.options.clone ? await checkouts.cloneEverywhere(invoking.projectId) : null;
          const consent = { allow: "clone allowed, start one with --clone", deny: "clone denied by the checkouts setting" };
          const remoteProblem = board.hosts.some((row) => row.blocker === NO_CHECKOUT)
            ? await checkouts.remote(invoking.projectId).then((url) => url === null ? NO_REMOTE : null, (error) => `git remote unknown (${error instanceof Error ? error.message : String(error)})`)
            : null;
          const lines = await Promise.all(board.hosts.map(async (row) => {
            const clone = row.blocker !== NO_CHECKOUT ? null
              : remoteProblem === NO_REMOTE ? NO_REMOTE
              : [cloning?.some((host) => host.id === row.id) ? "cloning in the background" : consent[await checkouts.verdict(invoking.projectId, row.id)], remoteProblem].filter(Boolean).join("; ");
            const blocker = clone === null ? row.blocker : `${NO_CHECKOUT}; ${clone}`;
            return `${row.id}  ${row.name}  ${row.running}+${row.held}/${row.limit ?? "?"}  ${blocker ?? `${row.free} free`}`;
          }));
          lines.push(`global ${board.global.running}/${board.global.limit ?? "unlimited"}`, `next ${board.next ?? "none"}`);
          if (cloning) lines.push(cloning.length > 0 ? `cloning onto ${cloning.map((host) => host.name).join(", ")}` : "no machine to clone onto");
          return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify(cloning ? { ...board, cloning } : board, null, 2)}\n` : `${lines.join("\n")}\n` };
        } catch (error) {
          if (error instanceof PluginCliError) throw error;
          throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "machines_failed" });
        }
      },
    }),
  };
}
