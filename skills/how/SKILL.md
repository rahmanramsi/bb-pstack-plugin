---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every worker runs in a pstack run ([`../poteto-mode/references/pstack-runs.md`](../poteto-mode/references/pstack-runs.md)) and is told in its prompt that it is read-only (no file edits, no commits). Every seat and the judge set `"reads": "commit"`, because they read committed code and nothing else. The explainer reads code too, so it is `commit` as well, not `prompt`. Keep their prompts free of local paths. Explorers use `{ "role": "how explorer" }` (default `codex/gpt-6.1-sol/xhigh`), and the explainer uses `{ "role": "how explainer" }` (default `claude-code/claude-opus-5-5/xhigh`). `bb pstack models` prints the effective table. If `bb pstack run start` rejects a tuple, use the default as an explicit `{ "tuple": … }` and say so. If it rejects the default, use the closest valid model of the same provider from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json`. Pick each worker's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Run a `panel` with one explainer seat that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Launch one `panel` with a seat per angle, each with `references/explorer-prompt.md` and its angle filled in, all on the `how explorer` role.

## 3. Synthesize (complex only)

The explainer is the same run's `judge`, on the `how explainer` role, with `references/explainer-prompt.md` as its prompt. The run hands it every explorer's findings, so step 3 is done when the run finishes. Read the judge's answer from the finish message or `bb pstack run status <id> --json`.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
