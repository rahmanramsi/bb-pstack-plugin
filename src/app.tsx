import { useEffect, useState } from "react";
import {
  definePluginApp, useBbNavigate, useComposer, useRpc,
  type PluginMessageDirectiveProps, type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button.tsx";
import type { rpcContract } from "./rpc.ts";
import { CHECKOUT_RENDERER } from "./checkout-form.ts";
import { CheckoutConsent } from "./ui/consent.tsx";
import { bannerSummary, directiveRunId, panelRunId } from "./ui/layout.ts";
import { ISSUES_PATH, IssuesPage, WorkerIssue } from "./ui/issues.tsx";
import { useRunView, useThreadView } from "./ui/live.ts";
import { Agreement, ChecklistPanel, Disclosure, Findings, LoadMessage, PanelFlow, RunHeading, RunOverview, Timeline, Workers, useNow } from "./ui/views.tsx";
import "./ui/styles.css";

const PANEL_ACTION = "pstack-run";

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
  return <><Button type="button" variant="ghost" size="sm" className="ps-action ps-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping..." : "Stop run"}</Button>{error === null ? null : <p role="alert" className="ps-error">{error}</p>}</>;
}

function RunCard({ threadId, runId }: { threadId: string; runId: string }) {
  const { state, refresh } = useRunView(threadId, runId);
  const navigate = useBbNavigate();
  const now = useNow();
  const run = state.status === "ready" ? state.value : undefined;
  return <section className="pstack ps-card" aria-label="pstack run">
    <LoadMessage state={state} />
    {run === null ? <p role="status" className="ps-message">This run does not belong to this thread, or it no longer exists.</p> : null}
    {!run ? null : <>
      <RunHeading run={run} now={now} />
      <RunOverview run={run} onThread={navigate.toThread} />
      <div className="ps-actions"><Button type="button" variant="ghost" size="sm" className="ps-action ps-details-action" onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION, title: run.title, params: { runId } })}>View details</Button>
        {run.status === "running" ? <StopRun threadId={threadId} runId={runId} refresh={refresh} /> : null}
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
  const violations = state.value.violations.filter((violation) => violation.acknowledgedAt === null);
  if (summary.runs === 0 && summary.open === 0 && !state.value.poteto && state.refreshError === null) return null;
  return <div className="pstack"><div className="ps-banner">
    <span>{summary.runs} active {summary.runs === 1 ? "run" : "runs"} · {summary.open} open checklist {summary.open === 1 ? "step" : "steps"}</span>
    {state.value.poteto ? <span role="status">Poteto-mode {state.value.poteto}{state.value.poteto === "stalled" ? ". Begin a playbook checklist to continue." : "."}</span> : null}
    {violations.length ? <span role="alert">{violations.length} poteto {violations.length === 1 ? "violation holds" : "violations hold"} the done gate.</span> : null}
    <Button type="button" variant="ghost" size="sm" className="ps-action" aria-label="Open runs and checklist" onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION, title: "pstack" })}>Open</Button>
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
  return <><LoadMessage state={state} />{state.status === "ready" && state.value === null ? <p role="status" className="ps-message">This run does not belong to this thread, or it no longer exists.</p> : null}{state.status !== "ready" || state.value === null ? null : <>
    <RunHeading run={state.value} now={now} />
    <RunOverview run={state.value} onThread={navigate.toThread} outcomes />
    {state.value.status !== "running" ? null : <div className="ps-actions ps-inspector-actions"><StopRun threadId={threadId} runId={runId} refresh={refresh} /></div>}
    {state.value.kind !== "panel" ? null : <Findings run={state.value} />}
    <Disclosure title="Timeline"><Timeline run={state.value} now={now} onThread={navigate.toThread} /></Disclosure>
    {state.value.kind !== "panel" ? null : <><Disclosure title="Review flow"><PanelFlow run={state.value} onThread={navigate.toThread} /></Disclosure><Disclosure title="Reviewer agreement"><Agreement run={state.value} /></Disclosure></>}
    <Disclosure title="Technical details"><p className="ps-run-id">Run <code>{state.value.id}</code> · {state.value.kind}</p><Workers run={state.value} onThread={navigate.toThread} /></Disclosure>
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
    <WorkerIssue threadId={threadId} />
    <LoadMessage state={state} />
    {state.status !== "ready" ? null : <>
      {state.value.activeRuns.length === 0 ? null : <nav className="ps-run-options" aria-label="Active pstack runs">{state.value.activeRuns.map((run) => <Button type="button" size="sm" variant="ghost" className="ps-action" aria-pressed={selected === run.id} key={run.id} onClick={() => setSelected(run.id)}>{run.title}</Button>)}</nav>}
    </>}
    {selected === null ? <p className="ps-message ps-muted">Select a run from its chat card or the active runs above.</p> : <RunInspector key={`${threadId}/${selected}`} threadId={threadId} runId={selected} />}
    {state.status !== "ready" ? null : <ChecklistPanel checklist={state.value.checklist} />}
    {state.status !== "ready" || !state.value.violations.length ? null : <section aria-label="Poteto violations">
      <h3>Poteto violations</h3>
      <ul>{state.value.violations.map((violation) => <li key={violation.key}>
        <p><code>{violation.key}</code>. {violation.detail}</p>
        {violation.acknowledgedAt === null ? <p>To acknowledge, send <code>/poteto-mode ack {violation.key}</code> as a user message.</p> : <p>Acknowledged.</p>}
      </li>)}</ul>
    </section>}
  </div>;
}

function Inspector({ threadId, params }: PluginThreadPanelProps) {
  const runId = panelRunId(params);
  return runId === undefined ? <div role="alert" className="pstack ps-message">This panel has invalid run parameters.</div> : <ThreadInspector key={threadId} threadId={threadId} runId={runId} />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "pstack-run", component: RunDirective });
  app.composer.customize({ id: "pstack-status", scopes: ["thread"], banners: [{ id: "runs-and-checklist", chrome: "bare", component: ComposerBanner }] });
  app.slots.pendingInteraction({ id: CHECKOUT_RENDERER, component: CheckoutConsent });
  app.slots.threadPanelAction({ id: PANEL_ACTION, title: "pstack runs and checklist", icon: "Layers", layout: "flush", component: Inspector });
  app.slots.navPanel({ id: "pstack-issues", title: "Issue workers", icon: "CircleDot", path: ISSUES_PATH, component: IssuesPage });
});
