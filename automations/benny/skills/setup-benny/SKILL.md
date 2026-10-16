---
name: setup-benny
description: Configure Benny and prepare its triage and repro automations. Use when installing Benny or changing its Slack, tracker, repository, routing, control, model, or budget settings.
disable-model-invocation: true
---

# Set up Benny

Benny ships as a dormant automation pack inside pstack. The plugin manifest exposes only pstack's normal skill root; this file and the two operational files are not slash skills.

The human enters setup by pointing a bb thread at the pack's `FOR_AGENTS.md`. The bootstrap flow copies the whole pack into the target repository, then reads this file directly at `.bb/automations/benny/skills/setup-benny/SKILL.md`.

Benny needs external configuration and two live bb automations.

bb automations start on a schedule only: a five-field cron expression with a timezone, a one-shot time, or a delay (`bb guide automations`). There is no Slack event trigger. Each Benny automation is therefore an agent automation on a cron schedule that polls the source channel through the provider's Slack MCP tools, selects one eligible report, and records its claim in a ledger file. Each run is its own bb thread, listed by `bb automation runs`.

Do not create or update an automation until the user explicitly asks. Never put a secret value in plugin files, prompts, or committed configuration.

## 1. Copy the pack and enable shared pstack skills

Do this before asking for Benny configuration and before running any `bb automation` write command.

Ask which repository will run the automations, and find its bb project ID with `bb project list --json`. The source pack is the directory containing `FOR_AGENTS.md`. The destination is `<target-repository>/.bb/automations/benny/`.

Merge the entire source pack into the destination:

1. Create the destination when it is absent.
2. Copy every source file to the same relative path.
3. Preserve destination-only files. Never delete unrelated files during install or refresh.
4. Keep user-owned configuration, feature maps, routing maps, rendered prompts, and the ledger outside the destination. Never overwrite them.
5. When an existing source-managed file differs, inspect the diff and merge without discarding local edits. If ownership is ambiguous, stop and ask before replacing it.
6. Verify that the destination contains `FOR_AGENTS.md`, this setup file, both operational files, their references, and the templates.

If this file is already being read from the target destination, treat the copy as complete and run the same verification before continuing.

Make sure pstack is installed and enabled on the bb server that will run the automations. Plugins belong to the bb server, not to the repository, so there is no file to commit for this step.

1. Run `bb plugin list`.
2. If pstack is absent, ask the user for its source and run `bb plugin install git:<repo-url>` or `bb plugin install <local-path>`.
3. If pstack is installed but disabled, run `bb plugin enable pstack`.
4. Change no other plugin.

Run `bb skill list --project <target-project-id> --json` and verify that these shared pstack skills resolve with scope `plugin` from the installed pstack plugin:

- `how`
- `why`
- `tdd`
- `unslop`
- `principle-separate-before-serializing-shared-state`
- `principle-minimize-reader-load`
- `principle-guard-the-context-window`
- `principle-sequence-verifiable-units`
- `principle-fix-root-causes`
- `principle-prove-it-works`

Do not count a skill loaded into the current session, a same-named copy in `~/.bb/skills` or the target's `.bb/skills`, or a provider's own skill directory. The check must show that a fresh thread in the target project receives pstack from the plugin.

If pstack cannot be installed or enabled, or any shared dependency does not resolve, stop and explain the failure.

The Benny files are read directly from `.bb/automations/benny/`. Do not copy that directory into `.bb/skills/`, add it to a plugin manifest, or expect its `SKILL.md` files to appear in the slash-skill list.

Tell the user that `.bb/automations/benny/` and any referenced secret-free configuration must be committed on the default branch before either automation is enabled. Do not commit them unless the user asks.

Once this check passes, live automation prompts may read the committed operational files by their stable repository-relative paths. They must not embed a plugin cache path or copy the file contents.

## 2. Adapt the configuration

Open these copied examples:

- `../../templates/configuration.example.yaml`
- `../reproduce-and-fix-issues/references/feature-map.example.md`

Create user-owned copies outside `.bb/automations/benny/`. These are configuration files, not pack files. Example locations:

- Project config, such as `.bb/benny/configuration.yaml`
- Project feature map, such as `.bb/benny/feature-map.md`
- Project routing map, such as `.bb/benny/routing.md`
- User config, such as `~/.config/benny/configuration.yaml`
- User feature map, such as `~/.config/benny/feature-map.md`

Fill one feature-map section for every user-facing feature the automation may reproduce. Keep it at the user point of view. Do not freeze implementation details or current code paths in the map.

Do not edit the copied examples. Pack refreshes may update source-managed files after conflict review, but they must never touch the user-owned copies.

Prefer committed, secret-free files in the target repository when a fresh automation checkout must read them. Otherwise paraphrase the required values into the live prompt. Reference a repository file only after `git ls-tree` on the default branch confirms that the file is committed there.

