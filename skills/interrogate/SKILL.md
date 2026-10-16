---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Multiple LLM reviewers challenge changes from independent angles."
disable-model-invocation: true
---

# Interrogate

Spawn one reviewer per configured model to adversarially review code changes. The adversarial signal comes from model diversity, not assigned personas. The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that.
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset.
- If the user's message references recent work, gather the relevant files.

Package the diff or file contents with any surrounding context files the reviewers need to understand the code.

## Step 2, Intent

Before spawning reviewers, state the intent in one clear paragraph from the user's message, commit messages, the PR description if one exists, and the code. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

**Launch path.** Run `bb pstack workflow ready` before spawning anything. If it exits 0, launch the reviewers as the bundled `pstack-panel` workflow (one seat per entry of `bb pstack models --role "interrogate reviewers"`, labeled Reviewer A, B, and so on, every seat with the filled reviewer prompt below, and no `judge`, since Step 5's lead judgment is yours) with `bb workflows run --script "$(bb pstack workflow source pstack-panel)" --args …`, collect the result as [`../swarm/references/bb-workflows.md`](../swarm/references/bb-workflows.md) describes, and skip the child-thread instructions below. If it exits 1, spawn child threads as below.

Launch all reviewers at once as child threads, one per entry on the `interrogate reviewers` line of the pstack `models` setting (`bb pstack models` prints the effective table), labeled Reviewer A, B, and so on to match the entry count. If that line is missing, use the table defaults.

| Reviewer | Default tuple |
|----------|---------------|
| Reviewer A | `claude-code/claude-opus-5-5/xhigh` |
| Reviewer B | `codex/gpt-6.1-sol/xhigh` |

Each reviewer is spawned with `bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --title "Reviewer <label>" --prompt-file -`, is told in its prompt that it is read-only (no file edits, no commits), and gets `--provider <id> --model <model> --reasoning-level <level>` from its configured entry, or its table default when there is no configured line. Omit the three flags for an `inherit-parent` entry, so that reviewer runs on the parent thread's execution. Each child notifies you when it finishes. Read its findings with `bb thread output <id>`.

If `bb thread spawn` rejects a configured entry, run that reviewer on its family's table default and say so. Families go by provider: `claude-code` or `codex`. With no family match, use Reviewer A's default. If it rejects a table default, spawn with the closest equivalent from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json` (prefer the same provider and reasoning level), and open a separate PR to update the default table. Do not block the review on the tuple issue. Never treat an alias entry as a rejected tuple or apply either fallback to it.

Read `references/reviewer-prompt.md` and fill in the same template for every reviewer with the stated intent, the diff or file contents, the rubric from `references/rubric.md`, and the code-quality lens from `references/code-quality-review.md`. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.

## Step 4, Synthesize

As results come back, build a unified picture. Parse every reviewer's findings. Merge findings that describe the same issue differently, and note which models raised each one. Findings two or more models raised independently are the highest signal. Read a lone model's finding, but weight it accordingly. Note disagreements. If one model flags something and another explicitly says the opposite, that is context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read `references/lead-judgment.md` for the full framework. Put every finding in one of four buckets, with the model(s) that raised it and a one-line rationale.

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. They would block a real PR.
- **Consider**. Legitimate, but you're not sure they outweigh the cost of addressing them now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact at this stage.
- **Dismissed**. Wrong, nitpicky, or missing context, with a brief reason.

## Output Format

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model name], [N findings] (one bullet per reviewer)

### Act On
[Each: description, which models raised it, why it matters.]

### Consider
[Each: description, which models raised it, the tradeoff.]

### Noted
[Brief list.]

### Dismissed
[Each with a brief rationale.]

### Agreement Map
[Where models agreed and diverged, and what that pattern tells us.]
