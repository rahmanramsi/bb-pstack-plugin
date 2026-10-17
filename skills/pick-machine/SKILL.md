---
name: pick-machine
description: "Choose which bb machine a new thread runs on, from each machine's live concurrency load, so spawns go to a machine with free slots instead of queueing on a full one. Spawn through its `spawn.mjs` wrapper instead of `bb thread spawn` when more than one machine is enrolled, when spawning several workers at once, or when the user says a machine is full, busy, or overloaded."
---

# Pick a machine

bb runs each thread on one machine. Every machine has a concurrency limit, and a spawn onto a full machine waits for a slot while another machine sits idle. Pick the machine from live numbers before you spawn, never from habit. The wrapper below does it on every spawn.

## Spawn through the wrapper

Use `scripts/spawn.mjs` wherever you would run `bb thread spawn`. It takes the same flags and runs `bb thread spawn` with them:

```bash
node <this skill dir>/scripts/spawn.mjs --parent-self --project "$BB_PROJECT_ID" --new-environment worktree \
  --provider codex --model gpt-6.1-sol --reasoning-level high --title "<short>" --prompt-file - <<'EOF'
…
EOF
```

- With `--new-environment worktree` and no machine named, it adds `--machine` for the eligible machine with the most free slots, and prints the choice on stderr. `--machine auto` asks for the same thing explicitly.
- A named `--machine`, an existing `--environment`, `--new-machine`, or a spawn without a fresh worktree passes through untouched, because the machine is already fixed or the thread doesn't need one.
- When no machine has a free slot, it spawns without `--machine` and bb queues the thread as usual.
- `--dry-run` prints the final `bb thread spawn` command instead of running it.

Each spawn reads live load, so a batch of spawns in a row spreads itself out as each new thread takes a slot.

## See the load first

To plan a wave, or to explain a choice, run the picker on its own:

```bash
node <this skill dir>/scripts/pick-machine.mjs --environment worktree --provider codex --model gpt-6.1-sol --count 3
```

It prints one line per machine: running threads over its limit and either the free slots or the reason the machine can't take the thread. The last line names the picks. Exit 1 means no machine can take it.

| flag | meaning |
|---|---|
| `--project <id>` | defaults to `$BB_PROJECT_ID` |
| `--environment worktree\|checkout` | the environment kind the spawn uses, default `worktree` |
| `--provider <id>` `--model <id>` | drop machines whose catalog lacks the model |
| `--count <n>` | spread n spawns, one pick per spawn, onto the machines with the most room left |
| `--exclude <id-or-name>` | skip a machine, repeatable |
| `--json` | the same result as JSON |

Pass a pick to a spawn as `--machine <id>` with `--new-environment worktree`. A machine selector can't be combined with an existing `--environment <id>`, because that environment already fixes its machine.

## What counts

- **Busy:** threads whose status is `active` or `pending`, hidden ones included. `idle` and `error` threads hold no slot.
- **Limit:** each machine's effective limit from `bb concurrency-limit status`. A global limit, when set, caps the total picks.
- **Eligible:** connected, active (not suspended), the project has a checkout there that offers the environment kind, and, when given, the provider lists the model on that machine.

## Keep it on this machine when

In these cases, pass this machine's ID as `--machine` (`bb status --json | jq -r .thread.environment.hostId`) so the wrapper leaves the spawn here.

- The task drives `browser-automation`, a bb terminal, a simulator, or local app state.
- It needs auth or files that exist only here. A remote thread can't read this machine's thread storage, so inline what it needs or point at repo paths.
- It forks a thread. Forks stay on the source machine.

## When nothing fits

- **Every machine is full.** Wait for a running child to finish, or spawn fewer. Don't raise a concurrency limit without asking the user.
- **The project has no checkout on a free machine.** Say which machines are free but lack the project. Adding a checkout (`bb project source add <project> --clone --machine <id>`) changes the user's setup, so ask first.
- **The model is missing on a free machine.** Pick another tuple from `bb pstack models` or ask. Check the provider CLI with `bb machine provider-cli status <machine>`. Picking a machine doesn't prove its provider is signed in, so watch the first turn of a remote spawn.

**Reply:** the machine each spawn went to and the load you saw, in one line per spawn.
