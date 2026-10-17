import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";

export type PotetoPhase = "activated" | "routed" | "stalled" | "complete";
export type PotetoThread = {
  threadId: string;
  activatedAt: number;
  phase: PotetoPhase;
  charterState: "pending" | "sent";
  charterAttempts: number;
  charterNextAt: number;
  revivals: number;
  auditCursor: string | null;
};

/** Replace code with spaces so tokens inside examples never activate the thread. */
export function outsideCode(text: string): string {
  let fence: { char: string; length: number } | null = null;
  return text.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && (!fence || (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()))) {
      fence = fence ? null : { char: marker[1][0], length: marker[1].length };
      return " ".repeat(line.length);
    }
    if (fence) return " ".repeat(line.length);
    return line;
  }).join("\n").replace(/(`+)([\s\S]*?)\1(?!`)/g, (span) => " ".repeat(span.length));
}

export function hasPotetoToken(text: string): boolean {
  return /(?:^|[^\w/$-])[/\u0024]poteto-mode(?=$|[^\w-])/.test(outsideCode(text));
}

export type PotetoDispatch = Pick<MessageDispatchHookContext, "initiator" | "senderThreadId" | "originPluginId" | "input"> & {
  thread: Pick<MessageDispatchHookContext["thread"], "id" | "originPluginId">;
};

export function isPotetoUser(context: PotetoDispatch, pluginId: string): boolean {
  return context.initiator === "user" && context.senderThreadId === null && context.originPluginId === null && context.thread.originPluginId !== pluginId;
}

export function activatesPoteto(context: PotetoDispatch, pluginId: string): boolean {
  if (!isPotetoUser(context, pluginId)) return false;
  if (hasPotetoToken(context.input.text)) return true;
  return context.input.blocks.some((block) => block.type === "text" && block.mentions?.some(({ resource, start, end }) =>
    resource.kind === "command" && resource.source === "skill" && resource.name === "poteto-mode" &&
    outsideCode(block.text).slice(start, end).trim().length > 0));
}

export type PotetoControl = { kind: "waive"; stepId: number; reason: string } | { kind: "ack"; key: string } | { kind: "invalid" };

export function potetoControl(text: string): PotetoControl | null {
  if (/^\s*[/\u0024]poteto-mode\s+ack\b/.test(text)) {
    const match = /^\s*[/\u0024]poteto-mode\s+ack\s+(\S+)\s*$/.exec(text);
    return match ? { kind: "ack", key: match[1] } : { kind: "invalid" };
  }
  if (!/^\s*[/\u0024]poteto-mode\s+waive\b/.test(text)) return null;
  const match = /^\s*[/\u0024]poteto-mode\s+waive\s+([1-9]\d*)\s+([^\r\n]+?)\s*$/.exec(text);
  if (!match || !Number.isSafeInteger(Number(match[1])) || match[2].length > 500) return { kind: "invalid" };
  return { kind: "waive", stepId: Number(match[1]), reason: match[2] };
}

export function revivalDecision(state: PotetoThread, idle: boolean, budget = 3): "deliver" | "revive" | "stall" | "none" {
  if (state.phase !== "activated") return "none";
  if (state.charterState === "pending") return "deliver";
  if (!idle) return "none";
  return state.revivals < budget ? "revive" : "stall";
}

export function potetoCharter(skillPath: string): string {
  return `Poteto-mode is active. Read ${skillPath} in full. Run bb pstack checklist begin <playbook> before any other work. The origin thread owns the playbook, checklist, and every spawn.`;
}
