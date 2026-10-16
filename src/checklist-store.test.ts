import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { openChecklistStore } from "./checklist-store.ts";
import { MIGRATIONS } from "./store.ts";
import type { Resolution, StepDraft } from "./checklist.ts";

const drafts: StepDraft[] = [
  { section: "playbook", text: "1. Read the design.", afterPr: false },
  { section: "pr", text: "**Readiness.** Check the PR.", afterPr: true },
];
const done = { kind: "done", evidence: [{ kind: "path", path: "src/checklist.ts" }] } satisfies Resolution;

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  for (const migration of MIGRATIONS) db.exec(migration);
  return { db, store: openChecklistStore(db) };
}

test("begin keeps the first source snapshot unchanged across repeated calls and new store handles", (t) => {
  const { db, store } = fixture(t);
  assert.equal(store.checklist("thr_test"), null);
  assert.deepEqual(store.createChecklist("thr_test", "feature", drafts, 1), { created: true });
  const original = store.checklist("thr_test");
  assert.ok(original);
  assert.deepEqual(original.steps.map((step) => step.text), drafts.map((step) => step.text));
  assert.equal(original.steps[1].afterPr, true);
  assert.deepEqual(store.createChecklist("thr_test", "bug-fix", [], 2), { created: false });
  assert.deepEqual(openChecklistStore(db).checklist("thr_test"), original);
  assert.equal(original.revision, 0);
  assert.equal(original.nudgedAtRevision, null);
});

test("resolving a step persists evidence once and rejects a conflicting close", (t) => {
  const { db, store } = fixture(t);
  store.createChecklist("thr_test", "feature", drafts, 1);
  assert.deepEqual(store.resolveStep("thr_test", 1, done), { changed: true });
  assert.deepEqual(openChecklistStore(db).resolveStep("thr_test", 1, structuredClone(done)), { changed: false });
  assert.ok("error" in store.resolveStep("thr_test", 1, { kind: "skipped", reason: "Different result" }));
  const state = store.checklist("thr_test");
  assert.ok(state);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.steps[0].resolution, done);
  assert.ok("error" in store.resolveStep("thr_test", 999, done));
  assert.ok("error" in store.resolveStep("thr_missing", 1, done));
  assert.equal(store.checklist("thr_test")?.revision, 1);
});

test("skip reasons are trimmed and blank reasons or empty evidence never close a step", (t) => {
  const { store } = fixture(t);
  store.createChecklist("thr_test", "feature", drafts, 1);
  assert.ok("error" in store.resolveStep("thr_test", 1, { kind: "skipped", reason: "   " }));
  assert.ok("error" in store.resolveStep("thr_test", 1, { kind: "skipped", reason: "x".repeat(501) }));
  const invalid = Reflect.apply(store.resolveStep, store, ["thr_test", 1, { kind: "done", evidence: [] }]);
  assert.ok("error" in invalid);
  assert.equal(store.checklist("thr_test")?.revision, 0);
  assert.deepEqual(store.resolveStep("thr_test", 1, { kind: "skipped", reason: "  No UI change.  " }), { changed: true });
  assert.deepEqual(store.resolveStep("thr_test", 1, { kind: "skipped", reason: "No UI change." }), { changed: false });
  assert.deepEqual(store.checklist("thr_test")?.steps[0].resolution, { kind: "skipped", reason: "No UI change." });
});

test("new steps retain stable ids and precise ordering after repeated insertions", (t) => {
  const { store } = fixture(t);
  store.createChecklist("thr_test", "feature", drafts, 1);
  for (let index = 0; index < 80; index++) {
    assert.deepEqual(store.addStep("thr_test", `Check ${index}`, 1), { id: index + 3 });
  }
  let state = store.checklist("thr_test");
  assert.ok(state);
  assert.equal(state.revision, 80);
  assert.deepEqual(state.steps.map((step) => step.id), [1, ...Array.from({ length: 80 }, (_, index) => 82 - index), 2]);
  assert.equal(state.steps[0].text, drafts[0].text);
  assert.equal(state.steps.at(-1)?.text, drafts[1].text);
  assert.deepEqual(store.addStep("thr_test", "Append", null), { id: 83 });
  assert.ok("error" in store.addStep("thr_test", "Check", 999));
  assert.ok("error" in store.addStep("thr_test", " ", 1));
  assert.ok("error" in store.addStep("thr_missing", "Check", null));
  state = store.checklist("thr_test");
  assert.equal(state?.revision, 81);
  assert.equal(state?.steps.at(-1)?.id, 83);
});

test("only one caller can mark a revision nudged and stale revisions cannot mark new state", (t) => {
  const { db, store } = fixture(t);
  const other = openChecklistStore(db);
  store.createChecklist("thr_test", "feature", drafts, 1);
  assert.equal(store.markNudged("thr_missing", 0), false);
  assert.equal(store.markNudged("thr_test", 0), true);
  assert.equal(other.markNudged("thr_test", 0), false);
  assert.equal(store.checklist("thr_test")?.revision, 0);
  assert.deepEqual(store.resolveStep("thr_test", 1, done), { changed: true });
  assert.equal(other.markNudged("thr_test", 0), false);
  assert.equal(other.markNudged("thr_test", 1), true);
  assert.equal(store.markNudged("thr_test", 1), false);
  assert.equal(store.checklist("thr_test")?.nudgedAtRevision, 1);
});
