import assert from "node:assert/strict";
import { test } from "node:test";
import { RunPlan } from "./contract.ts";
import { parseChoice, type ModelChoice } from "./models.ts";
import {
  acceptResult,
  classifyFailure,
  compile,
  deriveStatus,
  localPath,
  pinOf,
  plan,
  toView,
  type Action,
  type JobDraft,
  type JobSnapshot,
  type Origin,
  type RunId,
  type RunSnapshot,
} from "./runner.ts";

const ORIGIN: Origin = {
  threadId: "thr_origin",
  projectId: "prj_1",
  environmentId: "env_1",
  hostId: "host_home",
  pin: null,
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "high",
  permissionMode: "auto",
};

const ROLES: Record<string, string[]> = {
  "interrogate reviewers": ["claude-code/claude-opus-5-5/high", "codex/gpt-6.1-sol/high"],
  "arena cross-judge pool": ["claude-code/claude-opus-5-5/high", "codex/gpt-6.1-sol/high"],
  "swarm workers": ["codex/gpt-6.1-sol/high"],
  "judgment and prose": ["inherit-parent"],
};

function resolveRole(role: string): ModelChoice[] {
  return (ROLES[role] ?? []).map((value) => parseChoice(value)!);
}

function compiled(input: unknown): JobDraft[] {
  const result = compile(RunPlan.parse(input), resolveRole, ORIGIN);
  if (!result.ok) throw new Error(result.error);
  return result.jobs;
}

const NOW = 1_000_000;

function run(jobs: JobDraft[], states: Record<string, Partial<JobSnapshot>> = {}, deadline = NOW + 60_000): RunSnapshot {
  return {
    id: "psr_00000000-0000-0000-0000-000000000000" as RunId,
    status: "running",
    deadline,
    jobs: jobs.map((job) => ({
      ...job,
      state: job.after.length > 0 ? "blocked" : "queued",
      attempts: [],
      providerRetries: 0,
      repairs: 0,
      nextActionAt: null,
      value: null,
      error: null,
      ...states[job.key],
    })),
  };
}

const attached = (threadId: string) => ({ ordinal: 1, state: "attached" as const, threadId, issuedAt: NOW - 10, finishedAt: null, host: null });
const finished = (ordinal: number) => ({ ordinal, state: "finished" as const, threadId: `thr_${ordinal}`, issuedAt: NOW - 10, finishedAt: NOW - 5, host: null });
const review = (...titles: string[]) => ({
  findings: titles.map((title) => ({ severity: "warning" as const, title, location: "src/a.ts:1", detail: "detail" })),
});

const PANEL = {
  kind: "panel",
  title: "Review",
  seats: [{ label: "Reviewer {letter}", model: { role: "interrogate reviewers" }, prompt: "Review it.", result: "review" }],
  judge: { model: { role: "arena cross-judge pool" }, prompt: "Group the findings.", result: "grouping" },
};

const PANEL3 = {
  ...PANEL,
  seats: [
    { label: "Reviewer {letter}", model: { role: "interrogate reviewers" }, prompt: "Review it.", result: "review" },
    { label: "Prose {n}", model: { tuple: "inherit-parent" }, prompt: "Review it.", result: "review" },
  ],
};

const SWARM = {
  kind: "swarm",
  title: "check.sh per package",
  brief: "Run the package's check.sh.",
  slices: ["packages/api", "packages/cli"],
  verify: { prompt: "Re-run the evidence yourself." },
};

const types = (actions: Action[]) => actions.map((action) => `${action.type}:${"job" in action ? action.job : action.status}`);

test("compile expands a role into one templated seat per configured model", () => {
  const jobs = compiled(PANEL3);
  assert.deepEqual(
    jobs.map((job) => [job.key, job.label, `${job.model.provider}/${job.model.model}`]),
    [
      ["seat-1", "Reviewer A", "claude-code/claude-opus-5-5"],
      ["seat-2", "Reviewer B", "codex/gpt-6.1-sol"],
      ["seat-3", "Prose 3", "claude-code/claude-opus-5-5"],
      ["judge", "Judge", "codex/gpt-6.1-sol"],
    ],
  );
  assert.deepEqual(jobs.at(-1)!.after, ["seat-1", "seat-2", "seat-3"]);
  assert.equal(jobs.at(-1)!.quorum, 1);
});

