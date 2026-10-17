import { useEffect, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "../../components/ui/button.tsx";
import { CHECKOUT_PROOF_CHANNEL, ConsentForm, ProofSignal, type ConsentAnswer, type Verdict } from "../checkout-form.ts";
import type { rpcContract } from "../rpc.ts";

export function CheckoutConsent({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = ConsentForm.safeParse(interaction.payload);
  const form = parsed.success ? parsed.data : null;
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [proof, setProof] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Verdict>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRealtime(CHECKOUT_PROOF_CHANNEL, (payload) => {
    const signal = ProofSignal.safeParse(payload);
    if (signal.success && signal.data.formId === form?.formId) setProof(signal.data.proof);
  });
  useEffect(() => {
    if (form === null || proof !== null || connection !== "connected") return;
    rpc.call("pstackCheckoutProof", { formId: form.formId }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [form?.formId, proof, connection]);

  const settle = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  if (form === null) {
    return <div className="pstack ps-card"><p role="alert" className="ps-message">This checkout form is invalid.</p>
      <div className="ps-actions"><Button type="button" size="sm" variant="ghost" onClick={() => void settle(cancel)}>Close</Button></div></div>;
  }
  const decided = Object.keys(choices).length;
  const allows = Object.values(choices).includes("allow");
  const answer: ConsentAnswer = { decisions: choices, proof: allows ? proof : null };
  return <section className="pstack ps-card ps-consent" aria-labelledby={`consent-${form.formId}`}>
    <div className="ps-heading">
      <h2 id={`consent-${form.formId}`} className="ps-consent-title">Clone {form.projectName} onto more machines?</h2>
      <p className="ps-muted">When this machine is full, pstack can start delegates on another one. These machines have no checkout of {form.projectName}. Allowing a machine clones the project's repository onto it.</p>
    </div>
    <ul className="ps-consent-hosts">
      {form.hosts.map((host) => <li key={host.id} className="ps-consent-host">
        <span className="ps-consent-name">{host.name}<span className="ps-muted"> {host.id}</span></span>
        <span role="group" aria-label={`Clone onto ${host.name}`} className="ps-consent-choice">
          {(["allow", "deny"] as const).map((verdict) => <Button key={verdict} type="button" size="sm" variant="ghost" className="ps-action"
            aria-pressed={choices[host.id] === verdict} disabled={busy}
            onClick={() => setChoices((current) => ({ ...current, [host.id]: verdict }))}>{verdict === "allow" ? "Allow" : "Deny"}</Button>)}
        </span>
      </li>)}
    </ul>
    <div className="ps-actions">
      <Button type="button" size="sm" disabled={busy || decided === 0 || (allows && proof === null)} onClick={() => void settle(() => submit(answer))}>Save</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void settle(cancel)}>Not now</Button>
      {allows && proof === null ? <p role="status" className="ps-muted">Waiting for the connection to bb before an allow can be saved.</p> : null}
      {error === null ? null : <p role="alert" className="ps-error">{error}</p>}
    </div>
  </section>;
}
