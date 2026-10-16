import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "../../components/ui/button.tsx";
import type { RunView } from "../contract.ts";
import {
  agreementMatrix, checklistGroups, formatDuration, ganttLayout, panelFlow, runProgress,
  severityCounts, severityOrder, swarmGrid, type Checklist, type Job,
} from "./layout.ts";
import type { LiveState } from "./live.ts";

export function LoadMessage<T>({ state }: { state: LiveState<T> }) {
  if (state.status === "loading") return <p role="status" className="ps-message" aria-busy="true">Loading pstack...</p>;
  if (state.status === "error") return <p role="alert" className="ps-message">Could not load pstack. {state.message} Retrying automatically.</p>;
  if (state.refreshError !== null) return <p role="status" className="ps-message ps-warning">Could not refresh. {state.refreshError} Showing the last available data.</p>;
  return null;
}

export function Status({ value }: { value: string }) {
  return <span className="ps-status" data-state={value}>{value}</span>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ps-section"><h3>{title}</h3>{children}</section>;
}

export function RunHeading({ run, now }: { run: RunView; now: number }) {
  const progress = runProgress(run.jobs);
  return <header className="ps-heading">
    <div className="ps-title"><h2>{run.title}</h2><p>{run.kind} · {progress.settled}/{progress.total} jobs settled · {formatDuration((run.finishedAt ?? now) - run.createdAt)}</p></div>
    <Status value={run.status} />
  </header>;
}

export function WorkerButton({ job, onThread }: { job: Job; onThread: (threadId: string) => void }) {
  return <Button type="button" variant="ghost" size="sm" className="ps-worker" disabled={job.threadId === null}
    onClick={() => { if (job.threadId !== null) onThread(job.threadId); }} aria-label={`Open ${job.label} thread. ${job.state}`}>
    <span className="ps-worker-label">{job.label}</span><Status value={job.state} />
  </Button>;
}

export function PanelFlow({ run, onThread }: { run: RunView; onThread: (threadId: string) => void }) {
  const flow = panelFlow(run.jobs);
  return <div className="ps-flow-scroll" tabIndex={0} role="region" aria-label="Panel flow">
    <svg className="ps-flow" viewBox={`0 0 ${flow.width} ${flow.height}`} style={{ minWidth: flow.width }} role="group" aria-label="Origin, parallel reviewers, and judge">
      {flow.edges.map((edge) => <path key={edge.key} d={edge.path} className="ps-edge" data-state={edge.state} aria-hidden="true" />)}
      <foreignObject {...flow.origin}><div className="ps-origin">Origin thread</div></foreignObject>
      {[...flow.nodes, ...(flow.judge === null ? [] : [flow.judge])].map((node) => <foreignObject key={node.job.key} x={node.x} y={node.y} width={node.width} height={node.height}>
        <button type="button" className="ps-flow-node" data-state={node.job.state} disabled={node.job.threadId === null}
          onClick={() => { if (node.job.threadId !== null) onThread(node.job.threadId); }} aria-label={`Open ${node.job.label} thread. ${node.job.state}`}>
          <span className="ps-node-line"><strong>{node.job.label}</strong><Status value={node.job.state} /></span>
          <span className="ps-model">{node.job.model}</span><span className="ps-outcome">{node.job.summary ?? node.job.error ?? `Attempt ${node.job.attempt}`}</span>
        </button>
      </foreignObject>)}
    </svg>
  </div>;
}

export function SwarmGrid({ run, onThread }: { run: RunView; onThread: (threadId: string) => void }) {
  return <div className="ps-swarm">{swarmGrid(run.jobs).map(({ worker, verifier }) => <section className="ps-tile" key={worker.key}>
    <WorkerButton job={worker} onThread={onThread} />
    <p className="ps-model">{worker.model}</p><p>{worker.summary ?? worker.error ?? "Awaiting report"}</p>
    {verifier === null ? <p className="ps-muted">No verifier</p> : <div className="ps-verifier"><span className="ps-muted">Verification</span><WorkerButton job={verifier} onThread={onThread} /><p>{verifier.summary ?? verifier.error ?? "Awaiting verdict"}</p></div>}
  </section>)}</div>;
}

