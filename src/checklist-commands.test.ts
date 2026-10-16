import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createChecklistFeature } from "./checklist-commands.ts";
import { openChecklistStore } from "./checklist-store.ts";
import { playbookSources } from "./checklist.ts";
import { MIGRATIONS } from "./store.ts";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));
type SendInput = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];

function userDispatch(text: string) {
  return { thread: { id: "thr_test", originPluginId: null }, initiator: "user" as const, senderThreadId: null, originPluginId: null,
    input: { text, blocks: [{ type: "text" as const, text, mentions: [] }] } };
}

function timelineEvent(seq: number, at: number, item: unknown, type = "item/completed") {
  return { id: `evt_${seq}`, threadId: "thr_test", seq, createdAt: at, type, data: { item } };
}

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  for (const migration of MIGRATIONS) db.exec(migration);
  const time = { now: 100 };
  const store = openChecklistStore(db, () => time.now);
  const timeline: ReturnType<typeof timelineEvent>[] = [];
  const sends: SendInput[] = [];
  const publications: string[] = [];
  const work = { activeRuns: 0, activeChildren: 0 };
  const bb = { sdk: { threads: { events: { async list({ afterSeq, limit }: { afterSeq: string; limit: string }) {
    if (Number(limit) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    return timeline.filter((row) => row.seq > Number(afterSeq)).slice(0, Number(limit));
  } }, async send(input: SendInput) { sends.push(input); } } } } as unknown as BbPluginApi;
  const missing = new Set<string>();
  const feature = createChecklistFeature({
    bb, store, skillsDir, clock: () => time.now, activeWork: async () => work, publish: (id) => publications.push(id),
    evidenceError: async (evidence) => evidence.kind === "thread" && missing.has(evidence.id) ? `Thread ${evidence.id} does not exist.` : null,
  });
  const cli = defineCli({ name: "pstack", summary: "Playbook checklists", commands: feature.commands });
  async function run(argv: string[], id = "thr_test") {
    const result = await cli.run(argv, { threadId: id });
    const override = argv.indexOf("--thread");
    if (result.stdout) assert.ok(result.stdout.endsWith(feature.footer(override < 0 ? id : argv[override + 1])));
    return result;
  }
  return { db, store, feature, cli, run, sends, publications, work, missing, timeline, time };
}

test("every begin command snapshots source steps and appends Opening a PR exactly once", async (t) => {
  const { run, store, publications } = fixture(t);
  for (const [index, name] of [...playbookSources(skillsDir).keys()].entries()) {
    const id = `thr_playbook${index}`;
    assert.equal((await run(["checklist", "begin", name], id)).exitCode, 0);
    const state = store.checklist(id);
    assert.ok(state);
    assert.equal(state.playbook, name);
    assert.ok(state.steps.length > 0);
    assert.equal(state.steps.filter((step) => step.text.startsWith("**Worktree.**")).length, 1);
    assert.equal(state.steps.filter((step) => step.afterPr && step.section === "pr").length, 1);
    assert.equal(state.steps.every((step) => step.section === "pr"), name === "opening-a-pr");
    assert.equal((await run(["checklist", "begin", "feature"], id)).exitCode, 0);
    assert.deepEqual(store.checklist(id), state);
  }
  assert.equal(publications.length, playbookSources(skillsDir).size);
});

