# benny

benny gives you two bb automations for slack issue reports. one triages each report. the other reproduces confirmed bugs and may prepare a small draft fix.

bb automations run on a schedule, not on slack events. so each automation is a cron-scheduled agent run that polls the source channel through the provider's slack mcp tools, picks one eligible report, and works on it. a small ledger file outside the repository keeps two runs from handling the same report.

the files in this directory are dormant setup and automation sources. they do not appear as slash skills.

## set it up

1. point a bb thread at [`FOR_AGENTS.md`](./FOR_AGENTS.md) and name the target repository.
2. let setup merge this whole directory into the target at `.bb/automations/benny/`. it must preserve destination-only files and review conflicts instead of overwriting local edits.
3. make sure pstack is installed and enabled on the bb server that runs the automations, for shared dependencies:

```bash
bb plugin install git:<pstack-repo-url>   # or: bb plugin install <local-path>
bb plugin enable pstack
```

4. keep user-owned configuration outside the copied pack, for example in `.bb/benny/`. adapt [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md).
5. commit `.bb/automations/benny/` and any secret-free configuration before enabling either automation. scheduled runs check out the default branch, so uncommitted files are invisible to them.
6. review each automation before setup creates it paused with `bb automation create --disabled`. run each once by hand with `bb automation run`, send a harmless test report, and verify every source-channel post stays in the original thread. then `bb automation resume` both.
