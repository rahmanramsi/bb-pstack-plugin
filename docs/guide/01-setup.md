# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

In a terminal, run:

```text
bb plugin install git:<pstack-repo-url>
```

Or point it at a local checkout with `bb plugin install <local-path>`. bb asks you to confirm, then installs the plugin. `bb plugin list` shows it once it's running, and its skills appear as `/` commands in the bb composer.

## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, asks for a reasoning budget, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes the pstack plugin's `models` setting, a short list of role lines every pstack skill reads. `bb pstack models` prints the table in effect.

The defaults run at `xhigh` reasoning, the same as the `large` budget. `unlimited` lifts each model to its highest tier, up to `max`. Opus goes to `max`. A model whose highest tier is `xhigh` stays there. `medium` and `small` lower the reasoning and spend fewer tokens.

You only override what you care about. A role with no line in the setting keeps the skill's default. To restore a default, delete that role's line. A rerun of `/setup-pstack` keeps any role whose model differs from the default. When a default changes, a setting written before the change still pins the old default, so delete those role lines, or clear the setting with `bb plugin config pstack unset models`, then run `/setup-pstack` again.

Run `bb pstack doctor` after setup. It checks every role against the models this machine really has and prints one `ok` or `FAIL` line per role. The review panels (`/interrogate`, `/arena`, `/how`, `/why`, `/reflect`) and `/swarm` then run on those models, each as one pstack run with a live card in the thread.

Each role value is a `provider/model/level` tuple, such as `claude-code/claude-opus-5-5/xhigh` or `codex/gpt-6.1-sol/xhigh`. You might be wondering what happens if you want a delegate to run on whatever your thread runs on. Set a role to `inherit-parent` and pstack omits the provider, model, and reasoning flags when it spawns the child thread, so the child inherits your parent thread's model. It's not a model tuple. For a panel role the value is a list, and one child thread runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.bb/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

After setup, start a new thread. The model setting applies to new sessions.

## Keep the cost in check

pstack spends extra tokens on delegate threads and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main thread with cheaper, faster models in the code roles is a good split.
- Set a role to `inherit-parent` so it runs on the thread's own model.
- Shorten a panel list. Each entry runs one child thread.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. Picking `/poteto-mode` from the `/` menu attaches the skill to one message, and it fades as the thread moves on. To keep it on for every thread in a repository, add a line to the workspace's `.bb/AGENTS.md`, such as "use the poteto-mode skill for every non-trivial task". bb appends that file to every thread's instructions there. `~/.bb/AGENTS.md` does the same for all projects.

When `/poteto-mode` hands work to delegates, each one is a child thread you can open from the sidebar under its parent.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
