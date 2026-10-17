import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const linked = join(mkdtempSync(join(tmpdir(), "pick-machine-")), "scripts");
symlinkSync(import.meta.dirname, linked);

test("pick-machine.mjs runs when invoked through a symlinked skill directory", () => {
	const run = spawnSync(process.execPath, [join(linked, "pick-machine.mjs"), "--help"], { encoding: "utf8" });
	assert.equal(run.status, 0);
	assert.match(run.stdout, /Usage: node pick-machine\.mjs/);
});

test("spawn.mjs runs when invoked through a symlinked skill directory", () => {
	const run = spawnSync(process.execPath, [join(linked, "spawn.mjs"), "--machine", "auto"], { encoding: "utf8" });
	assert.equal(run.status, 2);
	assert.match(run.stderr, /--machine auto needs --new-environment worktree/);
});
