import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  AFTER_PR_LEADS, addStep, closeStep, extractSteps, gate, parseEvidence, parseReason,
  playbookSources, renderOpenSteps, shouldNudge, type Checklist, type Resolution,
} from "./checklist.ts";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));
const sources = playbookSources(skillsDir);

function checklist(name = "feature"): Checklist {
  const entry = [...sources].find(([key]) => key === name);
  assert.ok(entry);
  const steps = extractSteps(readFileSync(entry[1].file, "utf8"), entry[1].extractor, "playbook");
  const pr = [...sources].find(([key]) => key === "opening-a-pr");
  assert.ok(pr);
  steps.push(...extractSteps(readFileSync(pr[1].file, "utf8"), pr[1].extractor, "pr"));
  return {
    threadId: "thr_test", playbook: entry[0], revision: 0, nudgedAtRevision: null,
    steps: steps.map((step, index) => ({ ...step, id: index + 1, openedAt: 1, resolution: { kind: "open" } })),
  };
}

test("every real playbook and figure-it-out yields steps and every after-PR label still exists", () => {
  const files = readdirSync(`${skillsDir}/poteto-mode/playbooks`).filter((file) => file.endsWith(".md"));
  assert.equal(sources.size, files.length + 1);
  for (const [name, source] of sources) {
    const markdown = readFileSync(source.file, "utf8");
    const section = name === "opening-a-pr" ? "pr" : "playbook";
    const steps = extractSteps(markdown, source.extractor, section);
    assert.ok(steps.length > 0, `${name} must fail closed if its source changes shape`);
    for (const step of steps) assert.ok(markdown.includes(step.text), `${name} preserves source text`);
    if (name === "figure-it-out") {
      assert.equal(steps.length, 6);
      assert.match(steps[0].text, /^## Start\n/);
      assert.match(steps[5].text, /^## Phase E:/);
    }
    if (name === "opening-a-pr") {
      for (const label of AFTER_PR_LEADS) {
        assert.ok(markdown.includes(`**${label}.**`));
        assert.ok(steps.some((step) => step.text.startsWith(`**${label}.**`) && step.afterPr));
      }
    }
  }
});

test("numbered extraction folds sub-bullets verbatim and ignores fenced examples and reply prose", () => {
  const markdown = "# Steps\n\n```md\n1. Example\n```\n\n1. First.\n   - Nested.\n\n   More detail.\n2. Second.\n\n**Reply:** hand back.\n";
  assert.deepEqual(extractSteps(markdown, "numbered", "playbook"), [
    { section: "playbook", text: "1. First.\n   - Nested.\n\n   More detail.", skipPolicy: "agent", afterPr: false },
    { section: "playbook", text: "2. Second.", skipPolicy: "agent", afterPr: false },
  ]);
});

test("closing only feature step 4 cannot pass the PR gate", () => {
  let state = checklist();
  const done: Resolution = { kind: "done", evidence: [{ kind: "path", path: "src/checklist.ts" }] };
  const result = closeStep(state, 4, done);
  assert.equal(result.ok, false);
  const prGate = gate("pr", state);
  assert.ok(!prGate.pass);
  for (const id of [1, 2, 3]) assert.ok(prGate.open.some((step) => step.id === id));
  const prSteps = state.steps.filter((step) => step.section === "pr" && !step.afterPr);
  assert.ok(prSteps.length > 0);
  for (const step of prSteps) assert.ok(prGate.open.some((open) => open.id === step.id));
  assert.ok(prGate.open.every((step) => !step.afterPr));
  for (const step of prGate.open) {
    const next = closeStep(state, step.id, step.id % 2 || step.skipPolicy !== "agent" ? done : { kind: "skipped", reason: "Does not apply to this change." });
    assert.ok(next.ok);
    state = next.checklist;
  }
  assert.deepEqual(gate("pr", state), { pass: true });
  const doneGate = gate("done", state);
  assert.ok(!doneGate.pass);
  assert.ok(doneGate.open.every((step) => step.afterPr));
  for (const step of doneGate.open) {
    const next = closeStep(state, step.id, done);
    assert.ok(next.ok);
    state = next.checklist;
  }
  assert.deepEqual(gate("done", state), { pass: true });
  assert.equal(gate("pr", null).pass, false);
  assert.equal(gate("done", null).pass, false);
});

test("step resolutions are idempotent and conflicting resolutions cannot replace evidence", () => {
  const original = checklist();
  const resolution = { kind: "done", evidence: [{ kind: "commit", sha: "abcdef1" }] } satisfies Resolution;
  const first = closeStep(original, 1, resolution);
  assert.ok(first.ok && first.changed);
  assert.equal(first.checklist.revision, 1);
  assert.equal(original.steps[0].resolution.kind, "open");
  assert.deepEqual(closeStep(first.checklist, 1, structuredClone(resolution)), { ok: true, changed: false, checklist: first.checklist });
  assert.equal(closeStep(first.checklist, 1, { kind: "skipped", reason: "Other" }).ok, false);
  assert.equal(closeStep(original, 999, resolution).ok, false);
});

test("added steps preserve copied steps and keep stable ids when inserted", () => {
  const original = checklist();
  const added = addStep(original, "Check persistence", 2);
  assert.ok(added.ok);
  assert.equal(added.checklist.steps[2].text, "Check persistence");
  assert.equal(added.step.id, original.steps.length + 1);
  assert.deepEqual(added.checklist.steps.filter((step) => step.id !== added.step.id), original.steps);
  assert.equal(added.checklist.revision, 1);
  assert.equal(addStep(original, " ", null).ok, false);
  assert.equal(addStep(original, "Check", 999).ok, false);
});

test("evidence and skip reasons reject blank or malformed values", () => {
  const examples = ["thread:thr_worker", "run:psr_12345678-1234-1234-1234-123456789abc", "commit:abcdef1", "path:src/file.ts:12", "pr:https://github.com/get-bb/bb/pull/1"];
  for (const value of examples) assert.ok(!("error" in parseEvidence(value)), value);
  for (const value of ["", "path:", "thread:x", "run:x", "commit:nope", "pr:javascript:alert(1)", "other:x", "path:a\nb"]) {
    assert.ok("error" in parseEvidence(value), value);
  }
  assert.equal(parseReason("  Out of scope.  "), "Out of scope.");
  assert.equal(parseReason("x".repeat(500)), "x".repeat(500));
  assert.equal(typeof parseReason("x".repeat(501)), "object");
  assert.equal(typeof parseReason("  "), "object");
});

test("nudges happen once per revision and rendering respects every bound", () => {
  const state = checklist();
  assert.equal(shouldNudge(state, { activeRuns: 0, activeChildren: 0 }), true);
  assert.equal(shouldNudge(state, { activeRuns: 1, activeChildren: 0 }), false);
  assert.equal(shouldNudge(state, { activeRuns: 0, activeChildren: 1 }), false);
  assert.equal(shouldNudge({ ...state, nudgedAtRevision: state.revision }, { activeRuns: 0, activeChildren: 0 }), false);
  for (const bound of [0, 1, 20, 500, 1500, 10000]) assert.ok(renderOpenSteps(state, bound).length <= bound);
  assert.match(renderOpenSteps(state, 1500), /more open steps/);
  assert.equal(renderOpenSteps(null, 1500), "");
});

test("a playbook step that runs Opening a PR is an after-PR step, so gate pr does not demand it", () => {
  const sources = playbookSources(skillsDir);
  let found = 0;
  for (const [name, source] of sources) {
    if (source.extractor !== "numbered") continue;
    for (const step of extractSteps(readFileSync(source.file, "utf8"), source.extractor, "playbook")) {
      if (/Run \*\*Opening a PR\*\*/.test(step.text)) {
        found += 1;
        assert.equal(step.afterPr, true, `${name}: ${step.text.slice(0, 60)}`);
      }
    }
  }
  assert.ok(found >= 5);
  const feature = extractSteps(readFileSync(sources.get("feature" as never)!.file, "utf8"), "numbered", "playbook");
  assert.deepEqual(feature.filter((step) => step.afterPr).map((step) => step.text.slice(0, 2)), ["8."]);
});

test("a truncated open-steps block always ends with the full remainder notice", () => {
  const steps = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1, openedAt: 1, section: "playbook" as const, skipPolicy: "agent" as const, afterPr: false, resolution: { kind: "open" as const },
    text: `Step ${index + 1} ${"x".repeat(index * 7)}`,
  }));
  const checklist = { threadId: "thr_x", playbook: "feature" as never, steps, revision: 0, nudgedAtRevision: null };
  for (let max = 120; max <= 4000; max += 37) {
    const text = renderOpenSteps(checklist, max);
    assert.ok(text.length <= max, `length at ${max}`);
    const shown = text.split("\n").filter((line) => /^\d+\. \[/.test(line)).length;
    if (shown < steps.length) assert.match(text, new RegExp(`\\n${steps.length - shown} more open steps\\. Run bb pstack checklist show\\.$`), `notice at ${max}`);
  }
});

