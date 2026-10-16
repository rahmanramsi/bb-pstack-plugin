---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Every spawn is a read-only child thread (no file edits, no commits, said in its prompt): `bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --title "<short>" --prompt-file -`. Explorers use the `how explorer` line of the pstack `models` setting (default `codex/gpt-6.1-sol/xhigh`), and every explainer uses the `how explainer` line (default `claude-code/claude-opus-5-5/xhigh`). Pass that line's tuple as `--provider <id> --model <model> --reasoning-level <level>`, or the default if the line is missing (`bb pstack models` prints the effective table). Omit the three flags when the value is `inherit-parent`. If `bb thread spawn` rejects a tuple, use the default and say so. If it rejects the default, use the closest valid model of the same provider from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json`. Read each result with `bb thread output <id>`. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

**Launch path.** Run `bb pstack workflow ready` before spawning anything. If it exits 0, launch the explorers and the explainer together as the bundled `pstack-panel` workflow (one seat per angle with its filled explorer prompt on the `how explorer` tuple, and the step 3 explainer as the `judge` on the `how explainer` tuple with `references/explainer-prompt.md` as its prompt, so step 3 is done when the run finishes) with `bb workflows run --script "$(bb pstack workflow source pstack-panel)" --args …`, collect the result as [`../swarm/references/bb-workflows.md`](../swarm/references/bb-workflows.md) describes, and skip the child-thread instructions below. If it exits 1, spawn child threads as below.

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers at once, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
