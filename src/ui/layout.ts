import type { z } from "zod";
import { RUN_ID, type ChecklistView, type RunView, type ThreadView } from "../contract.ts";

export type Job = RunView["jobs"][number];
export type Checklist = z.infer<typeof ChecklistView>;
export type Thread = z.infer<typeof ThreadView>;
export type Severity = RunView["findings"][number]["severity"];

export const severityOrder: readonly Severity[] = ["critical", "warning", "nit"];
const severityRank: Record<Severity, number> = { critical: 0, warning: 1, nit: 2 };

export function directiveRunId(attributes: Readonly<Record<string, string>>): string | null {
  return Object.keys(attributes).length === 1 && RUN_ID.test(attributes.run ?? "") ? attributes.run! : null;
}

export function panelRunId(params: unknown): string | null | undefined {
  if (params === null) return null;
  if (typeof params !== "object" || Array.isArray(params) || !("runId" in params)) return undefined;
  return Object.keys(params).length === 1 && typeof params.runId === "string" && RUN_ID.test(params.runId)
    ? params.runId : undefined;
}

export function isSettled(state: Job["state"]): boolean {
  return ["succeeded", "failed", "skipped", "cancelled"].includes(state);
}

export function runProgress(jobs: readonly Job[]) {
  return { settled: jobs.filter((job) => isSettled(job.state)).length, total: jobs.length };
}

export function bannerSummary(thread: Thread) {
  return { runs: thread.activeRuns.length, open: thread.checklist?.steps.filter((step) => step.status === "open").length ?? 0 };
}

export function panelFlow(jobs: readonly Job[]) {
  const seats = jobs.filter((job) => job.kind === "seat");
  const judge = jobs.find((job) => job.kind === "judge") ?? null;
  const width = judge === null ? 480 : 760;
  const height = Math.max(108, seats.length * 84 + 24);
  const nodeWidth = 208;
  const nodeHeight = 64;
  const origin = { x: 16, y: height / 2 - nodeHeight / 2, width: 112, height: nodeHeight };
  const nodes = seats.map((job, index) => ({ job, x: 228, y: 12 + index * 84, width: nodeWidth, height: nodeHeight }));
  const judgeNode = judge === null ? null : { job: judge, x: 536, y: height / 2 - nodeHeight / 2, width: nodeWidth, height: nodeHeight };
  const curve = (x: number, y: number, toX: number, toY: number) => {
    const mid = (x + toX) / 2;
    return `M${x},${y} C${mid},${y} ${mid},${toY} ${toX},${toY}`;
  };
  const edges = nodes.flatMap((node) => [
    { key: `in-${node.job.key}`, state: node.job.state, path: curve(origin.x + origin.width, height / 2, node.x, node.y + nodeHeight / 2) },
    ...(judgeNode === null ? [] : [{ key: `out-${node.job.key}`, state: judgeNode.job.state, path: curve(node.x + node.width, node.y + nodeHeight / 2, judgeNode.x, height / 2) }]),
  ]);
  return { width, height, origin, nodes, judge: judgeNode, edges };
}

export function swarmGrid(jobs: readonly Job[]) {
  return jobs.filter((job) => job.kind === "slice").map((worker) => ({
    worker,
    verifier: jobs.find((job) => job.kind === "verifier" && job.slice === worker.slice) ?? null,
  }));
}

export function ganttLayout(run: Pick<RunView, "jobs" | "createdAt" | "finishedAt">, now: number) {
  const start = Math.min(run.createdAt, ...run.jobs.flatMap((job) => job.startedAt === null ? [] : [job.startedAt]));
  const end = Math.max(start + 1, run.finishedAt ?? now, ...run.jobs.flatMap((job) => job.finishedAt === null ? [] : [job.finishedAt]));
  const duration = end - start;
  const rows = run.jobs.map((job) => {
    if (job.startedAt === null) return { job, left: 0, width: 0, duration: null };
    const finish = Math.max(job.startedAt, job.finishedAt ?? (isSettled(job.state) ? job.startedAt : end));
    return { job, left: (job.startedAt - start) / duration * 100, width: (finish - job.startedAt) / duration * 100, duration: finish - job.startedAt };
  });
  return { start, end, duration, rows, ticks: [0, .25, .5, .75, 1].map((fraction) => ({ position: fraction * 100, elapsed: duration * fraction })) };
}

export function severityCounts(run: Pick<RunView, "jobs" | "findings">) {
  return run.jobs.filter((job) => job.kind === "seat").map((job) => {
    const counts: Record<Severity, number> = { critical: 0, warning: 0, nit: 0 };
    for (const finding of run.findings) if (finding.seat === job.label) counts[finding.severity] += 1;
    return { job, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });
}

export function agreementMatrix(run: Pick<RunView, "jobs" | "matrix">) {
  const rows = (run.matrix ?? []).slice().sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.title.localeCompare(b.title));
  const columns = [...new Set([...run.jobs.filter((job) => job.kind === "seat").map((job) => job.label), ...rows.flatMap((row) => Object.keys(row.cells))])];
  return { columns, rows: rows.map((row) => ({ ...row, agreement: Object.values(row.cells).filter((cell) => cell !== null).length })) };
}

export function checklistGroups(checklist: Checklist) {
  return (["playbook", "pr"] as const).map((section) => ({
    section,
    title: section === "playbook" ? checklist.playbook : "Opening a PR",
    steps: checklist.steps.filter((step) => step.section === section),
  })).filter((group) => group.steps.length > 0);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
