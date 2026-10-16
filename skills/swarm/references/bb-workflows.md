# Running a pstack fan-out as a bb workflow

pstack bundles two bb workflows. They take over the launch of a panel or fan-out. Each skill's own phases, briefs, and aggregation still apply. The workflow only spawns the workers, applies each seat's model, validates structured results, and hands everything back in one result.

| Workflow | Shape | Used by |
|---|---|---|
| `pstack-panel` | N seats, each on its own model, all at once. Optional judge or synthesizer that receives every answer. | interrogate (reviewers), architect (runners), arena (cross-judge, read-only candidates), how (explorers, then the explainer as judge), why (investigators, then the synthesizer as judge), reflect (three reviewers, then the synthesizer as judge) |
| `pstack-swarm` | One shared brief across many slices, a structured report per slice, optional per-slice verifier. | swarm |

## When to use it

Run `bb pstack workflow ready`. Use a workflow when it exits 0 and the workers are read-only or write only to their own distinct paths. Exit 1 means the `workflows` plugin is not running. The run gets a live progress card, retries transient provider failures, validates structured results, and returns one notification instead of N. Don't enable the plugin on your own.

Use child threads (`bb thread spawn --parent-self`) instead when a worker needs its own checkout (`--new-environment worktree`), a fast service tier (`--service-tier fast`), or a remote machine. Workflow workers run as hidden threads in the parent's environment and have no per-worker worktree or service tier.

## 1. Build the args file

Write prompts the same way the skill already says to: fill its templates, give file pointers instead of pasting large payloads, and say "read-only" for workers that must not edit. Put large inputs (a diff, a transcript) in a file under `$BB_THREAD_STORAGE` or the workspace and point to it. Workers run on the same machine and can read it.

Read seat models from the role line:

```sh
bb pstack models --role "interrogate reviewers"
```

Each value is `provider/model/level` or `inherit-parent`, and maps straight onto a seat's `model` field.

`pstack-panel` args:

```json
{
  "prompt": "<shared prompt for every seat, used when a seat has no prompt of its own>",
  "seats": [
    { "label": "Reviewer A", "model": "claude-code/claude-opus-5-5/xhigh" },
    { "label": "Reviewer B", "model": "codex/gpt-6.1-sol/xhigh", "prompt": "<optional per-seat prompt>" }
  ],
  "schema": { "type": "object", "required": ["findings"], "properties": { "findings": { "type": "array", "items": { "type": "string" } } } },
  "judge": { "label": "Synthesizer", "model": "claude-code/claude-opus-5-5/xhigh", "prompt": "<judge or synthesizer prompt>" }
}
```

`schema` and `judge` are optional. Without `schema`, each seat returns its final text. The judge's prompt is followed by every seat's answer under `# Panel answers`, labeled with the seat and its model. Add `judge.schema` when you parse the judge's answer.

`pstack-swarm` args:

```json
{
  "brief": "<standalone brief every worker gets>",
  "model": "codex/gpt-6.1-sol/xhigh",
  "slices": ["packages/api", { "name": "packages/cli", "brief": "<slice-specific notes>", "model": "inherit-parent" }],
  "verify": { "model": "claude-code/claude-opus-5-5/high", "prompt": "<what the verifier checks>" }
}
```

Each worker returns `{ slice, status: PASS | ISSUES | BLOCKED, summary, evidence[], issues[] }`. With `verify`, each report also carries `verification: { slice, confirmed, notes }`, or `null` when the verifier failed.

Schemas use the workflows plugin's safe subset. That means `type`, `properties`, `required`, `additionalProperties`, `items`, scalar `enum`, `const`, and size bounds. Do not use `pattern`, `format`, `$ref`, or combinators.

## 2. Run it

From the shell:

```sh
bb workflows run --script "$(bb pstack workflow source pstack-panel)" \
  --args "$(cat "$BB_THREAD_STORAGE/panel-args.json")"
```

The command prints `{"runId": …}` and returns immediately. Alternatively, call the `bb_workflow_run` tool with `script` set to the output of `bb pstack workflow source <name>` and `args` set to the JSON value. Copy its `previewDirective` into your reply once, on its own line, so the user sees the live run card.

A bad tuple fails that seat's call, which shows up as a dropped seat. It does not substitute a different model.

## 3. Collect the result

The finish arrives as a `[BB workflow finished · <run-id>]` message with the result inline. `bb workflows status <run-id>` is authoritative. Its `result` field holds the following.

- `pstack-panel` returns `{ results: [{ label, model, output }], dropped: [{ label, model }], judge }`.
- `pstack-swarm` returns `{ reports: [...], missing: [slice names] }`.

A dropped seat or missing slice is a dropout. Handle it the way the skill handles one (respawn once, proceed with N-1, or record the gap). Then run the skill's own synthesis, lead judgment, or aggregation over the result. The workflow's judge output is an input to your judgment, not a replacement for it.

For worker transcripts, redirect history into a file instead of printing it:

```sh
mkdir -p "$BB_THREAD_STORAGE/workflows"
bb workflows history <run-id> --cursor 0 --limit 100 > "$BB_THREAD_STORAGE/workflows/<run-id>.jsonl"
```

Stop a run with `bb workflows stop <run-id>`. Relaunch with `--resume <run-id>` to reuse every successful call that did not change.
