/**
 * The contract of pstack's host entry (src/host.ts), shared with the server that calls it. The host RPC API is
 * experimental; this file and src/host.ts are the only places that know it.
 *
 * The caller names a commit and a branch, never a refspec. The host builds `<sha>:refs/heads/<branch>` itself, and the
 * branch must match AGENT_BRANCH, so no payload can push to another ref.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const SHA = /^[0-9a-f]{40}$/;
export const AGENT_BRANCH = /^agent\/issue-\d+-[a-z0-9-]+$/;
const Sha = z.string().regex(SHA);

export const PushInput = z.strictObject({
  /** The worktree as environments.get reports it. The host reads its .git pointer files and never runs git inside it. */
  worktreePath: z.string().refine(isAbsolute, "must be absolute"),
  /** The server always sends https. file: lets host.test.ts push to a local bare repository. */
  remoteUrl: z.string().regex(/^(https:\/\/[^\s@]+|file:\/\/\/\S+)$/, "must be an https: or file: URL without credentials"),
  branch: z.string().regex(AGENT_BRANCH),
  /** The commit the accepted report named. A commit made after the report is not pushed. */
  sha: Sha,
  /** The remote branch must be at this commit, or absent when null, and `sha` must descend from it. */
  expectedRemoteSha: Sha.nullable(),
  /** A one-repository, contents-only installation token. It lives only in the git child's environment. */
  token: z.string().min(1),
});

export const PushResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pushed"), sha: Sha }),
  /** Decided before the push or by the remote; retrying cannot help. */
  z.strictObject({
    status: z.literal("rejected"),
    reason: z.enum(["missing-commit", "not-descendant", "stale-remote", "denied"]),
    detail: z.string(),
  }),
  /** Network, timeout, remote 5xx. The server probes the branch head before retrying. */
  z.strictObject({ status: z.literal("failed"), detail: z.string() }),
]);

export const hostContract = defineRpcContract({
  push: { input: PushInput, output: PushResult },
});

export type PushInput = z.infer<typeof PushInput>;
export type PushResult = z.infer<typeof PushResult>;
/** The server-side port. server.ts builds it from bb.hosts.experimental_client; tests pass a fake or the host harness. */
export type HostPush = (hostId: string, input: PushInput, signal?: AbortSignal) => Promise<PushResult>;

/** A real `git push` of a large first commit needs more than the 30 s default. */
export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;
