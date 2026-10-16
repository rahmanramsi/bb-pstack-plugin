import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Realtime channel. Payload is `{ threadId, revision }` only; every mount refetches through RPC. */
export const STATE_CHANNEL = "pstack-state";

/** Chat directive the CLI prints for a run; the agent copies it into its reply once. */
export const runDirective = (runId: string) => `::pstack-run{run="${runId}"}`;
export const RUN_ID = /^psr_[0-9a-f-]{36}$/;

/** A seat or worker model: a configured role (expanded by the plugin) or an explicit tuple. */
export const ModelRef = z.union([
  z.object({ role: z.string().min(1) }).strict(),
  z.object({ tuple: z.string().min(1) }).strict(),
]);

/** Fixed result contracts. Each maps to one zod schema in RESULT_SCHEMAS; there are no custom schemas. */
export const ResultKind = z.enum(["text", "review", "grouping", "report", "verdict"]);
export type ResultKind = z.infer<typeof ResultKind>;

export const Severity = z.enum(["critical", "warning", "nit"]);

export const Finding = z
  .object({
    severity: Severity,
    title: z.string().min(1).max(200),
    location: z.string().max(300),
    detail: z.string().max(4000),
    suggestion: z.string().max(2000).optional(),
  })
  .strict();

/** A judge that groups seat findings refers to them by plugin-assigned refs such as `A.1`. */
export const FindingGroup = z
  .object({
    title: z.string().min(1).max(200),
    severity: Severity,
    verdict: z.enum(["act-on", "consider", "noted", "dismissed"]),
    members: z.array(z.string().regex(/^[A-Z]{1,2}\.\d+$/)).min(1),
    rationale: z.string().max(2000),
  })
  .strict();

export const RESULT_SCHEMAS = {
  text: z.string(),
  review: z.object({ findings: z.array(Finding).max(100) }).strict(),
  grouping: z.object({ summary: z.string().max(4000), groups: z.array(FindingGroup).max(100) }).strict(),
  report: z
    .object({
      slice: z.string(),
      status: z.enum(["PASS", "ISSUES", "BLOCKED"]),
      summary: z.string().max(2000),
      evidence: z.array(z.string().max(1000)).max(50),
      issues: z.array(z.string().max(1000)).max(50),
    })
    .strict(),
  verdict: z
    .object({ slice: z.string(), verdict: z.enum(["VERIFIED", "NOT_VERIFIED", "INCONCLUSIVE"]), notes: z.string().max(4000) })
    .strict(),
} as const satisfies Record<ResultKind, z.ZodType>;

export type ResultValue<K extends ResultKind> = z.infer<(typeof RESULT_SCHEMAS)[K]>;

/**
 * What `bb pstack run start --file <plan.json>` accepts. Parsed once at the CLI boundary.
 * A seat with `model: { role }` expands into one seat per configured entry of that role
 * (label `{letter}` / `{n}` templated). A judge `role` is a pool: the plugin picks the entry whose
 * provider differs from the origin thread's, else the first.
 */
export const RunPlan = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("panel"),
      title: z.string().min(1).max(120),
      requestKey: z.string().min(1).max(200).optional(),
      seats: z
        .array(
          z
            .object({
              label: z.string().min(1).max(60),
              model: ModelRef,
              prompt: z.string().min(1),
              result: ResultKind.default("text"),
            })
            .strict(),
        )
        .min(1)
        .max(12),
      failure: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("quorum"), minimum: z.number().int().min(1) }).strict(),
          z.object({ kind: z.literal("all-required") }).strict(),
        ])
        .default({ kind: "quorum", minimum: 1 }),
      judge: z
        .object({
          label: z.string().min(1).max(60).default("Judge"),
          model: ModelRef,
          prompt: z.string().min(1),
          result: ResultKind.default("text"),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("swarm"),
      title: z.string().min(1).max(120),
      requestKey: z.string().min(1).max(200).optional(),
      brief: z.string().min(1),
      model: ModelRef.default({ role: "swarm workers" }),
      slices: z
        .array(
          z.union([
            z.string().min(1).max(120),
            z.object({ name: z.string().min(1).max(120), brief: z.string().optional(), model: ModelRef.optional() }).strict(),
          ]),
        )
        .min(1)
        .max(64),
      verify: z.object({ prompt: z.string().min(1), model: ModelRef.optional() }).strict().optional(),
    })
    .strict(),
]);
export type RunPlan = z.infer<typeof RunPlan>;

export const JobState = z.enum(["blocked", "queued", "running", "repairing", "uncertain", "succeeded", "failed", "skipped", "cancelled"]);
export const RunStatus = z.enum(["running", "succeeded", "partial", "failed", "cancelled"]);
export const StepStatus = z.enum(["open", "done", "skipped"]);

const JobView = z.object({
  key: z.string(),
  kind: z.enum(["seat", "judge", "slice", "verifier"]),
  label: z.string(),
  model: z.string(),
  state: JobState,
  attempt: z.number().int(),
  threadId: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  /** Short outcome line for cards: "4 findings", "PASS", "VERIFIED". */
  summary: z.string().nullable(),
  /** For swarm slice jobs: the slice they belong to. */
  slice: z.string().nullable(),
});

const MatrixRow = z.object({
  title: z.string(),
  severity: Severity,
  verdict: FindingGroup.shape.verdict.nullable(),
  /** seat label -> severity that seat gave, or null when it did not report the finding. */
  cells: z.record(z.string(), Severity.nullable()),
});

export const RunView = z.object({
  id: z.string(),
  kind: z.enum(["panel", "swarm"]),
  title: z.string(),
  status: RunStatus,
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  jobs: z.array(JobView),
  findings: z.array(Finding.extend({ ref: z.string(), seat: z.string() })),
  matrix: z.array(MatrixRow).nullable(),
});
export type RunView = z.infer<typeof RunView>;

export const StepView = z.object({
  id: z.string(),
  section: z.enum(["playbook", "pr"]),
  text: z.string(),
  status: StepStatus,
  evidence: z.array(z.string()),
  reason: z.string().nullable(),
});

export const ChecklistView = z.object({
  playbook: z.string(),
  steps: z.array(StepView),
  open: z.number().int(),
});

export const ThreadView = z.object({
  revision: z.number().int(),
  activeRuns: z.array(RunView.pick({ id: true, kind: true, title: true, status: true, jobs: true })),
  checklist: ChecklistView.nullable(),
});

export const rpcContract = defineRpcContract({
  pstackThreadView: { input: z.object({ threadId: z.string() }), output: ThreadView },
  pstackRunView: { input: z.object({ threadId: z.string(), runId: z.string().regex(RUN_ID) }), output: RunView },
  pstackStopRun: { input: z.object({ threadId: z.string(), runId: z.string().regex(RUN_ID) }), output: z.object({ stopped: z.boolean() }) },
});
