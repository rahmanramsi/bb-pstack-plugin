# Running a panel or a swarm

pstack runs its multi-model panels and fan-outs itself. A run puts each worker on a hidden thread on the model its role names. A worker runs in this thread's environment unless its `reads` lets it move to another machine (see below). It validates each worker's result, retries transient provider failures, and sends this thread one message when every worker is done. The user sees a live card in the chat. Skills keep their own phases, briefs, and aggregation. A run only replaces the launch.

Use a run when the workers are read-only, or when each writes only to its own path. A worker that needs its own checkout, the fast tier, or a particular machine stays a child thread from `bb pstack spawn --parent-self`.

## 1. Write the plan file

Put the plan in a JSON file under `$BB_THREAD_STORAGE`. Point workers at large inputs, such as a diff or a transcript, by path. Do not paste the inputs into the plan. Workers that read `origin` run on this machine and can read those files.

Every seat, judge, swarm brief, slice and verifier takes an optional `reads`, which says what the worker needs and so where it may run:

- `origin`, the default, reads this thread's worktree, uncommitted changes included, and files elsewhere on this machine. The worker always runs here.
- `commit` reads only files that are committed and pushed. When this machine is full, the worker may run on another machine with a worktree at the same commit. That happens only when this thread's worktree is clean, on a branch, and pushed to `origin/<branch>` at start. Otherwise the worker stays here.
- `prompt` reads nothing but its prompt. When this machine is full, the worker may run on any machine with a checkout of the project.

A `commit` or `prompt` prompt must not name a path under a home, temp or thread-storage directory, such as `/Users/…`, `/tmp/…` or `$BB_THREAD_STORAGE/…`. `run start` rejects such a plan and names the path. Put the content in the prompt, or use `origin`. A judge or verifier whose prompt picks up such a path from a seat's answer stays here. A worker that ran on another machine and failed is retried here.

A panel has seats that run in parallel and an optional judge that receives every seat's answer:

```json
{
  "kind": "panel",
  "title": "Review src/doctor.ts",
  "seats": [
    { "label": "Reviewer {letter}", "model": { "role": "interrogate reviewers" },
      "prompt": "Read-only. Your brief is at /…/brief.md.", "result": "review" }
  ],
  "failure": { "kind": "quorum", "minimum": 1 },
  "judge": { "model": { "role": "arena cross-judge pool" }, "prompt": "…", "result": "grouping" }
}
```

- `model` is `{ "role": "<role>" }` or `{ "tuple": "provider/model/level" }`. A seat that names a role becomes one seat per model on that role's line, and `{letter}` or `{n}` in its label numbers them. A judge that names a role picks the entry whose provider differs from this thread's.
- `result` is one of the following:
  - `text`, the default;
  - `review`, a list of findings with `severity`, `title`, `location`, `detail` and an optional `suggestion`;
  - `grouping`, for a judge that groups the seats' findings by their refs `A.1`, `B.2`, and so on, and gives each group a verdict;
  - `report`, for a swarm worker;
  - `verdict`, for a swarm verifier.
- `failure` is `quorum` with a minimum, the default being 1, or `all-required`. A judge runs only when the policy is met, and it is told which seats failed.

A swarm has one brief, many slices, and an optional verifier per slice:

```json
{
  "kind": "swarm",
  "title": "check.sh per package",
  "brief": "Read-only. Run the package's check.sh at 3f9e2c1 and report.",
  "slices": ["packages/api", { "name": "packages/cli", "brief": "Also run the e2e smoke." }],
  "verify": { "prompt": "Re-run the evidence yourself. Do not trust the report." }
}
```

Workers default to the `swarm workers` role. Each one returns `PASS`, `ISSUES` or `BLOCKED` with evidence. A slice's verifier starts as soon as that slice finishes and returns `VERIFIED`, `NOT_VERIFIED` or `INCONCLUSIVE`.

## 2. Start it

```sh
bb pstack run start --file "$BB_THREAD_STORAGE/plan.json"
```

The command prints the run id, a one-line summary with the seat and judge counts, and a `::pstack-run{run="psr_…"}` line. `bb pstack run status <id>` lists each job with its model and the machine it runs on. Copy that line into your reply once, on its own line, unedited. It renders the live card. Starting the same plan again with the same `requestKey` returns the same run.

## 3. Collect the result

When every job is done, this thread receives one agent-only message that starts `pstack panel run psr_… "<title>" finished: <status>.` (or `pstack swarm run …`), with each worker's outcome. `bb pstack run status <id>` is authoritative, and `--json` gives the full result. A failed seat or slice is a dropout. Handle it the way the skill handles one. Then run the skill's own synthesis or lead judgment over the result. A judge's answer is an input to your judgment, not a replacement for it.

Stop a run with `bb pstack run stop <id>`.
