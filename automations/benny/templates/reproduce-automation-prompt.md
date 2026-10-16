# Reproduce automation prompt

> Source material for the copied setup workflow. Render this intent into the `--prompt` of a `bb automation create` command after confirming that the copied pack is committed on the branch the automation checks out. Keep the rendered copy at the configured `automations.reproduce_prompt_path`.

Read and follow `.bb/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for this run.

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

This run was started by a schedule, not by a Slack event. Poll the configured source Slack channel through the configured Slack MCP tools and select one top-level report that already carries a trusted triage marker, as the operational file describes. If no report is eligible, stop silently.

The rendered prompt should name the configured repository, default branch, issue tracker, control adapter, feature map, and draft pull request capability.

Treat the selected report's source channel and root thread timestamp as immutable. If either is missing or does not match configuration, stop without posting.

Accept a configured triage marker only from the configured triage identity in this exact thread. Proceed only for `[benny:bug]` or `[benny:performance]`.

Require the configured control-adapter skill before attempting a repro. Reproduce the exact discriminating symptom twice through the real UI. Verify existing pull requests or commits without authoring over them. Attempt a bounded fix only after a confirmed repro and the operational file's fix gate.

The coordinator is the only Slack poster. Every child prompt must forbid every Slack MCP write tool, `chat.postMessage`, and all other Slack writes. Children return findings only.

Never post a root message in the source channel.
