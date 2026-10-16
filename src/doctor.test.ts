import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRoles,
  checkTuple,
  failedChecks,
  providerIds,
  renderChecks,
  type Catalog,
} from "./doctor.ts";

const catalog: Catalog = new Map([
  ["codex", { state: "ok", models: [{ model: "gpt-6.1-sol", levels: ["low", "xhigh", "max"] }] }],
  ["acp-x", { state: "unavailable" }],
  ["claude-code", { state: "error", detail: "auth_required" }],
  ["empty", { state: "ok", models: [] }],
]);

test("a tuple in the catalog passes", () => {
  assert.equal(checkTuple("codex/gpt-6.1-sol/xhigh", catalog).ok, true);
  assert.equal(checkTuple("inherit-parent", catalog).ok, true);
});

test("each kind of missing tuple names what is missing", () => {
  assert.match(checkTuple("pi/m/low", catalog).detail, /provider "pi" is not installed/);
  assert.match(checkTuple("acp-x/m/low", catalog).detail, /unavailable/);
  assert.match(checkTuple("claude-code/m/low", catalog).detail, /could not load claude-code models: auth_required/);
  assert.match(checkTuple("codex/gpt-9/low", catalog).detail, /has no model "gpt-9" \(has gpt-6.1-sol\)/);
  assert.match(checkTuple("codex/gpt-6.1-sol/high", catalog).detail, /does not support "high" \(supports low, xhigh, max\)/);
  assert.match(checkTuple("empty/m/low", catalog).detail, /\(has none\)/);
});

test("role checks name the role and value, and every failure fails the run", () => {
  const checks = checkRoles(
    [{ role: "bug-fix", panel: false, source: "configured", models: ["codex/gpt-9/low"] }],
    catalog,
  );
  assert.equal(checks[0]?.subject, "bug-fix: codex/gpt-9/low");
  const all = [...checks, { ok: true, subject: "swarm workers: codex/gpt-6.1-sol/xhigh", detail: "available" }];
  assert.deepEqual(failedChecks(all).map((check) => check.subject), ["bug-fix: codex/gpt-9/low"]);
  assert.match(renderChecks(all), /^FAIL  bug-fix: codex\/gpt-9\/low .*\nok    swarm workers/);
});

test("provider ids come only from real tuples", () => {
  assert.deepEqual(
    providerIds([
      { role: "a", panel: true, source: "default", models: ["codex/x/low", "inherit-parent", "claude-code/y/max"] },
    ]),
    ["claude-code", "codex"],
  );
});

test("a multi-line detail stays on its check's line", () => {
  const rendered = renderChecks([
    { ok: false, subject: "bug-fix: x/y/z", detail: "boom\n  at stack\n" },
  ]);
  assert.equal(rendered, "FAIL  bug-fix: x/y/z  (boom at stack)");
});
