---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the pstack plugin's models setting, which overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack plugin's `models` setting, which sets pstack's model per role. Every value is a bb tuple `provider/model/level`.

## Steps

### 1. Detect available models

List the providers, then each provider's models for this environment. That is the dependable source.

```sh
bb provider list --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Each model entry has `model`, `supportedReasoningEfforts[].reasoningEffort`, and `supportedServiceTiers`. The detected set is every `provider/model/level` where `level` is one of that model's supported efforts. If you cannot detect any, ask the user to paste the tuples they have access to. Never write a real tuple you have not confirmed is available. The alias `inherit-parent` is always valid even though it is not a detected tuple.

### 2. Load current state

The default role-to-model mapping is the shape shown in step 5 below. If `bb plugin config pstack` shows a `models` value, read it and treat its `# budget` line and its role values as the current choices. `bb pstack models` prints the effective table (defaults merged with overrides). Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Use a structured question (AskUserQuestion in Claude Code), or plain text when the provider has none. Offer these four options with these exact labels, and name the current budget when the setting records one. With no setting, say that `large` matches the skill defaults.

- `unlimited: max reasoning`
- `large: xhigh reasoning`
- `medium: high reasoning`
- `small: medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by provider, model, list, or alias (`inherit-parent`). `unlimited`, `large`, `medium`, and `small` set the level of every real tuple, panel entries included, to `max`, `xhigh`, `high`, or `medium`. The level is the third segment, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. Efforts a provider lists off this ladder (such as `ultra` or `ultracode`) are never picked by a budget. If the model's `supportedReasoningEfforts` lacks the target, use the highest supported level at or below it, else mark the role as needing a choice. `inherit-parent` does not change. So `unlimited` turns `claude-code/claude-opus-5-5/xhigh` into `claude-code/claude-opus-5-5/max` and `codex/gpt-6.1-sol/xhigh` into `codex/gpt-6.1-sol/max`. `large` keeps both defaults. `small` turns them into `claude-code/claude-opus-5-5/medium` and `codex/gpt-6.1-sol/medium`.

**(c) Show the roles and confirm.** Show every role with its tuple, marking any real tuple not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` (this role runs on the parent thread's provider, model, and level) as the options. Use a structured question. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a comma-separated list, and one child thread runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose provider and model family differ from the parent thread's when possible. `swarm workers` is the default tuple for every worker unless a race or comparison assigns another tuple per arm.

### 4. Validate

Every real tuple written must be in the detected set: the provider is in `bb provider list`, the model is in that provider's `bb provider models` output, and the level is in that model's `supportedReasoningEfforts`. `inherit-parent` always passes. If a chosen real tuple is not available, stop and ask again.

### 5. Write the setting

Write the whole value in one call, a `# budget` line with the chosen label and its target effort, then one line per role, using the same labels poteto-mode uses. Setting the whole value keeps re-runs idempotent. Shape:

```sh
bb plugin config pstack set models "# budget: large (xhigh)
feature, refactoring: codex/gpt-6.1-sol/xhigh
bug-fix: codex/gpt-6.1-sol/xhigh
perf-issue: codex/gpt-6.1-sol/xhigh
hillclimb: codex/gpt-6.1-sol/xhigh
judgment and prose: claude-code/claude-opus-5-5/xhigh
hardest tasks: claude-code/claude-opus-5-5/xhigh
how explorer: codex/gpt-6.1-sol/xhigh
how explainer: claude-code/claude-opus-5-5/xhigh
why investigators: codex/gpt-6.1-sol/xhigh
why synthesizer: claude-code/claude-opus-5-5/xhigh
reflect tooling: codex/gpt-6.1-sol/xhigh
reflect judgment, divergent, synthesizer: claude-code/claude-opus-5-5/xhigh
arena runners: claude-code/claude-opus-5-5/xhigh, codex/gpt-6.1-sol/xhigh
arena cross-judge pool: claude-code/claude-opus-5-5/xhigh, codex/gpt-6.1-sol/xhigh
swarm workers: codex/gpt-6.1-sol/xhigh
architect runners: claude-code/claude-opus-5-5/xhigh, codex/gpt-6.1-sol/xhigh
interrogate reviewers: claude-code/claude-opus-5-5/xhigh, codex/gpt-6.1-sol/xhigh"
```

A role with no line falls back to the skill default. `inherit-parent` as a value means the role runs on the parent thread's execution (omit `--provider`, `--model`, and `--reasoning-level`). Alias entries in a panel list still count toward its fan-out.

### 6. Confirm

Run `bb pstack doctor`. It checks every effective role against the live provider catalog. Fix any `FAIL` line before you finish. Then show the result with `bb pstack models`. Tell the user the configuration was written and that it applies to new threads, and to existing threads when their provider session next starts. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (it ships with the pstack plugin). On no, move on without pushing.
