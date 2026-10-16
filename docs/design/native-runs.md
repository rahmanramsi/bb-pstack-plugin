# Native panel runs and playbook checklists

## Problem

pstack's review panels (`interrogate`, `architect`, `arena`, `how`, `why`, `reflect`) and `swarm` need several models to work in parallel and report back. pstack must run these itself instead of depending on another plugin. `/poteto-mode` also asks the agent to copy a playbook's steps into a todo list and close each one, but nothing checks that it does. Agents skip steps without saying so.

The bb Plugin SDK sets the limits:

- `threads.spawn` has no idempotency key.
- Instructions from a plugin are fixed for the life of a provider session.
- The `message.dispatch` hook can admit or hold a message, but cannot change it.
- A newly registered agent tool appears only when a session next starts.

## Usage

The thread that runs a skill uses the `bb pstack` CLI. The CLI works in any provider and in a session that is already running. Only hidden worker threads see the `pstack_result` tool.

A panel (`interrogate`, step 3):

```sh
bb pstack run start --file "$BB_THREAD_STORAGE/review-plan.json"
```

```json
{
  "kind": "panel",
  "title": "Review src/doctor.ts",
  "seats": [{ "label": "Reviewer {letter}", "model": { "role": "interrogate reviewers" },
              "prompt": "Read-only. The review brief is at /…/brief.md.", "result": "review" }]
}
```

The role expands into one seat per configured model. The command prints the run id and a `::pstack-run{run="psr_…"}` directive for the chat card. When the run ends, the thread gets one agent-only message with every seat's outcome.

A swarm (`swarm`, phase B):

```json
{ "kind": "swarm", "title": "check.sh per package", "brief": "Read-only. Run the package's check.sh.",
  "slices": ["packages/api", "packages/cli"],
  "verify": { "prompt": "Re-run the evidence yourself." } }
```

Each slice gets its verifier as soon as that slice finishes. There is no barrier.

A playbook checklist (`poteto-mode`):

```sh
bb pstack checklist begin feature        # the plugin copies the steps; idempotent
bb pstack checklist done 1 --evidence run:psr_…
bb pstack checklist skip 7 --reason "design not contested; both reviewers agreed"
bb pstack checklist add "Port the fix to app.tsx" --after 4
bb pstack gate pr                        # exit 1 with every open step; run before gh pr create
bb pstack gate done                      # exit 1 until every step, including after-PR ones, is closed
```

Every `bb pstack` command ends with the open steps.

## Shape

**Jobs, not a graph.** A run is a fixed set of jobs inserted at start (`src/runner.ts`).
- A panel has one `seat` job per seat, plus an optional `judge` that waits for every seat.
- A swarm has one `slice` job per slice, plus an optional `verifier` that waits for its own slice only.

`compile()` is the only place that knows these two shapes.

**A pure reconciler.** `plan(snapshot, now)` returns actions: release, skip, spawn, retry, repair, fail and finish. The engine applies each action through a compare-and-set transition in `src/store.ts`, so applying one twice does nothing. Thread events, a 15 s maintenance tick and startup all call the same `tick(runId)`. The tick polls running workers, so a missed event cannot strand a run.

**No duplicate workers.** An attempt row is claimed with `INSERT OR IGNORE` and stored as `issued` before `threads.spawn` runs. On restart:
- An issued attempt whose thread is found through plugin metadata is adopted.
- An issued attempt with no thread found becomes `uncertain`, and stays that way until the run deadline.

An issued attempt is never spawned again, because a late spawn would duplicate a seat or a judge.

**Failure policy.**
- **Panel.** The failure policy is stored on the plan: `quorum` (default 1) or `all-required`. A judge receives every input's outcome, with failed seats named. When the quorum is missed, the judge is skipped.
- **Retries.** Transient provider failures retry twice on a fresh thread, after 1 s and then 4 s. Structured results get two corrective turns.
- **Run status.** It is derived from the job states: `succeeded`, `partial`, `failed` or `cancelled`.

**Fixed result contracts.** `text`, `review`, `grouping`, `report` and `verdict` each map to one Zod schema in `src/contract.ts`. There are no custom schemas, because no skill needs one.

**Agreement by reference.**
- Seats that return `review` findings get refs such as `A.1`.
- A judge with the `grouping` contract groups those refs and gives each group a verdict. The plugin checks that every ref exists and appears in at most one group.
- The matrix is derived from that grouping. The plugin never guesses which findings match.

**Checklists** (`src/checklist.ts`).
- The plugin extracts the steps from the skill files: the numbered steps of a playbook, the phases of figure-it-out, and the bold-lead paragraphs of Opening a PR. Opening a PR is appended to every playbook.
- Text is copied verbatim and snapshotted, so a later edit to a skill does not change an open checklist.
- A step closes only as `done` with evidence (`thread:`, `run:`, `commit:`, `path:`, `pr:`) or `skipped` with a reason. A SQLite `CHECK` enforces the same rule.
- Both gates are pure functions of the stored state.

**Where open steps reach the agent.**
- The session instructions list them for new and resumed sessions.
- Every `bb pstack` command prints them.
- One agent-only nudge is sent when the thread goes idle with open steps. The checklist records the revision it nudged at, and only a step change starts a new revision, so the nudge cannot loop.

**Surfaces.**
- The UI reads `pstackThreadView` and `pstackRunView` over RPC.
- It refetches on a payload-free `pstack-state` signal and polls every 15 s while it is visible.
- Workers are hidden threads owned by the origin thread. The UI reaches them through the card and the inspector.

## Synthesis decision

This design came from two candidate sketches and a cross-judge.

**Base.** The candidate with fixed jobs, a never-respawn rule for uncertain attempts, and a gate over every step.

**Taken from the other candidate:**
- plugin-side role expansion and judge-pool selection;
- explicit finding refs for grouping;
- a pure `plan()` reconciler;
- the CLI as the only surface for the origin thread.

**Rejected:**
- a generic task graph (speculative for two shapes);
- native origin tools (two ways to do one task, and they appear only in new sessions);
- custom JSON schemas with Ajv;
- automatic grouping of findings by text.

## Tradeoffs accepted

- We accept a possible `uncertain` gap after a crash during a spawn, in exchange for never running a duplicate seat or judge.
- We accept at-least-once completion messages, in exchange for honest delivery semantics.
- We accept that open steps reach the agent at session start, on every command and in one nudge, not on every turn, because the SDK cannot do more.
- We accept a 15 s poll of running workers, in exchange for never stranding a run on a missed event.

## Alternatives considered

- **A generic dependency graph, or the Workflows script engine.** It covers more shapes, but skills would have to learn nodes and edges. Two fixed shapes hide that.
- **Native tools for the origin thread.** They render better in the timeline. They lost because they appear only after a session restart, and a parallel CLI would give agents two ways to do one task.
- **Automatic clustering of findings.** It needs no judge. It lost because a wrong merge creates false agreement, which is the strongest signal in a review.

## Open questions and risks

- Can recovery find every plugin-owned hidden thread after a lost spawn response? If it cannot, the job stays `uncertain` until the deadline.
- Is one nudge per checklist revision too chatty when the agent is waiting for the user on purpose?