test("CLI gates reject feature step 4 alone, then distinguish pre-PR steps and after-PR steps", async (t) => {
  const { run, store, publications } = fixture(t);
  assert.equal((await run(["gate", "pr"])).exitCode, 1);
  await run(["checklist", "begin", "feature"]);
  const outOfOrder = await run(["checklist", "done", "4", "--evidence", "path:src/checklist.ts"]);
  assert.equal(outOfOrder.exitCode, 1);
  assert.match(outOfOrder.stdout ?? "", /Close it before step 4/);
  for (const step of [1, 2, 3]) await run(["checklist", "done", String(step), "--evidence", "path:src/checklist.ts"]);
  assert.equal((await run(["checklist", "done", "4", "--evidence", "path:src/checklist.ts", "--evidence", "commit:abcdef1"])).exitCode, 0);
  const beforeRepeat = publications.length;
  await run(["checklist", "done", "4", "--evidence", "path:src/checklist.ts", "--evidence", "commit:abcdef1"]);
  assert.equal(publications.length, beforeRepeat);
  const blocked = await run(["gate", "pr"]);
  assert.equal(blocked.exitCode, 1);
  for (const id of [5, 6, 7]) assert.match(blocked.stdout ?? "", new RegExp(`\\n${id}\\. \\[playbook\\]`));
  const state = store.checklist("thr_test");
  assert.ok(state);
  for (const step of state.steps.filter((step) => !step.afterPr && step.resolution.kind === "open")) {
    const args = step.id % 2 || step.skipPolicy !== "agent" ? ["done", String(step.id), "--evidence", "path:src/checklist.ts"]
      : ["skip", String(step.id), "--reason", "This step does not apply."];
    assert.equal((await run(["checklist", ...args])).exitCode, 0);
  }
  assert.equal((await run(["gate", "pr"])).exitCode, 0);
  assert.equal((await run(["gate", "done"])).exitCode, 1);
  const afterPr = state.steps.filter((step) => step.afterPr);
  assert.deepEqual(afterPr.map((step) => step.text.slice(0, 15)), ["8. Run **Openin", "**Readiness.** "]);
  for (const step of afterPr) {
    assert.equal((await run(["gate", "done"])).exitCode, 1);
    await run(["checklist", "done", String(step.id), "--evidence", "pr:https://github.com/get-bb/bb/pull/1"]);
  }
  assert.equal((await run(["gate", "done"])).exitCode, 0);
  const shown = await run(["checklist", "show"]);
  assert.match(shown.stdout ?? "", /Evidence: path:src\/checklist.ts, commit:abcdef1/);
  assert.match(shown.stdout ?? "", /Reason: This step does not apply\./);
  const revision = store.checklist("thr_test")?.revision;
  assert.equal((await run(["checklist", "skip", "4", "--reason", "Different"])).exitCode, 1);
  assert.equal(store.checklist("thr_test")?.revision, revision);
});

test("thread overrides, custom step insertion, and SDK validation preserve thread isolation", async (t) => {
  const { run, cli, store } = fixture(t);
  assert.equal((await run(["checklist", "begin", "missing"])).exitCode, 1);
  assert.equal(store.checklist("thr_test"), null);
  assert.equal((await cli.run(["checklist", "begin", "feature"], {})).exitCode, 1);
  await run(["checklist", "begin", "feature", "--thread", "thr_other"]);
  assert.equal(store.checklist("thr_test"), null);
  await run(["checklist", "add", "Check recovery", "--after", "2", "--thread", "thr_other"]);
  const state = store.checklist("thr_other");
  assert.ok(state);
  assert.equal(state.steps[2].text, "Check recovery");
  for (const args of [
    ["done", "1", "--evidence", "unknown:x"], ["done", "1", "--evidence", "path:"],
    ["skip", "1", "--reason", " "], ["done", "1.2", "--evidence", "path:src"],
    ["done", "999", "--evidence", "path:src"], ["add", " ", "--after", "2"],
    ["add", "Invalid", "--after", "999"],
  ]) assert.equal((await run(["checklist", ...args, "--thread", "thr_other"])).exitCode, 1);
  assert.deepEqual(store.checklist("thr_other"), state);
  assert.equal((await run(["checklist", "done", "1", "--thread", "thr_other"])).exitCode, 1);
  assert.equal((await run(["checklist", "add", "Invalid", "--after", "0", "--thread", "thr_other"])).exitCode, 1);
  const help = await cli.run(["checklist", "done", "--help"], {});
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout ?? "", /--evidence/);
});

