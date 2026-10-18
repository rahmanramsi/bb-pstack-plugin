import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { IssueJob } from "./layout.ts";

/** Node strips types but not JSX, and the shared button imports extensionless paths that the app bundler resolves. */
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (!specifier.startsWith(".")) throw error;
      return next(`${specifier.replace(/\.js$/, "")}.ts`, context);
    }
  },
  load(url, context, next) {
    if (!url.endsWith(".tsx")) return next(url, context);
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), { fileName: url, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

Object.assign(globalThis, { __bbPluginRuntime: { react: React, pluginSdkApp: { useBbNavigate: () => ({ openUrl() {}, toThread() {} }), useRpc: () => ({ call: async () => ({}) }), Markdown: () => null } } });
const { IssueRow } = await import("./issues.tsx");

const job: IssueJob = { id: "psi_00000000-0000-0000-0000-000000000001", repo: "acme/web", issue: 41, title: "Fix mobile navigation", issueUrl: "https://github.com/acme/web/issues/41", state: "review", next: null, triggeredBy: "maya", branch: "agent/issue-41", parentId: null, retryOf: null, threadId: "thr_worker", pr: { number: 7, url: "https://github.com/acme/web/pull/7" }, pushedSha: null, round: 1, summary: null, outcome: "ready", limitation: null, delivery: { pending: false, error: null }, error: null, createdAt: 1, updatedAt: 100, poll: { polledAt: 100, error: null } };

function render(overrides: Partial<IssueJob>) {
  const html = renderToStaticMarkup(React.createElement(IssueRow, { job: { ...job, ...overrides }, now: 100, onThread: null, refresh() {} }));
  const status = /<span class="ps-status" data-state="([^"]+)">([^<]+)<\/span>/.exec(html);
  const notes = [...html.matchAll(/<p class="(ps-error|ps-warning|ps-muted)">([^<]+)<\/p>/g)].map(([, kind, text]) => ({ kind, text }));
  return { tone: status?.[1], label: status?.[2], notes };
}

test("a failed job shows its failure first while the issue status comment cannot be delivered", () => {
  const row = render({ state: "sticking", outcome: "failure", error: "Tests fail on the base branch", delivery: { pending: true, error: "GitHub is unavailable" } });
  assert.equal(row.tone, "failed");
  assert.equal(row.notes[0]?.kind, "ps-error");
  assert.equal(row.notes[0]?.text, "Tests fail on the base branch");
  assert.ok(row.notes.some((note) => note.kind === "ps-error" && note.text.includes("GitHub is unavailable")));
});

test("a ready pull request keeps its outcome while delivery is pending and is never shown as merged", () => {
  const ready = render({ delivery: { pending: true, error: null } });
  const merged = render({ state: "closing", outcome: "merged" });
  assert.equal(ready.label, render({}).label);
  assert.notEqual(ready.tone, "succeeded");
  assert.equal(merged.tone, "succeeded");
  assert.notEqual(merged.label, ready.label);
  assert.deepEqual(ready.notes.map((note) => note.kind), ["ps-muted"]);
});

test("a pull request closed without merging renders as a failure", () => {
  const row = render({ state: "stuck", outcome: "closed-unmerged", error: "the pull request closed without merging" });
  assert.equal(row.tone, "failed");
  assert.match(row.label ?? "", /without merging/);
});

test("an unreadable branch policy renders as a warning beside a ready result", () => {
  const limitation = "Branch policy could not be inspected: rulesets are unavailable. Observed CI and local evidence passed; merge prerequisites are not established.";
  const row = render({ limitation });
  assert.equal(row.label, render({}).label);
  assert.deepEqual(row.notes, [{ kind: "ps-warning", text: limitation }]);
});
