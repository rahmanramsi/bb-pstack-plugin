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

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Each prefix maps to its short options that take the next word as their value.
const PREFIXES = new Map([["sudo", "CDghpRrTtUu"], ["env", "CSu"], ["xargs", "adEILnPRSs"], ["time", "fo"], ["nohup", ""], ["command", ""], ["exec", "a"],
  ["!", ""], ["{", ""], ["if", ""], ["then", ""], ["else", ""], ["elif", ""], ["do", ""], ["while", ""], ["until", ""]]);

function basename(word: string): string { return word.slice(word.lastIndexOf("/") + 1); }

function closingParen(script: string, from: number): number {
  let depth = 1;
  for (let index = from; index < script.length; index++) {
    if (script[index] === "(") depth++;
    else if (script[index] === ")" && --depth === 0) return index;
  }
  return script.length;
}

export function simpleCommands(script: string): string[][] {
  const commands: string[][] = [];
  const heredocs: string[] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCommand = () => { endWord(); if (words.length > 0) commands.push(words); words = []; };
  let index = 0;
  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1] ?? "";
    if (char === "\\") {
      if (next !== "\n") word = (word ?? "") + next;
      index += 2;
    } else if (char === "'") {
      const end = script.indexOf("'", index + 1);
      const stop = end < 0 ? script.length : end;
      word = (word ?? "") + script.slice(index + 1, stop);
      index = stop + 1;
    } else if (char === '"') {
      let text = "";
      for (index++; index < script.length && script[index] !== '"';) {
        const escaped = script[index + 1] ?? "";
        if (script[index] === "\\" && escaped !== "" && '"\\$`\n'.includes(escaped)) {
          if (escaped !== "\n") text += escaped;
          index += 2;
        } else if (script.startsWith("$(", index)) {
          const end = closingParen(script, index + 2);
          commands.push(...simpleCommands(script.slice(index + 2, end)));
          text += script.slice(index, end + 1);
          index = end + 1;
        } else text += script[index++];
      }
      word = (word ?? "") + text;
      index++;
    } else if (char === "#" && word === null) {
      const end = script.indexOf("\n", index);
      index = end < 0 ? script.length : end;
    } else if (script.startsWith("<<", index) && !script.startsWith("<<<", index)) {
      endWord();
      const heredoc = /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>]+))/.exec(script.slice(index));
      if (heredoc) heredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]);
      index += heredoc ? heredoc[0].length : 2;
    } else if (char === "\n") {
      endCommand();
      index++;
      for (const delimiter of heredocs.splice(0)) {
        while (index < script.length) {
          const end = script.indexOf("\n", index);
          const line = script.slice(index, end < 0 ? script.length : end);
          index = end < 0 ? script.length : end + 1;
          if (line.trim() === delimiter) break;
        }
      }
    } else if (char === "&" && (next === ">" || /[<>]$/.test(word ?? ""))) {
      word = (word ?? "") + char;
      index++;
    } else if (";&|()`".includes(char)) {
      endCommand();
      index++;
    } else if (char === " " || char === "\t") {
      endWord();
      index++;
    } else {
      word = (word ?? "") + char;
      index++;
    }
  }
  endCommand();
  return commands;
}

function invocation(words: string[]): string[] {
  let rest = words;
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_]\w*=/.test(rest[0])) rest = rest.slice(1);
    const valued = rest.length > 0 ? PREFIXES.get(basename(rest[0])) : undefined;
    if (valued === undefined) return rest;
    let index = 1;
    while (index < rest.length && rest[index].startsWith("-")) {
      if (rest[index] === "--") { index++; break; }
      index += rest[index].length === 2 && valued.includes(rest[index][1]) ? 2 : 1;
    }
    rest = rest.slice(index);
  }
}

function shellScript([program, ...args]: string[]): string | null {
  if (!SHELLS.has(basename(program))) return null;
  let command = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-o" || arg === "+o") index++;
    else if (/^-[a-zA-Z]+$/.test(arg)) command ||= arg.includes("c");
    else if (!/^(?:\+[a-zA-Z]+|--.*)$/.test(arg)) return command ? arg : null;
  }
  return null;
}

export function createsPr(command: string): boolean {
  return simpleCommands(command).some((words) => {
    const program = invocation(words);
    if (program.length === 0) return false;
    const script = shellScript(program);
    if (script !== null) return createsPr(script);
    // `bb pstack gh pr create` is `gh pr create` behind two more words.
    const [name, group, action, ...flags] = basename(program[0]!) === "bb" && program[1] === "pstack" && program[2] === "gh" ? ["gh", ...program.slice(3)] : program;
    return ["gh", "origin"].includes(basename(name!)) && group === "pr" && (action === "create" || action === "new")
      && !flags.includes("--help") && !flags.includes("-h");
  });
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
