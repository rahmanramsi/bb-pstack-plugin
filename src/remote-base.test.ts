import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchInput, FetchResult } from "./host-contract.ts";
import { GitHubSetupError } from "./issues/github.ts";
import type { RepoName } from "./issues/job.ts";
import { createRemoteBase, type RemoteBaseDeps } from "./remote-base.ts";

const REPO = "acme/web" as RepoName;
const SHA = "a".repeat(40);

function fake(options: { checkout?: boolean; app?: boolean; credentials?: () => Promise<{ remoteUrl: string; token: string }>; fetch?: FetchResult } = {}) {
  const fetches: { hostId: string; input: FetchInput }[] = [];
  const revoked: string[] = [];
  const deps: RemoteBaseDeps = {
    checkout: async () => (options.checkout ?? true) ? { path: "/bb/checkouts/web", repo: REPO } : null,
    repo: () => (options.app ?? true) ? {
      fetchCredentials: options.credentials ?? (async () => ({ remoteUrl: "https://github.com/acme/web.git", token: "ghs_x" })),
      revoke: async (token) => { revoked.push(token); },
      defaultBranch: async () => "production",
    } : null,
    fetch: async (hostId, input) => { fetches.push({ hostId, input }); return options.fetch ?? { status: "fetched", refs: [{ branch: "production", sha: SHA }, { branch: "dev", sha: SHA }] }; },
    warn() {},
  };
  return { remoteBase: createRemoteBase(deps), fetches, revoked };
}

test("the default branch and an origin branch are fetched through the App on the worker's machine and named in full", async () => {
  const f = fake();
  assert.equal(await f.remoteBase({ projectId: "p1", hostId: "host_box", base: null }), "refs/remotes/origin/production");
  assert.equal(await f.remoteBase({ projectId: "p1", hostId: "host_box", base: "origin/dev" }), "refs/remotes/origin/dev");
  assert.deepEqual(f.fetches.map(({ hostId, input }) => [hostId, input.worktreePath]), [["host_box", "/bb/checkouts/web"], ["host_box", "/bb/checkouts/web"]]);
  assert.deepEqual(f.revoked, ["ghs_x", "ghs_x"]);
});

test("a ref bb would not fetch is returned untouched without a fetch", async () => {
  const f = fake();
  assert.equal(await f.remoteBase({ projectId: "p1", hostId: "host_box", base: "feature/x" }), "feature/x");
  assert.deepEqual(f.fetches, []);
});

test("without a checkout, the App, or an installation on the repository, bb keeps fetching itself", async () => {
  const notInstalled = async () => { throw new GitHubSetupError("the GitHub App is not installed on acme/web"); };
  for (const options of [{ checkout: false }, { app: false }, { credentials: notInstalled }]) {
    const f = fake(options);
    assert.equal(await f.remoteBase({ projectId: "p1", hostId: "host_box", base: "origin/production" }), null);
    assert.deepEqual(f.fetches, []);
  }
});

test("a failed fetch or a missing branch throws, and the token is revoked either way", async () => {
  const failed = fake({ fetch: { status: "failed", detail: "network" } });
  await assert.rejects(failed.remoteBase({ projectId: "p1", hostId: "host_box", base: null }), /network/);
  assert.deepEqual(failed.revoked, ["ghs_x"]);
  const missing = fake();
  await assert.rejects(missing.remoteBase({ projectId: "p1", hostId: "host_box", base: "origin/gone" }), /has no branch gone/);
  assert.deepEqual(missing.revoked, ["ghs_x"]);
});
