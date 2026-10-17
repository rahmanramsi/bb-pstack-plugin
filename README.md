# pstack for bb

pstack by [poteto](https://x.com/poteto) (Lauren Tan), packaged as a [bb](https://getbb.app) plugin. the skills, playbooks, and principles are the upstream [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack), adapted so they drive bb threads, bb providers, and the bb CLI.

i'm [poteto](https://x.com/poteto). i'm not a president or ceo, but i've worked with millions of lines of code at Meta, Netflix, and Cursor. i'm also on the react core team where i help build and maintain react compiler.

there's a growing sense that ai writes too much slop code. i agree. i don't want to ship like a team of twenty slop artists. throughput without quality is not a goal i aspire to. if you want to go fast, go deep first. 

**pstack is my answer.** these are the same skills i use everyday to ship high quality code at Cursor. this turns your agents into a real engineering team. the goal is not to maximize loc, in fact it's the opposite. pstack helps you write less, but higher quality code.

**pstack gives you fearless parallelism.** when you can go deep on one agent and trust it to write good, verifiable code, you can truly parallelize with confidence. start multiple agents up with `poteto-mode` and trust that they'll apply rigorous engineering principles to their work.

**bb gives you the best of all worlds.** every frontier model has its strengths and weaknesses. bb runs claude code, codex, and other providers side by side, and pstack can hand each job to the model that's best at it. in fact, many of my skills use multi-model workflows to take advantage of each model's unique strengths.

fork it. improve it. make it yours. PRs are welcome! 

## install

```bash
bb plugin install git:https://github.com/rahmanramsi/bb-pstack-plugin.git
```

or, from a local checkout:

```bash
bb plugin install /path/to/bb-pstack-plugin
```

the skills show up in every thread's `/` menu. the plugin also adds a small cli:

| command | what it does |
|---|---|
| `bb pstack models [--role <role>] [--json]` | the model each role uses, configured values merged over the defaults. |
| `bb pstack spawn --new-environment worktree --prompt-stdin` | creates a delegate on the eligible machine with the most free slots. `--parent-self` sets its parent. `--machine here` pins local work. `--dry-run` prints the decision and spawn arguments. |
| `bb pstack machines [--provider <id> --model <id>] [--ask-clone] [--json]` | shows running threads, held slots, concurrency limits, and placement blockers. automatic placement onto another machine requires a known limit. `--ask-clone` asks you in the thread whether to clone the project onto machines that have no checkout. |
| `bb pstack doctor` | checks every role against the live provider catalog. run it after setup. |
| `bb pstack run start --file <plan.json>` | runs a review panel or a swarm on hidden worker threads, with a live card in the chat. skills write the plan for you. |
| `bb pstack run status <id>` / `run stop <id>` | a run's progress and results, or stop it. |
| `bb pstack checklist begin <playbook>` | copies a playbook's steps into the thread's checklist. `checklist done <id> --evidence …`, `checklist skip <id> --reason …` and `checklist add` close and extend it. |
| `bb pstack gate pr` / `gate done` | exit 1 while checklist steps are open. `/poteto-mode` runs them before it opens a PR and before its final reply. |

an agent can still call plain `bb thread spawn --parent-self --new-environment worktree`. when its machine is full and another machine has room for the same project and model, pstack refuses that spawn and names `bb pstack spawn` as the fix. it never refuses a fork, a person's thread, a reused environment, or a thread pstack spawned. it also lets the spawn through whenever it lacks the facts to decide. turn the `placementGuard` setting off to disable it (`bb plugin config pstack set placementGuard false`).

## get started

two steps:

1. run [`/setup-pstack`](./skills/setup-pstack/SKILL.md), pick a reasoning budget, and choose which models you want from the providers bb has.
2. use [`/poteto-mode`](./skills/poteto-mode/SKILL.md) whenever you're doing anything that requires rigor.

new here? the [pstack guide](./docs/guide/README.md) walks you through a first real task, from setup and prompting through verification and overnight runs. stuck, or unsure which skill fits? ask [`/poteto-help`](./skills/poteto-help/SKILL.md).

that's it. the other skills are situational; the mode skill uses them for you as needed. out of the box the mode splits work by model strength: code delegates (feature, refactoring, bug fix, perf, hillclimb) go to GPT-6.1 Sol on codex, while the hardest changes, prose, and judgment go to Claude Opus 5.5 on claude code. the default panel is Claude Opus 5.5 / GPT-6.1 Sol. [`/setup-pstack`](./skills/setup-pstack/SKILL.md) changes any of it.

## usage

use [`/poteto-mode`](./skills/poteto-mode/SKILL.md) at the start of a task. it reads your request, picks from a set of playbooks, and runs the other skills as the steps need them.

pick `/poteto-mode` from the `/` menu before you type your task, so bb attaches the skill to the message.

### just use [`/poteto-mode`](./skills/poteto-mode/SKILL.md)

this skill is the main shortcut. i use it whenever i need the agent to do rigorous engineering work. it comes with twenty-three playbooks:

```
/poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even when idle. repro
first, then fix and verify.
```

```
/poteto-mode i'm going to bed. land the stack even if ci flakes. i want everything merged by
morning.
```

<details>
<summary>the twenty-three playbooks</summary>

| playbook | for |
|---|---|
| [investigation](./skills/poteto-mode/playbooks/investigation.md) | a read-only question. how does x work, why was y built this way, are we sure. |
| [bug fix](./skills/poteto-mode/playbooks/bug-fix.md) | reproduce a defect, root-cause it, and fix with runtime evidence. |
| [perf](./skills/poteto-mode/playbooks/perf-issue.md) | trace a measured slowness and improve it against a baseline. |
| [hillclimb](./skills/poteto-mode/playbooks/hillclimb.md) | sustained, scientific improvement of one metric against a target, looping hypotheses with before/after measurement and one commit per accepted win. |
| [runtime forensics](./skills/poteto-mode/playbooks/runtime-forensics.md) | diagnose a live symptom (leak, idle-cpu spin, glitch) from instrumentation. |
| [trace forensics](./skills/poteto-mode/playbooks/trace-forensics.md) | diagnose a captured profiling artifact (cpuprofile, trace, spindump, heap snapshot). |
| [feature](./skills/poteto-mode/playbooks/feature.md) | new or changed behavior, built from a named data shape. |
| [refactoring](./skills/poteto-mode/playbooks/refactoring.md) | a behavior-preserving change to structure or shape. |
| [prototype](./skills/poteto-mode/playbooks/prototype.md) | a throwaway sketch to make a design or behavioral decision cheaply, or to settle an empirical fork by observing it. |
| [visual parity](./skills/poteto-mode/playbooks/visual-parity.md) | pixel-exact ui equivalence between two implementations. |
| [authoring a skill](./skills/poteto-mode/playbooks/authoring-a-skill.md) | writing or editing a SKILL.md. |
| [eval](./skills/poteto-mode/playbooks/eval.md) | test how a skill or prompt change affects agent behavior, blinded. |
| [babysit](./skills/poteto-mode/playbooks/babysit.md) | drive a pr or a stack to merge-ready: conflicts, review threads, ci. |
| [shipping](./skills/poteto-mode/playbooks/shipping.md) | independently verify a green stack, then land the contiguous verified run bottom-up through github by default or origin when available. |
| [autonomous run](./skills/poteto-mode/playbooks/autonomous-run.md) | drive a long task to completion without stopping. |
| [orchestrate](./skills/poteto-mode/playbooks/orchestrate.md) | a standing project handed to one coordinator chat: multi-day, many stacked prs, fleets of subagents. |
| [autopilot-full](./skills/poteto-mode/playbooks/autopilot-full.md) | run independent prs to merged with one owner per pr and a root swarm verdict on each round, from the code-ready head on. |
| [autopilot-stack](./skills/poteto-mode/playbooks/autopilot-stack.md) | build and verify one linear base-branch stack for the operator to review and land. |
| [session pickup](./skills/poteto-mode/playbooks/session-pickup.md) | resume or take over a prior agent's in-flight work. |
| [pause safely](./skills/poteto-mode/playbooks/pause-safely.md) | suspend in-flight work cleanly so it can be resumed later. |
| [multi-phase plan](./skills/poteto-mode/playbooks/multi-phase-plan.md) | work that spans phases or stacked PRs. |
| [worktree cleanup](./skills/poteto-mode/playbooks/worktree-cleanup.md) | reclaim disk by pruning merged or abandoned worktrees and stale ios simulators, safety-gated. |
| [opening a pr](./skills/poteto-mode/playbooks/opening-a-pr.md) | open a ready pr from small ordered commits with a conventional commits title and a briefing-style body. invoked at the end of every other playbook. |

</details>



when invoked it:

1. matches your task to a [playbook](./skills/poteto-mode/playbooks/) and opens a todo list whose first items are its steps, copied in verbatim.
2. routes to the other skills as the steps fire.
3. writes unslopped replies framed for the consumer and the maintainer.

the full rules and playbooks live in [`skills/poteto-mode/SKILL.md`](./skills/poteto-mode/SKILL.md).

to keep [`/poteto-mode`](./skills/poteto-mode/SKILL.md) on across turns, add a line such as "use the poteto-mode skill for every non-trivial task" to `.bb/AGENTS.md` in the repo (or `~/.bb/AGENTS.md` for every project). bb appends that file to every thread's instructions. say so to opt out for one task, or remove the line.

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) works extremely well with long-running loops: claude code's `/loop`, or a bb automation (`bb guide automations`). you can make your agents work for many hours without sacrificing rigor.

