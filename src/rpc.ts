import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { RUN_ID, RunView, ThreadView } from "./contract.ts";

/** The UI's RPC surface. The frontend imports only its type, so the SDK stays out of the app bundle. */
export const rpcContract = defineRpcContract({
  pstackThreadView: { input: z.object({ threadId: z.string() }), output: ThreadView },
  pstackRunView: { input: z.object({ threadId: z.string(), runId: z.string().regex(RUN_ID) }), output: RunView.nullable() },
  pstackStopRun: { input: z.object({ threadId: z.string(), runId: z.string().regex(RUN_ID) }), output: z.object({ stopped: z.boolean() }) },
  /** Sends the form's proof over realtime only, never in the reply, so a CLI caller cannot read it. */
  pstackCheckoutProof: { input: z.object({ formId: z.string() }), output: z.object({ sent: z.boolean() }) },
});
