# benny automation intent

## what i want to automate

i want two bb automations that work together in one slack issue channel.

bb automations are schedule-driven (`--cron`, `--at`, or `--in`). they have no slack event trigger. so each automation runs on a cron schedule, polls the source channel through the provider's slack mcp tools, and handles one eligible report per run. a ledger file outside the repository records which reports each automation already claimed.

### automation 1: triage issue reports

- trigger: on each scheduled run, i want this automation to poll my configured source slack channel, pick the oldest new top-level report that has no triage reply and no ledger claim, and keep that report's original thread coordinates.
- behavior: i want it to read the thread and attachments, classify the report as a bug or performance issue, feature request, question or feedback, or reroute, and trace the likely owning layer before routing.
- tracker: i want it to search my configured tracker for duplicates, update a confident duplicate, and create a ticket only for a clear net-new bug.
- tools: i want slack thread read and reply access, my configured tracker integration, and my optional routing map.
- outcome: i want exactly one reply in the source thread with a short verdict and `[benny:bug]`, `[benny:performance]`, or `[benny:other]`. a bug or performance marker may include the tracker url.
- boundary: i never want this automation to post a root message in the source channel.

### automation 2: reproduce and fix confirmed bugs

- trigger: on each scheduled run, i want this automation to poll the same source channel and pick the oldest top-level report that already carries a trusted triage marker and has no repro ledger claim. a report still waiting for its verdict gets picked up by a later run.
- gates: i want it to stop when someone clearly owns the fix. if an existing pull request or merged commit may fix the report, i want verification instead of a competing change.
- behavior: i want it to use my configured control adapter and feature map, reproduce the exact symptom twice through the real ui, and capture screenshots, video, and a read-only state cross-check.
- fix: i want it to verify existing pull requests without authoring over them. after a confirmed repro, it may attempt one bounded root-cause fix, use tdd when the test is cheap, smoke the blast radius, and open a draft pull request only when before-and-after proof passes.
- tools: i want slack thread read and reply access, repository and history access, draft pull request creation, my configured tracker, and my control adapter.
- outcome: i want evidence and a verified result in the source or optional operations threads, plus an optional draft pull request. updates should be concise.
- boundary: i never want this automation to post a root message in the source channel.

### shared rules

- i want the source channel and root thread coordinates to stay immutable for the whole run.
- i treat utility and debug bots as evidence, not delegation or fix ownership.
- i allow delegate threads to help, but they cannot post to slack or receive slack credentials.
- i want this entire pack committed at `.bb/automations/benny/` in the target repository. its `SKILL.md` files are direct automation instructions, not registered skills.
- i want pstack installed and enabled on the bb server (`bb plugin install`, `bb plugin enable pstack`) only for shared dependencies such as `how`, `why`, `tdd`, `unslop`, and the required principle skills.
- i want each live automation prompt to read its committed operational file directly. i do not want plugin cache paths, copied excerpts, or slash-skill discovery.
- i keep user-owned configuration, feature maps, routing maps, rendered prompts, the ledger, and secrets outside `.bb/automations/benny/` so pack refreshes cannot overwrite them.
- i want both automations to fail closed when channel coordinates, tracker access, the control adapter, or the feature map are missing or uncertain.
- i want draft pull requests only. do not merge or deploy.

### my configuration

- source slack channel: `<channel>`
- optional operations channel: `<channel or none>`
- repository and default branch: `<repo>`, `<branch>`
- tracker: `<type, team, project, labels, intake status>`
- routing map: `<path or none>`
- triage identity: `<slack identity>`
- control skill: `<configured skill or adapter>`
- feature map: `<committed same-repo path outside the copied pack, or behavior to paraphrase>`
- models: `<triage, reproduce, code, media review, each as provider/model/level>`
- status emoji strings: `<seen, reproducing, reproduced, blocked, fixing, failed, pull request opened>`
- schedule: `<triage cron, repro cron, timezone, lookback window>`
- ledger: `<absolute path outside the repository on the host that runs the automations>`
- budgets: `<polling, verdict wait, follow-up, repro, rejection, fix>`
- optional bot token capability: `<none, file download, or editable operations status>`

start from [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md). copy and fill them outside this pack, for example under `.bb/benny/`. keep secret values in a secret manager or environment.

## for the agent

the human enters setup by pointing a bb thread at this file. do not look for or invoke a discovered benny slash skill.

1. ask which repository will run the automations.
2. treat the directory containing this `FOR_AGENTS.md` as the source pack.
3. merge the entire source pack into `<target-repository>/.bb/automations/benny/`.
4. preserve every destination-only file. never delete unrelated files or overwrite user-owned configuration, feature maps, or routing maps.
5. when an existing destination file at a source-managed path differs, review the diff and merge without discarding local edits. if ownership is ambiguous, stop and ask before replacing it.
6. verify that the copied `FOR_AGENTS.md` and `skills/setup-benny/SKILL.md` exist in the target repository.
7. read and follow `.bb/automations/benny/skills/setup-benny/SKILL.md` directly from the target repository.

i want pstack installed and enabled on the bb server that will run the automations. check `bb plugin list`. if pstack is missing, ask me for its source and run `bb plugin install git:<repo-url>` or `bb plugin install <local-path>`. if it is installed but disabled, run `bb plugin enable pstack`. do not change any other plugin.

i want verification against the target project, not the current session. run `bb skill list --project <target-project-id>` and confirm that pstack's `how`, `why`, `tdd`, `unslop`, and the principle skills used by benny are listed with scope `plugin` and a path inside the installed pstack plugin. do not count a same-named copy from `~/.bb/skills`, the target's `.bb/skills`, or a provider's own skill directory.

if pstack cannot be enabled or any shared dependency does not resolve, stop and explain what failed. do not add `.bb/automations/benny/skills/` to `.bb/skills/` or a plugin manifest, or expect its files to appear in the slash-skill list.

tell me that `.bb/automations/benny/` and any referenced secret-free configuration must be committed on the default branch before either automation is enabled. do not create or update an automation until i explicitly ask.

for first-time creation, use `bb automation create` once for triage and once for repro and fix, each created paused with `--disabled`. show me the full command and the rendered prompt and get my approval for the first automation before starting the second.

paraphrase this intent and the finished configuration into each prompt. the triage prompt must read and follow `.bb/automations/benny/skills/triage-issue-reports/SKILL.md`. the repro prompt must read and follow `.bb/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`. use these repo-relative paths only after confirming with git that they are committed on the branch the automation checks out.

for existing automations, find them with `bb automation list --project <target-project-id>` and change them in place with `bb automation update`, after i approve each change. do not create duplicates.