test("instructions are bounded and concurrent idle handlers send one agent-only nudge per revision", async (t) => {
  const { run, store, feature, sends, work } = fixture(t);
  assert.equal(feature.instructions("thr_test"), null);
  assert.equal(feature.footer("thr_test"), "");
  await feature.onIdle("thr_test");
  await run(["checklist", "begin", "feature"]);
  const instructions = feature.instructions("thr_test");
  assert.ok(instructions && instructions.length <= 1500);
  assert.match(instructions, /gate pr/);
  work.activeRuns = 1;
  await feature.onIdle("thr_test");
  work.activeRuns = 0;
  work.activeChildren = 1;
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 0);
  work.activeChildren = 0;
  await Promise.all(Array.from({ length: 12 }, () => feature.onIdle("thr_test")));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].threadId, "thr_test");
  assert.equal(sends[0].mode, "steer-if-active");
  assert.deepEqual(sends[0].input?.map((part) => ({ type: part.type, visibility: part.visibility })), [{ type: "text", visibility: "agent-only" }]);
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 1);
  await run(["checklist", "done", "1", "--evidence", "path:src/checklist.ts"]);
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 2);
  await run(["checklist", "done", "1", "--evidence", "path:src/checklist.ts"]);
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 2);
  const state = store.checklist("thr_test");
  assert.ok(state);
  for (const step of state.steps.filter((step) => step.resolution.kind === "open")) {
    store.resolveStep("thr_test", step.id, { kind: "done", evidence: [{ kind: "path", path: "src" }] });
  }
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 2);
});

test("a stale idle snapshot cannot consume the nudge for a newer revision", async (t) => {
  const { store, feature, sends } = fixture(t);
  const state = { section: "playbook", skipPolicy: "agent", afterPr: false, text: "Check recovery" } as const;
  store.createChecklist("thr_test", "feature", [state], 1);
  const idle = feature.onIdle("thr_test");
  store.addStep("thr_test", "Check restart", 1);
  await idle;
  assert.equal(sends.length, 0);
  assert.equal(store.checklist("thr_test")?.nudgedAtRevision, null);
  await feature.onIdle("thr_test");
  assert.equal(sends.length, 1);
});

test("done rejects a thread reference that does not exist and leaves the step open", async (t) => {
  const { run, store, missing } = fixture(t);
  await run(["checklist", "begin", "feature"]);
  missing.add("thr_gone");
  const result = await run(["checklist", "done", "1", "--evidence", "thread:thr_gone"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout ?? "", /Thread thr_gone does not exist\./);
  assert.equal(store.checklist("thr_test")?.steps.find((step) => step.id === 1)?.resolution.kind, "open");
});

test("first and later user dispatches activate idempotently without any SDK I/O", async (t) => {
  const { feature, store, sends } = fixture(t);
  for (const prefix of ["first", "later"]) {
    for (const text of ["build this /poteto-mode", "build /poteto-mode this"]) {
      const ctx = userDispatch(text);
      ctx.thread.id = `thr_${prefix}_${text.length}`;
      if (prefix === "later") feature.dispatch({ ...ctx, input: { text: "hello", blocks: [] } });
      assert.deepEqual(feature.dispatch(ctx), { action: "proceed" });
      const first = store.poteto(ctx.thread.id);
      assert.ok(first);
      assert.deepEqual(feature.dispatch(ctx), { action: "proceed" });
      assert.deepEqual(store.poteto(ctx.thread.id), first);
    }
  }
  assert.equal(sends.length, 0);
});

test("charter retries failed sends, survives reopen, and bounded idle revivals become visibly stalled", async (t) => {
  const { db, store } = fixture(t);
  let now = 100;
  let fail = true;
  const sends: SendInput[] = [];
  const bb = { pluginId: "pstack", sdk: { threads: { events: { async list() { return []; } }, async send(input: SendInput) {
    if (fail) throw new Error("offline");
    sends.push(input);
  } } } } as unknown as BbPluginApi;
  function feature() {
    return createChecklistFeature({ bb, store: openChecklistStore(db), skillsDir, clock: () => now,
      activeWork: async () => ({ activeRuns: 0, activeChildren: 0 }), publish: () => {}, evidenceError: async () => null });
  }
  let current = feature();
  current.dispatch(userDispatch("build this /poteto-mode"));
  assert.match(current.instructions("thr_test") ?? "", /checklist begin <playbook> before any other work/);
  await assert.rejects(current.reconcile("thr_test"), /offline/);
  assert.equal(store.poteto("thr_test")?.charterState, "pending");
  fail = false;
  now += 30_000;
  current = feature();
  await Promise.all(Array.from({ length: 8 }, () => current.reconcile("thr_test")));
  assert.equal(store.poteto("thr_test")?.charterState, "sent");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].mode, "steer-if-active");
  assert.equal(sends[0].input?.[0].visibility, "agent-only");
  for (let index = 0; index < 4; index++) { now += 30_000; await current.onIdle("thr_test"); }
  assert.equal(sends.length, 4);
  assert.equal(store.poteto("thr_test")?.phase, "stalled");
  assert.match(current.footer("thr_test"), /stalled/);
  const cli = defineCli({ name: "pstack", summary: "checklists", commands: current.commands });
  await cli.run(["checklist", "begin", "feature"], { threadId: "thr_test" });
  assert.equal(store.poteto("thr_test")?.phase, "routed");
});

