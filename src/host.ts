/**
 * pstack's host entry, run by the host daemon on the machine that holds a thread's worktree: `push` for issue workers,
 * and `pushBranch`, `inspect` and `fetch` for `bb pstack gh`.
 *
 * The worktree and its repository config belong to the worker. A plain `git push` inside it would honor the worker's
 * `url.<x>.insteadOf` (sending the token elsewhere), `http.proxy`, `credential.helper` and pre-push hooks. So the push
 * runs from a scratch bare repository whose config pstack controls, borrowing the worker's objects read-only through
 * `objects/info/alternates`. A fetch runs there too; its packs are then copied into the worktree's object store and its
 * refs written with hooks off.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type FetchInput, type FetchResult, type PushInput, type PushResult, type InspectCommitInput, type InspectCommitResult } from "./host-contract.ts";

type Run = { code: number; stdout: string; stderr: string };

function git(args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, { env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

function gitWithInput(args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, input: string): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, { env, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** `<worktree>/.git` is a `gitdir:` file for a linked worktree or a directory; `commondir` points at the shared one. */
function resolveCommonDir(worktreePath: string): string {
  const dotGit = join(worktreePath, ".git");
  const gitDir = statSync(dotGit).isDirectory()
    ? dotGit
    : resolve(worktreePath, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
  const commonFile = join(gitDir, "commondir");
  return existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
}

function resolveObjectsDir(worktreePath: string): string {
  const objects = join(resolveCommonDir(worktreePath), "objects");
  if (!statSync(objects).isDirectory()) throw new Error(`${worktreePath} has no git object store`);
  return objects;
}

const INHERITED = ["PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

/**
 * The git child's whole environment. Nothing comes from the worker. The token exists only here, as an extra header
 * scoped to the remote URL, so it is never in argv, a URL, a file, or the worker's environment.
 */
function isolatedEnv(scratch: string, remoteUrl: string, token: string | null): NodeJS.ProcessEnv {
  const config: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ...(token ? [[`http.${remoteUrl}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] as [string, string]] : []),
  ];
  const env: NodeJS.ProcessEnv = {
    HOME: scratch,
    GIT_DIR: scratch,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: new URL(remoteUrl).protocol.slice(0, -1),
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const name of INHERITED) if (process.env[name] !== undefined) env[name] = process.env[name];
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** The lease or a fast-forward check failed: the remote branch is not where the push expected it. */
const STALE = /^\[rejected\] \((stale info|fetch first|non-fast-forward)\)$/;

/** The `--porcelain` line for `ref`: its flag (`!` when rejected) and summary, such as `[remote rejected] (reason)`. */
function refStatus(stdout: string, ref: string): { flag: string; summary: string } | null {
  for (const line of stdout.split("\n")) {
    const [flag, refs, summary] = line.split("\t");
    if (flag !== undefined && summary !== undefined && refs?.endsWith(`:${ref}`)) return { flag, summary: summary.trim() };
  }
  return null;
}

/** A bare repository in `tempDir` that reads the worktree's objects through alternates. Removed after `use`. */
async function withScratch<T>(worktreePath: string, tempDir: string, signal: AbortSignal, use: (scratch: string) => Promise<T>, failed: (detail: string) => T): Promise<T> {
  const objects = resolveObjectsDir(worktreePath);
  const scratch = await mkdtemp(join(tempDir, "git-"));
  try {
    const { GIT_DIR: _unused, ...initEnv } = isolatedEnv(scratch, "file:///", null);
    const init = await git(["init", "--bare", "-q", scratch], initEnv, signal);
    if (init.code !== 0) return failed(`git init: ${init.stderr.trim()}`);
    await writeFile(join(scratch, "objects", "info", "alternates"), `${objects}\n`);
    return await use(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function inspectObjects(input: InspectCommitInput, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<InspectCommitResult> {
  for (const sha of [input.sha, input.comparisonSha, ...input.publishedSha ? [input.publishedSha] : [], ...input.ancestorShas ?? []]) {
    if ((await git(["cat-file", "-e", `${sha}^{commit}`], env, signal)).code !== 0) return { kind: "missing-object", sha };
  }
  const common = await git(["merge-base", input.comparisonSha, input.sha], env, signal);
  if (common.code !== 0) throw new Error("cannot establish a merge base for pinned Git objects");
  const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", common.stdout.trim(), input.sha], env, signal);
  const history = await git(["log", "--no-ext-diff", "--no-textconv", "--format=", "--name-only", "--no-renames", "--diff-merges=remerge", "-z", input.sha, "--not", input.comparisonSha, ...input.publishedSha ? [input.publishedSha] : []], env, signal);
  if (diff.code !== 0 || history.code !== 0) throw new Error("cannot inspect pinned Git objects");
  let workflows = history.stdout.split("\0").some((path) => path.trim().startsWith(".github/workflows/"));
  if (!workflows) {
    // Remerge omits octopus commits. Reconstruct each unpublished merge, including ones later reverted.
    const octopus = await git(["rev-list", "--min-parents=3", "--parents", input.sha, "--not", input.comparisonSha, ...input.publishedSha ? [input.publishedSha] : []], env, signal);
    if (octopus.code !== 0) throw new Error("cannot inspect multi-parent contribution history");
    for (const line of octopus.stdout.trim().split("\n").filter(Boolean)) {
      const [commit, first, ...parents] = line.split(" ");
      let merged = first!;
      let tree = "";
      for (const parent of parents) {
        // Octopus has no rename detection. Upstream additions retain their original paths.
        const merge = await git(["-c", "merge.renames=false", "merge-tree", "--write-tree", "--no-messages", "--allow-unrelated-histories", merged, parent], env, signal);
        if (merge.code !== 0 && merge.code !== 1) throw new Error("cannot reconstruct multi-parent merge");
        tree = merge.stdout.split("\n")[0]!;
        const synthetic = await git(["-c", "user.name=pstack", "-c", "user.email=pstack@localhost", "commit-tree", tree, "-p", merged, "-p", parent, "-m", "Reconstruct merge tree"], env, signal);
        if (synthetic.code !== 0) throw new Error("cannot record reconstructed merge parents");
        merged = synthetic.stdout.trim();
      }
      const authored = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", tree, commit!, "--", ".github/workflows/"], env, signal);
      if (authored.code !== 0) throw new Error("cannot inspect multi-parent workflow contribution");
      if (authored.stdout.length > 0) { workflows = true; break; }
    }
  }
  if (input.publishedSha) {
    const ancestor = await git(["merge-base", "--is-ancestor", input.publishedSha, input.sha], env, signal);
    if (ancestor.code !== 0 && ancestor.code !== 1) throw new Error("cannot inspect pinned publication ancestry");
    if (ancestor.code === 1) {
      const oldBase = await git(["merge-base", input.comparisonSha, input.publishedSha], env, signal);
      if (oldBase.code !== 0) throw new Error("cannot establish the published contribution base");
      const oldContribution = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", oldBase.stdout.trim(), input.publishedSha, "--", ".github/workflows/"], env, signal);
      const replaced = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", input.publishedSha, input.sha, "--", ".github/workflows/"], env, signal);
      if (oldContribution.code !== 0 || replaced.code !== 0) throw new Error("cannot inspect replaced workflow contribution");
      const contributed = new Set(oldContribution.stdout.split("\0").filter(Boolean));
      workflows ||= replaced.stdout.split("\0").some((path) => contributed.has(path));
    }
  }
  const ancestry = [];
  for (const sha of input.ancestorShas ?? []) {
    const result = await git(["merge-base", "--is-ancestor", sha, input.sha], env, signal);
    if (result.code !== 0 && result.code !== 1) throw new Error("cannot inspect pinned Git ancestry");
    ancestry.push({ sha, included: result.code === 0 });
  }
  return { kind: "inspected", sha: input.sha, comparisonSha: input.comparisonSha, nonemptyDiff: diff.stdout.length > 0, workflows, ...(input.ancestorShas ? { ancestry } : {}) };
}

async function inspectCommit(input: InspectCommitInput, tempDir: string, signal: AbortSignal): Promise<InspectCommitResult> {
  return withScratch(input.worktreePath, tempDir, signal,
    (scratch) => inspectObjects(input, isolatedEnv(scratch, "file:///", null), signal),
    (detail) => { throw new Error(detail); });
}

async function push(input: PushInput & { rewrite?: boolean | undefined }, tempDir: string, signal: AbortSignal): Promise<PushResult> {
  const redact = (text: string) => text.split(input.token).join("***").trim();
  return withScratch(input.worktreePath, tempDir, signal, async (scratch): Promise<PushResult> => {
    const local = isolatedEnv(scratch, input.remoteUrl, null);

    if ((await git(["cat-file", "-e", `${input.sha}^{commit}`], local, signal)).code !== 0) {
      return { status: "rejected", reason: "missing-commit", detail: `${input.sha} is not a commit in ${input.worktreePath}` };
    }
    if (input.expectedRemoteSha !== null && !input.rewrite) {
      const ancestor = await git(["merge-base", "--is-ancestor", input.expectedRemoteSha, input.sha], local, signal);
      if (ancestor.code !== 0) {
        return { status: "rejected", reason: "not-descendant", detail: `${input.sha} does not descend from the pushed ${input.expectedRemoteSha}` };
      }
    }

    const classified = await inspectObjects({ worktreePath: input.worktreePath, sha: input.sha, comparisonSha: input.comparisonSha, publishedSha: input.expectedRemoteSha }, local, signal);
    if (classified.kind === "missing-object") return { status: "rejected", reason: "missing-commit", detail: `missing comparison object ${classified.sha}` };
    if (classified.workflows !== input.workflows) return { status: "rejected", reason: "denied", detail: "workflow classification changed" };
    const ref = `refs/heads/${input.branch}`;
    // Ancestry is checked above unless a rewrite was asked for, so the lease forces nothing else. It makes the
    // remote-state check atomic: an empty expected value means the branch must not exist yet.
    const result = await git(
      ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:${input.expectedRemoteSha ?? ""}`, input.remoteUrl, `${input.sha}:${ref}`],
      isolatedEnv(scratch, input.remoteUrl, input.token),
      signal,
    );
    if (result.code === 0) return { status: "pushed", sha: input.sha };
    const status = refStatus(result.stdout, ref);
    if (status?.flag === "!") {
      const remote = result.stderr.split("\n").filter((line) => line.startsWith("remote:"));
      const reason = STALE.test(status.summary) ? "stale-remote" : "remote-rejected";
      return { status: "rejected", reason, detail: redact([status.summary, ...remote].join("\n")) };
    }
    const output = redact(`${result.stdout}\n${result.stderr}`);
    if (!status && /\b403\b|denied|not permitted/i.test(output)) return { status: "rejected", reason: "denied", detail: output };
    return { status: "failed", detail: output };
  }, (detail) => ({ status: "failed", detail }));
}

/** `remote.origin.url` from the repository's config file alone. */
async function inspect(worktreePath: string, signal: AbortSignal): Promise<{ originUrl: string | null }> {
  const config = join(resolveCommonDir(worktreePath), "config");
  const env = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const result = await git(["config", "--file", config, "--get", "remote.origin.url"], env, signal);
  return { originUrl: result.code === 0 ? result.stdout.trim() || null : null };
}

/**
 * Fetches every branch into the scratch repository, copies the new packs into the worktree's object store, then points
 * `refs/remotes/origin/<branch>` at the fetched commits. Packs are copied before any ref moves, so a ref never names a
 * missing object. Branches deleted on the remote keep their old remote-tracking ref.
 */
async function fetchRefs(input: FetchInput, tempDir: string, signal: AbortSignal): Promise<FetchResult> {
  const redact = (text: string) => text.split(input.token).join("***").trim();
  const common = resolveCommonDir(input.worktreePath);
  return withScratch(input.worktreePath, tempDir, signal, async (scratch): Promise<FetchResult> => {
    const env = isolatedEnv(scratch, input.remoteUrl, input.token);
    const fetched = await git(["-c", "fetch.unpackLimit=1", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", input.remoteUrl, "+refs/heads/*:refs/heads/*"], env, signal);
    if (fetched.code !== 0) return { status: "failed", detail: redact(`${fetched.stdout}\n${fetched.stderr}`) };
    const listed = await git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"], env, signal);
    if (listed.code !== 0) return { status: "failed", detail: listed.stderr.trim() };
    const refs = listed.stdout.split("\n").filter(Boolean).map((line) => {
      const [sha, ref] = line.split(" ");
      return { branch: ref!.slice("refs/heads/".length), sha: sha! };
    });

    const packs = join(scratch, "objects", "pack");
    for (const name of await readdir(packs)) {
      if (/^pack-[0-9a-f]+\.(pack|idx|rev)$/.test(name)) await copyFile(join(packs, name), join(common, "objects", "pack", name));
    }
    const target = isolatedEnv(scratch, input.remoteUrl, null);
    target.GIT_DIR = common;
    const update = await gitWithInput(["update-ref", "--stdin"], target, signal, refs.map(({ branch, sha }) => `update refs/remotes/origin/${branch} ${sha}\n`).join(""));
    if (update.code !== 0) return { status: "failed", detail: update.stderr.trim() };
    return { status: "fetched", refs };
  }, (detail) => ({ status: "failed", detail }));
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspectCommit: (input, ctx) => inspectCommit(input, ctx.experimental_paths.tempDir, ctx.signal),
    push: (input, ctx) => push(input, ctx.experimental_paths.tempDir, ctx.signal),
    pushBranch: (input, ctx) => push(input, ctx.experimental_paths.tempDir, ctx.signal),
    inspect: (input, ctx) => inspect(input.worktreePath, ctx.signal),
    fetch: (input, ctx) => fetchRefs(input, ctx.experimental_paths.tempDir, ctx.signal),
  },
});
