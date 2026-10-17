#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gather, rank } from "./pick-machine.mjs";

/** Reads the value of `--flag value` or `--flag=value`, last one wins. */
function flag(args, ...names) {
	let found;
	for (let i = 0; i < args.length; i++) {
		for (const name of names) {
			if (args[i] === name && i + 1 < args.length) found = args[i + 1];
			else if (args[i].startsWith(`${name}=`)) found = args[i].slice(name.length + 1);
		}
	}
	return found;
}

function withoutFlag(args, ...names) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (names.includes(args[i])) i++;
		else if (!names.some((name) => args[i].startsWith(`${name}=`))) out.push(args[i]);
	}
	return out;
}

/**
 * Decides how to run `bb thread spawn` with these args. Pure.
 * Picks a machine only for a fresh worktree with no machine named, or with `--machine auto`.
 * Everything else passes through untouched, because the environment or machine is already fixed.
 */
export function plan(args) {
	const machine = flag(args, "--machine", "--host");
	const fresh = flag(args, "--new-environment") === "worktree";
	const fixed = flag(args, "--environment") !== undefined || flag(args, "--new-machine") !== undefined;
	if (machine === "auto" && (!fresh || fixed)) return { error: "--machine auto needs --new-environment worktree and no --environment or --new-machine" };
	if (!fresh || fixed || (machine !== undefined && machine !== "auto")) return { pick: null, args };
	return {
		pick: { project: flag(args, "--project") ?? process.env.BB_PROJECT_ID, environment: "worktree", provider: flag(args, "--provider"), model: flag(args, "--model") },
		args: withoutFlag(args, "--machine", "--host"),
	};
}

function main() {
	const argv = process.argv.slice(2);
	const dryRun = argv.includes("--dry-run");
	const decided = plan(argv.filter((arg) => arg !== "--dry-run"));
	if (decided.error) {
		console.error(decided.error);
		process.exit(2);
	}
	let args = decided.args;
	if (decided.pick) {
		const result = rank(gather(decided.pick));
		const chosen = result.machines.find((m) => m.id === result.picks[0]);
		if (chosen) {
			args = [...args, "--machine", chosen.id];
			console.error(`pick-machine: ${chosen.name} (${chosen.id}), ${chosen.running}/${chosen.limit} busy`);
		} else {
			console.error("pick-machine: no machine has a free slot for this spawn; leaving the machine to bb, which queues it");
		}
	}
	if (dryRun) {
		console.log(["bb", "thread", "spawn", ...args].join(" "));
		process.exit(0);
	}
	const run = spawnSync(process.env.BB_CLI || "bb", ["thread", "spawn", ...args], { stdio: "inherit" });
	process.exit(run.status ?? 1);
}

// bb loads skills through a symlinked directory, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
