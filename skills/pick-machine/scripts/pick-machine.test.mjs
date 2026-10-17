import assert from "node:assert/strict";
import { test } from "node:test";
import { rank } from "./pick-machine.mjs";

const machine = (id, extra = {}) => ({ id, name: id, status: "connected", phase: "active", ...extra });
const threads = (host, n, status = "active") => Array.from({ length: n }, () => ({ status, environmentHostId: host }));

function facts(overrides = {}) {
	return {
		machines: [machine("local"), machine("box")],
		threads: [],
		limits: new Map([["local", 4], ["box", 4]]),
		globalLimit: null,
		environments: new Map(),
		models: new Map(),
		...overrides,
	};
}

test("a full machine is skipped for one with room", () => {
	const result = rank(facts({ threads: threads("local", 4) }));
	assert.deepEqual(result.picks, ["box"]);
	assert.equal(result.machines.find((m) => m.id === "local").reason, "full (4/4)");
});

test("pending threads hold a slot, idle and errored ones do not", () => {
	const result = rank(facts({ threads: [...threads("local", 2, "pending"), ...threads("local", 2, "active"), ...threads("box", 9, "idle"), ...threads("box", 9, "error")] }));
	assert.deepEqual(result.picks, ["box"]);
});

test("several spawns spread across machines by remaining room", () => {
	const result = rank(facts({ threads: threads("local", 2) }), { count: 4 });
	assert.deepEqual(result.picks.toSorted(), ["box", "box", "box", "local"]);
});

test("a machine without the project's environment or the model is not a candidate", () => {
	const result = rank(
		facts({
			environments: new Map([["box", { ok: false, reason: "project has no checkout here" }]]),
			models: new Map([["local", { ok: false, reason: "codex has no gpt-x" }]]),
		}),
	);
	assert.deepEqual(result.picks, []);
	assert.deepEqual(result.machines.map((m) => m.reason), ["codex has no gpt-x", "project has no checkout here"]);
});

test("offline, suspended, and excluded machines are not candidates", () => {
	const result = rank(
		facts({ machines: [machine("local", { status: "disconnected" }), machine("box", { phase: "suspended" }), machine("spare", { name: "spare-box" })], limits: new Map([["local", 4], ["box", 4], ["spare", 4]]) }),
		{ exclude: ["spare-box"] },
	);
	assert.deepEqual(result.picks, []);
	assert.deepEqual(result.machines.map((m) => m.reason), ["status disconnected", "phase suspended", "excluded"]);
});

test("the global limit caps picks even when machines have room", () => {
	const result = rank(facts({ threads: threads("local", 1), globalLimit: 2 }), { count: 3 });
	assert.equal(result.globalFree, 1);
	assert.equal(result.picks.length, 1);
});