export function Timeline({ run, now, onThread }: { run: RunView; now: number; onThread: (threadId: string) => void }) {
  const timeline = ganttLayout(run, now);
  return <Section title="Timeline"><div className="ps-gantt" role="list">
    {timeline.rows.map((row) => <div className="ps-gantt-row" role="listitem" key={row.job.key}>
      <WorkerButton job={row.job} onThread={onThread} />
      <div className="ps-track" aria-hidden="true"><span className="ps-time-bar" data-state={row.job.state} style={{ left: `${row.left}%`, width: `${row.width}%` }} /></div>
      <span className="ps-duration">{row.duration === null ? "Not started" : formatDuration(row.duration)}</span>
    </div>)}
    <div className="ps-gantt-row ps-axis" aria-hidden="true"><span /><div className="ps-ticks">{timeline.ticks.map((tick) => <span key={tick.position}>{formatDuration(tick.elapsed)}</span>)}</div><span /></div>
  </div></Section>;
}

export function Findings({ run }: { run: RunView }) {
  const reviewers = severityCounts(run);
  const max = Math.max(1, ...reviewers.map((reviewer) => reviewer.total));
  return <Section title="Findings by reviewer">
    <div className="ps-severity-bars">{reviewers.map(({ job, counts }) => <div className="ps-reviewer" key={job.key}>
      <span>{job.label}</span><div className="ps-count-track">{severityOrder.map((severity) => <span key={severity} data-severity={severity} style={{ width: `${counts[severity] / max * 100}%` }} />)}</div>
      <span className="ps-counts">{severityOrder.map((severity) => `${counts[severity]} ${severity}`).join(" · ")}</span>
    </div>)}</div>
    {run.findings.length === 0 ? <p className="ps-muted">No findings reported.</p> : <div className="ps-findings">{run.findings.map((finding) => <details key={finding.ref}>
      <summary><Status value={finding.severity} /><strong>{finding.title}</strong><span className="ps-muted">{finding.ref} · {finding.seat}</span></summary>
      <div className="ps-finding-detail"><code>{finding.location}</code><p>{finding.detail}</p>{finding.suggestion === undefined ? null : <p>Suggestion. {finding.suggestion}</p>}</div>
    </details>)}</div>}
  </Section>;
}

export function Agreement({ run }: { run: RunView }) {
  const matrix = agreementMatrix(run);
  return <Section title="Agreement matrix">{matrix.rows.length === 0 ? <p className="ps-muted">No grouped findings available.</p> : <div className="ps-table-scroll" tabIndex={0} role="region" aria-label="Agreement matrix">
    <table><caption className="ps-muted">Agreement reflects the judge's explicit finding groups.</caption><thead><tr><th scope="col">Finding</th>{matrix.columns.map((column) => <th scope="col" key={column}>{column}</th>)}<th scope="col">Verdict</th></tr></thead>
      <tbody>{matrix.rows.map((row, index) => <tr key={index} data-consensus={row.agreement > 1}>
        <th scope="row">{row.title}<span className="ps-muted ps-cell-meta">{row.severity} · {row.agreement} reviewers</span></th>
        {matrix.columns.map((column) => <td key={column}><span data-severity={row.cells[column] ?? "none"}>{row.cells[column] ?? "Not reported"}</span></td>)}
        <td>{row.verdict ?? "Pending"}</td>
      </tr>)}</tbody>
    </table>
  </div>}</Section>;
}

export function Workers({ run, onThread }: { run: RunView; onThread: (threadId: string) => void }) {
  return <Section title="Workers"><div className="ps-workers">{run.jobs.map((job) => <div className="ps-worker-row" key={job.key}>
    <WorkerButton job={job} onThread={onThread} /><p className="ps-model">{job.model} · attempt {job.attempt}</p>
    {job.summary === null ? null : <p>{job.summary}</p>}{job.error === null ? null : <p className="ps-error">{job.error}</p>}
  </div>)}</div></Section>;
}

export function ChecklistPanel({ checklist }: { checklist: Checklist | null }) {
  if (checklist === null) return <Section title="Checklist"><p className="ps-muted">No playbook checklist for this thread.</p></Section>;
  return <Section title="Checklist">{checklistGroups(checklist).map((group) => <section key={group.section} className="ps-checklist-group">
    <h4>{group.title}</h4><ol className="ps-checklist">{group.steps.map((step) => <li key={step.id}>
      <div className="ps-step-heading"><Status value={step.status} /><span className="ps-muted">{step.id}</span></div>
      <Markdown className="ps-step-text" content={step.text} />
      {step.evidence.length === 0 ? null : <ul aria-label="Evidence">{step.evidence.map((evidence, index) => <li className="ps-evidence" key={index}><code>{evidence}</code></li>)}</ul>}
      {step.reason === null ? null : <p className="ps-muted">Skip reason. {step.reason}</p>}
    </li>)}</ol>
  </section>)}</Section>;
}
