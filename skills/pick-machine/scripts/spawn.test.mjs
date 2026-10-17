import assert from "node:assert/strict";
import { test } from "node:test";
import { plan } from "./spawn.mjs";

test("a fresh worktree with no machine gets a pick from its project and model", () => {
	const result = plan(["--project", "p1", "--new-environment", "worktree", "--provider", "codex", "--model=gpt-6.1-sol", "--prompt-file", "-"]);
	assert.deepEqual(result.pick, { project: "p1", environment: "worktree", provider: "codex", model: "gpt-6.1-sol" });
	assert.deepEqual(result.args, ["--project", "p1", "--new-environment", "worktree", "--provider", "codex", "--model=gpt-6.1-sol", "--prompt-file", "-"]);
});

test("--machine auto is replaced by the pick", () => {
	const result = plan(["--new-environment=worktree", "--machine", "auto", "--title", "x"]);
	assert.notEqual(result.pick, null);
	assert.deepEqual(result.args, ["--new-environment=worktree", "--title", "x"]);
});

test("a named machine, an existing environment, or a non-worktree spawn passes through untouched", () => {
	for (const args of [
		["--new-environment", "worktree", "--machine", "box"],
		["--new-environment", "worktree", "--host=box"],
		["--environment", "env_1"],
		["--new-environment", "personal"],
		["--prompt", "hi"],
	]) assert.deepEqual(plan(args), { pick: null, args });
});

test("--machine auto without a fresh worktree is refused", () => {
	assert.ok(plan(["--machine", "auto", "--environment", "env_1"]).error);
	assert.ok(plan(["--machine", "auto"]).error);
});
