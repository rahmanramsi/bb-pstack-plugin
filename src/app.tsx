import { useEffect, useState } from "react";
import {
  definePluginApp, useBbNavigate, useComposer, useRpc,
  type PluginMessageDirectiveProps, type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button.tsx";
import type { rpcContract } from "./contract.ts";
import { bannerSummary, directiveRunId, panelRunId } from "./ui/layout.ts";
import { useRunView, useThreadView } from "./ui/live.ts";
import { Agreement, ChecklistPanel, Findings, LoadMessage, PanelFlow, RunHeading, SwarmGrid, Timeline, Workers } from "./ui/views.tsx";
import "./ui/styles.css";

const PANEL_ACTION = "pstack-run";

function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function StopRun({ threadId, runId, refresh }: { threadId: string; runId: string; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await rpc.call("pstackStopRun", { threadId, runId });
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStopping(false); }
  };
  return <><Button type="button" variant="ghost" size="sm" className="ps-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping..." : "Stop run"}</Button>{error === null ? null : <p role="alert" className="ps-error">{error}</p>}</>;
}

function RunCard({ threadId, runId }: { threadId: string; runId: string }) {
  const { state, refresh } = useRunView(threadId, runId);
  const navigate = useBbNavigate();
  const now = useNow();
  return <section className="pstack ps-card" aria-label="pstack run">
    <LoadMessage state={state} />
    {state.status !== "ready" ? null : <>
      <RunHeading run={state.value} now={now} />
      {state.value.kind === "panel" ? <PanelFlow run={state.value} onThread={navigate.toThread} /> : <SwarmGrid run={state.value} onThread={navigate.toThread} />}
      <div className="ps-actions"><Button type="button" variant="ghost" size="sm" onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION, title: state.value.title, params: { runId } })}>View details</Button>
        {state.value.status === "running" ? <StopRun threadId={threadId} runId={runId} refresh={refresh} /> : null}<code>{runId}</code>
      </div>
    </>}
  </section>;
}

function RunDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const runId = directiveRunId(attributes);
  return runId === null ? <div role="alert" className="pstack ps-message">pstack-run requires one valid run attribute.</div> : <RunCard key={`${message.threadId}/${runId}`} threadId={message.threadId} runId={runId} />;
}

function ThreadBanner({ threadId }: { threadId: string }) {
  const { state } = useThreadView(threadId);
  const navigate = useBbNavigate();
  if (state.status === "loading") return null;
  if (state.status === "error") return <div className="pstack"><LoadMessage state={state} /></div>;
  const summary = bannerSummary(state.value);
  if (summary.runs === 0 && summary.open === 0 && state.refreshError === null) return null;
  return <div className="pstack"><div className="ps-banner">
    <span>{summary.runs} active {summary.runs === 1 ? "run" : "runs"} · {summary.open} open checklist {summary.open === 1 ? "step" : "steps"}</span>
    {state.value.activeRuns.map((run) => <Button type="button" variant="ghost" size="sm" key={run.id} onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION, title: run.title, params: { runId: run.id } })}>{run.title}</Button>)}
    <Button type="button" variant="ghost" size="sm" onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION, title: "pstack" })}>Checklist and runs</Button>
  </div><LoadMessage state={state} /></div>;
}

function ComposerBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <ThreadBanner key={scope.threadId} threadId={scope.threadId} /> : null;
}

function RunInspector({ threadId, runId }: { threadId: string; runId: string }) {
  const { state, refresh } = useRunView(threadId, runId);
  const navigate = useBbNavigate();
  const now = useNow();
  return <><LoadMessage state={state} />{state.status !== "ready" ? null : <>
    <RunHeading run={state.value} now={now} />
    {state.value.kind === "swarm" ? <SwarmGrid run={state.value} onThread={navigate.toThread} /> : null}
    <Timeline run={state.value} now={now} onThread={navigate.toThread} />
    {state.value.kind !== "panel" ? null : <><Findings run={state.value} /><Agreement run={state.value} /></>}
    <Workers run={state.value} onThread={navigate.toThread} />
    {state.value.status !== "running" ? null : <div className="ps-actions"><StopRun threadId={threadId} runId={runId} refresh={refresh} /></div>}
  </>}</>;
}

function ThreadInspector({ threadId, runId }: { threadId: string; runId: string | null }) {
  const { state } = useThreadView(threadId);
  const [selected, setSelected] = useState(runId);
  useEffect(() => {
    if (runId !== null) setSelected(runId);
    else if (state.status === "ready") setSelected((current) => current ?? state.value.activeRuns[0]?.id ?? null);
  }, [runId, state]);
  return <div className="pstack ps-inspector">
    <LoadMessage state={state} />
    {state.status !== "ready" ? null : <>
      {state.value.activeRuns.length === 0 ? null : <nav className="ps-run-options" aria-label="Active pstack runs">{state.value.activeRuns.map((run) => <Button type="button" size="sm" variant="ghost" aria-pressed={selected === run.id} key={run.id} onClick={() => setSelected(run.id)}>{run.title}</Button>)}</nav>}
    </>}
    {selected === null ? <p className="ps-message ps-muted">Select a run from its chat card or the active runs above.</p> : <RunInspector key={`${threadId}/${selected}`} threadId={threadId} runId={selected} />}
    {state.status !== "ready" ? null : <ChecklistPanel checklist={state.value.checklist} />}
  </div>;
}

function Inspector({ threadId, params }: PluginThreadPanelProps) {
  const runId = panelRunId(params);
  return runId === undefined ? <div role="alert" className="pstack ps-message">This panel has invalid run parameters.</div> : <ThreadInspector key={threadId} threadId={threadId} runId={runId} />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "pstack-run", component: RunDirective });
  app.composer.customize({ id: "pstack-status", scopes: ["thread"], banners: [{ id: "runs-and-checklist", chrome: "bare", component: ComposerBanner }] });
  app.slots.threadPanelAction({ id: PANEL_ACTION, title: "pstack runs and checklist", icon: "Layers", layout: "flush", component: Inspector });
});