test("skip policy markers are parsed once and hidden from checklist text", () => {
  const state = checklist();
  assert.deepEqual(state.steps.slice(0, 4).map((step) => step.skipPolicy), ["user", "user", "agent", "never"]);
  assert.equal(state.steps.some((step) => step.text.includes("pstack: skip=")), false);
  assert.throws(() => extractSteps("1. Work <!-- pstack: skip=maybe -->", "numbered", "playbook"), /Unknown pstack skip policy/);
});

test("ordered closure rejects agent waivers and never-skippable steps but leaves PR steps unordered", () => {
  let state = checklist();
  const skip = { kind: "skipped", reason: "Already implemented." } as const;
  const first = closeStep(state, 1, skip);
  assert.ok(!first.ok);
  assert.match(first.error, /user must send \/poteto-mode waive 1/);
  for (const id of [1, 2]) {
    const result = closeStep(state, id, skip, "user");
    assert.ok(result.ok);
    state = result.checklist;
  }
  const third = closeStep(state, 3, skip);
  assert.ok(third.ok);
  state = third.checklist;
  const fourth = closeStep(state, 4, skip, "user");
  assert.ok(!fourth.ok);
  assert.match(fourth.error, /cannot be skipped.*done 4 --evidence/);
  const pr = state.steps.find((step) => step.section === "pr");
  assert.ok(pr);
  assert.equal(closeStep(state, pr.id, skip).ok, true);
});
