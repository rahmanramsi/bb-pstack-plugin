#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

// A thread holds a slot from the moment its turn starts until it settles.
const BUSY = new Set(["active", "pending"]);
const ENVIRONMENTS = { worktree: "git-worktree", checkout: "project-checkout" };

const USAGE = `Usage: node pick-machine.mjs [--project <id>] [--environment worktree|checkout]
                         [--provider <id> [--model <id>]] [--count <n>] [--exclude <id-or-name>]... [--json]`;

/**
 * Ranks machines for new threads. Pure: every fact comes in through `facts`.
 * A machine is a candidate when it is connected and active, offers the environment for the project,
 * offers the model when one is asked for, and has a free slot under its effective limit.
 */
export function rank(facts, { count = 1, exclude = [] } = {}) {
	const busy = new Map();
	for (const thread of facts.threads) {
		if (!BUSY.has(thread.status) || !thread.environmentHostId) continue;
		busy.set(thread.environmentHostId, (busy.get(thread.environmentHostId) ?? 0) + 1);
	}
	const totalBusy = [...busy.values()].reduce((sum, n) => sum + n, 0);
	const globalFree = facts.globalLimit === null ? Infinity : Math.max(0, facts.globalLimit - totalBusy);

	const machines = facts.machines.map((machine) => {
		const limit = facts.limits.get(machine.id) ?? null;
		const running = busy.get(machine.id) ?? 0;
		const free = limit === null ? 0 : Math.max(0, limit - running);
		const environment = facts.environments.get(machine.id);
		const model = facts.models?.get(machine.id);
		const reason = [
			exclude.includes(machine.id) || exclude.includes(machine.name) ? "excluded" : null,
			machine.status !== "connected" ? `status ${machine.status}` : null,
			machine.phase !== "active" ? `phase ${machine.phase}` : null,
			environment?.ok === false ? environment.reason : null,
			model?.ok === false ? model.reason : null,
			limit === null ? "no concurrency limit reported" : null,
			limit !== null && free === 0 ? `full (${running}/${limit})` : null,
		].find((r) => r !== null) ?? null;
		return { id: machine.id, name: machine.name, running, limit, free, reason };
	});

	const eligible = machines
		.filter((m) => m.reason === null)
		.sort((a, b) => b.free - a.free || b.free / b.limit - a.free / a.limit || a.name.localeCompare(b.name));

	// Spread `count` spawns one at a time onto whichever eligible machine has the most room left.
	const room = new Map(eligible.map((m) => [m.id, m.free]));
	const picks = [];
	for (let i = 0; i < Math.min(count, globalFree); i++) {
		const next = eligible.filter((m) => room.get(m.id) > 0).sort((a, b) => room.get(b.id) - room.get(a.id))[0];
		if (!next) break;
		room.set(next.id, room.get(next.id) - 1);
		picks.push(next.id);
	}

	return { picks, machines, totalBusy, globalLimit: facts.globalLimit, globalFree };
}

function bb(args) {
	const out = execFileSync(process.env.BB_CLI || "bb", [...args, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	return JSON.parse(out);
}

function tryBb(args) {
	try {
		return { ok: true, value: bb(args) };
	} catch (error) {
		const text = String(error.stdout ?? "");
		let message = error.message.split("\n")[0];
		try {
			message = JSON.parse(text).error?.message ?? message;
		} catch {}
		return { ok: false, message };
	}
}

/** Reads every fact `rank` needs from the live bb server. */
export function gather({ project, environment, provider, model }) {
	const concurrency = bb(["concurrency-limit", "status"]);
	const machines = bb(["machine", "list"]).map((m) => ({ id: m.id, name: m.name, status: m.status, phase: m.lifecycle?.phase ?? "active" }));
	const threads = bb(["thread", "list", "--include-hidden"]);
	const limits = new Map(concurrency.hosts.map((h) => [h.id, h.effectiveLimit]));
	const live = machines.filter((m) => m.status === "connected" && m.phase === "active");

	const environments = new Map();
	if (project) {
		for (const m of live) {
			const result = tryBb(["environment", "providers", "--project", project, "--machine", m.id]);
			if (!result.ok) {
				environments.set(m.id, { ok: false, reason: result.message });
				continue;
			}
			const entry = result.value.find((p) => p.id === ENVIRONMENTS[environment]);
			if (!entry) environments.set(m.id, { ok: false, reason: "project has no checkout here" });
			else if (entry.availability?.status !== "available")
				environments.set(m.id, { ok: false, reason: entry.availability?.message ?? `${environment} ${entry.availability?.status}` });
			else environments.set(m.id, { ok: true });
		}
	}

	const models = new Map();
	if (provider) {
		for (const m of live) {
			const result = tryBb(["provider", "models", provider, "--machine", m.id, ...(project ? ["--project", project] : [])]);
			if (!result.ok) models.set(m.id, { ok: false, reason: `${provider}: ${result.message}` });
			else if (model && !result.value.some((entry) => entry.id === model || entry.model === model))
				models.set(m.id, { ok: false, reason: `${provider} has no ${model}` });
			else models.set(m.id, { ok: true });
		}
	}

	return { machines, threads, limits, globalLimit: concurrency.globalLimit, environments, models };
}

function parse(argv) {
	const options = { project: process.env.BB_PROJECT_ID, environment: "worktree", count: 1, exclude: [], json: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
			return argv[++i];
		};
		if (flag === "--project") options.project = value();
		else if (flag === "--environment") options.environment = value();
		else if (flag === "--provider") options.provider = value();
		else if (flag === "--model") options.model = value();
		else if (flag === "--count") options.count = Number(value());
		else if (flag === "--exclude") options.exclude.push(value());
		else if (flag === "--json") options.json = true;
		else if (flag === "-h" || flag === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else throw new Error(`unknown option ${flag}`);
	}
	if (!(options.environment in ENVIRONMENTS)) throw new Error("--environment must be worktree or checkout");
	if (!Number.isInteger(options.count) || options.count < 1) throw new Error("--count must be a positive integer");
	if (options.model && !options.provider) throw new Error("--model needs --provider");
	return options;
}

function main() {
	let options;
	try {
		options = parse(process.argv.slice(2));
	} catch (error) {
		console.error(`${error.message}\n${USAGE}`);
		process.exit(2);
	}
	const result = rank(gather(options), options);
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const width = Math.max(...result.machines.map((m) => m.name.length), 4);
		for (const m of result.machines) {
			const load = m.limit === null ? "?" : `${m.running}/${m.limit}`;
			console.log(`${m.id}  ${m.name.padEnd(width)}  ${load.padStart(5)}  ${m.reason ?? `${m.free} free`}`);
		}
		const global = result.globalLimit === null ? "unlimited" : `${result.totalBusy}/${result.globalLimit}`;
		console.log(`\nglobal: ${global}`);
		console.log(result.picks.length === 0 ? "pick: none" : `pick: ${result.picks.join(" ")}`);
	}
	process.exit(result.picks.length === 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
