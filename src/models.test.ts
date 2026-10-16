import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveRoles, parseModelConfig, renderTable } from "./models.ts";

test("an empty config keeps every default", () => {
  const parsed = parseModelConfig("");
  assert.ok(parsed.ok);
  const roles = effectiveRoles(parsed.config);
  assert.ok(roles.every((role) => role.source === "default"));
  assert.deepEqual(
    roles.find((role) => role.role === "interrogate reviewers")?.models,
    ["claude-code/claude-opus-5-5/xhigh", "codex/gpt-6.1-sol/xhigh"],
  );
});

test("configured lines override their role and record the budget", () => {
  const parsed = parseModelConfig(
    [
      "# pstack model configuration",
      "# budget: medium (high)",
      "bug-fix: codex/gpt-6.1-sol/high",
      "reflect judgment, divergent, synthesizer: inherit-parent",
      "arena runners: claude-code/claude-opus-5-5/high, inherit-parent, codex/gpt-6.1-sol/high",
    ].join("\n"),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.config.budget, "medium (high)");
  const byRole = new Map(effectiveRoles(parsed.config).map((r) => [r.role, r]));
  assert.deepEqual(byRole.get("bug-fix")?.models, ["codex/gpt-6.1-sol/high"]);
  assert.equal(byRole.get("bug-fix")?.source, "configured");
  assert.deepEqual(byRole.get("reflect judgment, divergent, synthesizer")?.models, [
    "inherit-parent",
  ]);
  assert.equal(byRole.get("arena runners")?.models.length, 3);
  assert.equal(byRole.get("feature, refactoring")?.source, "default");
  assert.match(renderTable(parsed.config), /bug-fix\s+codex\/gpt-6.1-sol\/high\n/);
});

test("invalid lines are reported with their line numbers", () => {
  const parsed = parseModelConfig(
    [
      "how critics: codex/gpt-6.1-sol/high",
      "bug-fix: grok-4.7-xhigh-fast",
      "swarm workers: codex/a/high, codex/b/high",
      "bug-fix codex/gpt-6.1-sol/high",
    ].join("\n"),
  );
  assert.ok(!parsed.ok);
  assert.deepEqual(parsed.errors, [
    'line 1: unknown role "how critics"',
    'line 2: "grok-4.7-xhigh-fast" is not "provider/model/level" or "inherit-parent"',
    'line 3: role "swarm workers" takes one model, not a list',
    'line 4: expected "<role>: <value>"',
  ]);
});

test("an empty or repeated budget line is an error", () => {
  const parsed = parseModelConfig(
    ["# budget:", "# budget: large (xhigh)", "# budget: small (medium)"].join("\n"),
  );
  assert.ok(!parsed.ok);
  assert.deepEqual(parsed.errors, [
    "line 1: budget line has no value",
    "line 3: budget appears twice",
  ]);
});