## skills

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) runs most of these for you when a step needs them (`how`, `why`, `architect`, `arena`, `swarm`, `interrogate`, `unslop`, `no-comments`, `technical-writing`, `tdd`, and the principles). the table below is for when you want one directly:

```
/how do we cancel runs? do we have an n+1 when we look up every run to cancel?
```

```
/interrogate review this pr.
```

<details>
<summary>all skills</summary>

| skill | use it when |
|---|---|
| [`/poteto-mode`](./skills/poteto-mode/SKILL.md) | default entry point for any non-trivial task. |
| [`/poteto-help`](./skills/poteto-help/SKILL.md) | you're new to pstack, or unsure which skill, playbook, or principle fits. finds out what you're trying to do, answers that part, and hands you a prompt to type. runs only when you type `/poteto-help`. |
| [`/in-your-own-words`](./skills/in-your-own-words/SKILL.md) | you want the agent to play back your goal and the problem before it starts. runs only when you type `/in-your-own-words`. |
| [`/sharpen`](./skills/sharpen/SKILL.md) | you want a task approached the way a top expert would, aimed at what you're really after, without overspecifying it or deciding your choices for you. |
| [`/how`](./skills/how/SKILL.md) | you want a walkthrough of how a subsystem works. |
| [`/why`](./skills/why/SKILL.md) | you want to know why something was built this way. discovers available MCPs at run time and queries each evidence category in parallel (source control, issue tracker, long-form docs, real-time chat, infra observability, error tracking, analytics warehouse). |
| [`/recall`](./skills/recall/SKILL.md) | you're starting or resuming work and want your recent context on a topic rebuilt from your own chat history and the shared record, handed back as a tight current-state brief. |
| [`/ketchup`](./skills/ketchup/SKILL.md) | you want what changed in this chat since your last message, in a few plain sentences and small visuals, with just enough context on each action item to make the call. |
| [`/blast-radius`](./skills/blast-radius/SKILL.md) | you have a small-looking change and want to know what else it could break, with the one fact it's safe because of proven by running code, not asserted. |
| [`/architect`](./skills/architect/SKILL.md) | you're about to write code that crosses a function boundary and want the caller's usage, types, and module shape settled first. |
| [`/arena`](./skills/arena/SKILL.md) | you want N parallel attempts at the same thing, then to grab the best parts of each. |
| [`/swarm`](./skills/swarm/SKILL.md) | you want N parallel workers across different slices or races, then one aggregated report. |
| [`/interrogate`](./skills/interrogate/SKILL.md) | you have a diff and want different models to try to break it, including a strict code-quality lens. |
| [`/automate-me`](./skills/automate-me/SKILL.md) | you want your own `-mode` skill, drafted from how you've actually worked. |
| [`/setup-pstack`](./skills/setup-pstack/SKILL.md) | you want to pick which models pstack uses per role. detects your models and writes a config rule. |
| [`/reflect`](./skills/reflect/SKILL.md) | a long task landed and you want the recipe captured as a skill edit. |
| [`/correct`](./skills/correct/SKILL.md) | you keep correcting agents for the same mistakes. mines history for mistake classes, fixes each at the highest level that works (architecture, then types, lint, and ci, then tests, with docs last), and keeps a table pairing each rule with what enforces it. |
| [`/teach`](./skills/teach/SKILL.md) | you want to actually understand a change or subsystem, not just have it summarized. runs how + why and weaves one plain explanation, built up diagram by diagram. |
| [`/tdd`](./skills/tdd/SKILL.md) | you're fixing a bug and there's a cheap local test path. write the failing test first, then the fix. |
| [`/benchmark-checklist`](./skills/benchmark-checklist/SKILL.md) | you ran a benchmark or measured a speedup or regression. vets the number (limiter, tuning, errors, repeat runs, end-to-end relevance) before you report or act on it. |
| [`/no-comments`](./skills/no-comments/SKILL.md) | strip comments before review; spawns Comment Sicko, fixes accepted findings, offers encodings for claimed constraints. |
| [`/typescript-best-practices`](./skills/typescript-best-practices/SKILL.md) | you're reading or editing typescript. grounds the type-system-discipline principle in syntax. |
| [`/figure-it-out`](./skills/figure-it-out/SKILL.md) | no bundled playbook fits. designs a rigorous, auditable playbook for the task. |
| [`/show-me-your-work`](./skills/show-me-your-work/SKILL.md) | you want a reviewable decision trail. logs decisions to a tsv you can commit. |
| [`/create-verification-skill`](./skills/create-verification-skill/SKILL.md) | your project has no scripted way to prove app behavior. generates a project-local verify skill with a feature map, for any language or platform. |
| [`/maintain-verification-skill`](./skills/maintain-verification-skill/SKILL.md) | your verify skill's feature map has drifted from the app. source wave + one live pass, at most one PR of proven corrections. |
| [`/unslop`](./skills/unslop/SKILL.md) | you're cleaning up writing. removes AI tells. |
| [`/bro`](./skills/bro/SKILL.md) | you want the last message restated in plain human language, no jargon. |
| [`/technical-writing`](./skills/technical-writing/SKILL.md) | layered doc standard (Diátaxis + Google developer style + STE + Global English) for docs, RFCs, readmes, PR descriptions, commit messages. |