test("compile picks the judge from the pool by a provider other than the origin's, else the first", () => {
  const judge = (providerId: string) => compile(RunPlan.parse(PANEL), resolveRole, { ...ORIGIN, providerId });
  const pick = (result: ReturnType<typeof judge>) => (result.ok ? result.jobs.at(-1)!.model.provider : result.error);
  assert.equal(pick(judge("claude-code")), "codex");
  assert.equal(pick(judge("codex")), "claude-code");
  assert.equal(pick(judge("pi")), "claude-code");
});

test("compile resolves inherit-parent to the origin's tuple", () => {
  const [seat] = compiled({ ...PANEL, judge: undefined, seats: [{ label: "Solo", model: { role: "judgment and prose" }, prompt: "p" }] });
  assert.deepEqual(seat!.model, { kind: "tuple", provider: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
});

test("compile rejects unknown roles, bad tuples, repeated labels, and an unreachable quorum", () => {
  const error = (input: unknown) => {
    const result = compile(RunPlan.parse(input), resolveRole, ORIGIN);
    return result.ok ? null : result.error;
  };
  assert.match(error({ ...PANEL, seats: [{ label: "R", model: { role: "nope" }, prompt: "p" }] })!, /unknown role "nope"/);
  assert.match(error({ ...PANEL, seats: [{ label: "R", model: { tuple: "codex" }, prompt: "p" }] })!, /not "provider\/model\/level"/);
  assert.match(error({ ...PANEL, seats: [{ label: "R", model: { role: "interrogate reviewers" }, prompt: "p" }] })!, /repeats/);
  assert.match(error({ ...PANEL, failure: { kind: "quorum", minimum: 3 } })!, /quorum 3/);
  assert.match(error({ ...SWARM, slices: ["a", "a"] })!, /slice "a" repeats/);
});

test("compile gives every slice a verifier that waits on that slice only and keeps its slice name", () => {
  const jobs = compiled(SWARM);
  assert.deepEqual(
    jobs.map((job) => [job.key, job.kind, job.slice, job.after.join(","), job.result]),
    [
      ["slice-1", "slice", "packages/api", "", "report"],
      ["verify-1", "verifier", "packages/api", "slice-1", "verdict"],
      ["slice-2", "slice", "packages/cli", "", "report"],
      ["verify-2", "verifier", "packages/cli", "slice-2", "verdict"],
    ],
  );
  assert.match(jobs[0]!.prompt, /check\.sh[\s\S]*Your slice: packages\/api/);
});

test("compile gives every job the reads its plan declares, defaulting to origin", () => {
  const panel = compiled({ ...PANEL, seats: [{ ...PANEL.seats[0], reads: "commit" }], judge: { ...PANEL.judge, reads: "prompt" } });
  assert.deepEqual(panel.map((job) => job.reads), ["commit", "commit", "prompt"]);
  assert.deepEqual(compiled(PANEL).map((job) => job.reads), ["origin", "origin", "origin"]);
  const swarm = compiled({ ...SWARM, reads: "commit", slices: ["a", { name: "b", reads: "origin" }], verify: { prompt: "Re-run.", reads: "prompt" } });
  assert.deepEqual(swarm.map((job) => [job.key, job.reads]), [["slice-1", "commit"], ["verify-1", "prompt"], ["slice-2", "origin"], ["verify-2", "prompt"]]);
});

test("compile rejects a job that may leave this machine when its prompt names a local path", () => {
  const error = (input: unknown) => {
    const result = compile(RunPlan.parse(input), resolveRole, ORIGIN);
    return result.ok ? null : result.error;
  };
  const seat = (reads: string) => ({ ...PANEL, judge: undefined, seats: [{ label: "R", model: { tuple: "codex/gpt-6.1-sol/high" }, prompt: "Your brief is at /Users/me/brief.md.", reads }] });
  assert.match(error(seat("commit"))!, /R reads "commit", but its prompt names \/Users\/me\/brief\.md/);
  assert.match(error(seat("prompt"))!, /\/Users\/me\/brief\.md/);
  assert.equal(error(seat("origin")), null);
  assert.match(error({ ...SWARM, reads: "commit", brief: "Read $BB_THREAD_STORAGE/brief.md." })!, /\$BB_THREAD_STORAGE\/brief\.md/);
});

test("localPath finds home, temp, and thread-storage paths but not repo paths or URLs", () => {
  for (const [text, path] of [
    ["see /Users/me/x.md", "/Users/me/x.md"],
    ["`/tmp/arena-1/candidate-2/`", "/tmp/arena-1/candidate-2/"],
    ["(/home/bb/notes.txt)", "/home/bb/notes.txt"],
    ["read ~/notes.md", "~/notes.md"],
    ["at ${BB_THREAD_STORAGE}/brief.md", "${BB_THREAD_STORAGE}/brief.md"],
  ] as const) assert.equal(localPath(text), path);
  for (const text of ["src/runner.ts:120", "https://example.com/home/x", "the /api/v1 route", "a and/or b"]) assert.equal(localPath(text), null);
});

test("pinOf pins only a clean branch whose HEAD is already on origin", () => {
  const status = (checkout: unknown, state = "clean", baseRef: string | null = "abc") => ({
    outcome: "available",
    workspace: { checkout, workingTree: { state }, mergeBase: { mergeBaseBranch: "origin/feature", baseRef } },
  }) as unknown as Parameters<typeof pinOf>[0];
  const branch = { kind: "branch", branchName: "feature", headSha: "abc" };
  assert.deepEqual(pinOf(status(branch)), { branch: "feature", sha: "abc" });
  assert.equal(pinOf(status(branch, "dirty_uncommitted")), null);
  assert.equal(pinOf(status(branch, "untracked")), null);
  assert.equal(pinOf(status(branch, "clean", null)), null, "origin/feature does not exist");
  assert.equal(pinOf(status(branch, "clean", "older")), null, "HEAD is ahead of origin/feature");
  assert.equal(pinOf(status({ kind: "detached", headSha: "abc" })), null);
  assert.equal(pinOf(status({ ...branch, branchName: "other" })), null, "the merge base is for another branch");
});

type PlanCase = { name: string; snapshot: RunSnapshot; now?: number; expect: string[]; check?: (actions: Action[]) => void };

const seatsDone = (value: unknown, failed: string[] = [], error = "the model refused") =>
  Object.fromEntries(
    ["seat-1", "seat-2", "seat-3"].map((key) => [
      key,
      failed.includes(key)
        ? { state: "failed" as const, error, attempts: [finished(1)] }
        : { state: "succeeded" as const, value, attempts: [finished(1)] },
    ]),
  );

const PLAN_CASES: PlanCase[] = [
  {
    name: "a fresh panel spawns every seat and holds the judge",
    snapshot: run(compiled(PANEL3)),
    expect: ["spawn:seat-1", "spawn:seat-2", "spawn:seat-3"],
    check: (actions) => assert.ok(actions.every((action) => action.type !== "spawn" || action.ordinal === 1)),
  },
  {
    name: "panel quorum met releases the judge with every outcome, failures named, findings tagged",
    snapshot: run(compiled({ ...PANEL3, failure: { kind: "quorum", minimum: 2 } }), seatsDone(review("Leak", "Race"), ["seat-2"])),
    expect: ["release:judge"],
    check: ([release]) => {
      assert.equal(release!.type, "release");
      const prompt = (release as Extract<Action, { type: "release" }>).prompt;
      assert.match(prompt, /^Group the findings\./);
      assert.match(prompt, /2 of 3 inputs succeeded\. Did not succeed: Reviewer B\./);
      assert.match(prompt, /### Reviewer B \(codex\/gpt-6\.1-sol\/high\): failed\nthe model refused/);
      assert.match(prompt, /- A\.1 \[warning\] Leak/);
      assert.match(prompt, /- C\.2 \[warning\] Race/);
    },
  },
  {
    name: "panel quorum missed skips the judge",
    snapshot: run(compiled({ ...PANEL3, failure: { kind: "quorum", minimum: 2 } }), seatsDone(review("Leak"), ["seat-1", "seat-2"])),
    expect: ["skip:judge"],
  },
  {
    name: "all-required skips the judge when one seat failed",
    snapshot: run(compiled({ ...PANEL3, failure: { kind: "all-required" } }), seatsDone(review("Leak"), ["seat-3"])),
    expect: ["skip:judge"],
  },
  {
    name: "the judge waits while a seat is still running",
    snapshot: run(compiled(PANEL3), { ...seatsDone(review()), "seat-3": { state: "running", attempts: [attached("thr_3")] } }),
    expect: [],
  },
  {
    name: "a swarm verifier is released when its own slice finishes, with no barrier",
    snapshot: run(compiled(SWARM), {
      "slice-1": { state: "succeeded", value: { slice: "packages/api", status: "PASS", summary: "ok", evidence: [], issues: [] }, attempts: [finished(1)] },
      "slice-2": { state: "running", attempts: [attached("thr_2")] },
    }),
    expect: ["release:verify-1"],
    check: ([release]) => assert.match((release as Extract<Action, { type: "release" }>).prompt, /"status": "PASS"/),
  },
  {
    name: "a failed slice skips its verifier",
    snapshot: run(compiled(SWARM), {
      "slice-1": { state: "failed", error: "check.sh not found", attempts: [finished(1)] },
      "slice-2": { state: "running", attempts: [attached("thr_2")] },
    }),
    expect: ["skip:verify-1"],
  },
  {
    name: "spawns stop at the concurrency limit of 8 and verifiers go before unstarted slices",
    snapshot: (() => {
      const slices = Array.from({ length: 10 }, (_, index) => `p${index + 1}`);
      const states: Record<string, Partial<JobSnapshot>> = {};
      for (let index = 2; index <= 8; index++) states[`slice-${index}`] = { state: "running", attempts: [attached(`thr_${index}`)] };
      states["slice-1"] = { state: "succeeded", attempts: [finished(1)] };
      states["verify-1"] = { state: "queued" };
      return run(compiled({ ...SWARM, slices }), states);
    })(),
    expect: ["spawn:verify-1"],
  },
  {
    name: "a round that releases a verifier holds spawns so the verifier takes the next free slot",
    snapshot: (() => {
      const slices = Array.from({ length: 10 }, (_, index) => `p${index + 1}`);
      const states: Record<string, Partial<JobSnapshot>> = {};
      for (let index = 2; index <= 8; index++) states[`slice-${index}`] = { state: "running", attempts: [attached(`thr_${index}`)] };
      states["slice-1"] = { state: "succeeded", attempts: [finished(1)] };
      return run(compiled({ ...SWARM, slices }), states);
    })(),
    expect: ["release:verify-1"],
  },
  {
    name: "a transient provider failure retries after 1 s",
    snapshot: run(compiled(SWARM), { "slice-1": { state: "failed", error: "Provider overloaded (HTTP 529)", attempts: [finished(1)] }, "slice-2": { state: "running", attempts: [attached("thr_2")] } }),
    expect: ["retry:slice-1"],
    check: ([retry]) => assert.equal((retry as Extract<Action, { type: "retry" }>).at, NOW + 1_000),
  },
  {
    name: "the second transient failure retries after 4 s",
    snapshot: run(compiled(SWARM), { "slice-1": { state: "failed", providerRetries: 1, error: "429 Too Many Requests", attempts: [finished(1), finished(2)] }, "slice-2": { state: "running", attempts: [attached("thr_2")] } }),
    expect: ["retry:slice-1"],
    check: ([retry]) => assert.equal((retry as Extract<Action, { type: "retry" }>).at, NOW + 4_000),
  },
  {
    name: "a third transient failure is final and the verifier is skipped",
    snapshot: run(compiled(SWARM), { "slice-1": { state: "failed", providerRetries: 2, error: "socket hang up", attempts: [finished(1), finished(2), finished(3)] }, "slice-2": { state: "running", attempts: [attached("thr_2")] } }),
    expect: ["skip:verify-1"],
  },
  {
    name: "a queued retry waits for its backoff, then spawns the next ordinal",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "queued", providerRetries: 1, nextActionAt: NOW + 1, attempts: [finished(1)] } }),
    expect: [],
  },
  {
    name: "a due retry spawns the next ordinal",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "queued", providerRetries: 1, nextActionAt: NOW, attempts: [finished(1)] } }),
    expect: ["spawn:slice-1"],
    check: ([spawn]) => assert.equal((spawn as Extract<Action, { type: "spawn" }>).ordinal, 2),
  },
  {
    name: "an invalid result within the repair budget gets a corrective turn",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "repairing", repairs: 1, error: "status: invalid", attempts: [attached("thr_1")] } }),
    expect: ["repair:slice-1"],
    check: ([repair]) => assert.match((repair as Extract<Action, { type: "repair" }>).message, /status: invalid[\s\S]*pstack_result[\s\S]*2 of 2/),
  },
  {
    name: "an invalid result past the repair budget fails the job",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "repairing", repairs: 2, error: "status: invalid", attempts: [attached("thr_1")] } }),
    expect: ["fail:slice-1"],
  },
  {
    name: "past the deadline every open job fails and nothing spawns",
    snapshot: run(compiled(SWARM), { "slice-1": { state: "running", attempts: [attached("thr_1")] }, "slice-2": { state: "uncertain", attempts: [{ ordinal: 1, state: "issued", threadId: null, issuedAt: NOW, finishedAt: null, host: null }] } }, NOW),
    expect: ["fail:slice-1", "fail:verify-1", "fail:slice-2", "fail:verify-2"],
  },
  {
    name: "restart: an issued attempt with no thread never spawns again",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "running", attempts: [{ ordinal: 1, state: "issued", threadId: null, issuedAt: NOW, finishedAt: null, host: null }] } }),
    expect: [],
  },
  {
    name: "restart: an uncertain job never spawns again before the deadline",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "uncertain", attempts: [{ ordinal: 1, state: "issued", threadId: null, issuedAt: NOW, finishedAt: null, host: null }] } }),
    expect: [],
  },
  {
    name: "restart: an attached attempt is left to the engine's poll",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "running", attempts: [attached("thr_1")] } }),
    expect: [],
  },
  {
    name: "restart: a running job that never claimed its attempt spawns it",
    snapshot: run(compiled({ ...SWARM, verify: undefined, slices: ["a"] }), { "slice-1": { state: "running", providerRetries: 1, attempts: [finished(1)] } }),
    expect: ["spawn:slice-1"],
    check: ([spawn]) => assert.equal((spawn as Extract<Action, { type: "spawn" }>).ordinal, 2),
  },
  {
    name: "every job settled finishes the run with the derived status",
    snapshot: run(compiled(SWARM), {
      "slice-1": { state: "succeeded" },
      "verify-1": { state: "succeeded" },
      "slice-2": { state: "failed", error: "check.sh not found" },
      "verify-2": { state: "skipped", error: "0 of 1 inputs succeeded; 1 required" },
    }),
    expect: ["finish:partial"],
  },
];

