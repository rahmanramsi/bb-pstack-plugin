import assert from "node:assert/strict";
import { test } from "node:test";
import { activatesPoteto, hasPotetoToken, revivalDecision, type PotetoDispatch, type PotetoThread } from "./poteto.ts";

export function userDispatch(text: string): PotetoDispatch {
  return { thread: { id: "thr_test", originPluginId: null }, initiator: "user", senderThreadId: null, originPluginId: null,
    input: { text, blocks: [{ type: "text", text, mentions: [] }] } };
}

test("activation tokens work at the start, middle and end without matching examples or longer names", () => {
  for (const text of ["/poteto-mode build it", "build /poteto-mode this", "build it /poteto-mode", "also $poteto-mode this", "($poteto-mode)"]) {
    assert.equal(hasPotetoToken(text), true, text);
  }
  for (const text of ["`/poteto-mode`", "``a `/poteto-mode` example``", "```md\n/poteto-mode\n```", "~~~\n$poteto-mode\n~~~", "/poteto-mode-extra", "https://a/poteto-mode", "foo$poteto-mode"]) {
    assert.equal(hasPotetoToken(text), false, text);
  }
});

test("only user messages or user skill mentions can activate an origin", () => {
  const context = userDispatch("build it /poteto-mode");
  assert.equal(activatesPoteto(context, "pstack"), true);
  for (const initiator of ["agent", "system", "mixed"] as const) assert.equal(activatesPoteto({ ...context, initiator }, "pstack"), false);
  assert.equal(activatesPoteto({ ...context, senderThreadId: "thr_parent" }, "pstack"), false);
  assert.equal(activatesPoteto({ ...context, thread: { ...context.thread, originPluginId: "pstack" } }, "pstack"), false);
  assert.equal(activatesPoteto({ ...context, originPluginId: "another-plugin" }, "pstack"), false);
  const mention = userDispatch("use poteto-mode");
  mention.input.blocks = [{ type: "text", text: mention.input.text, mentions: [{ start: 4, end: 15, resource: {
    kind: "command", label: "poteto-mode", name: "poteto-mode", origin: "user", source: "skill", trigger: "/", argumentHint: null,
  } }] }];
  assert.equal(activatesPoteto(mention, "pstack"), true);
});

test("revival retries pending delivery and stops after three successful idle revivals", () => {
  const state: PotetoThread = { threadId: "thr_test", activatedAt: 1, phase: "activated", charterState: "pending", charterAttempts: 0, charterNextAt: 0, revivals: 0, auditCursor: null };
  assert.equal(revivalDecision(state, false), "deliver");
  assert.equal(revivalDecision({ ...state, charterState: "sent" }, false), "none");
  assert.equal(revivalDecision({ ...state, charterState: "sent" }, true), "revive");
  assert.equal(revivalDecision({ ...state, charterState: "sent", revivals: 3 }, true), "stall");
  for (const phase of ["routed", "complete", "stalled"] as const) assert.equal(revivalDecision({ ...state, phase }, true), "none");
});
