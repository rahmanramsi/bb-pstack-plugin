import { useState } from "react";
import { Markdown, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "../../components/ui/button.tsx";
import { TERMINAL, canStop, machineLabel } from "../issues/job.ts";
import type { rpcContract } from "../rpc.ts";
import { formatAge, issueNext, issueNotes, issueStatus, type IssueJob, type IssueNote, type IssueRepo } from "./layout.ts";
import { useIssueBoard } from "./live.ts";
import { LoadMessage, useNow } from "./views.tsx";

import { issueEntries, issuePath, matchesIssue, type CatalogIssue, type IssueEntry } from "./issue-list.ts";

export const ISSUES_PATH = "issues";
export function IssuesPage({ subPath }: PluginNavPanelProps) {
  const { state, refresh } = useIssueBoard({ all: true });
  const navigate = useBbNavigate();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [status, setStatus] = useState("open");
  const [worker, setWorker] = useState("all");
  const [sort, setSort] = useState("updated");
  const board = state.status === "ready" ? state.value : null;
  const entries = board ? issueEntries(board) : [];
  const selected = entries.find(({ issue }) => subPath === issuePath(issue));
  const open = (issue: CatalogIssue) => navigate.toPluginPanel(ISSUES_PATH, { subPath: issuePath(issue) });
  const back = () => navigate.toPluginPanel(ISSUES_PATH, { subPath: "" });
  const counts = entries.filter(({ issue }) => !repo || issue.repo === repo);
  const filtered = entries.filter((entry) => matchesIssue(entry, { repo, state: status, query, worker }));
  if (sort === "oldest") filtered.reverse();
  if (sort === "number") filtered.sort((a, b) => b.issue.issue - a.issue.issue);
  return <div className="pstack ps-issues ps-issue-page">
    <LoadMessage state={state} />
    {subPath.startsWith("issue/") ? selected
      ? <IssueDetail entry={selected} jobs={board?.jobs.filter((job) => job.repo === selected.issue.repo && job.issue === selected.issue.issue) ?? []} now={now} back={back} refresh={refresh} />
      : state.status !== "ready" ? null : <div className="ps-issue-empty"><h2>Issue unavailable</h2><p>It is no longer in the issue catalog.</p><Button variant="outline" onClick={back}>Back to issues</Button></div>
      : <>
        <div className="ps-issue-heading"><div><h2>Issues</h2><p>Start a worker, follow its progress, and review the result.</p></div>
          <Button type="button" variant="outline" size="sm" className="ps-list-button" onClick={refresh}><IssueIcon kind="refresh" />Refresh</Button>
        </div>
        <div className="ps-issue-toolbar">
          <div className="ps-issue-search"><IssueIcon kind="search" /><input type="search" aria-label="Search issues" placeholder="Search issues, labels, or #number" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <select aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">All repositories</option>{board?.repos.map(({ repo }) => <option key={repo} value={repo}>{repo}</option>)}</select>
          <select aria-label="Worker status" value={worker} onChange={(event) => setWorker(event.target.value)}><option value="all">All workers</option><option value="active">Active workers</option><option value="ready">Ready to start</option><option value="attention">Needs attention</option></select>
        </div>
        {board?.repos.filter((view) => view.error && (!repo || view.repo === repo)).map((view) => <p key={view.repo} className="ps-issue-notice ps-error" role="alert">{view.repo}: {view.error}</p>)}
        <div className="ps-issue-table">
          <div className="ps-issue-tablebar"><div className="ps-issue-tabs" role="group" aria-label="Issue state">{["open", "closed", "all"].map((value) => <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{value === "all" ? "All issues" : value === "open" ? "Open" : "Closed"}<span>{counts.filter(({ issue }) => value === "all" || issue.state === value).length}</span></button>)}</div>
            <select aria-label="Sort issues" value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">Recently updated</option><option value="oldest">Least recently updated</option><option value="number">Issue number</option></select>
          </div>
          <table className="ps-issue-grid"><thead><tr><th scope="col">Issue</th><th scope="col">Assignee</th><th scope="col">Worker</th><th scope="col">Updated</th><th scope="col"><span className="ps-sr-only">Actions</span></th></tr></thead><tbody>
            {state.status === "loading" ? [0, 1, 2, 3, 4].map((row) => <tr key={row} aria-hidden="true" className="ps-issue-skeleton"><td colSpan={5}><span /><span /></td></tr>)
              : filtered.map((entry) => <IssueListRow key={`${entry.issue.repo}#${entry.issue.issue}`} entry={entry} now={now} onOpen={() => open(entry.issue)} refresh={refresh} />)}
          </tbody></table>
          {state.status !== "ready" || filtered.length ? null : <div className="ps-issue-empty"><IssueIcon kind="issue" /><h3>{entries.length ? "No issues match your filters" : "No issues yet"}</h3><p>{entries.length ? "Try a different search or repository." : "Add a repository in the GitHub plugin to see its issues here."}</p>{entries.length ? <Button type="button" variant="outline" size="sm" onClick={() => { setQuery(""); setRepo(""); setStatus("all"); setWorker("all"); }}>Clear filters</Button> : null}</div>}
        </div>
        {board ? <div className="ps-issue-footer"><span>{filtered.length} of {entries.length} issues</span><span>Label an issue <code>agent</code> to start automatically</span></div> : null}
      </>}
  </div>;
}

function IssueIcon({ kind }: { kind: "issue" | "closed" | "search" | "refresh" | "back" | "external" | "play" }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "search" ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></> : kind === "refresh" ? <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1" /></> : kind === "back" ? <path d="m10 5-7 7 7 7M3 12h18" /> : kind === "external" ? <><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></> : kind === "play" ? <path d="m8 5 11 7-11 7Z" /> : <><circle cx="12" cy="12" r="9" />{kind === "closed" ? <path d="m8 12 3 3 5-6" /> : <circle cx="12" cy="12" r="1" />}</>}
  </svg>;
}

function IssueLabels({ labels }: { labels: string[] }) {
  return labels.length ? <span className="ps-issue-labels">{labels.map((label) => <span key={label} className="ps-issue-label" data-agent={label === "agent"}>{label}</span>)}</span> : null;
}

function WorkerStatus({ job }: { job: IssueJob | null }) {
  if (!job) return <span className="ps-muted">Not started</span>;
  const status = issueStatus(job);
  return <span className="ps-status" data-state={status.tone}>{status.label}</span>;
}

const noteClass: Record<IssueNote["tone"], string> = { error: "ps-error", warning: "ps-warning", muted: "ps-muted" };

function IssueNotes({ notes }: { notes: readonly IssueNote[] }) {
  return <>{notes.map((note) => <p key={note.text} className={noteClass[note.tone]}>{note.text}</p>)}</>;
}

function IssueListRow({ entry: { issue, job }, now, onOpen, refresh }: { entry: IssueEntry; now: number; onOpen: () => void; refresh: () => void }) {
  const navigate = useBbNavigate();
  const active = job !== null && !TERMINAL.has(job.state);
  const problem = job ? issueNotes(job).find((note) => note.tone === "error")?.text : undefined;
  return <tr>
    <td className="ps-issue-main"><span className="ps-issue-state-icon" data-state={issue.state}><IssueIcon kind={issue.state === "open" ? "issue" : "closed"} /></span><div><button type="button" className="ps-issue-open" onClick={onOpen}>{issue.title}</button><div className="ps-issue-meta"><span>{issue.repo}</span><span>#{issue.issue}</span><IssueLabels labels={issue.labels} /></div>{problem ? <p className="ps-error ps-issue-problem">{problem}</p> : null}</div></td>
    <td className="ps-issue-assignee"><span className="ps-sr-only">Assignee: </span>{issue.assignees.length ? issue.assignees.join(", ") : <span className="ps-muted">Unassigned</span>}</td>
    <td className="ps-issue-worker"><WorkerStatus job={job} /></td>
    <td className="ps-issue-updated"><time dateTime={new Date(issue.updatedAt).toISOString()}>{formatAge(issue.updatedAt, now)}</time></td>
    <td className="ps-issue-row-actions">{active ? job.threadId ? <Button type="button" variant="outline" size="sm" className="ps-list-button" onClick={() => { if (job.threadId) navigate.toThread(job.threadId); }}>Thread</Button> : <Button type="button" variant="outline" size="sm" className="ps-list-button" onClick={onOpen}>View job</Button> : issue.state === "open" ? <StartIssue issue={issue} refresh={refresh} /> : null}<Button type="button" variant="ghost" size="icon" className="ps-list-icon" aria-label={`Open ${issue.repo}#${issue.issue} on GitHub`} onClick={() => navigate.openUrl(issue.issueUrl)}><IssueIcon kind="external" /></Button></td>
  </tr>;
}

function IssueDetail({ entry: { issue, job }, jobs, now, back, refresh }: { entry: IssueEntry; jobs: IssueJob[]; now: number; back: () => void; refresh: () => void }) {
  const navigate = useBbNavigate();
  const active = job !== null && !TERMINAL.has(job.state);
  return <div className="ps-issue-detail">
    <div className="ps-issue-detail-nav"><Button variant="ghost" size="sm" className="ps-list-button" onClick={back}><IssueIcon kind="back" />Issues</Button><Button variant="ghost" size="sm" className="ps-list-button" onClick={() => navigate.openUrl(issue.issueUrl)}>Open in GitHub<IssueIcon kind="external" /></Button></div>
    <div className="ps-issue-detail-heading"><div><p className="ps-muted">{issue.repo} #{issue.issue}</p><h2>{issue.title}</h2><div className="ps-issue-detail-meta"><span className="ps-issue-state-icon" data-state={issue.state}><IssueIcon kind={issue.state === "open" ? "issue" : "closed"} />{issue.state === "open" ? "Open" : "Closed"}</span>{issue.author ? <span>Opened by {issue.author}</span> : null}<span>Updated {formatAge(issue.updatedAt, now)}</span></div></div>{issue.state === "open" && !active ? <StartIssue issue={issue} refresh={refresh} /> : null}</div>
    <div className="ps-issue-detail-layout"><article className="ps-issue-body"><Markdown content={issue.body || "No description provided."} /></article><aside className="ps-issue-sidebar">
      <section><h3>Worker</h3><WorkerStatus job={job} />{active && job.threadId ? <Button variant="outline" size="sm" className="ps-list-button" onClick={() => { if (job.threadId) navigate.toThread(job.threadId); }}>Open worker thread</Button> : null}{job?.pr ? <Button variant="outline" size="sm" className="ps-list-button" onClick={() => { if (job.pr) navigate.openUrl(job.pr.url); }}>Pull request #{job.pr.number}<IssueIcon kind="external" /></Button> : null}{job && canStop(job.state) ? <StopIssueJob id={job.id} issue={issue.issue} refresh={refresh} /> : null}{issue.startError ? <p className="ps-muted">{issue.startError}</p> : null}{job ? <IssueNotes notes={issueNotes(job)} /> : null}{job && issueNext(job) ? <p className="ps-muted">{issueNext(job)}</p> : null}</section>
      <section><h3>Assignees</h3><p>{issue.assignees.join(", ") || "Unassigned"}</p></section><section><h3>Labels</h3>{issue.labels.length ? <IssueLabels labels={issue.labels} /> : <p className="ps-muted">No labels</p>}</section>
    </aside></div>
    {jobs.length ? <details className="ps-issue-history"><summary>Worker history <span>{jobs.length}</span></summary><ul className="ps-task-list">{jobs.map((item) => <IssueRow key={item.id} job={item} now={now} onThread={navigate.toThread} refresh={refresh} />)}</ul></details> : null}
  </div>;
}

function StartIssue({ issue, refresh }: { issue: CatalogIssue; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ kind: "idle" | "starting" | "started" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const start = async () => {
    setState({ kind: "starting" });
    try { await rpc.call("pstackStartIssue", { repo: issue.repo, issue: issue.issue }); setState({ kind: "started" }); refresh(); }
    catch (cause) { setState({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  return <div className="ps-issue-start"><Button type="button" variant="outline" size="sm" className="ps-list-button" aria-label={`Start ${issue.repo}#${issue.issue}`} disabled={issue.startError !== null || state.kind === "starting" || state.kind === "started"} onClick={() => void start()}><IssueIcon kind="play" />{state.kind === "starting" ? "Starting..." : state.kind === "started" ? "Started" : "Start"}</Button>{issue.startError ? <span className="ps-sr-only">{issue.startError}</span> : null}{state.kind === "failed" ? <p role="alert" className="ps-error">{state.message}</p> : null}</div>;
}

export function WorkerIssue({ threadId }: { threadId: string }) {
  const { state, refresh } = useIssueBoard({ threadId });
  const now = useNow();
  if (state.status !== "ready") return null;
  const [repo] = state.value.repos;
  if (repo === undefined) return null;
  return <><LoadMessage state={state} /><RepoSection repo={repo} jobs={state.value.jobs} empty="" now={now} onThread={null} refresh={refresh} /></>;
}

function RepoSection({ repo, jobs, empty, now, onThread, refresh }: {
  repo: IssueRepo; jobs: readonly IssueJob[]; empty: string; now: number; onThread: ((threadId: string) => void) | null; refresh: () => void;
}) {
  return <section className="ps-section" aria-label={repo.repo}>
    <header className="ps-repo-heading"><h3>{repo.repo}</h3></header>
    {repo.error ? <p className="ps-error">{repo.error}</p> : null}
    {jobs.length ? <ul className="ps-task-list">{jobs.map((job) => <IssueRow key={job.id} job={job} now={now} onThread={onThread} refresh={refresh} />)}</ul> : <p className="ps-muted">{empty}</p>}
  </section>;
}

export function IssueRow({ job, now, onThread, refresh }: { job: IssueJob; now: number; onThread: ((threadId: string) => void) | null; refresh: () => void }) {
  const navigate = useBbNavigate();
  const status = issueStatus(job);
  const next = issueNext(job);
  const threadId = job.threadId;
  const pr = job.pr;
  return <li className="ps-issue">
    <div className="ps-issue-line"><span className="ps-issue-title"><strong>#{job.issue}</strong> {job.title}</span><span className="ps-status" data-state={status.tone}>{status.label}</span></div>
    {next === null ? null : <p className="ps-muted">{next}</p>}
    <p className="ps-muted"><code>{job.branch}</code> · {machineLabel(job.host)} · updated {formatAge(job.updatedAt, now)}</p>
    <div className="ps-issue-links">
      {onThread === null || threadId === null ? null
        : <Button type="button" variant="ghost" size="sm" className="ps-action" aria-label={`Open the worker thread for #${job.issue}`} onClick={() => onThread(threadId)}>Thread</Button>}
      <Button type="button" variant="ghost" size="sm" className="ps-action" aria-label={`Open issue #${job.issue} on GitHub`} onClick={() => navigate.openUrl(job.issueUrl)}>Issue</Button>
      {pr === null ? null
        : <Button type="button" variant="ghost" size="sm" className="ps-action" aria-label={`Open pull request #${pr.number} on GitHub`} onClick={() => navigate.openUrl(pr.url)}>PR #{pr.number}</Button>}
      {canStop(job.state) ? <StopIssueJob id={job.id} issue={job.issue} refresh={refresh} /> : null}
    </div>
    <IssueNotes notes={issueNotes(job)} />
  </li>;
}

type StopState = { kind: "idle" | "confirming" | "stopping" | "ended" } | { kind: "failed"; message: string };

function StopIssueJob({ id, issue, refresh }: { id: string; issue: number; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<StopState>({ kind: "idle" });
  const stop = async () => {
    setState({ kind: "stopping" });
    try {
      const { stopped } = await rpc.call("pstackStopIssueJob", { id });
      setState({ kind: stopped ? "idle" : "ended" });
      refresh();
    } catch (cause) {
      setState({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  if (state.kind === "confirming") {
    return <span className="ps-confirm" role="group" aria-label={`Stop #${issue}`}>
      <span>Stop the worker and end this job?</span>
      <Button type="button" variant="ghost" size="sm" className="ps-action ps-stop" onClick={() => void stop()}>Stop job</Button>
      <Button type="button" variant="ghost" size="sm" className="ps-action" onClick={() => setState({ kind: "idle" })}>Cancel</Button>
    </span>;
  }
  return <>
    <Button type="button" variant="ghost" size="sm" className="ps-action ps-stop" aria-label={`Stop #${issue}`} disabled={state.kind === "stopping"}
      onClick={() => setState({ kind: "confirming" })}>{state.kind === "stopping" ? "Stopping..." : "Stop"}</Button>
    {state.kind === "failed" ? <p role="alert" className="ps-error">{state.message}</p> : null}
    {state.kind === "ended" ? <p role="status" className="ps-muted">This job already ended.</p> : null}
  </>;
}
