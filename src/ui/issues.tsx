import { useState } from "react";
import { useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "../../components/ui/button.tsx";
import { TERMINAL, canStop, machineLabel } from "../issues/job.ts";
import type { rpcContract } from "../rpc.ts";
import { formatAge, issueNext, issueStates, type IssueJob, type IssueRepo } from "./layout.ts";
import { useIssueBoard } from "./live.ts";
import { LoadMessage, useNow } from "./views.tsx";

export const ISSUES_PATH = "issues";
const ENDED = "all";

export function IssuesPage({ subPath }: PluginNavPanelProps) {
  const all = subPath === ENDED;
  const { state, refresh } = useIssueBoard({ all });
  const navigate = useBbNavigate();
  const now = useNow();
  const board = state.status === "ready" ? state.value : null;
  return <div className="pstack ps-issues">
    <LoadMessage state={state} />
    {board === null ? null : board.repos.length === 0
      ? <p className="ps-message ps-muted">No repositories to watch. Set githubAppId, githubPrivateKey and issueRepos in the pstack plugin settings.</p>
      : board.repos.map((repo) => <RepoSection key={repo.repo} repo={repo} jobs={board.jobs.filter((job) => job.repo === repo.repo)}
        empty={all ? "No jobs." : "No open jobs."} now={now} onThread={navigate.toThread} refresh={refresh} />)}
  </div>;
}

export function IssuesHeader({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const all = subPath === ENDED;
  return <div className="pstack">
    <Button type="button" variant="ghost" size="sm" className="ps-action ps-toggle" aria-pressed={all}
      onClick={() => navigate.toPluginPanel(ISSUES_PATH, { subPath: all ? "" : ENDED, replace: true })}>Show ended jobs</Button>
  </div>;
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
    <header className="ps-repo-heading"><h3>{repo.repo}</h3><span className="ps-muted">{repo.polledAt === null ? "Not polled yet" : `Polled ${formatAge(repo.polledAt, now)}`}</span></header>
    {repo.error === null ? null : <p className="ps-error">Poll error. {repo.error}</p>}
    {jobs.length === 0 ? <p className="ps-muted">{empty}</p>
      : <ul className="ps-task-list">{jobs.map((job) => <IssueRow key={job.id} job={job} now={now} onThread={onThread} refresh={refresh} />)}</ul>}
  </section>;
}

function IssueRow({ job, now, onThread, refresh }: { job: IssueJob; now: number; onThread: ((threadId: string) => void) | null; refresh: () => void }) {
  const navigate = useBbNavigate();
  const state = issueStates[job.state];
  const next = issueNext(job);
  const threadId = job.threadId;
  const pr = job.pr;
  return <li className="ps-issue">
    <div className="ps-issue-line"><span className="ps-issue-title"><strong>#{job.issue}</strong> {job.title}</span><span className="ps-status" data-state={state.tone}>{state.label}</span></div>
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
    {job.error === null ? null : <p className="ps-error">{job.error}</p>}
    {TERMINAL.has(job.state) || job.poll.error === null ? null : <p className="ps-error">Poll error. {job.poll.error}</p>}
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
