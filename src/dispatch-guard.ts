import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostId, REFRESH_MS, type Need, type Placement, type Target } from "./placement.ts";

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

const FreshWorktree = z.object({
  kind: z.literal("provider"),
  environmentProviderId: z.literal("git-worktree"),
  machine: z.object({ type: z.literal("existing"), hostId }),
  inputs: z.object({
    branch: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("default") }),
      z.object({ kind: z.literal("named"), name: z.string().min(1) }),
    ]),
  }),
});

/**
 * The only dispatch the guard may refuse: the first turn of a delegate an agent spawned with
 * `bb thread spawn --parent-self --new-environment worktree`. Returns what that delegate needs,
 * with home affinity so it leaves home only when home is full.
 */
export function delegateStart(context: MessageDispatchHookContext): Need | null {
  if (context.attempt !== "start-turn" || context.environment !== null) return null;
  // bb reports an agent's CLI spawn as initiator "user" with no senderThreadId. The cli origin
  // plus a parent link is what tells it apart from a person starting a thread, and from the
  // threads pstack and other plugins spawn, which arrive with origin "plugin".
  if (context.origin !== "cli" || context.parentThreadId === null || context.thread.originKind === "fork") return null;
  const intent = FreshWorktree.safeParse(context.environmentIntent);
  const { providerId, model } = context.requestedExecution;
  if (!intent.success || model === null) return null;
  const { branch } = intent.data.inputs;
  const baseBranch = branch.kind === "named" ? branch.name : null;
  return {
    projectId: context.project.id,
    home: { kind: "worktree", hostId: intent.data.machine.hostId, baseBranch },
    away: { kind: "worktree", baseBranch, pin: null },
    affinity: "home",
    model: `${providerId}/${model}`,
  };
}

export function decide(context: MessageDispatchHookContext, wouldMove: (need: Need) => Target | null): MessageDispatchHookDecision {
  const need = delegateStart(context);
  const target = need && wouldMove(need);
  if (!need || !target) return PROCEED;
  const home = context.host?.name ?? need.home.hostId;
  return {
    action: "reject",
    message: `${target.why}. Spawn this delegate again with \`bb pstack spawn\` and the same flags to place it on ${target.hostName}, `
      + `or add \`--machine ${need.home.hostId}\` to that command to wait for a slot on ${home}.`,
  };
}

/**
 * Starts the placement refresh service and returns the guard's `message.dispatch` answer. The caller registers it:
 * bb allows one handler per hook per plugin, so server.ts composes it with the checklist's.
 */
export function registerDispatchGuard(
  bb: BbPluginApi,
  placement: Placement,
  enabled: () => boolean,
): (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision> {
  const guard = async (context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> => {
    if (!enabled()) return PROCEED;
    try {
      if (!delegateStart(context)) return PROCEED;
      const occupancy = { requestedAt: Date.now(), threads: await bb.sdk.threads.listRunning() };
      return decide(context, (need) => placement.wouldMove(need, occupancy));
    } catch (error) {
      bb.log.warn(`pstack dispatch guard: ${error instanceof Error ? error.message : String(error)}`);
      return PROCEED;
    }
  };
  bb.background.service("pstack-placement", {
    async start(signal) {
      while (!signal.aborted) {
        await placement.refresh().catch((error) => bb.log.warn(`pstack placement refresh: ${error instanceof Error ? error.message : String(error)}`));
        await sleep(REFRESH_MS, undefined, { signal }).catch(() => undefined);
      }
    },
  });
  return guard;
}
