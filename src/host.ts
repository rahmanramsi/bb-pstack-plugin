/**
 * pstack's host entry, run by the host daemon on the machine that holds an issue worker's worktree. One method, `push`.
 *
 * The worktree and its repository config belong to the worker. A plain `git push` inside it would honor the worker's
 * `url.<x>.insteadOf` (sending the token elsewhere), `http.proxy`, `credential.helper` and pre-push hooks. So the push
 * runs from a scratch bare repository whose config pstack controls, borrowing the worker's objects read-only through
 * `objects/info/alternates`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type PushInput, type PushResult } from "./host-contract.ts";

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

/** `<worktree>/.git` is a `gitdir:` file for a linked worktree or a directory; `commondir` points at the shared one. */
function resolveObjectsDir(worktreePath: string): string {
  const dotGit = join(worktreePath, ".git");
  const gitDir = statSync(dotGit).isDirectory()
    ? dotGit
    : resolve(worktreePath, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
  const commonFile = join(gitDir, "commondir");
  const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
  const objects = join(common, "objects");
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

async function push(input: PushInput, tempDir: string, signal: AbortSignal): Promise<PushResult> {
  const objects = resolveObjectsDir(input.worktreePath);
  const scratch = await mkdtemp(join(tempDir, "push-"));
  const redact = (text: string) => text.split(input.token).join("***").trim();
  try {
    const local = isolatedEnv(scratch, input.remoteUrl, null);
    const { GIT_DIR: _unused, ...initEnv } = local;
    const init = await git(["init", "--bare", "-q", scratch], initEnv, signal);
    if (init.code !== 0) return { status: "failed", detail: `git init: ${init.stderr.trim()}` };
    await writeFile(join(scratch, "objects", "info", "alternates"), `${objects}\n`);

    if ((await git(["cat-file", "-e", `${input.sha}^{commit}`], local, signal)).code !== 0) {
      return { status: "rejected", reason: "missing-commit", detail: `${input.sha} is not a commit in ${input.worktreePath}` };
    }
    if (input.expectedRemoteSha !== null) {
      const ancestor = await git(["merge-base", "--is-ancestor", input.expectedRemoteSha, input.sha], local, signal);
      if (ancestor.code !== 0) {
        return { status: "rejected", reason: "not-descendant", detail: `${input.sha} does not descend from the pushed ${input.expectedRemoteSha}` };
      }
    }

    const ref = `refs/heads/${input.branch}`;
    // Ancestry is checked above, so the lease never forces a rewrite. It makes the remote-state check atomic: an
    // empty expected value means the branch must not exist yet.
    const result = await git(
      ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:${input.expectedRemoteSha ?? ""}`, input.remoteUrl, `${input.sha}:${ref}`],
      isolatedEnv(scratch, input.remoteUrl, input.token),
      signal,
    );
    const output = redact(`${result.stdout}\n${result.stderr}`);
    if (result.code === 0) return { status: "pushed", sha: input.sha };
    if (/stale info|fetch first|non-fast-forward/.test(output)) return { status: "rejected", reason: "stale-remote", detail: output };
    if (/\b403\b|denied|not permitted|protected branch/i.test(output)) return { status: "rejected", reason: "denied", detail: output };
    return { status: "failed", detail: output };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    push: (input, ctx) => push(input, ctx.experimental_paths.tempDir, ctx.signal),
  },
});