test("only a direct user control message can waive Feature steps 1 and 2, and step 4 cannot be waived", async (t) => {
  const { feature, run, store, sends } = fixture(t);
  await run(["checklist", "begin", "feature"]);
  assert.equal((await run(["checklist", "skip", "1", "--reason", "already done"])).exitCode, 1);
  const ctx = userDispatch("/poteto-mode waive 1 Existing design accepted.");
  assert.deepEqual(feature.dispatch({ ...ctx, initiator: "agent" }), { action: "proceed" });
  assert.equal(store.checklist("thr_test")?.steps[0].resolution.kind, "open");
  assert.match(JSON.stringify(feature.dispatch(ctx)), /Step 1 waived/);
  assert.match(JSON.stringify(feature.dispatch(ctx)), /Step 1 waived/);
  assert.equal(store.checklist("thr_test")?.revision, 1);
  assert.equal((await run(["checklist", "skip", "2", "--reason", "already done"])).exitCode, 1);
  feature.dispatch(userDispatch("/poteto-mode waive 2 Existing architecture accepted."));
  await run(["checklist", "done", "3", "--evidence", "path:plan.md"]);
  assert.equal((await run(["checklist", "skip", "4", "--reason", "already done"])).exitCode, 1);
  assert.match(JSON.stringify(feature.dispatch(userDispatch("/poteto-mode waive 4 No delegation."))), /cannot be skipped/);
  assert.equal(store.checklist("thr_test")?.steps[3].resolution.kind, "open");
  assert.equal(sends.length, 0);
});

test("CLI passes the step opening time to reject stale thread and run evidence with recovery instructions", async (t) => {
  const { evidenceFreshnessError } = await import("./checklist.ts");
  const { store } = fixture(t);
  store.createChecklist("thr_test", "feature", [{ section: "playbook", text: "Verify", afterPr: false, skipPolicy: "agent" }], 200);
  let createdAt = 100;
  const feature = createChecklistFeature({ bb: {} as BbPluginApi, store, skillsDir, activeWork: async () => ({ activeRuns: 0, activeChildren: 0 }), publish: () => {},
    evidenceError: async (evidence, _thread, openedAt) => evidenceFreshnessError(evidence, createdAt, openedAt) });
  const cli = defineCli({ name: "pstack", summary: "checklist", commands: feature.commands });
  for (const reference of ["thread:thr_old", "run:psr_12345678-1234-1234-1234-123456789abc"]) {
    const result = await cli.run(["checklist", "done", "1", "--evidence", reference], { threadId: "thr_test" });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout ?? "", /predates this step.*Start fresh work/);
  }
  assert.equal(store.checklist("thr_test")?.steps[0].resolution.kind, "open");
  createdAt = 200;
  assert.equal((await cli.run(["checklist", "done", "1", "--evidence", "thread:thr_new"], { threadId: "thr_test" })).exitCode, 0);
});

