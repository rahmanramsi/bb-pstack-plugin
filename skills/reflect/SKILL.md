---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, export this conversation's bb thread (`$BB_THREAD_ID`, the thread `bb thread show --self --json` reports) to a file. Do not search across other projects' threads. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
bb thread log --self --all > "$BB_THREAD_STORAGE/reflect-transcript.txt"
```

That file is the transcript path the reviewer templates take. If the export fails or comes back empty, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

**Launch path.** Run `bb pstack workflow ready` before spawning anything. If it exits 0, launch the three reviewers and the synthesizer together as the bundled `pstack-panel` workflow (the three reviewers as seats with their filled templates and role tuples from the table below, and the synthesizer as the `judge` on its role tuple. Workflow workers are ordinary threads on their provider, so they keep the same MCP access) with `bb workflows run --script "$(bb pstack workflow source pstack-panel)" --args …`, collect the result as [`../swarm/references/bb-workflows.md`](../swarm/references/bb-workflows.md) describes, and skip the child-thread instructions below. If it exits 1, spawn child threads as below.

Spawn three child threads at once, each with `bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --title "<short>" --prompt-file -`. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, so they run as plain threads. Their templates already forbid file edits.

Each reviewer and the synthesizer name a role line of the pstack `models` setting and a default (`bb pstack models` prints the effective table). Pass that line's tuple as `--provider <id> --model <model> --reasoning-level <level>`, or the default if the line is missing. Omit the three flags when the value is `inherit-parent`. If `bb thread spawn` rejects a tuple, use the default and say so. If it rejects the default, use the closest valid model of the same provider from `bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json`. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default tuple | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `claude-code/claude-opus-5-5/xhigh` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `codex/gpt-6.1-sol/xhigh` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `claude-code/claude-opus-5-5/xhigh` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings as their final message. Read each with `bb thread output <id>`.

## 3. Synthesize

One child thread, spawned the same way, with the tuple from the `reflect judgment, divergent, synthesizer` line (default `claude-code/claude-opus-5-5/xhigh`). It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to bb's `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and use it to tune the skill's description.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