for (const { name, snapshot, now, expect, check } of PLAN_CASES) {
  test(`plan: ${name}`, () => {
    const actions = plan(snapshot, now ?? NOW);
    assert.deepEqual(types(actions), expect);
    check?.(actions);
  });
}

test("plan does nothing for a finished run", () => {
  assert.deepEqual(plan({ ...run(compiled(SWARM)), status: "cancelled" }, NOW), []);
});

test("deriveStatus", () => {
  const jobs = (...states: JobSnapshot["state"][]) => run(compiled({ ...SWARM, verify: undefined, slices: states.map((_, i) => `s${i}`) }), Object.fromEntries(states.map((state, i) => [`slice-${i + 1}`, { state }]))).jobs;
  assert.equal(deriveStatus(jobs("succeeded", "succeeded")), "succeeded");
  assert.equal(deriveStatus(jobs("succeeded", "skipped")), "partial");
  assert.equal(deriveStatus(jobs("failed", "skipped")), "failed");
  assert.equal(deriveStatus(jobs("succeeded", "running")), "running");
  assert.equal(deriveStatus(jobs("cancelled", "running")), "cancelled");
});

test("deriveStatus marks a swarm partial when a verifier rejects a report or a slice is blocked", () => {
  const snapshot = (values: Record<string, unknown>) =>
    run(compiled(SWARM), Object.fromEntries(compiled(SWARM).map((job) => [job.key, { state: "succeeded", value: values[job.key] ?? (job.kind === "verifier" ? { verdict: "VERIFIED" } : { status: "PASS" }) }]))).jobs;
  const verifierKey = compiled(SWARM).find((job) => job.kind === "verifier")!.key;
  const sliceKey = compiled(SWARM).find((job) => job.kind === "slice")!.key;
  assert.equal(deriveStatus(snapshot({})), "succeeded");
  assert.equal(deriveStatus(snapshot({ [verifierKey]: { verdict: "NOT_VERIFIED" } })), "partial");
  assert.equal(deriveStatus(snapshot({ [sliceKey]: { status: "BLOCKED" } })), "partial");
  assert.equal(deriveStatus(snapshot({ [sliceKey]: { status: "ISSUES" } })), "succeeded");
});