</details>



### examples

mostly i type [`/poteto-mode`](./skills/poteto-mode/SKILL.md) at the start of a task and let it route to a playbook. the other skills fire as the steps need them. a few i reach for directly.


<details>
<summary>all the examples</summary>

```
bug fix:           /poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even
                   when idle. repro first, then fix and verify.
perf:              /poteto-mode a big list takes a second or two to load even though we virtualize.
                   run a cpu trace and tell me why.
feature:           /poteto-mode build a small feature behind a feature flag. verify it really works.
prototype:         /poteto-mode build two prototypes of the markdown renderer so we can compare.
                   spawn an agent for each.
multi-phase:       /poteto-mode open source these skills as a plugin. nothing internal leaks, work
                   in a temp dir, show me the dependency graph first.
overnight run:     /poteto-mode i'm going to bed. land the stack even if ci flakes. i want
                   everything merged by morning.
babysit:           /poteto-mode check on pr 123. anything outstanding?
visual parity:     /poteto-mode the row spacing is too tall when this flag is on. the second image
                   is correct. repro and fix until it matches.
figure it out:     /poteto-mode i'm stepping away. migrate every caller from the synchronous store
                   to the new async one, keeping behavior identical. i want to trust it was done
                   right when i'm back.
how:               /how do we cancel runs? do we have an n+1 when we look up every run to cancel?
why:               /why is this feature flag not on yet?
architect:         design this instrumentation to be high signal with no false positives. /architect
                   this first.
arena:             /arena take my prompt to the arena verbatim. i want to compare their proposals
                   with yours.
swarm:             /swarm check every package under packages/ against its check.sh. one worker per
                   package. one report.
interrogate:       /interrogate review this pr.
tdd:               /tdd implement
unslop:            can we unslop and tighten the new changes?
reflect:           /reflect that took too long. capture what we learned so the next run doesn't
                   repeat it.
correct:           /correct
show-me-your-work: /show-me-your-work keep a decision trail i can review when i'm back.
automate-me:       /automate-me
help:              /poteto-help which skill should i use to review this branch?
```

