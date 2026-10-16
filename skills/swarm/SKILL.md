---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
4. Pick the worker model from the `swarm workers` line of the pstack `models` setting (`bb pstack models` prints the effective table). If that line is missing, use `codex/gpt-6.1-sol/xhigh`. For `inherit-parent`, omit `--provider`, `--model`, and `--reasoning-level` so the workers run on the parent thread's execution. If `bb thread spawn` rejects a tuple, use the default and say so. If it rejects the default, use the closest valid model of the same provider from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json`. For a model race, name each arm's tuple up front. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

**Launch path.** When no worker needs its own worktree or the fast tier, run `bb pstack workflow ready`. If it exits 0, run the whole fan-out as the bundled `pstack-swarm` workflow (one slice per worker, the shared brief, the step 4 tuple as `model`, and an optional `verify` stage) with `bb workflows run --script "$(bb pstack workflow source pstack-swarm)" --args …`. It returns one structured report per slice and names every dropout. See [`references/bb-workflows.md`](references/bb-workflows.md). Otherwise spawn child threads as below.

Spawn all N workers at once as child threads, each with `bb thread spawn --parent-self --project "$BB_PROJECT_ID" --title "<short>" --prompt-file -` and the step 4 tuple as `--provider <id> --model <model> --reasoning-level <level>`, left unset for `inherit-parent`. A worker that writes gets `--new-environment worktree`. A read-only worker can share `--environment "$BB_ENVIRONMENT_ID"`. Each child notifies you when it finishes. Read its result with `bb thread output <id>`.

When a worker must start from a non-default branch, pass `--base-branch <ref>` with `--new-environment worktree`.



Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
