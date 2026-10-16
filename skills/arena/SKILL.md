---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Use the `arena runners` line of the pstack `models` setting (`bb pstack models` prints the effective table). If that line is missing, default to one each on `claude-code/claude-opus-5-5/xhigh` and `codex/gpt-6.1-sol/xhigh`. An `inherit-parent` entry in this line or the cross-judge line means the parent thread's execution, so omit `--provider`, `--model`, and `--reasoning-level` for it. If `bb thread spawn` rejects a configured tuple, run that seat on its family's default and say so. Families go by provider: `claude-code` or `codex`. With no family match, use `claude-code/claude-opus-5-5/xhigh`. If it rejects a default, use the closest valid model of the same provider from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json`. Spawn more runners when the arena covers multiple design directions. Use the same tuple N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each candidate its own output location (a bb managed worktree via `--new-environment worktree` where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

**Launch path.** When candidates only write to their own `/tmp/arena-<slug>/candidate-<n>/` paths, launch the fan-out and the Phase C cross-judge as one pstack run ([`../poteto-mode/references/pstack-runs.md`](../poteto-mode/references/pstack-runs.md)): a `panel` with one seat per runner, each seat's prompt naming its own output path, and the cross-judge as its `judge` on `{ "role": "arena cross-judge pool" }`, which picks a provider that differs from this thread's. Phase C is then done when the run finishes. When candidates need their own checkout, spawn child threads as below.

Spawn all N candidates at once as child threads (`bb thread spawn --parent-self --project "$BB_PROJECT_ID" --title "arena candidate <n>" --prompt-file -` plus the runner's model flags), each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

Each child notifies you when it finishes. Read its result with `bb thread output <id>`. Workflow workers share the parent's environment, so each candidate writes to its `/tmp/arena-<slug>/candidate-<n>/` path.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one tuple from the `arena cross-judge pool` line of the pstack `models` setting. If that line is missing, choose from `claude-code/claude-opus-5-5/xhigh` and `codex/gpt-6.1-sol/xhigh`. Prefer a provider and model family that differs from the parent thread's (`bb thread show --self --json` gives the parent's `.thread.providerId`). Spawn one read-only judge thread on that tuple (no file edits, no commits). It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
