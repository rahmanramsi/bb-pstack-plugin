import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { PushBranchInput, PushResult } from "../host-contract.ts";
import { GitHubPermanentError, type GitHub, type PullDetail, type RepoClient } from "../issues/github.ts";
import { ghCommands, repoFromRemote } from "./commands.ts";

const HEAD = "a".repeat(40);
const REMOTE = "b".repeat(40);
const MAIN = "c".repeat(40);
const PULL: PullDetail = { number: 7, url: "https://github.com/acme/web/pull/7", title: "feat: x", body: "Body", author: "pstack[bot]", state: "open", draft: true, head: "feat/x", headSha: HEAD, base: "main", headRepo: "acme/web" };

function harness(options: { branch?: string | null; origin?: string | null; remoteSha?: string | null; push?: PushResult; issueWorker?: boolean; configured?: boolean; gate?: string; ahead?: number; workflows?: boolean; missingObject?: boolean } = {}) {
  const calls: string[] = [];
  const pushes: PushBranchInput[] = [];
  const scopes: { workflows: boolean }[] = [];
  const inspections: { sha: string; comparisonSha: string; publishedSha: string | null }[] = [];
  const created: unknown[] = [];
  const comments: { issue: number; body: string }[] = [];
  const revoked: string[] = [];
  const closed: number[] = [];
  const deleted: string[] = [];
  const branch = options.branch === undefined ? "feat/x" : options.branch;
  const repo = {
    defaultBranch: async () => "main",
    capabilities: async () => ({ defaultHead: MAIN }),
    branchSha: async (name: string) => (name === "feat/x" ? (options.remoteSha === undefined ? REMOTE : options.remoteSha) : name === "main" ? MAIN : null),
    closePull: async (number: number) => void closed.push(number),
    deleteBranch: async (name: string) => void deleted.push(name),
    pushCredentials: async (input: { workflows: boolean }) => (scopes.push(input), { remoteUrl: "https://github.com/acme/web.git", token: "ghs_push" }),
    fetchCredentials: async () => ({ remoteUrl: "https://github.com/acme/web.git", token: "ghs_fetch" }),
    revoke: async (token: string) => void revoked.push(token),
    createPull: async (input: unknown) => (created.push(input), { number: 7, url: PULL.url }),
    pull: async (number: number) => (number === 7 ? PULL : null),
    pullForBranch: async (name: string) => (name === "feat/x" ? PULL : null),
    comment: async (issue: number, body: string) => (comments.push({ issue, body }), { id: 1 }),
    issueDetail: async () => null,
    feedback: async () => ({
      reviews: [{ id: 5, author: "ana", state: "CHANGES_REQUESTED", body: "See inline.", submittedAt: 0 }],
      inline: [
        { id: 11, author: "ana", path: "src/a.ts", line: 3, inReplyTo: null, body: "Rename this.", createdAt: 0 },
        { id: 12, author: "pstack[bot]", path: "src/a.ts", line: 3, inReplyTo: 11, body: "Done.", createdAt: 60_000 },
      ],
      conversation: [],
    }),
    checks: async () => [{ name: "test", status: "completed", conclusion: "success", url: null }],
  } as unknown as RepoClient;
  const github: GitHub = { repo: (name) => (calls.push(name), repo) };
  const bb = {
    sdk: {
      threads: { get: async () => ({ environmentId: "env_1" }) },
      environments: {
        get: async () => ({ hostId: "host_1", status: "ready", path: "/work/web" }),
        status: async () => ({
          outcome: "available",
          workspace: {
            checkout: branch === null ? { kind: "detached", headSha: HEAD } : { kind: "branch", branchName: branch, headSha: HEAD },
            workingTree: { hasUncommittedChanges: false, files: [] },
            mergeBase: options.ahead === undefined ? null : { aheadCount: options.ahead },
          },
        }),
      },
      files: { read: async ({ path }: { path: string }) => ({ content: `file ${path}`, contentEncoding: "utf8" }) },
    },
    log: { warn: () => {} },
  } as unknown as BbPluginApi;
  const commands = ghCommands({
    bb,
    github,
    configured: () => options.configured ?? true,
    isIssueWorker: () => options.issueWorker ?? false,
    prGate: () => (options.gate ? { pass: false, reason: options.gate } : { pass: true }),
    host: {
      inspect: async () => (options.origin === undefined ? "git@github.com:Acme/web.git" : options.origin),
      inspectCommit: async (_hostId, input) => {
        inspections.push(input);
        return options.missingObject ? { kind: "missing-object", sha: input.comparisonSha } : { kind: "inspected", ...input, nonemptyDiff: true, workflows: options.workflows ?? false };
      },
      pushBranch: async (_hostId, input) => (pushes.push(input), options.push ?? { status: "pushed", sha: input.sha }),
      fetch: async () => ({ status: "fetched", refs: [{ branch: "main", sha: REMOTE }] }),
    },
  });
  const cli = defineCli({ name: "pstack", summary: "pstack", commands });
  const run = (argv: string[]) => cli.run(argv, { threadId: "thr_1", cwd: "/work/web" });
  return { run, calls, pushes, created, comments, revoked, closed, deleted, scopes, inspections };
}