test("late checklist closure and late PR gates retain both violations until the user acknowledges them", async (t) => {
  const { run, store, feature, timeline, time, sends } = fixture(t);
  feature.dispatch(userDispatch("Implement the feature /poteto-mode"));
  timeline.push(timelineEvent(1, 150, { type: "fileChange", id: "write-1", changes: [{ path: "src/settings.tsx", kind: "update" }] }));
  time.now = 200;
  await run(["checklist", "begin", "feature"]);
  for (const id of [1, 2]) {
    assert.equal((await run(["checklist", "skip", String(id), "--reason", "Implemented before the checklist."])).exitCode, 1);
    feature.dispatch(userDispatch(`/poteto-mode waive ${id} Accept the supplied design.`));
  }
  await run(["checklist", "done", "3", "--evidence", "path:plan.md"]);
  assert.equal((await run(["checklist", "skip", "4", "--reason", "Implemented before activation."])).exitCode, 1);
  const checklist = store.checklist("thr_test");
  assert.ok(checklist);
  for (const step of checklist.steps.filter((step) => step.resolution.kind === "open" && !step.afterPr)) {
    assert.equal((await run(["checklist", "done", String(step.id), "--evidence", "path:src/settings.tsx"])).exitCode, 0);
  }
  timeline.push(timelineEvent(2, 250, { type: "commandExecution", id: "publish-1", command: "cd app && gh pr create --title settings", status: "completed", exitCode: 0 }));
  time.now = 300;
  assert.equal((await run(["gate", "pr"])).exitCode, 0);
  assert.equal(store.checklist("thr_test")?.prGatePassedAt, 300);
  time.now = 400;
  assert.equal((await run(["gate", "pr"])).exitCode, 0);
  assert.equal(store.checklist("thr_test")?.prGatePassedAt, 300);
  for (const step of checklist.steps.filter((step) => step.afterPr)) await run(["checklist", "done", String(step.id), "--evidence", "pr:https://example.com/pull/1"]);
  const result = await run(["gate", "done"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout ?? "", /work-before-checklist:write-1/);
  assert.match(result.stdout ?? "", /pr-before-gate:publish-1/);
  assert.equal(store.violations("thr_test").length, 2);
  assert.equal(store.poteto("thr_test")?.auditCursor, "2");
  await feature.reconcile("thr_test");
  assert.equal(sends.length, 3);
  await feature.reconcile("thr_test");
  assert.equal(sends.length, 3);
  for (const violation of store.violations("thr_test")) {
    const ctx = userDispatch(`/poteto-mode ack ${violation.key}`);
    assert.deepEqual(feature.dispatch({ ...ctx, initiator: "agent" }), { action: "proceed" });
    assert.equal(store.violations("thr_test").find((entry) => entry.key === violation.key)?.acknowledgedAt, null);
    assert.equal(feature.dispatch(ctx).action, "reject");
    const firstAck = store.violations("thr_test");
    time.now++;
    feature.dispatch(ctx);
    assert.deepEqual(store.violations("thr_test"), firstAck);
  }
  assert.equal((await run(["gate", "done"])).exitCode, 0);
  assert.equal(store.poteto("thr_test")?.phase, "complete");
});

test("unreadable timeline data creates one visible held violation across cursor replay", async (t) => {
  const { feature, store, run, timeline, time } = fixture(t);
  feature.dispatch(userDispatch("/poteto-mode build"));
  timeline.push(timelineEvent(1, 150, { type: "futureWrite", id: "new-item" }));
  time.now = 200;
  await feature.reconcile("thr_test");
  timeline.push(timelineEvent(2, 160, { type: "commandExecution", id: "broken" }));
  await feature.reconcile("thr_test");
  assert.equal(store.violations("thr_test").length, 1);
  assert.match(feature.footer("thr_test"), /audit-unreadable/);
  assert.equal((await run(["gate", "done"])).exitCode, 1);
  assert.match(JSON.stringify(feature.dispatch(userDispatch("/poteto-mode ack absent"))), /Unknown violation/);
});

test("the auditor pages raw events and gates refuse to pass when the timeline cannot be read", async (t) => {
  const { store, feature, run, timeline, time } = fixture(t);
  feature.dispatch(userDispatch("/poteto-mode"));
  for (let seq = 1; seq <= 501; seq++) timeline.push(timelineEvent(seq, 150, { type: "reasoning", id: `reason-${seq}` }));
  timeline.push(timelineEvent(502, 150, { type: "fileChange", id: "last", changes: [{ path: "src/a.ts" }] }));
  time.now = 200;
  await run(["gate", "done"]);
  assert.equal(store.poteto("thr_test")?.auditCursor, "502");
  assert.equal(store.violations("thr_test")[0].key, "work-before-checklist:last");
  const unavailable = createChecklistFeature({ bb: { sdk: { threads: { events: { async list() { throw new Error("offline"); } } } } } as unknown as BbPluginApi,
    store, skillsDir, activeWork: async () => ({ activeRuns: 0, activeChildren: 0 }), publish: () => {}, evidenceError: async () => null });
  const cli = defineCli({ name: "pstack", summary: "checklist", commands: unavailable.commands });
  const failed = await cli.run(["gate", "pr"], { threadId: "thr_test" });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stdout ?? "", /audit failed.*Retry this gate.*offline/);
  assert.equal(store.checklist("thr_test"), null);
});

