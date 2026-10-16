import assert from "node:assert/strict";
import { test } from "node:test";
import { agreementMatrix, bannerSummary, checklistGroups, directiveRunId, ganttLayout, panelFlow, panelRunId, runProgress, severityCounts, swarmGrid, type Job } from "./layout.ts";

function job(key: string, overrides: Partial<Job> = {}): Job {
  return { key, kind: "seat", label: key, model: "codex/model/high", state: "queued", attempt: 0, threadId: null, host: null, startedAt: null, finishedAt: null, error: null, summary: null, slice: null, ...overrides };
}

test("directive and inspector reject malformed identifiers and extra parameters", () => {
  const id = "psr_11111111-1111-1111-1111-111111111111";
  assert.equal(directiveRunId({ run: id }), id);
  assert.equal(directiveRunId({ run: id, other: "x" }), null);
  assert.equal(directiveRunId({ run: "psr_bad" }), null);
  assert.equal(panelRunId(null), null);
  assert.equal(panelRunId({ runId: id }), id);
  assert.equal(panelRunId({ runId: "bad" }), undefined);
  assert.equal(panelRunId([]), undefined);
});

test("panel flow preserves seat order, avoids overlap at twelve seats, and omits an absent judge", () => {
  const seats = Array.from({ length: 12 }, (_, index) => job(String(index)));
  const layout = panelFlow([...seats, job("judge", { kind: "judge" })]);
  assert.equal(layout.nodes.length, 12);
  assert.equal(layout.edges.length, 24);
  for (let index = 1; index < layout.nodes.length; index++) {
    assert.ok(layout.nodes[index]!.y >= layout.nodes[index - 1]!.y + layout.nodes[index - 1]!.height);
  }
  assert.ok(layout.nodes.at(-1)!.y + layout.nodes.at(-1)!.height <= layout.height);
  assert.ok(layout.judge!.x > layout.nodes[0]!.x + layout.nodes[0]!.width);
  assert.equal(panelFlow(seats).judge, null);
  assert.equal(panelFlow(seats).edges.length, 12);
  assert.deepEqual(runProgress([job("uncertain", { state: "uncertain" }), job("failed", { state: "failed" })]), { settled: 1, total: 2 });
});

test("swarm pairs each verifier with its slice rather than array order", () => {
  const jobs = [job("a", { kind: "slice", slice: "a" }), job("b", { kind: "slice", slice: "b" }), job("vb", { kind: "verifier", slice: "b" })];
  assert.deepEqual(swarmGrid(jobs).map(({ worker, verifier }) => [worker.key, verifier?.key ?? null]), [["a", null], ["b", "vb"]]);
});

test("gantt uses real starts and finishes and does not invent queued or skipped duration", () => {
  const run = { createdAt: 1000, finishedAt: null, jobs: [job("a", { state: "succeeded", startedAt: 1000, finishedAt: 3000 }), job("b", { state: "running", startedAt: 2000 }), job("q"), job("skipped", { state: "skipped", startedAt: 2000 })] };
  const layout = ganttLayout(run, 5000);
  assert.deepEqual(layout.rows.map(({ left, width, duration }) => ({ left, width, duration })), [{ left: 0, width: 50, duration: 2000 }, { left: 25, width: 75, duration: 3000 }, { left: 0, width: 0, duration: null }, { left: 25, width: 0, duration: 0 }]);
  assert.equal(ganttLayout({ ...run, finishedAt: 4000 }, 100000).end, 4000);
  assert.ok(ganttLayout({ jobs: [], createdAt: 1000, finishedAt: 1000 }, 1000).duration > 0);
});

test("severity counts include reviewers with no findings and matrix uses only server grouping", () => {
  const jobs = [job("B"), job("A")];
  const findings = [{ ref: "A.1", seat: "A", severity: "critical" as const, title: "Failure", location: "a.ts", detail: "Details" }];
  assert.deepEqual(severityCounts({ jobs, findings }).map(({ job, counts }) => [job.label, counts]), [["B", { critical: 0, warning: 0, nit: 0 }], ["A", { critical: 1, warning: 0, nit: 0 }]]);
  assert.deepEqual(agreementMatrix({ jobs, matrix: null }).rows, []);
  const matrix = [{ title: "Low", severity: "nit" as const, verdict: null, cells: { A: "nit" as const, B: null } }, { title: "High", severity: "critical" as const, verdict: "act-on" as const, cells: { A: "critical" as const, B: "warning" as const } }];
  const ordered = agreementMatrix({ jobs, matrix });
  assert.deepEqual(ordered.columns, ["B", "A"]);
  assert.deepEqual(ordered.rows.map((row) => [row.title, row.agreement]), [["High", 2], ["Low", 1]]);
  assert.equal(matrix[0]!.title, "Low");
});

test("checklist retains status, evidence and skip reason within its original sections", () => {
  const checklist = { playbook: "feature", open: 1, steps: [{ id: "1", section: "playbook" as const, text: "Build", status: "open" as const, evidence: [], reason: null }, { id: "2", section: "playbook" as const, text: "Check", status: "done" as const, evidence: ["commit:abc"], reason: null }, { id: "3", section: "pr" as const, text: "Publish", status: "skipped" as const, evidence: [], reason: "Local only" }] };
  const groups = checklistGroups(checklist);
  assert.deepEqual(groups.map((group) => [group.section, group.steps.map((step) => step.id)]), [["playbook", ["1", "2"]], ["pr", ["3"]]]);
  assert.deepEqual(groups[0]!.steps[1]!.evidence, ["commit:abc"]);
  assert.equal(groups[1]!.steps[0]!.reason, "Local only");
  assert.deepEqual(bannerSummary({ violations: [], poteto: null, revision: 1, activeRuns: [], checklist }), { runs: 0, open: 1 });
});
