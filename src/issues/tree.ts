/**
 * The worker's thread tree, read for signs of progress: the worker, its child threads at any depth, and the hidden
 * threads of the pstack runs any of them started, which carry no parent.
 */
import type { PluginBoundThreadsArea } from "@get-bb/plugin-sdk";
import type { TreeFact } from "./job.ts";

/** The SDK exports the event list's arguments but not the event type union. */
type ThreadEventType = NonNullable<Parameters<PluginBoundThreadsArea["events"]["list"]>[0]["types"]>[number];

/**
 * Events a thread writes while it works. A message sent to the thread (`turn/input/accepted`, `client/*`) is left out,
 * so pstack's own reminder never counts as progress, and so is bookkeeping such as token and rate limit updates.
 */
export const PROGRESS_EVENTS = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/progress",
  "item/delegation/completed",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
] as const satisfies readonly [ThreadEventType, ...ThreadEventType[]];

/** A tree larger than this gives no verdict. */
export const MAX_MEMBERS = 64;

const HELD: ReadonlySet<string> = new Set(["pending", "starting"]);

export type TreeThread = { id: string; status: string; archivedAt: number | null; deletedAt: number | null };
/** A job of a running pstack run, with the threads of its attempts. */
export type RunJob = { state: string; nextActionAt: number | null; attempts: readonly { threadId: string | null }[] };

export type TreeDeps = {
  thread: (threadId: string) => Promise<TreeThread>;
  children: (threadId: string) => Promise<readonly TreeThread[]>;
  /** When the thread last wrote one of PROGRESS_EVENTS, or null when it never has. */
  lastProgress: (threadId: string) => Promise<number | null>;
  /** The jobs of the pstack runs this thread started that are still running. */
  runJobs: (threadId: string) => readonly RunJob[];
  clock: () => number;
};

export const isMissing = (error: unknown) => {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  return candidate?.status === 404 || candidate?.code === "thread_not_found";
};

const gone = (thread: TreeThread) => thread.archivedAt !== null || thread.deletedAt !== null;

const waitingForSlot = (job: RunJob, now: number) => job.state === "queued" && (job.nextActionAt === null || job.nextActionAt <= now);

/** Null when the tree cannot be read whole: the worker cannot be read, a read fails, or the tree is too large. */
export function createTreeActivity(deps: TreeDeps): (threadId: string) => Promise<TreeFact | null> {
  return async (rootId) => {
    const now = deps.clock();
    const seen = new Set([rootId]);
    const pending: { id: string; thread: TreeThread | null }[] = [{ id: rootId, thread: null }];
    let lastActiveAt: number | null = null;
    let queued = false;
    try {
      for (let member = pending.shift(); member; member = pending.shift()) {
        const { id } = member;
        let thread: TreeThread;
        let children: readonly TreeThread[];
        let last: number | null;
        try {
          thread = member.thread ?? (await deps.thread(id));
          if (id !== rootId && gone(thread)) continue;
          [children, last] = await Promise.all([deps.children(id), deps.lastProgress(id)]);
        } catch (error) {
          if (id !== rootId && isMissing(error)) continue;
          throw error;
        }
        if (HELD.has(thread.status)) queued = true;
        if (last !== null) lastActiveAt = Math.max(lastActiveAt ?? 0, last);
        const add = (childId: string, child: TreeThread | null) => {
          if (seen.has(childId)) return;
          seen.add(childId);
          pending.push({ id: childId, thread: child });
        };
        for (const child of children) if (!gone(child)) add(child.id, child);
        for (const job of deps.runJobs(id)) {
          if (waitingForSlot(job, now)) queued = true;
          for (const attempt of job.attempts) if (attempt.threadId) add(attempt.threadId, null);
        }
        if (seen.size > MAX_MEMBERS) return null;
      }
    } catch {
      return null;
    }
    return { lastActiveAt, queued };
  };
}
