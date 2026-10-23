/**
 * A fresh worktree based on `origin/<branch>` makes bb run `git fetch origin` with the machine's own git credentials,
 * which a machine pstack cloned a private repository onto does not have. remoteBase fetches through the pstack GitHub
 * App instead and names the full remote-tracking ref, which bb uses as it is, without fetching.
 */
import type { FetchInput, FetchResult } from "./host-contract.ts";
import { GitHubSetupError } from "./issues/github.ts";
import type { RepoName } from "./issues/job.ts";

export type RemoteBase = (input: {
  projectId: string;
  hostId: string;
  /** `origin/<branch>`, or null for the repository's default branch. Any other ref needs no fetch and is returned as is. */
  base: string | null;
}) => Promise<string | null>;

export interface RemoteBaseDeps {
  /** The project's checkout on a host and its GitHub repository, or null when it has none. */
  checkout(projectId: string, hostId: string): Promise<{ path: string; repo: RepoName } | null>;
  /** Null when the GitHub App is not configured. */
  repo(name: RepoName): {
    fetchCredentials(): Promise<{ remoteUrl: string; token: string }>;
    revoke(token: string): Promise<void>;
    defaultBranch(): Promise<string>;
  } | null;
  fetch(hostId: string, input: FetchInput): Promise<FetchResult>;
  warn(message: string): void;
}

/**
 * Returns `refs/remotes/origin/<branch>` after updating it on the host, or null when the App cannot reach the
 * repository, so the caller keeps the ref it had and bb fetches as before. Throws when the fetch itself fails.
 */
export function createRemoteBase(deps: RemoteBaseDeps): RemoteBase {
  return async ({ projectId, hostId, base }) => {
    if (base !== null && !base.startsWith("origin/")) return base;
    const checkout = await deps.checkout(projectId, hostId);
    const repo = checkout && deps.repo(checkout.repo);
    if (!checkout || !repo) return null;
    let credentials: { remoteUrl: string; token: string };
    try {
      credentials = await repo.fetchCredentials();
    } catch (error) {
      if (error instanceof GitHubSetupError) return null;
      throw error;
    }
    try {
      const branch = base === null ? await repo.defaultBranch() : base.slice("origin/".length);
      const result = await deps.fetch(hostId, { worktreePath: checkout.path, remoteUrl: credentials.remoteUrl, token: credentials.token });
      if (result.status === "failed") throw new Error(`fetching ${checkout.repo} on ${hostId}: ${result.detail}`);
      if (!result.refs.some((ref) => ref.branch === branch)) throw new Error(`${checkout.repo} has no branch ${branch}`);
      return `refs/remotes/origin/${branch}`;
    } finally {
      await repo.revoke(credentials.token).catch((error) => deps.warn(`could not revoke a fetch token: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
}