The ledger is runtime state, not configuration. Put `state.ledger_path` at an absolute path outside the repository on the machine that runs the automations, because each repro run starts in a fresh worktree. Never commit it.

Use stable repository-relative paths for committed pack and configuration files. Never reference the plugin source directory or a plugin cache path from a live automation.

## 3. Fill the required choices

Ask for or confirm:

- Source Slack channel ID
- Optional operations or status channel ID
- Repository URL and default branch
- Triage identity or Slack user ID
- Issue tracker type, team, project, labels, and intake status
- Tracker adapter skill or MCP actions
- Optional routing map path
- Required control skill name
- Required user-facing feature-map path
- Status emoji strings
- Pull request URL format
- Cron schedule and timezone for each automation, and the lookback window
- Ledger path
- Polling and effort budgets
- Model for triage, repro, code work, and media review, each as a `provider/model/level` tuple

Use only models that `bb provider models <provider-id> --environment <environment-id> --json` lists, with a reasoning level from that model's `supportedReasoningEfforts`. Do not guess a model and do not carry over a private default.

Pick schedules the work can sustain. Triage runs are short, so a few minutes apart is reasonable. Each repro run creates a fresh worktree even when no report qualifies, so space those further apart. Runs may overlap; the ledger claim keeps them off the same report.

The source channel, triage identity, repository, tracker adapter, control skill, and feature map must be explicit. Fail setup if any required value stays ambiguous.

Use pstack's `unslop` skill on the final automation names, descriptions, and prompt shims before saving them.

## 4. Check integration capabilities

The triage automation needs:

- Read access to the configured source Slack channel and its threads
- Thread-reply access in that channel
- Attachment metadata and file download access when reports include media
- Search, read, create, and update access through the configured issue-tracker adapter

The repro automation needs:

- Read access to the source thread
- Thread-reply access in the source channel
- Optional post and edit access in the configured operations channel
- Repository read and history access
- A pull request action that can open a draft pull request
- The configured control-adapter skill

bb has no per-thread tool restriction. A child thread spawned with `bb thread spawn` on the same provider normally sees the same Slack MCP tools as its parent. Unless the user shows that a worker's provider or machine has no Slack write tools, record that worker isolation is unproven, so the operational files keep every edit and every Slack post in the coordinator.

Prefer the configured Slack MCP tools of the provider that runs the automations for reads and posts. Automation runs are unattended, so the tools must already be authenticated on the machine that runs them, and the identity they post as must be the configured triage identity. The optional `BENNY_SLACK_BOT_TOKEN` may fill a narrow gap such as editing one operations status message or downloading an attachment. Store the value in a secret manager or environment, not in YAML.

Do not use undocumented integration endpoints.

## 5. Prepare the routing map

If the user wants reroutes or owner pings:

1. Copy `../triage-issue-reports/references/routing.example.md` outside `.bb/automations/benny/`.
2. Replace every placeholder with public or organization-local values.
3. Keep owner pings off by default.
4. Allow a ping only for a configured feature owner or a confirmed likely regression author.

If no routing map is configured, triage may classify a report but must not guess a destination or owner.

## 6. Verify the control adapter

Read `../reproduce-and-fix-issues/references/control-adapter.md` and the user's completed feature map.

Confirm that the named skill can:

- Bring up the target app
- Navigate every mapped feature through the real UI
- Exercise mapped states through declared adapter actions
- Inspect state without forcing the result
- Capture screenshots
- Start and stop a recording
- Clean up its processes and temporary data

If any capability is missing, leave the repro automation disabled. It must fail closed rather than claim a reproduction it did not perform.

## 7. Prepare the live automations

Ask whether this is first-time creation or configuration of existing automations.

Read `../../FOR_AGENTS.md` from the copied pack as the primary user-intent source for either path. Use it to understand the two polling schedules, tools, instructions, outcomes, and shared rules.

### First-time creation

Create one automation at a time.

For each automation:

1. Read the matching copied prompt template as secondary internal source material.
2. Turn `FOR_AGENTS.md`, the finished Benny configuration, and the template intent into a complete natural-language prompt.
3. Tell the live prompt to read and follow its exact committed operational file under `.bb/automations/benny/`.
4. Use the stable repository-relative path, not a plugin source or cache path. Do not copy the operational file contents into the live prompt.
5. Confirm with git that the copied pack and any referenced configuration files are committed on the default branch the automation checks out.
6. Save the rendered prompt at the configured prompt path outside the pack.
7. Show the user the rendered prompt and the exact `bb automation create` command, and get explicit approval.
8. Create the automation paused with `--disabled`, then show its `bb automation show` output.
9. Finish this automation before starting the next one.

The triage automation, filled from configuration:

