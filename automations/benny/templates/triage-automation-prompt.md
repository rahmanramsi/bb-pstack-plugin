# Triage automation prompt

> Source material for the copied setup workflow. Render this intent into the `--prompt` of a `bb automation create` command after confirming that the copied pack is committed on the branch the automation checks out. Keep the rendered copy at the configured `automations.triage_prompt_path`.

Read and follow `.bb/automations/benny/skills/triage-issue-reports/SKILL.md` for this run.

Configuration source. Include this repository-relative path only when it is committed in the same target repository. Otherwise paraphrase the configured values. Never use a plugin source or cache path:

```text
{{BENNY_CONFIG_PATH}}
```

Schedule and selection:

```json
{
	"source_channel_id": "{{SLACK_CHANNEL_ID}}",
	"ledger_path": "{{BENNY_LEDGER_PATH}}",
	"lookback_hours": "{{BENNY_LOOKBACK_HOURS}}"
}
```

This run was started by a schedule, not by a Slack event. Poll the configured source Slack channel through the configured Slack MCP tools and select one new top-level report as the operational file describes. If no report is eligible, stop without posting or writing to the issue tracker.

Treat the selected report's source channel and root thread timestamp as immutable. If either is missing or does not match configuration, stop without posting or writing to the issue tracker.

The committed operational file owns classification, attachment review, cause tracing, routing, dedupe, tracker writes, and the final verdict. Post no progress messages. Never post a root message in the source channel.

The coordinator is the only Slack poster. Any delegated worker must be read-only, return findings only, and receive an explicit ban on every Slack write action.

End the single verdict with exactly one configured marker:

```text
[benny:bug]
[benny:performance]
[benny:other]
```

A bug or performance marker may add `tracker=<URL>`.