</details>

## delegates and Comment Sicko

[`/poteto-mode`](./skills/poteto-mode/SKILL.md) runs in the thread that receives it. that thread owns the playbook, the todo list, and every delegate.

delegates are child bb threads (`bb pstack spawn --parent-self`), each on the provider, model, and reasoning level its role names. they show up under the parent in the sidebar, and the parent hears back when each one finishes. code-writing delegates get their own managed worktree.

a delegate spawned during a run is a **poteto delegate**: its prompt starts with the [poteto delegate preamble](./skills/poteto-mode/references/poteto-agent.md), which makes it load `poteto-mode` in full, including its inline principles index, before doing any work. a plain thread skips that read and drifts. do not spawn a poteto delegate to run the playbook itself.

panels and fan-outs (`arena`, `swarm`, `interrogate`, `architect`, `how`, `why`, `reflect`) run as one pstack run: a panel puts several models in front of the same task and can hand every answer to a judge or synthesizer, and a swarm runs one brief across many slices with a structured report and an optional verifier per slice. workers are hidden threads you reach from the run's card. a worker runs on this machine unless its plan says it reads only committed code or only its prompt; then it can move to another machine when this one is full, and `bb pstack run status` shows where each one ran. writers that need their own checkout stay child threads. see [`pstack-runs.md`](./skills/poteto-mode/references/pstack-runs.md).