test("classifyFailure", () => {
  for (const error of ["Provider overloaded", "HTTP 503 from upstream", "rate limit exceeded", "read ECONNRESET", "socket hang up", "api error 529", "workspace mismatch: the worker's HEAD on box is abc", "workspace unverified: could not read the worker's HEAD"]) {
    assert.equal(classifyFailure(error), "transient", error);
  }
  for (const error of ["model not found", "permission denied", "the run deadline passed", "status 400"]) {
    assert.equal(classifyFailure(error), "permanent", error);
  }
});

test("acceptResult parses whole JSON, one fenced block, or a direct value", () => {
  const verdict = { slice: "a", verdict: "VERIFIED", notes: "re-ran it" };
  assert.deepEqual(acceptResult("verdict", JSON.stringify(verdict)), { ok: true, value: verdict });
  assert.deepEqual(acceptResult("verdict", `Done.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\nThanks.`), { ok: true, value: verdict });
  assert.deepEqual(acceptResult("verdict", verdict), { ok: true, value: verdict });
  assert.deepEqual(acceptResult("text", "plain words"), { ok: true, value: "plain words" });
});

test("acceptResult rejects prose, two fenced blocks, and values off the contract", () => {
  assert.equal(acceptResult("review", "Looks fine to me.").ok, false);
  assert.equal(acceptResult("review", "```json\n{}\n```\n```json\n{}\n```").ok, false);
  const wrong = acceptResult("verdict", { slice: "a", verdict: "MAYBE", notes: "" });
  assert.equal(wrong.ok, false);
  assert.match((wrong as { error: string }).error, /verdict/);
  assert.equal(acceptResult("review", { findings: [], extra: 1 }).ok, false);
});

