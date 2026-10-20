/**
 * The contract of pstack's host entry (src/host.ts), shared with the server that calls it. The host RPC API is
 * experimental; this file and src/host.ts are the only places that know it.
 *
 * The caller names a commit and a branch, never a refspec. The host builds `<sha>:refs/heads/<branch>` itself. `push`
 * takes only an AGENT_BRANCH; `pushBranch`, for `bb pstack gh push`, takes any BRANCH, and the server refuses the
 * repository's default branch before calling it.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AGENT_BRANCH } from "./agent-branch.ts";

export const SHA = /^[0-9a-f]{40}$/;
export { AGENT_BRANCH };
/** A plain branch name: no leading dash or dot, no `..`, `@{`, `//`, trailing `/`, `.lock` or `.`. */
export const BRANCH = /^(?![-./])(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock$|[./]$))[A-Za-z0-9._\/-]{1,200}$/;
const Sha = z.string().regex(SHA);
const WorktreePath = z.string().refine(isAbsolute, "must be absolute");
const RemoteUrl = z.string().regex(/^(https:\/\/[^\s@]+|file:\/\/\/\S+)$/, "must be an https: or file: URL without credentials");

export const PushInput = z.strictObject({
  /** The worktree as environments.get reports it. The host reads its .git pointer files and never runs git inside it. */
  worktreePath: WorktreePath,
  /** The server always sends https. file: lets host.test.ts push to a local bare repository. */
  remoteUrl: RemoteUrl,
  branch: z.string().regex(AGENT_BRANCH),
  /** The commit the accepted report named. A commit made after the report is not pushed. */
  sha: Sha,
  /** The remote branch must be at this commit, or absent when null, and `sha` must descend from it. */
  expectedRemoteSha: Sha.nullable(),
  comparisonSha: Sha,
  workflows: z.boolean(),
  /** A one-repository token with contents write and already-granted workflows write when required. It lives only in the git child's environment. */
  token: z.string().min(1),
});

export const PushResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pushed"), sha: Sha }),
  /**
   * Decided before the push or by the remote; retrying cannot help. `stale-remote`: the branch is not at the expected
   * commit. `remote-rejected`: the remote refused the ref, such as a rule, a hook or a workflow file the token may not
   * write; `detail` carries its reason. `denied`: the transport refused the token.
   */
  z.strictObject({
    status: z.literal("rejected"),
    reason: z.enum(["missing-commit", "not-descendant", "stale-remote", "remote-rejected", "denied"]),
    detail: z.string(),
  }),
  /** No ref was refused: network, timeout, remote 5xx. The server probes the branch head before retrying. */
  z.strictObject({ status: z.literal("failed"), detail: z.string() }),
]);

export const PushBranchInput = PushInput.extend({
  branch: z.string().regex(BRANCH),
  /** Skip the descendant check, so a rebased branch can replace `expectedRemoteSha`. The lease still pins it. */
  rewrite: z.boolean().optional(),
});

export const InspectInput = z.strictObject({ worktreePath: WorktreePath });
/** `remote.origin.url` as the repository's own config file holds it, without global rewrites. */
export const InspectResult = z.strictObject({ originUrl: z.string().nullable() });

export const FetchInput = z.strictObject({
  worktreePath: WorktreePath,
  remoteUrl: RemoteUrl,
  /** A one-repository, contents-read installation token. It lives only in the git child's environment. */
  token: z.string().min(1),
});
/** `refs/remotes/origin/<branch>` updated to each listed commit. */
export const FetchResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("fetched"), refs: z.array(z.strictObject({ branch: z.string(), sha: Sha })) }),
  z.strictObject({ status: z.literal("failed"), detail: z.string() }),
]);

export const InspectCommitInput = z.strictObject({ worktreePath: WorktreePath, sha: Sha, comparisonSha: Sha, publishedSha: Sha.nullable(), ancestorShas: z.array(Sha).optional() });
export const InspectCommitResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inspected"), sha: Sha, comparisonSha: Sha, nonemptyDiff: z.boolean(), workflows: z.boolean(), ancestry: z.array(z.strictObject({ sha: Sha, included: z.boolean() })).optional() }),
  z.strictObject({ kind: z.literal("missing-object"), sha: Sha }),
]);
export type InspectCommitInput = z.infer<typeof InspectCommitInput>;
export type InspectCommitResult = z.infer<typeof InspectCommitResult>;
export type HostInspectCommit = (hostId: string, input: InspectCommitInput, signal?: AbortSignal) => Promise<InspectCommitResult>;

export const hostContract = defineRpcContract({
  inspectCommit: { input: InspectCommitInput, output: InspectCommitResult },
  push: { input: PushInput, output: PushResult },
  pushBranch: { input: PushBranchInput, output: PushResult },
  inspect: { input: InspectInput, output: InspectResult },
  fetch: { input: FetchInput, output: FetchResult },
});

export type PushInput = z.infer<typeof PushInput>;
export type PushResult = z.infer<typeof PushResult>;
export type PushBranchInput = z.infer<typeof PushBranchInput>;
export type FetchInput = z.infer<typeof FetchInput>;
export type FetchResult = z.infer<typeof FetchResult>;
/** The server-side port. server.ts builds it from bb.hosts.experimental_client; tests pass a fake or the host harness. */
export type HostPush = (hostId: string, input: PushInput, signal?: AbortSignal) => Promise<PushResult>;

/** The ports `bb pstack gh` uses. server.ts builds them from bb.hosts.experimental_client. */
export type HostGit = {
  inspectCommit: HostInspectCommit;
  pushBranch(hostId: string, input: PushBranchInput): Promise<PushResult>;
  inspect(hostId: string, worktreePath: string): Promise<string | null>;
  fetch(hostId: string, input: FetchInput): Promise<FetchResult>;
};

/** A real `git push` of a large first commit needs more than the 30 s default. */
export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;