## the checklist

`/poteto-mode` doesn't ask the agent to copy a playbook into its own todo list. the plugin copies the steps, verbatim, and the agent closes each one with evidence (a thread, a run, a commit, a path, a pr) or a one-line reason for skipping it. the open steps show in the thread and at the end of every `bb pstack` command. `bb pstack gate pr` fails while steps are open, so a skipped `how` or `architect` can't slide into a pr unnoticed.

pstack also ships [Comment Sicko](./skills/no-comments/references/comment-sicko.md), a comment reviewer that only deletes comments. usually invoke it through [`/no-comments`](./skills/no-comments/SKILL.md), not directly.

## principles

twenty-four short skills, one principle each. `poteto-mode` indexes them inline and reads that index at task start. the standalone files are there so other skills can reference a principle by name, and so the index can point at the full rule for each.

<details>
<summary>all twenty-four principles</summary>

| principle | group | rule |
|---|---|---|
| [laziness-protocol](./skills/principle-laziness-protocol/SKILL.md) | core | Bias toward deletion and the smallest change that solves the problem. |
| [foundational-thinking](./skills/principle-foundational-thinking/SKILL.md) | core | Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes obvious. |
| [redesign-from-first-principles](./skills/principle-redesign-from-first-principles/SKILL.md) | core | Redesign as if the requirement had been a foundational assumption from day one, instead of bolting it on. |
| [attack-the-premise](./skills/principle-attack-the-premise/SKILL.md) | core | Apply when two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before you write another fix that assumes it. |
| [subtract-before-you-add](./skills/principle-subtract-before-you-add/SKILL.md) | core | Remove dead weight, redundant validators, and stub references first, then build on the simpler base. |
| [minimize-reader-load](./skills/principle-minimize-reader-load/SKILL.md) | core | Count layers between question and answer, and hidden state in the reader's head; collapse one-caller wrappers and shrink mutable scope. |
| [outcome-oriented-execution](./skills/principle-outcome-oriented-execution/SKILL.md) | core | Apply during planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture; don't preserve smooth intermediate states with throwaway compatibility code. |
| [experience-first](./skills/principle-experience-first/SKILL.md) | core | Choose user delight over implementation convenience; ship fewer polished features over more rough ones. |
| [exhaust-the-design-space](./skills/principle-exhaust-the-design-space/SKILL.md) | core | Build 2-3 competing prototypes and compare side by side before committing. |
| [build-the-lever](./skills/principle-build-the-lever/SKILL.md) | core | Apply to any non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator, or a skill your subagents follow) instead of working by hand. The tool is the artifact a reviewer can rerun. |
| [model-the-domain](./skills/principle-model-the-domain/SKILL.md) | architecture | Encode the domain in a structure instead of scattered conditionals. |
| [boundary-discipline](./skills/principle-boundary-discipline/SKILL.md) | architecture | Concentrate guards at system boundaries (CLI, config, network, external APIs); trust internal types and keep business logic in pure functions. |
| [type-system-discipline](./skills/principle-type-system-discipline/SKILL.md) | architecture | Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, exhaust variants, derive from authoritative schemas. |
| [make-operations-idempotent](./skills/principle-make-operations-idempotent/SKILL.md) | architecture | Converge to the same end state regardless of partial prior runs. |
| [migrate-callers-then-delete-legacy-apis](./skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md) | architecture | Migrate callers and delete the old API in the same wave instead of preserving compatibility layers. |
| [separate-before-serializing-shared-state](./skills/principle-separate-before-serializing-shared-state/SKILL.md) | architecture | Eliminate the sharing first; serialize structurally only when one shared writer is a real invariant. |
| [prove-it-works](./skills/principle-prove-it-works/SKILL.md) | verification | Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.'. |
| [fix-root-causes](./skills/principle-fix-root-causes/SKILL.md) | verification | Trace each symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate. |
| [sequence-verifiable-units](./skills/principle-sequence-verifiable-units/SKILL.md) | verification | Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself to a reviewer. |
| [test-behavior-not-implementation](./skills/principle-test-behavior-not-implementation/SKILL.md) | verification | Apply when you write, change, or keep a test. Assert what the code's users can observe, so the test fails when that behavior breaks and keeps passing when only the internals change. |
| [explain-the-number](./skills/principle-explain-the-number/SKILL.md) | verification | Apply before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result. Find what limits it, and rule out that it measured something other than the work you think. |
| [guard-the-context-window](./skills/principle-guard-the-context-window/SKILL.md) | delegation | Route bulk to subagents; keep summaries in the main thread, not raw payloads. |
| [never-block-on-the-human](./skills/principle-never-block-on-the-human/SKILL.md) | delegation | Proceed, present the result, let the human course-correct after the fact; reserve confirmation for irreversible actions. |
| [encode-lessons-in-structure](./skills/principle-encode-lessons-in-structure/SKILL.md) | meta | Encode the rule as a lint, metadata flag, runtime check, or script instead of more text. |