- Name `benny-triage`.
- The prompt reads and follows `.bb/automations/benny/skills/triage-issue-reports/SKILL.md` for every run.
- Each run polls the configured source Slack channel and handles the oldest new top-level report.
- Read the selected thread and reply only inside it.
- Use the configured issue-tracker integration.
- Classify, inspect evidence, trace cause, dedupe, and create only clear new bugs.
- End one thread-only verdict with the configured `[benny:bug]`, `[benny:performance]`, or `[benny:other]` marker and optional tracker URL.
- Never post a source-channel root message.

```bash
bb automation create --project <target-project-id> --name benny-triage --disabled \
  --cron "<schedule.triage_cron>" --timezone "<schedule.timezone>" \
  --prompt "$(cat <automations.triage_prompt_path>)" \
  --provider <provider> --model <model> --reasoning <level> \
  --environment <project-checkout-environment-id-or-path>
```

Triage edits no code, so it may run in the project's existing checkout. Keep that checkout on the default branch.

After the triage automation exists, the repro and fix automation:

- Name `benny-reproduce`.
- The prompt reads and follows `.bb/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for every run.
- Each run polls the same source Slack channel and handles the oldest report that carries a trusted triage marker.
- Use the configured repository and default branch.
- Read the source thread and reply only inside it.
- Include pull request creation and the configured tracker, control-adapter, and feature-map requirements. Paraphrase mapped user paths and states unless the feature map is committed on the default branch.
- Reproduce the exact symptom twice through the mapped real UI and capture evidence.
- Verify an existing fix without authoring over it.
- Attempt an optional bounded fix only after confirmed repro, then open a draft pull request when proof and checks pass.
- Never post a source-channel root message.

```bash
bb automation create --project <target-project-id> --name benny-reproduce --disabled \
  --cron "<schedule.reproduce_cron>" --timezone "<schedule.timezone>" \
  --prompt "$(cat <automations.reproduce_prompt_path>)" \
  --provider <provider> --model <model> --reasoning <level> \
  --new-environment worktree --base-branch <default-branch>
```

The repro run edits code and opens a pull request, so each run gets its own bb-managed worktree off the default branch.

Add `--service-tier fast` only when `bb provider models` lists that tier for the chosen model. Leave `--permission-mode` at the provider default unless the user asks otherwise.

### Existing automations

Find them with `bb automation list --project <target-project-id>` and read each with `bb automation show <automation-id> --project <target-project-id>`.

Finish configuration, routing, control-adapter, and feature-map validation. Then show the user the exact `bb automation update` command for each change and run it only after approval.

For the existing triage automation, check:

- Name
- Direct instruction to read `.bb/automations/benny/skills/triage-issue-reports/SKILL.md`
- Cron schedule, timezone, and environment
- Source channel, ledger path, and lookback window in the prompt
- Slack thread read and reply capabilities
- Issue-tracker integration
- Paraphrased triage instructions, thread-only rule, and Benny verdict markers

For the existing repro automation, check:

- Name
- Direct instruction to read `.bb/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`
- Cron schedule, timezone, worktree environment, and base branch
- Source channel, ledger path, and lookback window in the prompt
- Repository and default branch
- Slack thread read and reply capabilities
- Pull request action
- Tracker, control-adapter, and feature-map requirements
- Paraphrased marker check, evidence, verification, and bounded-fix instructions

A prompt change is `bb automation update <automation-id> --project <target-project-id> --prompt "$(cat <prompt-path>)"`. Do not create replacements or duplicates.

### Creation boundary

Create and change automations only through `bb automation create` and `bb automation update` after the user approves the exact command. Never call a plugin RPC or write automation storage directly.

Do not enable either automation until the thread-safety test passes.

## 8. Test thread safety

Use a test channel or a harmless test report.

Before testing, confirm that pstack is enabled, that `.bb/automations/benny/` and every referenced secret-free configuration file are committed on the branch used by the automation checkout, and that both live prompts point at their exact committed operational files. If any check fails, stop. Tell the user that the automation cannot be enabled yet.

While both automations are still paused, trigger runs by hand with `bb automation run <automation-id> --project <target-project-id>`: triage first, then repro. Read each run's thread from `bb automation runs <automation-id> --project <target-project-id>`.

Verify:

1. Triage stores the root `thread_ts` and posts exactly one verdict as a reply.
2. The verdict contains one configured marker.
3. Repro accepts the marker only from the configured triage identity.
4. Repro keeps the same immutable source coordinates.
5. No source-channel root message appears.
6. A delegated worker cannot use any Slack write action.
7. Missing coordinates, a deleted parent, or a failed preflight produces no post and no tracker issue.
8. A second manual run of each automation skips the test report because of its ledger row.

Enable normal traffic with `bb automation resume <automation-id> --project <target-project-id>` only after all eight checks pass.