test("repoFromRemote reads github.com remotes in every form and nothing else", () => {
  for (const url of ["https://github.com/Acme/web.git", "https://github.com/acme/web", "git@github.com:acme/web.git", "ssh://git@github.com/acme/web.git", "https://x-access-token@github.com/acme/web.git"]) {
    assert.equal(repoFromRemote(url), "acme/web", url);
  }
  for (const url of ["https://gitlab.com/acme/web.git", "https://github.com.evil.com/acme/web", "file:///tmp/web.git", "https://github.com/acme"]) assert.equal(repoFromRemote(url), null, url);
});

test("gh push sends HEAD to the current branch, expecting the remote head, and revokes the token", async () => {
  const h = harness();
  const result = await h.run(["gh", "push"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `Pushed ${HEAD} to acme/web feat/x.\n`);
  assert.deepEqual(h.calls, ["acme/web"]);
  assert.deepEqual(h.pushes, [{ worktreePath: "/work/web", remoteUrl: "https://github.com/acme/web.git", branch: "feat/x", sha: HEAD, expectedRemoteSha: REMOTE, comparisonSha: MAIN, workflows: false, token: "ghs_push", rewrite: false }]);
  assert.deepEqual(h.revoked, ["ghs_push"]);
});

test("gh push refuses the default branch, detached heads and issue workers before minting a token", async () => {
  for (const [options, argv, code] of [
    [{}, ["gh", "push", "--branch", "main"], "default branch main"],
    [{ branch: null }, ["gh", "push"], "not on a branch"],
    [{ issueWorker: true }, ["gh", "push"], "issue worker cannot push"],
    [{ configured: false }, ["gh", "push"], "no GitHub App"],
    [{ origin: "https://gitlab.com/acme/web.git" }, ["gh", "push"], "is not a github.com repository"],
  ] as const) {
    const h = harness(options);
    const result = await h.run([...argv]);
    assert.notEqual(result.exitCode, 0, code);
    assert.match(result.stderr ?? "", new RegExp(code), code);
    assert.deepEqual(h.pushes, [], code);
    assert.deepEqual(h.revoked, [], code);
  }
});

test("gh push --force-with-lease asks the host to replace the branch it read", async () => {
  const h = harness();
  assert.equal((await h.run(["gh", "push", "--force-with-lease"])).exitCode, 0);
  assert.equal(h.pushes[0]?.rewrite, true);
  assert.equal(h.pushes[0]?.expectedRemoteSha, REMOTE);
});

test("a rejected push points at fetch and still revokes the token", async () => {
  const h = harness({ push: { status: "rejected", reason: "not-descendant", detail: "diverged" } });
  const result = await h.run(["gh", "push"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr ?? "", /push rejected \(not-descendant\): diverged[\s\S]*bb pstack gh fetch/);
  assert.deepEqual(h.revoked, ["ghs_push"]);
});

test("a new branch with no commits beyond the default branch is not pushed", async () => {
  const h = harness({ remoteSha: null, ahead: 0 });
  const result = await h.run(["gh", "push"]);
  assert.match(result.stderr ?? "", /has no commits that main lacks[\s\S]*Commit your work first/);
  assert.deepEqual(h.pushes, []);
  assert.equal((await harness({ remoteSha: null, ahead: 1 }).run(["gh", "push"])).exitCode, 0);
  assert.equal((await harness({ remoteSha: null }).run(["gh", "push"])).exitCode, 0, "without origin/main locally, only HEAD at main's tip is refused");
});

test("gh pr close closes the pull request and deletes only its own non-default head branch", async () => {
  const h = harness();
  const result = await h.run(["gh", "pr", "close", "--delete-branch", "--body", "Superseded."]);
  assert.equal(result.stdout, `Closed ${PULL.url}\nDeleted feat/x.\n`);
  assert.deepEqual(h.closed, [7]);
  assert.deepEqual(h.deleted, ["feat/x"]);
  assert.deepEqual(h.comments, [{ issue: 7, body: "Superseded." }]);
});

test("gh push of a branch already at HEAD does not push", async () => {
  const h = harness({ remoteSha: HEAD });
  assert.equal((await h.run(["gh", "push"])).stdout, `acme/web feat/x is already at ${HEAD}.\n`);
  assert.deepEqual(h.pushes, []);
});

test("gh pr create opens a ready pull request against the default branch with the body file", async () => {
  const h = harness();
  const result = await h.run(["gh", "pr", "create", "--title", "feat: x", "--body-file", "pr.md"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `Opened ${PULL.url}\n`);
  assert.deepEqual(h.created, [{ head: "feat/x", base: "main", title: "feat: x", body: "file /work/web/pr.md", draft: false }]);
});

test("gh pr create in poteto mode waits for gate pr", async () => {
  const h = harness({ gate: "2 open steps block the pr gate." });
  const result = await h.run(["gh", "pr", "create", "--title", "t"]);
  assert.match(result.stderr ?? "", /gate pr has not passed:\n2 open steps block the pr gate\./);
  assert.deepEqual(h.created, []);
});

test("gh pr create refuses a branch that is not pushed", async () => {
  const h = harness({ branch: "feat/unpushed" });
  const result = await h.run(["gh", "pr", "create", "--title", "t"]);
  assert.match(result.stderr ?? "", /feat\/unpushed is not on GitHub/);
  assert.deepEqual(h.created, []);
});

test("gh pr view, pr comment and checks find the pull request for the current branch", async () => {
  const h = harness();
  assert.match((await h.run(["gh", "pr", "view"])).stdout ?? "", /^#7 feat: x\n  state   draft\n  branch  feat\/x → main/);
  assert.equal((await h.run(["gh", "pr", "comment", "--body", "Done."])).exitCode, 0);
  assert.deepEqual(h.comments, [{ issue: 7, body: "Done." }]);
  assert.equal((await h.run(["gh", "checks", "7"])).stdout, `Checks on ${HEAD}:\n  success      test\n`);
  assert.match((await h.run(["gh", "pr", "view", "8"])).stderr ?? "", /no pull request #8/);
});

test("gh pr feedback groups inline replies under the thread id pr reply takes", async () => {
  const h = harness();
  assert.equal((await h.run(["gh", "pr", "feedback"])).stdout, [
    "#7 feat: x",
    "",
    "=== review 5 by @ana: CHANGES_REQUESTED, 1970-01-01 00:00",
    "See inline.",
    "",
    "=== thread 11 at src/a.ts:3",
    "--- @ana, 1970-01-01 00:00",
    "Rename this.",
    "--- @pstack[bot], 1970-01-01 00:01",
    "Done.",
    "",
  ].join("\n"));
});

test("GitHub's refusals become CLI errors with a hint", async () => {
  const repo = { comment: async () => { throw new GitHubPermanentError("POST /repos/acme/web/issues/3/comments: 403 Resource not accessible by integration", 403); } };
  const cli = defineCli({
    name: "pstack",
    summary: "pstack",
    commands: ghCommands({
      bb: { sdk: { threads: { get: async () => ({ environmentId: "e" }) }, environments: { get: async () => ({ hostId: "h", status: "ready", path: "/w" }), status: async () => ({ outcome: "available", workspace: { checkout: { kind: "branch", branchName: "x", headSha: HEAD }, workingTree: { hasUncommittedChanges: false } } }) } } } as unknown as BbPluginApi,
      github: { repo: () => repo as unknown as RepoClient },
      configured: () => true,
      isIssueWorker: () => false,
      prGate: () => ({ pass: true }),
      host: { inspect: async () => "https://github.com/acme/web.git", inspectCommit: async (_hostId, input) => ({ kind: "missing-object", sha: input.sha }), pushBranch: async () => ({ status: "failed", detail: "" }), fetch: async () => ({ status: "failed", detail: "" }) },
    }),
  });
  const result = await cli.run(["gh", "issue", "comment", "3", "--body", "hi"], { threadId: "thr_1" });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr ?? "", /403 Resource not accessible[\s\S]*lack a permission/);
});

test("gh push classifies pinned objects before requesting workflow scope and passes the same classification to the host", async () => {
  for (const remoteSha of [REMOTE, null]) {
    const h = harness({ remoteSha, workflows: true });
    assert.equal((await h.run(["gh", "push"])).exitCode, 0);
    assert.equal(h.inspections[0]?.sha, HEAD);
    assert.equal(h.inspections[0]?.comparisonSha, MAIN);
    assert.equal(h.inspections[0]?.publishedSha, remoteSha);
    assert.deepEqual(h.scopes, [{ workflows: true }]);
    assert.equal(h.pushes[0]?.comparisonSha, MAIN);
    assert.equal(h.pushes[0]?.workflows, true);
  }
});

test("gh push refuses missing comparison objects before requesting a token", async () => {
  const h = harness({ missingObject: true });
  assert.notEqual((await h.run(["gh", "push"])).exitCode, 0);
  assert.deepEqual(h.scopes, []);
  assert.deepEqual(h.pushes, []);
});
