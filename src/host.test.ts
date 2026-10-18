import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "./host.ts";

const TOKEN = "ghs_PLANTED_SECRET_TOKEN";
const BRANCH = "agent/issue-41-submit-button";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", `edit ${file}`);
  return sh(cwd, "rev-parse", "HEAD");
}

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && readFileSync(path).includes(needle));
}

/**
 * A main checkout with a linked worktree (as bb's managed worktrees are), a bare remote reached over file://, and a
 * worker that planted a url rewrite to another remote, a hooks path with a pre-push hook that dumps its environment,
 * and a credential helper that logs what it is given.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pstack-host-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const evil = join(root, "evil.git");
  const main = join(root, "main");
  const worktree = join(root, "worktree");
  const temp = join(root, "temp");
  const loot = join(root, "loot");
  for (const dir of [main, temp, loot]) mkdirSync(dir);
  sh(root, "init", "--bare", "-q", remote);
  sh(root, "init", "--bare", "-q", evil);
  sh(main, "init", "-q", "-b", "main");
  commit(main, "README.md", "hello\n");
  sh(main, "worktree", "add", "-q", "-b", "bb/thread-branch", worktree);

  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nenv > ${join(loot, "pre-push-env")}\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  sh(worktree, "config", "core.hooksPath", hooks);
  sh(worktree, "config", `url.file://${evil}.insteadOf`, `file://${remote}`);
  sh(worktree, "config", "credential.helper", `!f() { cat >> ${join(loot, "credential")}; env >> ${join(loot, "credential")}; }; f`);

  const harness = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir: join(root, "data"), tempDir: temp } });
  const baseSha = sh(worktree, "rev-parse", "HEAD");
  const push = (sha: string, expectedRemoteSha: string | null, branch = BRANCH, comparisonSha = baseSha) =>
    harness.experimental_call("push", { worktreePath: worktree, remoteUrl: `file://${remote}`, branch, sha, expectedRemoteSha, comparisonSha, workflows: false, token: TOKEN });
  const remoteHead = () => {
    try {
      return sh(root, "--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`);
    } catch {
      return null;
    }
  };
  return { root, main, remote, evil, worktree, temp, loot, push, remoteHead, harness, baseSha };
}

test("push sends the reported commit from a scratch repository the worktree's config and hooks never touch", async () => {
  const f = fixture();
  const first = commit(f.worktree, "a.txt", "one\n");
  assert.deepEqual(await f.push(first, null), { status: "pushed", sha: first });
  assert.equal(f.remoteHead(), first);

  assert.equal(sh(f.root, "--git-dir", f.evil, "for-each-ref").trim(), "", "the planted insteadOf did not redirect the push");
  assert.deepEqual(readdirSync(f.loot), [], "the planted pre-push hook and credential helper never ran");
  assert.deepEqual(filesContaining(f.root, TOKEN), [], "the token was written nowhere");
  assert.deepEqual(readdirSync(f.temp), [], "the scratch repository is removed");

  const later = commit(f.worktree, "b.txt", "two\n");
  commit(f.worktree, "c.txt", "not reported yet\n");
  assert.deepEqual(await f.push(later, first), { status: "pushed", sha: later });
  assert.equal(f.remoteHead(), later, "the reported commit is pushed, not HEAD");
  await f.harness.experimental_dispose();
});

test("push never rewrites the remote branch", async () => {
  const f = fixture();
  const first = commit(f.worktree, "a.txt", "one\n");
  assert.equal((await f.push(first, null)).status, "pushed");

  sh(f.worktree, "checkout", "-q", "--detach", "HEAD~1");
  const sibling = commit(f.worktree, "z.txt", "rewrite\n");
  assert.deepEqual(await f.push(sibling, first), {
    status: "rejected",
    reason: "not-descendant",
    detail: `${sibling} does not descend from the pushed ${first}`,
  });

  const second = commit(f.worktree, "y.txt", "on top\n");
  const stale = await f.push(second, null);
  assert.equal(stale.status === "rejected" && stale.reason, "stale-remote", "a branch that already exists is not overwritten when none was expected");
  assert.equal(f.remoteHead(), first);

  const missing = await f.push("f".repeat(40), null);
  assert.equal(missing.status === "rejected" && missing.reason, "missing-commit");
  await f.harness.experimental_dispose();
});

test("the contract admits only agent branches and full commit ids", async () => {
  const f = fixture();
  const sha = commit(f.worktree, "a.txt", "one\n");
  await assert.rejects(f.push(sha, null, "main"));
  await assert.rejects(f.push("HEAD", null));
  assert.equal(f.remoteHead(), null);
  assert.equal(existsSync(join(f.loot, "pre-push-env")), false);
  await f.harness.experimental_dispose();
});

test("a push the remote refuses is rejected with the remote's reason, not retried as a failure", async () => {
  const f = fixture();
  const hook = join(f.remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'GH013: Repository rule violations found for refs/heads/agent' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const sha = commit(f.worktree, "a.txt", "one\n");
  const result = await f.push(sha, null);
  assert.equal(result.status, "rejected");
  assert.equal(result.status === "rejected" && result.reason, "remote-rejected");
  assert.match(result.status === "rejected" ? result.detail : "", /pre-receive hook declined[\s\S]*GH013: Repository rule violations/);
  assert.equal(f.remoteHead(), null);
  await f.harness.experimental_dispose();
});

test("pushBranch pushes any plain branch name and still never rewrites it", async () => {
  const f = fixture();
  const call = (sha: string, expectedRemoteSha: string | null, branch: string) =>
    f.harness.experimental_call("pushBranch", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch, sha, expectedRemoteSha, comparisonSha: f.baseSha, workflows: false, token: TOKEN });
  const first = commit(f.worktree, "a.txt", "one\n");
  assert.deepEqual(await call(first, null, "feat/thing"), { status: "pushed", sha: first });
  assert.equal(sh(f.root, "--git-dir", f.remote, "rev-parse", "refs/heads/feat/thing"), first);
  assert.deepEqual(readdirSync(f.loot), [], "the planted pre-push hook and credential helper never ran");
  assert.deepEqual(filesContaining(f.root, TOKEN), []);

  const stale = await call(commit(f.worktree, "b.txt", "two\n"), null, "feat/thing");
  assert.equal(stale.status === "rejected" && stale.reason, "stale-remote");

  sh(f.worktree, "checkout", "-q", "--detach", "HEAD~2");
  const rebased = commit(f.worktree, "r.txt", "rebased\n");
  const diverged = await call(rebased, first, "feat/thing");
  assert.equal(diverged.status === "rejected" && diverged.reason, "not-descendant");
  const leased = (expected: string) => f.harness.experimental_call("pushBranch", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch: "feat/thing", sha: rebased, expectedRemoteSha: expected, comparisonSha: f.baseSha, workflows: false, token: TOKEN, rewrite: true });
  assert.equal(((await leased(f.baseSha)) as { reason?: string }).reason, "stale-remote", "a rewrite still needs the remote at the expected commit");
  assert.deepEqual(await leased(first), { status: "pushed", sha: rebased });
  assert.equal(sh(f.root, "--git-dir", f.remote, "rev-parse", "refs/heads/feat/thing"), rebased);
  for (const branch of ["-x", "a..b", "refs/heads/x/", "x.lock", "a b", "x@{1}"]) await assert.rejects(call(first, null, branch), branch);
  await f.harness.experimental_dispose();
});

test("inspect reads origin from the repository's own config", async () => {
  const f = fixture();
  assert.deepEqual(await f.harness.experimental_call("inspect", { worktreePath: f.worktree }), { originUrl: null });
  sh(f.worktree, "remote", "add", "origin", "https://github.com/acme/web.git");
  assert.deepEqual(await f.harness.experimental_call("inspect", { worktreePath: f.worktree }), { originUrl: "https://github.com/acme/web.git" });
  await f.harness.experimental_dispose();
});

test("fetch brings remote branches into origin/* without the worktree's config, hooks or credential helper", async () => {
  const f = fixture();
  const other = join(f.root, "other");
  sh(f.root, "clone", "-q", f.remote, other);
  const upstream = commit(other, "up.txt", "from upstream\n");
  sh(other, "push", "-q", "origin", "HEAD:refs/heads/feature");
  writeFileSync(join(f.root, "hooks", "reference-transaction"), `#!/bin/sh\necho ran > ${join(f.loot, "reference-transaction")}\n`);
  chmodSync(join(f.root, "hooks", "reference-transaction"), 0o755);

  const result = await f.harness.experimental_call("fetch", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, token: TOKEN });
  assert.deepEqual(result, { status: "fetched", refs: [{ branch: "feature", sha: upstream }] });
  assert.equal(sh(f.worktree, "rev-parse", "refs/remotes/origin/feature"), upstream);
  assert.equal(sh(f.worktree, "cat-file", "-t", upstream), "commit", "the fetched objects are in the worktree's store");
  assert.equal(sh(f.worktree, "cat-file", "-p", `${upstream}:up.txt`), "from upstream");
  assert.deepEqual(readdirSync(f.loot), [], "no hook or credential helper ran");
  assert.deepEqual(filesContaining(f.root, TOKEN), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});

test("commit inspection includes deleted and reverted workflow ancestors without reading worker commands", async () => {
  const f = fixture();
  const base = sh(f.worktree, "rev-parse", "HEAD");
  mkdirSync(join(f.worktree, ".github/workflows"), { recursive: true });
  const added = commit(f.worktree, ".github/workflows/check.yml", "name: check\n");
  sh(f.worktree, "rm", ".github/workflows/check.yml");
  sh(f.worktree, "commit", "-qm", "remove workflow");
  const head = commit(f.worktree, "a.txt", "change\n");
  assert.deepEqual(await f.harness.experimental_call("inspectCommit", { publishedSha: null, worktreePath: f.worktree, sha: head, comparisonSha: base }), {
    kind: "inspected", sha: head, comparisonSha: base, nonemptyDiff: true, workflows: true,
  });
  assert.deepEqual(await f.harness.experimental_call("inspectCommit", { publishedSha: null, worktreePath: f.worktree, sha: head, comparisonSha: added }), {
    kind: "inspected", sha: head, comparisonSha: added, nonemptyDiff: true, workflows: true,
  });
  assert.equal((await f.harness.experimental_call("push", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch: BRANCH, sha: head, expectedRemoteSha: null, comparisonSha: base, workflows: false, token: TOKEN })).status, "rejected");
  assert.equal(f.remoteHead(), null);
  assert.deepEqual(readdirSync(f.loot), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});

test("fixed object inspection proves ancestry including default-base ancestors and rejects missing objects", async () => {
  const f = fixture();
  const base = sh(f.worktree, "rev-parse", "HEAD");
  const head = commit(f.worktree, "a.txt", "main change\n");
  sh(f.worktree, "checkout", "-qb", "side", base);
  const side = commit(f.worktree, "side.txt", "side change\n");
  const input = { publishedSha: null, worktreePath: f.worktree, sha: head, comparisonSha: base, ancestorShas: [base, side, head] };
  const result = await f.harness.experimental_call("inspectCommit", input);
  assert.equal(result.kind, "inspected");
  if (result.kind === "inspected") assert.deepEqual(result.ancestry, [{ sha: base, included: true }, { sha: side, included: false }, { sha: head, included: true }]);
  const missing = "f".repeat(40);
  assert.deepEqual(await f.harness.experimental_call("inspectCommit", { ...input, ancestorShas: [missing] }), { kind: "missing-object", sha: missing });
  await assert.rejects(f.harness.experimental_call("inspectCommit", { ...input, ancestorShas: ["--help"] }));
  assert.deepEqual(readdirSync(f.loot), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});

test("base-only workflows and base-only changes do not count as unpublished worker changes", async () => {
  const f = fixture();
  const common = sh(f.worktree, "rev-parse", "HEAD");
  sh(f.worktree, "checkout", "-qb", "main-advance");
  mkdirSync(join(f.worktree, ".github/workflows"), { recursive: true });
  const base = commit(f.worktree, ".github/workflows/check.yml", "name: base check\n");
  sh(f.worktree, "checkout", "-qb", "worker", common);
  const head = commit(f.worktree, "a.txt", "worker change\n");
  const result = await f.harness.experimental_call("inspectCommit", { publishedSha: null, worktreePath: f.worktree, sha: head, comparisonSha: base });
  assert.equal(result.kind, "inspected");
  if (result.kind === "inspected") {
    assert.equal(result.workflows, false);
    assert.equal(result.nonemptyDiff, true);
  }
  const empty = await f.harness.experimental_call("inspectCommit", { publishedSha: null, worktreePath: f.worktree, sha: common, comparisonSha: base });
  assert.equal(empty.kind, "inspected");
  if (empty.kind === "inspected") assert.equal(empty.nonemptyDiff, false);
  const pushed = await f.harness.experimental_call("push", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch: BRANCH, sha: head, expectedRemoteSha: null, comparisonSha: base, workflows: false, token: TOKEN });
  assert.equal(pushed.status, "pushed");
  assert.equal(f.remoteHead(), head);
  assert.deepEqual(readdirSync(f.loot), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});

test("later publication merges upstream-only workflows without requiring workflow write", async () => {
  const f = fixture();
  const published = commit(f.worktree, "a.txt", "worker feature\n");
  assert.equal((await f.push(published, null)).status, "pushed");
  mkdirSync(join(f.main, ".github/workflows"), { recursive: true });
  const base = commit(f.main, ".github/workflows/check.yml", "name: upstream check\n");
  sh(f.worktree, "merge", "--no-edit", base);
  const head = sh(f.worktree, "rev-parse", "HEAD");
  const inspected = await f.harness.experimental_call("inspectCommit", { publishedSha: published, worktreePath: f.worktree, sha: head, comparisonSha: base });
  assert.equal(inspected.kind, "inspected");
  if (inspected.kind === "inspected") assert.equal(inspected.workflows, false);
  await f.harness.experimental_dispose();
});

test("rebasing onto an upstream workflow update preserves contents-only classification", async () => {
  const f = fixture();
  mkdirSync(join(f.main, ".github/workflows"), { recursive: true });
  const oldBase = commit(f.main, ".github/workflows/check.yml", "name: original upstream check\n");
  sh(f.worktree, "reset", "--hard", oldBase);
  const published = commit(f.worktree, "a.txt", "worker feature\n");
  assert.equal((await f.push(published, null, BRANCH, oldBase)).status, "pushed");
  const base = commit(f.main, ".github/workflows/check.yml", "name: updated upstream check\n");
  sh(f.worktree, "rebase", "--onto", base, oldBase);
  const head = sh(f.worktree, "rev-parse", "HEAD");
  const inspected = await f.harness.experimental_call("inspectCommit", { worktreePath: f.worktree, sha: head, comparisonSha: base, publishedSha: published });
  assert.equal(inspected.kind, "inspected");
  if (inspected.kind === "inspected") assert.equal(inspected.workflows, false);
  const pushed = await f.harness.experimental_call("pushBranch", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch: BRANCH, sha: head, expectedRemoteSha: published, comparisonSha: base, workflows: false, token: TOKEN, rewrite: true });
  assert.equal(pushed.status, "pushed");
  assert.equal(f.remoteHead(), head);
  assert.deepEqual(readdirSync(f.loot), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});

test("published worker workflows require no repeated grant until they change, revert or are deleted", async () => {
  const f = fixture();
  mkdirSync(join(f.worktree, ".github/workflows"), { recursive: true });
  const published = commit(f.worktree, ".github/workflows/check.yml", "name: worker check\n");
  const scope = async (sha: string) => {
    const result = await f.harness.experimental_call("inspectCommit", { worktreePath: f.worktree, sha, comparisonSha: f.baseSha, publishedSha: published });
    assert.equal(result.kind, "inspected");
    return result.kind === "inspected" && result.workflows;
  };
  const feature = commit(f.worktree, "a.txt", "worker feature\n");
  assert.equal(await scope(feature), false);
  const changed = commit(f.worktree, ".github/workflows/check.yml", "name: changed worker check\n");
  assert.equal(await scope(changed), true);
  const reverted = commit(f.worktree, ".github/workflows/check.yml", "name: worker check\n");
  assert.equal(await scope(reverted), true, "net-zero unpublished workflow edits still need scope");
  sh(f.worktree, "rm", ".github/workflows/check.yml"); sh(f.worktree, "commit", "-qm", "remove worker workflow");
  assert.equal(await scope(sh(f.worktree, "rev-parse", "HEAD")), true);
  assert.equal(await scope(f.baseSha), true, "rewinding away published workflow work still changes the remote workflow");
  await f.harness.experimental_dispose();
});

test("workflow conflict resolutions are inspected while clean upstream merges are excluded", async () => {
  const f = fixture();
  mkdirSync(join(f.main, ".github/workflows"), { recursive: true });
  const common = commit(f.main, ".github/workflows/check.yml", "name: original\n");
  sh(f.worktree, "reset", "--hard", common);
  const published = commit(f.worktree, ".github/workflows/check.yml", "name: worker\n");
  const base = commit(f.main, ".github/workflows/check.yml", "name: upstream\n");
  assert.throws(() => sh(f.worktree, "merge", "--no-edit", base));
  const head = commit(f.worktree, ".github/workflows/check.yml", "name: combined\n");
  const result = await f.harness.experimental_call("inspectCommit", { worktreePath: f.worktree, sha: head, comparisonSha: base, publishedSha: published });
  assert.equal(result.kind, "inspected");
  if (result.kind === "inspected") assert.equal(result.workflows, true);
  const refused = await f.harness.experimental_call("push", { worktreePath: f.worktree, remoteUrl: `file://${f.remote}`, branch: BRANCH, sha: head, expectedRemoteSha: published, comparisonSha: base, workflows: false, token: TOKEN });
  assert.equal(refused.status, "rejected");
  assert.deepEqual(readdirSync(f.loot), []);
  assert.deepEqual(readdirSync(f.temp), []);
  await f.harness.experimental_dispose();
});
