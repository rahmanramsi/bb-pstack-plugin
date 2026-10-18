import assert from "node:assert/strict";
import { test } from "node:test";
import { auditPage, classifyTimelineEvent, createsPr, deriveViolation } from "./poteto-audit.ts";

const context = { activatedAt: 100, checklistAt: 200, prGateAt: 300 };
function row(item: unknown, at = 150) { return { seq: 1, createdAt: at, type: "item/completed", data: { item } }; }

test("raw completed commands and file changes classify without rendered timeline assumptions", () => {
  assert.deepEqual(classifyTimelineEvent(row({ type: "commandExecution", id: "cmd", command: "gh pr create" }), 500), { kind: "command", itemId: "cmd", at: 150, command: "gh pr create" });
  assert.deepEqual(classifyTimelineEvent(row({ type: "fileChange", id: "write", changes: [{ path: "src/a.ts", kind: "update", diff: "diff" }] }), 500), { kind: "file-change", itemId: "write", at: 150, paths: ["src/a.ts"] });
  for (const raw of [null, row({ type: "commandExecution", id: "missing-command" }), row({ type: "fileChange", id: "missing-paths" })]) {
    assert.equal(classifyTimelineEvent(raw, 500).kind, "unreadable");
  }
  assert.equal(classifyTimelineEvent(row({ type: "reasoning", id: "thought" }), 500).kind, "other");
});

const prCommands: [string, boolean][] = [
  ["gh pr create --title a", true],
  ["gh pr new --fill", true],
  ["origin pr create", true],
  ["cd app && gh pr create", true],
  ["pwd; origin pr create", true],
  ["git push || gh pr create", true],
  ["(gh pr create --fill)", true],
  ["gh pr create --fill 2>&1 | tail -1", true],
  ["git push\ngh pr create", true],
  ['url=$(gh pr create --fill)', true],
  ['url="$(gh pr create --fill)"', true],
  ["cat > body.md <<'EOF'\ntext\nEOF\ngh pr create -F body.md", true],
  ['/bin/zsh -lc "gh pr create --repo o/r --base main --title \\"fix: a\\""', true],
  ["/bin/bash -lc 'gh pr create --fill'", true],
  ['bash -c "cd repo && gh pr create"', true],
  ["sh -lc 'gh pr new'", true],
  ["zsh -ic 'gh pr create'", true],
  ["bash -o pipefail -c 'gh pr create'", true],
  ['/bin/zsh -lc "bash -c \'gh pr create\'"', true],
  ['/bin/zsh -lc "cat > b.md <<\'EOF\'\ngh pr create\nEOF\ngh pr create -F b.md"', true],
  ["/bin/zsh -lc 'cat > b.md <<'\"'EOF'\nit'\"'\"'s\nEOF\ngh pr create -F b.md'", true],
  ["GH_TOKEN=x gh pr create", true],
  ['GH_TOKEN="a b" GH_HOST=h gh pr create', true],
  ["/opt/homebrew/bin/gh pr create", true],
  ["./bin/origin pr create", true],
  ["sudo gh pr create", true],
  ["sudo -u me gh pr create", true],
  ["time gh pr create", true],
  ["env GH_TOKEN=x gh pr create", true],
  ["env -i GH_TOKEN=x /usr/local/bin/gh pr create", true],
  ["nohup gh pr create &", true],
  ["echo body | xargs gh pr create --body", true],
  ["xargs -I {} gh pr create --head {}", true],
  ["command gh pr create", true],
  ["if gh pr create; then echo ok; fi", true],
  ["bb pstack gh pr create --title t", true],
  ['bash -lc "bb pstack gh pr create --body-file b.md"', true],
  ["bb pstack gh pr view", false],
  ["bb pstack gh pr create --help", false],
  ["gh pr view", false],
  ["gh pr list --search 'pr create'", false],
  ["gh pr create --help", false],
  ["gh pr create -h", false],
  ["echo 'gh pr create'", false],
  ['echo "gh pr create"', false],
  ['echo "a && gh pr create"', false],
  ["cat > body.md <<'EOF'\ngh pr create\nEOF", false],
  ["cat <<-EOF\n\tgh pr create\n\tEOF\necho done", false],
  ['/bin/zsh -lc "cat > b.md <<\'EOF\'\ngh pr create\nEOF"', false],
  ['git commit -m "gh pr create"', false],
  ["grep 'gh pr create' log.txt", false],
  ["grep -n 'gh pr\\|pr create' log.txt", false],
  ["rg 'gh pr create' src", false],
  ["echo done # gh pr create; gh pr create", false],
  ["bash script.sh gh pr create", false],
  ['/bin/zsh -lc "echo \\"gh pr create\\""', false],
  ["ghx pr create", false],
];

test("PR creation detects executed gh and origin commands through shell wrappers and prefixes but not quoted or heredoc text", () => {
  for (const [command, expected] of prCommands) assert.equal(createsPr(command), expected, command);
});

test("temporal violation rules use event time even when checklist and PR gates now exist", () => {
  const write = { kind: "file-change", itemId: "write", at: 150, paths: ["src/a.ts"] } as const;
  assert.equal(deriveViolation(context, { ...write, paths: [...write.paths] })?.key, "work-before-checklist:write");
  assert.equal(deriveViolation(context, { ...write, paths: [], at: 200 }), null);
  assert.equal(deriveViolation(context, { ...write, paths: [], at: 99 }), null);
  const command = { kind: "command", itemId: "cmd", at: 250, command: "origin pr create" } as const;
  assert.equal(deriveViolation(context, command)?.key, "pr-before-gate:cmd");
  assert.equal(deriveViolation({ ...context, prGateAt: null }, command)?.kind, "pr-before-gate");
  assert.equal(deriveViolation(context, { ...command, at: 300 }), null);
  assert.equal(deriveViolation(context, { ...command, command: "gh pr list" }), null);
});

test("unreadable page shapes produce a durable diagnostic rather than silently disappearing", () => {
  const result = auditPage({ rows: [] }, context, 500);
  assert.equal(result.cursor, null);
  assert.equal(result.violations[0].key, "audit-unreadable");
  const mixed = auditPage([row({ type: "fileChange", id: "write", changes: [] }), { seq: 2, createdAt: 160, type: "item/completed", data: {} }], context, 500);
  assert.equal(mixed.cursor, "2");
  assert.deepEqual(mixed.violations.map((violation) => violation.kind), ["work-before-checklist", "audit-unreadable"]);
});

test("unknown events and completed item types produce no violations", () => {
  const result = auditPage([
    { seq: 2, createdAt: 150, type: "future/event", data: {} },
    { ...row({ type: "future", id: "x" }), seq: 3 },
  ], context, 500);
  assert.equal(result.cursor, "3");
  assert.deepEqual(result.violations, []);
});

test("a completed command without command text produces an audit-unreadable violation", () => {
  const result = auditPage([row({ type: "commandExecution", id: "missing-command" })], context, 500);
  assert.deepEqual(result.violations.map((violation) => violation.kind), ["audit-unreadable"]);
});

test("provider messages and unknown provider payloads produce no violations", () => {
  for (const type of ["user", "system"]) {
    const raw = { seq: 2, createdAt: 150, type: "provider/unhandled", data: { rawType: `sdk/${type}`, rawEvent: { method: "sdk/message", params: { message: { type } } } } };
    assert.equal(classifyTimelineEvent(raw, 500).kind, "other");
    assert.deepEqual(auditPage([{ ...raw, data: { ...raw.data, rawType: "sdk/new-tool" } }], context, 500).violations, []);
  }
});
