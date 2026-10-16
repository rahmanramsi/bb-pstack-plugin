import { z } from "zod";

export type ViolationKind = "pr-before-gate" | "work-before-checklist" | "audit-unreadable";
export type ViolationDraft = { key: string; kind: ViolationKind; detail: string; observedAt: number };
export type PotetoViolation = ViolationDraft & { acknowledgedAt: number | null; notifiedAt: number | null };
export type AuditContext = { activatedAt: number; checklistAt: number | null; prGateAt: number | null };
export type TimelineAction =
  | { kind: "command"; itemId: string; at: number; command: string }
  | { kind: "file-change"; itemId: string; at: number; paths: string[] }
  | { kind: "unreadable"; at: number; detail: string }
  | { kind: "other"; at: number };

const envelope = z.object({ seq: z.number().int().nonnegative(), createdAt: z.number(), type: z.string(), data: z.unknown() });
const itemEnvelope = z.object({ item: z.object({ id: z.string().min(1), type: z.string() }) });
const commandItem = z.object({ item: z.object({ command: z.string() }) });
const fileItem = z.object({ item: z.object({ changes: z.array(z.object({ path: z.string() })) }) });

export function classifyTimelineEvent(raw: unknown, now: number): TimelineAction {
  const row = envelope.safeParse(raw);
  if (!row.success) return { kind: "unreadable", at: now, detail: "The timeline event envelope is unreadable." };
  const { type, data, createdAt: at } = row.data;
  if (type !== "item/completed") return { kind: "other", at };
  const header = itemEnvelope.safeParse(data);
  if (!header.success) return { kind: "unreadable", at, detail: "A completed timeline item has no readable type or id." };
  const itemId = header.data.item.id;
  switch (header.data.item.type) {
    case "commandExecution": {
      const parsed = commandItem.safeParse(data);
      return parsed.success ? { kind: "command", itemId, at, command: parsed.data.item.command }
        : { kind: "unreadable", at, detail: `Command ${itemId} has no readable command text.` };
    }
    case "fileChange": {
      const parsed = fileItem.safeParse(data);
      return parsed.success ? { kind: "file-change", itemId, at, paths: parsed.data.item.changes.map((change) => change.path) }
        : { kind: "unreadable", at, detail: `File change ${itemId} has no readable paths.` };
    }
    default: return { kind: "other", at };
  }
}

export function createsPr(command: string): boolean {
  let delimiter: string | null = null;
  const executable = command.split("\n").filter((line) => {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      return false;
    }
    const heredoc = /<<-?\s*['"]?([a-zA-Z_]\w*)['"]?/.exec(line);
    if (heredoc) delimiter = heredoc[1];
    return true;
  }).join("\n");
  return /(?:^|[\n;&|()])\s*(?:command\s+)?(?:gh|origin)\s+pr\s+create\b/.test(executable);
}

export function deriveViolation(context: AuditContext, action: TimelineAction): ViolationDraft | null {
  if (action.at < context.activatedAt) return null;
  switch (action.kind) {
    case "unreadable": return { key: "audit-unreadable", kind: "audit-unreadable", detail: action.detail, observedAt: action.at };
    case "file-change": return context.checklistAt === null || context.checklistAt > action.at
      ? { key: `work-before-checklist:${action.itemId}`, kind: "work-before-checklist", detail: `Files changed before checklist begin: ${action.paths.join(", ").slice(0, 1000)}`, observedAt: action.at } : null;
    case "command": return createsPr(action.command) && (context.prGateAt === null || context.prGateAt > action.at)
      ? { key: `pr-before-gate:${action.itemId}`, kind: "pr-before-gate", detail: "A PR-create command completed before gate pr passed.", observedAt: action.at } : null;
    case "other": return null;
  }
}

export function auditPage(raw: unknown, context: AuditContext, now: number): { cursor: string | null; violations: ViolationDraft[] } {
  const page = z.array(z.unknown()).safeParse(raw);
  if (!page.success) return { cursor: null, violations: [{ key: "audit-unreadable", kind: "audit-unreadable", detail: "The timeline page is unreadable.", observedAt: now }] };
  let seq: number | null = null;
  const violations: ViolationDraft[] = [];
  for (const value of page.data) {
    const parsed = envelope.safeParse(value);
    if (parsed.success) seq = Math.max(seq ?? 0, parsed.data.seq);
    const violation = deriveViolation(context, classifyTimelineEvent(value, now));
    if (violation) violations.push(violation);
  }
  return { cursor: seq === null ? null : String(seq), violations };
}
