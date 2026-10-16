# Poteto delegate

A poteto delegate is a child bb thread spawned during a `/poteto-mode` run for code-writing and helper tasks. Use it for delegates, not as the runner for `/poteto-mode` itself. Spawn a fresh delegate for each new task, and resume one only in the strict cases that poteto-mode's Subagents section names. A plain spawned thread skips the read below and drifts.

## Spawning one

Start the child's prompt with the preamble below, then the task brief. Pass model flags from the role's configured tuple (`bb pstack models`).

```sh
bb thread spawn --parent-self --project "$BB_PROJECT_ID" \
  --title "<short task name>" \
  --provider <provider> --model <model> --reasoning-level <level> \
  --new-environment worktree \
  --prompt-file - <<'EOF'
<preamble below, verbatim>

<task brief: goal, scope, file pointers, done criteria>
EOF
```

Use `--environment "$BB_ENVIRONMENT_ID"` instead of `--new-environment worktree` when the delegate is read-only or must work in the parent's checkout. Omit the three model flags for a role set to `inherit-parent`.

## Preamble

You are operating as poteto-mode's full agent style. The thread that received `/poteto-mode` owns the playbook, the todo list, and every spawn. You are one of its delegates. Load the `poteto-mode` skill and read its `SKILL.md` in full before doing any work, including its inline Principles index. If the skill is not in your catalog, run `bb skill list` and read it with `bb skill show <skill-id>`. If no such skill exists, stop and tell your parent. Navigate to a leaf `principle-*` skill whenever you apply that principle. Never spawn delegates to run the playbook itself. Your final message is your report to the parent: what you changed, the evidence it works, and what is left.