for (const kind of ["pr", "done"]) test(`${kind} gate resumes a bounded audit of 3000 events from its persisted cursor`, async (t) => {
  const { db, store, feature, run, timeline } = fixture(t);
  feature.dispatch(userDispatch("/poteto-mode"));
  store.createChecklist("thr_test", "feature", [], 100);
  for (let seq = 1; seq <= 3000; seq++) timeline.push(timelineEvent(seq, 150, { type: "reasoning", id: `reason-${seq}` }));

  const catchingUp = await run(["gate", kind]);
  assert.equal(catchingUp.exitCode, 1);
  assert.match(catchingUp.stdout ?? "", /audit is still catching up/);
  assert.equal(openChecklistStore(db).poteto("thr_test")?.auditCursor, "2000");
  assert.equal(store.checklist("thr_test")?.prGatePassedAt, null);
  assert.notEqual(store.poteto("thr_test")?.phase, "complete");

  const caughtUp = await run(["gate", kind]);
  assert.equal(caughtUp.exitCode, 0);
  assert.match(caughtUp.stdout ?? "", new RegExp(`${kind} gate passed`));
  assert.equal(openChecklistStore(db).poteto("thr_test")?.auditCursor, "3000");
  assert.equal((await run(["gate", kind])).exitCode, 0);
});

test("failed violation notifications retry after restart and are marked sent only after success", async (t) => {
  const { db, store } = fixture(t);
  store.createChecklist("thr_test", "feature", [{ section: "playbook", text: "Work", skipPolicy: "agent", afterPr: false }], 100);
  store.activate("thr_test", "activation", 100);
  const charterAttempt = store.claimCharter("thr_test", 100);
  assert.ok(charterAttempt !== null);
  store.charterSent("thr_test", charterAttempt);
  store.recordAudit("thr_test", null, "1", [{ key: "pr-before-gate:cmd", kind: "pr-before-gate", detail: "PR created early.", observedAt: 200 }]);
  let now = 300;
  let fail = true;
  const sends: SendInput[] = [];
  const bb = { sdk: { threads: { events: { async list() { return []; } }, async send(input: SendInput) {
    if (fail) throw new Error("offline");
    sends.push(input);
  } } } } as unknown as BbPluginApi;
  const create = () => createChecklistFeature({ bb, store: openChecklistStore(db), skillsDir, clock: () => now,
    activeWork: async () => ({ activeRuns: 0, activeChildren: 0 }), publish: () => {}, evidenceError: async () => null });
  await assert.rejects(create().reconcile("thr_test"), /offline/);
  assert.equal(store.violations("thr_test")[0].notifiedAt, null);
  fail = false;
  now += 30_000;
  const restarted = create();
  await Promise.all([restarted.reconcile("thr_test"), restarted.reconcile("thr_test")]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].input?.[0].visibility, "agent-only");
  assert.equal(store.violations("thr_test")[0].notifiedAt, now);
  await restarted.reconcile("thr_test");
  assert.equal(sends.length, 1);
});

test("dispatch activation and user controls never access SDK, realtime, or thread APIs", (t) => {
  const { store } = fixture(t);
  const bb = { pluginId: "pstack", get sdk() { throw new Error("SDK I/O under dispatch lock"); }, get realtime() { throw new Error("network I/O under dispatch lock"); } } as unknown as BbPluginApi;
  const feature = createChecklistFeature({ bb, store, skillsDir, clock: () => 100, activeWork: async () => { throw new Error("thread I/O"); },
    publish: () => { throw new Error("network publication"); }, evidenceError: async () => { throw new Error("evidence I/O"); } });
  assert.equal(feature.dispatch(userDispatch("build /poteto-mode this")).action, "proceed");
  store.createChecklist("thr_test", "feature", [{ section: "playbook", text: "Ground", skipPolicy: "user", afterPr: false }], 100);
  assert.equal(feature.dispatch(userDispatch("/poteto-mode waive 1 Use existing grounding.")).action, "reject");
  store.recordAudit("thr_test", null, "1", [{ key: "audit-unreadable", kind: "audit-unreadable", detail: "Unsupported item.", observedAt: 100 }]);
  assert.equal(feature.dispatch(userDispatch("/poteto-mode ack audit-unreadable")).action, "reject");
});
