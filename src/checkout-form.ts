import { z } from "zod";

/** The `bb.ui.requestInput` renderer id; the app registers a `pendingInteraction` slot under the same id. */
export const CHECKOUT_RENDERER = "checkout-consent";
/** Realtime channel that carries a form's proof to the bb app, which the bb CLI cannot read. */
export const CHECKOUT_PROOF_CHANNEL = "pstack-checkout-proof";

export const Verdict = z.enum(["allow", "deny"]);
export type Verdict = z.infer<typeof Verdict>;

export const ConsentForm = z.object({
  formId: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string(),
  hosts: z.array(z.object({ id: z.string().min(1), name: z.string() })).min(1),
});
export type ConsentForm = z.infer<typeof ConsentForm>;

export const ConsentAnswer = z.object({
  decisions: z.record(z.string(), Verdict),
  proof: z.string().nullable(),
}).strict();
export type ConsentAnswer = z.infer<typeof ConsentAnswer>;

export const ProofSignal = z.object({ formId: z.string(), proof: z.string() });