const META = { kind: "panel" as const, title: "Review", createdAt: NOW - 100, finishedAt: NOW };

function panelWith(grouping: unknown): RunSnapshot {
  return run(compiled(PANEL3), {
    "seat-1": { state: "succeeded", value: review("Leak", "Race"), attempts: [finished(1)] },
    "seat-2": { state: "succeeded", value: review("Memory leak"), attempts: [finished(1)] },
    "seat-3": { state: "failed", error: "the model refused", attempts: [finished(1)] },
    judge: { state: "succeeded", value: grouping, attempts: [finished(1)] },
  });
}

test("toView tags findings with seat refs and derives the matrix from the judge's grouping", () => {
  const view = toView(
    panelWith({
      summary: "s",
      groups: [{ title: "Leak", severity: "critical", verdict: "act-on", members: ["A.1", "B.1"], rationale: "same leak" }],
    }),
    META,
  );
  assert.deepEqual(
    view.findings.map((finding) => [finding.ref, finding.seat, finding.title]),
    [
      ["A.1", "Reviewer A", "Leak"],
      ["A.2", "Reviewer A", "Race"],
      ["B.1", "Reviewer B", "Memory leak"],
    ],
  );
  assert.deepEqual(view.matrix, [
    { title: "Leak", severity: "critical", verdict: "act-on", cells: { "Reviewer A": "warning", "Reviewer B": "warning", "Prose 3": null } },
    { title: "Race", severity: "warning", verdict: null, cells: { "Reviewer A": "warning", "Reviewer B": null, "Prose 3": null } },
  ]);
  const seat3 = view.jobs.find((job) => job.key === "seat-3")!;
  assert.deepEqual([seat3.state, seat3.error, seat3.summary, seat3.finishedAt], ["failed", "the model refused", null, NOW - 5]);
  assert.equal(view.jobs[0]!.summary, "2 findings");
});

test("toView drops the matrix when a grouping names a missing ref or repeats one", () => {
  const group = (members: string[]) => ({ title: "g", severity: "nit", verdict: "noted", members, rationale: "" });
  assert.equal(toView(panelWith({ summary: "", groups: [group(["A.1", "C.1"])] }), META).matrix, null);
  assert.equal(toView(panelWith({ summary: "", groups: [group(["A.1"]), group(["A.1", "B.1"])] }), META).matrix, null);
});

test("toView keeps the slice name on both slice and verifier jobs", () => {
  const view = toView(run(compiled(SWARM)), { ...META, kind: "swarm" });
  assert.deepEqual(view.jobs.map((job) => job.slice), ["packages/api", "packages/api", "packages/cli", "packages/cli"]);
  assert.equal(view.matrix, null);
});