</details>

## not shipped here

a few things `poteto-mode` references but doesn't bundle:

- `/deslop` and the `deslop` skill ship in cursor's `cursor-team-kit` plugin. `poteto-mode` runs it when it's installed and skips that step otherwise.
- driving a real app for proof uses bb's own tools: the `browser-automation` skill for browser, Electron, and web UIs, and bb terminals (`bb guide terminals`) for CLIs and TUIs.
- `/skill-creator` is a bb built-in, used when a playbook writes a skill.

## why are there no planning skills?

your provider already has a plan mode (`/plan` in the composer, or `bb thread spawn --plan`), and it works great with pstack. but personally, i don't believe in planning. the best spec is code. if you do want to make a plan, [`/poteto-mode`](./skills/poteto-mode/SKILL.md) covers it, but it's not a default. 

## make it yours

`poteto-mode` is my style. you may not want exactly that.

type [`/automate-me`](./skills/automate-me/SKILL.md). it mines your recent transcripts, drafts a `<your-name>-mode` skill from how you've actually worked, and routes through pstack underneath. you keep pstack as the base and end up with your own routing skill alongside `poteto-mode`.

a delegate can only run on a machine with a checkout of its project. the plugin's `checkouts` setting says where pstack may clone one, one `<projectId|*> allow|deny <hostId|*>` line per rule. the most specific rule wins, and deny wins a tie. when this machine is full and another machine lacks only a checkout, pstack clones the project there if a rule allows it. if no rule decides, it asks you once in the thread, and your answer is saved as a rule. dismissing the question keeps it away for 24 hours. an agent can answer deny for you but cannot answer allow, because an allow must come from the bb app.

models are configurable too. type [`/setup-pstack`](./skills/setup-pstack/SKILL.md). it detects the providers and models bb has (`bb provider list`, `bb provider models`) and saves a small table mapping each role (code, judgment, the review panels) to a `provider/model/level` tuple in the plugin's `models` setting. the plugin adds that table to every thread's instructions, and `bb pstack models` prints it merged with the defaults. every skill falls back to sensible defaults for a role with no line, so you override only what you want.

when a default changes, a configuration saved before the change still pins the old default. delete those role lines (Settings, Installed plugins, pstack, or `bb plugin config pstack unset models` to clear all of them), then run `/setup-pstack` again. a rerun keeps any role whose model differs from the default.

## automations

pstack also ships a dormant [benny automation pack](./automations/benny/). benny triages slack issue reports, then reproduces and fixes confirmed bugs with real ui evidence. its files are not registered as slash skills.

to set it up, point an agent at [`FOR_AGENTS.md`](./automations/benny/FOR_AGENTS.md). setup copies the pack into the target repository at `.bb/automations/benny/`, makes sure pstack is enabled for shared skills, and keeps user configuration outside the copied pack.

## license

MIT. see [LICENSE](./LICENSE). the original work is copyright (c) 2026 Lauren Tan.
