import { EFFECT_POLICY, LABEL, TERMINAL, type Effect, type EffectMode, type EffectOutcome, type Job } from "./job.ts";
import { GitHubTransientError, type GitHub } from "./github.ts";
import type { IssueStore } from "./store.ts";
import { statusMarker } from "./text.ts";

export const STATUS_AUDIT_MS = 60 * 60_000;
export const TERMINAL_STATUS_AUDIT_MS = 24 * STATUS_AUDIT_MS;
export const DELIVERY_RETRY_MS = 60_000;
export const STATUS_CONCURRENCY = 4;
const SETTLE_MARGIN_MS = 5_000;

export function desiredLabels(job: Job): Extract<Effect, { op: "labels" }> {
  const ready = job.control.readiness !== null;
  const terminal = TERMINAL.has(job.phase.state);
  const add: Extract<Effect, { op: "labels" }>["add"] = ready ? [LABEL.review] : (terminal || job.control.parked) ? [] : [LABEL.working];
  const remove = [LABEL.working, LABEL.needsInfo, LABEL.review].filter((label) => !add.includes(label));
  return { op: "labels", key: `status-labels:${JSON.stringify({ add, remove })}`, on: "issue", add, remove };
}

export function desiredPrLabels(job: Job): Extract<Effect, { op: "labels" }> | null {
  if (!job.pr) return null;
  const add = job.control.parked ? [LABEL.stuck] : [];
  const remove = job.control.parked ? [] : [LABEL.stuck];
  return { op: "labels", key: `status-pr-labels:${job.pr.number}:${JSON.stringify({ add, remove })}`, on: "pr", add, remove };
}

type DeliveryDeps = {
  store: IssueStore;
  github: GitHub;
  clock: () => number;
  runEffect: (job: Job, effect: Effect, mode: EffectMode, deadline: number) => Promise<EffectOutcome>;
};

export function createStatusDelivery({ store, github, clock, runEffect }: DeliveryDeps): () => Promise<void> {
  let running: Promise<void> | null = null;
  async function deliver(): Promise<void> {
    const statuses = store.statuses(clock());
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, statuses.length) }, async () => {
      while (index < statuses.length) {
        const status = statuses[index++]!;
        if (!store.claimStatus(status, clock())) continue;
        try {
          if (status.nextAt <= clock() && status.retryNotBefore <= clock()) {
            let error: string | null = null;
            let nextAt = clock() + STATUS_AUDIT_MS;
            let notBefore = 0;
            try {
              await github.repo(status.repo, AbortSignal.timeout(50_000)).upsertIssueStatus({ issue: status.issue, marker: statusMarker(status.repo, status.issue), revision: status.revision, body: status.body });
              const projected = store.get(status.jobId);
              nextAt = clock() + (projected?.generation === status.generation && TERMINAL.has(projected.phase.state) ? TERMINAL_STATUS_AUDIT_MS : STATUS_AUDIT_MS);
            } catch (failure) {
              error = failure instanceof Error ? failure.message : String(failure);
              notBefore = failure instanceof GitHubTransientError ? failure.notBefore ?? 0 : 0;
              nextAt = Math.max(clock() + DELIVERY_RETRY_MS, notBefore);
            }
            store.settleStatus(status, { error, nextAt, notBefore, now: clock(), release: false });
          }
          const job = store.get(status.jobId);
          if (!job || job.generation !== status.generation) continue;
          for (const item of status.decorations) {
            if (clock() >= (status.leaseUntil ?? 0) - SETTLE_MARGIN_MS) break;
            const attempts = store.claimDecoration(status, item.effect.key, clock());
            if (attempts === null) continue;
            const outcome = await runEffect(job, item.effect, attempts > 0 && EFFECT_POLICY[item.effect.op].recovery.kind === "probe" ? "probe-then-perform" : "perform", status.leaseUntil! - SETTLE_MARGIN_MS);
            const error = outcome.kind === "done" ? null : "error" in outcome ? outcome.error : "delivery unconfirmed";
            const notBefore = outcome.kind === "retry" ? outcome.notBefore ?? 0 : 0;
            store.settleDecoration(status, item.effect.key, error, Math.max(clock() + DELIVERY_RETRY_MS, notBefore), clock(), notBefore);
          }
        } finally {
          store.releaseStatus(status, clock());
        }
      }
    }));
  }
  return () => {
    if (running) return running;
    const task = deliver().finally(() => { if (running === task) running = null; });
    running = task;
    return task;
  };
}
