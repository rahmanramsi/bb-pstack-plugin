/**
 * `bb pstack gh …`: GitHub for agent threads through pstack's GitHub App, so no token ever enters an agent's
 * environment. Every command acts on the repository behind the invoking thread's worktree `origin`. Pushes and fetches
 * run on the worktree's machine through the host entry; everything else is a REST call from the server.
 */
import { PluginCliError, cliCommand, type BbPluginApi, type PluginCliCommand } from "@get-bb/plugin-sdk";
import { BRANCH, type HostGit } from "../host-contract.ts";
import { GitHubPermanentError, GitHubSetupError, type CheckResult, type GitHub, type IssueDetail, type PullDetail, type PullFeedback, type RepoClient } from "../issues/github.ts";
import type { RepoName } from "../issues/job.ts";
import { readThreadFile } from "../thread-files.ts";

export type GhDeps = {
  bb: BbPluginApi;
  github: GitHub;
  host: HostGit;
  /** Whether the GitHub App id and private key are set. */
  configured: () => boolean;
  /** Issue workers hand their work to `bb pstack issues report` instead of pushing or opening pull requests. */
  isIssueWorker: (threadId: string) => boolean;
  /** The poteto-mode `pr` gate for threads in poteto mode; other threads pass. */
  prGate: (threadId: string) => { pass: true } | { pass: false; reason: string };
};

/** Contributed to every thread's instructions while the GitHub App is configured. */
export const GH_INSTRUCTIONS =
  "GitHub: agents hold no GitHub token. Use `bb pstack gh` (push, fetch, pr create|view|feedback|edit|comment|reply|merge|close, issue view|comment, checks) for the repository behind this worktree's origin; plain `git push` and `gh` are not authenticated. See the pstack `github` skill.";

type Workspace = { threadId: string; environmentId: string; hostId: string; path: string; repo: RepoName; branch: string | null; headSha: string | null; dirty: boolean };

/** `owner/name` from a GitHub https, scp-like or ssh remote URL, or null for any other host. */
export function repoFromRemote(url: string): RepoName | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? (`${match[1]}/${match[2]}`.toLowerCase() as RepoName) : null;
}

const positiveInt = (value: string, what: string): number => {
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  throw new PluginCliError(`"${value}" is not a ${what} number`, { code: "invalid_number" });
};

const json = (value: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });

function formatPull(pull: PullDetail): string {
  const state = pull.state === "open" && pull.draft ? "draft" : pull.state;
  return [`#${pull.number} ${pull.title}`, `  state   ${state}`, `  branch  ${pull.head} → ${pull.base}`, `  head    ${pull.headSha}`, `  author  @${pull.author}`, `  url     ${pull.url}`, "", pull.body.trim() || "(no description)"].join("\n");
}

function formatIssue(issue: IssueDetail): string {
  const head = [`#${issue.number} ${issue.title}`, `  state   ${issue.state}`, `  author  @${issue.author}`, ...(issue.labels.length > 0 ? [`  labels  ${issue.labels.join(", ")}`] : []), `  url     ${issue.url}`];
  const comments = issue.comments.map((comment) => `--- @${comment.author}, ${stamp(comment.createdAt)}\n${comment.body.trim()}`);
  return [...head, "", issue.body.trim() || "(no description)", ...comments].join("\n");
}

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** Inline comments grouped under the thread's first comment, whose id `pr reply` takes. */
function formatFeedback(pull: PullDetail, feedback: PullFeedback): string {
  const out = [`#${pull.number} ${pull.title}`];
  for (const review of feedback.reviews) out.push(`\n=== review ${review.id} by @${review.author}: ${review.state}, ${stamp(review.submittedAt)}`, ...(review.body.trim() ? [review.body.trim()] : []));
  const roots = feedback.inline.filter((comment) => comment.inReplyTo === null);
  for (const root of roots) {
    out.push(`\n=== thread ${root.id} at ${root.path}${root.line === null ? "" : `:${root.line}`}`);
    for (const comment of [root, ...feedback.inline.filter((reply) => reply.inReplyTo === root.id)]) out.push(`--- @${comment.author}, ${stamp(comment.createdAt)}`, comment.body.trim());
  }
  for (const comment of feedback.conversation) out.push(`\n=== comment ${comment.id} by @${comment.author}, ${stamp(comment.createdAt)}`, comment.body.trim());
  if (out.length === 1) out.push("No reviews or comments.");
  return out.join("\n");
}

function formatChecks(sha: string, checks: readonly CheckResult[]): string {
  if (checks.length === 0) return `No checks on ${sha}.`;
  const label = (check: CheckResult) => (check.status === "completed" ? (check.conclusion ?? "completed") : check.status);
  return [`Checks on ${sha}:`, ...checks.map((check) => `  ${label(check).padEnd(11)}  ${check.name}${check.url ? `  ${check.url}` : ""}`)].join("\n");
}

export function ghCommands(deps: GhDeps): Record<string, PluginCliCommand> {
  const { bb, github, host } = deps;

  async function workspace(ctx: { threadId?: string | undefined }): Promise<Workspace> {
    if (!ctx.threadId) throw new PluginCliError("run this from an agent thread", { code: "thread_required" });
    if (!deps.configured()) {
      throw new PluginCliError("pstack has no GitHub App", { code: "github_not_configured", hint: "Set githubAppId and githubPrivateKey in the pstack plugin settings." });
    }
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (!thread.environmentId) throw new PluginCliError("this thread has no environment yet", { code: "no_environment" });
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== "ready" || !environment.path) throw new PluginCliError(`this thread's environment is ${environment.status}`, { code: "environment_not_ready" });
    const originUrl = await host.inspect(environment.hostId, environment.path);
    const repo = originUrl ? repoFromRemote(originUrl) : null;
    if (!repo) {
      throw new PluginCliError(originUrl ? `origin ${originUrl} is not a github.com repository` : "this worktree has no origin remote", { code: "no_github_origin" });
    }
    const status = await bb.sdk.environments.status({ environmentId: thread.environmentId });
    if (status.outcome !== "available") throw new PluginCliError(`cannot read the worktree: ${status.outcome === "unavailable" ? status.failure.message : status.message}`, { code: "status_unavailable" });
    const { checkout, workingTree } = status.workspace;
    return {
      threadId: ctx.threadId,
      environmentId: thread.environmentId,
      hostId: environment.hostId,
      path: environment.path,
      repo,
      branch: checkout.kind === "branch" ? checkout.branchName : null,
      headSha: checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null,
      dirty: workingTree.hasUncommittedChanges,
    };
  }

  /** Runs `use` and turns GitHub's errors into CLI errors an agent can act on. */
  async function withRepo<T>(repo: RepoName, use: (client: RepoClient) => Promise<T>): Promise<T> {
    try {
      return await use(github.repo(repo));
    } catch (error) {
      if (error instanceof GitHubSetupError) throw new PluginCliError(error.message, { code: "github_setup", hint: `Install the pstack GitHub App on ${repo}, or ask a person to.` });
      if (error instanceof GitHubPermanentError) {
        const hint = error.status === 403 ? "The GitHub App may lack a permission this needs; a person can grant it in the App's settings." : undefined;
        throw new PluginCliError(error.message, { code: `github_${error.status}`, ...(hint ? { hint } : {}) });
      }
      throw error;
    }
  }

  const refuseIssueWorker = (threadId: string, what: string) => {
    if (deps.isIssueWorker(threadId)) {
      throw new PluginCliError(`an issue worker cannot ${what}`, { code: "issue_worker", hint: "Hand your result to `bb pstack issues report`; pstack pushes and opens the pull request." });
    }
  };

  async function body(input: { body?: string | undefined; "body-file"?: string | undefined }, ctx: { threadId?: string; cwd?: string }, threadId: string): Promise<string | undefined> {
    if (input["body-file"] !== undefined) return readThreadFile(bb, { threadId, cwd: ctx.cwd, path: input["body-file"], errorCode: "body_file_unreadable" });
    return input.body;
  }

  const bodyOptions = {
    body: { type: "string", description: "Text in Markdown" },
    "body-file": { type: "string", description: "Markdown file on this thread's machine; a relative path resolves against the current directory" },
  } as const;

  return {
    "gh push": cliCommand({
      summary: "Push this worktree's HEAD commit to its branch on GitHub, as the pstack GitHub App",
      description:
        "Pushes the committed HEAD, never uncommitted changes. The remote branch must be absent or an ancestor of HEAD; after a rebase, --force-with-lease replaces it, but only while it is still at the commit pstack reads before the push. The repository's default branch is refused; push a branch and open a pull request. Workflow files under .github/workflows are refused by GitHub unless the App has the workflows permission.",
      options: {
        branch: { type: "string", description: "Remote branch name (defaults to the worktree's current branch)" },
        "force-with-lease": { type: "boolean", description: "Replace the remote branch even if HEAD does not descend from it" },
        json: { type: "boolean", description: "Emit { repo, branch, sha } as JSON" },
      },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        refuseIssueWorker(ws.threadId, "push");
        const branch = input.options.branch ?? ws.branch;
        if (!branch) throw new PluginCliError("the worktree is not on a branch", { code: "detached_head", hint: "Check out a branch, or pass --branch." });
        if (!BRANCH.test(branch)) throw new PluginCliError(`"${branch}" is not a branch name pstack pushes`, { code: "invalid_branch" });
        if (!ws.headSha) throw new PluginCliError("the worktree has no commit", { code: "no_commit" });
        const sha = ws.headSha;
        return withRepo(ws.repo, async (repo) => {
          const defaultBranch = await repo.defaultBranch();
          if (branch === defaultBranch) {
            throw new PluginCliError(`pstack does not push to ${ws.repo}'s default branch ${defaultBranch}`, { code: "default_branch", hint: "Push another branch and open a pull request with `bb pstack gh pr create`." });
          }
          const expectedRemoteSha = await repo.branchSha(branch);
          if (expectedRemoteSha === null && !(await hasOwnCommits(bb, ws, defaultBranch, await repo.branchSha(defaultBranch)))) {
            throw new PluginCliError(`HEAD ${sha} has no commits that ${defaultBranch} lacks, so ${branch} would only copy ${defaultBranch}`, {
              code: "nothing_to_push",
              hint: ws.dirty ? "Commit your changes first; uncommitted changes are never pushed." : "Commit your work first.",
            });
          }
          if (expectedRemoteSha === sha) {
            return input.options.json ? json({ repo: ws.repo, branch, sha, pushed: false }) : { exitCode: 0, stdout: `${ws.repo} ${branch} is already at ${sha}.\n` };
          }
          const comparisonSha = expectedRemoteSha ?? (await repo.capabilities({ fresh: true })).defaultHead;
          if (!host.inspectCommit) throw new PluginCliError("the host cannot inspect pinned commits", { code: "unsupported_host" });
          const classification = await host.inspectCommit(ws.hostId, { worktreePath: ws.path, sha, comparisonSha });
          if (classification.kind === "missing-object") throw new PluginCliError(`commit ${classification.sha} is not available in this worktree`, { code: "missing_commit" });
          if (classification.sha !== sha || classification.comparisonSha !== comparisonSha) throw new PluginCliError("the host inspected different commits", { code: "stale_inspection" });
          const workflows = classification.workflows;
          const { remoteUrl, token } = await repo.pushCredentials({ workflows });
          try {
            const result = await host.pushBranch(ws.hostId, { worktreePath: ws.path, remoteUrl, branch, sha, expectedRemoteSha, comparisonSha, workflows, token, rewrite: input.options["force-with-lease"] ?? false });
            if (result.status === "failed") throw new PluginCliError(`push failed: ${result.detail}`, { code: "push_failed", hint: "Nothing was refused; run the push again." });
            if (result.status === "rejected") {
              const hint =
                result.reason === "not-descendant" || result.reason === "stale-remote"
                  ? `The remote ${branch} has commits HEAD lacks. Run \`bb pstack gh fetch\`, rebase or merge origin/${branch}, then push again; pass --force-with-lease only when you rebased on purpose.`
                  : undefined;
              throw new PluginCliError(`push rejected (${result.reason}): ${result.detail}`, { code: `push_${result.reason}`, ...(hint ? { hint } : {}) });
            }
          } finally {
            await repo.revoke(token).catch((error) => bb.log.warn(`pstack gh: could not revoke a push token: ${error instanceof Error ? error.message : String(error)}`));
          }
          const note = ws.dirty ? "\nUncommitted changes were not pushed." : "";
          return input.options.json ? json({ repo: ws.repo, branch, sha, pushed: true }) : { exitCode: 0, stdout: `Pushed ${sha} to ${ws.repo} ${branch}.${note}\n` };
        });
      },
    }),
    "gh fetch": cliCommand({
      summary: "Fetch every branch of this worktree's GitHub repository into refs/remotes/origin/*",
      description: "Updates remote-tracking refs only; the checkout and local branches stay as they are. Tags are not fetched.",
      options: { json: { type: "boolean", description: "Emit the fetched { branch, sha } list as JSON" } },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        return withRepo(ws.repo, async (repo) => {
          const { remoteUrl, token } = await repo.fetchCredentials();
          try {
            const result = await host.fetch(ws.hostId, { worktreePath: ws.path, remoteUrl, token });
            if (result.status === "failed") throw new PluginCliError(`fetch failed: ${result.detail}`, { code: "fetch_failed" });
            return input.options.json ? json(result.refs) : { exitCode: 0, stdout: `Fetched ${result.refs.length} branch${result.refs.length === 1 ? "" : "es"} of ${ws.repo} into origin/*.\n` };
          } finally {
            await repo.revoke(token).catch((error) => bb.log.warn(`pstack gh: could not revoke a fetch token: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      },
    }),
    "gh pr create": cliCommand({
      summary: "Open a pull request from this worktree's pushed branch",
      description: "Push the branch with `bb pstack gh push` first. The pull request opens ready for review unless --draft is passed.",
      options: {
        title: { type: "string", description: "Pull request title" },
        ...bodyOptions,
        base: { type: "string", description: "Branch to merge into (defaults to the repository's default branch)" },
        head: { type: "string", description: "Branch to merge from (defaults to the worktree's current branch)" },
        draft: { type: "boolean", description: "Open it as a draft" },
        json: { type: "boolean", description: "Emit { number, url } as JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        refuseIssueWorker(ws.threadId, "open pull requests");
        const gated = deps.prGate(ws.threadId);
        if (!gated.pass) throw new PluginCliError(`gate pr has not passed:\n${gated.reason}`, { code: "pr_gate", hint: "Close the open steps, then run `bb pstack gate pr`." });
        const title = input.options.title?.trim();
        if (!title) throw new PluginCliError("--title is required", { code: "title_required" });
        const head = input.options.head ?? ws.branch;
        if (!head) throw new PluginCliError("the worktree is not on a branch", { code: "detached_head", hint: "Pass --head." });
        const text = (await body(input.options, ctx, ws.threadId)) ?? "";
        return withRepo(ws.repo, async (repo) => {
          if ((await repo.branchSha(head)) === null) {
            throw new PluginCliError(`${head} is not on GitHub`, { code: "branch_not_pushed", hint: "Run `bb pstack gh push` first." });
          }
          const base = input.options.base ?? (await repo.defaultBranch());
          const pull = await repo.createPull({ head, base, title, body: text, draft: input.options.draft ?? false });
          return input.options.json ? json(pull) : { exitCode: 0, stdout: `Opened ${pull.url}\n` };
        });
      },
    }),
    "gh pr view": cliCommand({
      summary: "Show a pull request: title, state, branches, head commit and description",
      positionals: [{ name: "number", description: "Pull request number (defaults to the one for the current branch)" }],
      options: { json: { type: "boolean", description: "Emit the pull request as JSON" } },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          return input.options.json ? json(pull) : { exitCode: 0, stdout: `${formatPull(pull)}\n` };
        });
      },
    }),
    "gh pr edit": cliCommand({
      summary: "Change a pull request's title, description or base branch",
      positionals: [{ name: "number", description: "Pull request number (defaults to the one for the current branch)" }],
      options: { title: { type: "string", description: "New title" }, base: { type: "string", description: "New base branch" }, ...bodyOptions },
      constraints: [{ kind: "at-most-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        refuseIssueWorker(ws.threadId, "edit pull requests");
        const text = await body(input.options, ctx, ws.threadId);
        const title = input.options.title?.trim();
        const base = input.options.base;
        if (text === undefined && !title && !base) throw new PluginCliError("pass --title, --base, --body or --body-file", { code: "nothing_to_edit" });
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          await repo.editPull(pull.number, { ...(title ? { title } : {}), ...(base ? { base } : {}), ...(text !== undefined ? { body: text } : {}) });
          return { exitCode: 0, stdout: `Edited ${pull.url}\n` };
        });
      },
    }),
    "gh pr comment": cliCommand({
      summary: "Comment on a pull request's conversation",
      positionals: [{ name: "number", description: "Pull request number (defaults to the one for the current branch)" }],
      options: bodyOptions,
      constraints: [{ kind: "exactly-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        const text = (await body(input.options, ctx, ws.threadId))!;
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          await repo.comment(pull.number, text);
          return { exitCode: 0, stdout: `Commented on ${pull.url}\n` };
        });
      },
    }),
    "gh pr feedback": cliCommand({
      summary: "Show a pull request's reviews, inline review threads and conversation comments",
      positionals: [{ name: "number", description: "Pull request number (defaults to the one for the current branch)" }],
      options: { json: { type: "boolean", description: "Emit { reviews, inline, conversation } as JSON" } },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          const feedback = await repo.feedback(pull.number);
          return input.options.json ? json(feedback) : { exitCode: 0, stdout: `${formatFeedback(pull, feedback)}\n` };
        });
      },
    }),
    "gh pr close": cliCommand({
      summary: "Close a pull request without merging, optionally deleting its branch",
      positionals: [{ name: "number", description: "Pull request number (defaults to the one for the current branch)" }],
      options: {
        "delete-branch": { type: "boolean", description: "Delete the head branch too, when it lives in this repository and is not the default branch" },
        ...bodyOptions,
      },
      constraints: [{ kind: "at-most-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        refuseIssueWorker(ws.threadId, "close pull requests");
        const text = await body(input.options, ctx, ws.threadId);
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          if (pull.state === "merged") throw new PluginCliError(`#${pull.number} is already merged`, { code: "pull_merged" });
          if (text) await repo.comment(pull.number, text);
          if (pull.state === "open") await repo.closePull(pull.number);
          const lines = [pull.state === "open" ? `Closed ${pull.url}` : `${pull.url} was already closed.`];
          if (input.options["delete-branch"]) {
            if (pull.headRepo !== ws.repo) lines.push(`Kept ${pull.head}: it lives in ${pull.headRepo ?? "a deleted fork"}, not ${ws.repo}.`);
            else if (pull.head === (await repo.defaultBranch())) lines.push(`Kept ${pull.head}: it is the default branch.`);
            else {
              await repo.deleteBranch(pull.head);
              lines.push(`Deleted ${pull.head}.`);
            }
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        });
      },
    }),
    "gh pr reply": cliCommand({
      summary: "Answer an inline review comment in its thread",
      description: "Pass the id of the thread's first comment, shown as `thread <id>` by `bb pstack gh pr feedback`; GitHub refuses replies to replies.",
      positionals: [
        { name: "number", description: "Pull request number", required: true },
        { name: "comment", description: "Id of the thread's first inline comment", required: true },
      ],
      options: bodyOptions,
      constraints: [{ kind: "exactly-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        const number = positiveInt(input.positionals.number, "pull request");
        const comment = positiveInt(input.positionals.comment, "comment");
        const text = (await body(input.options, ctx, ws.threadId))!;
        return withRepo(ws.repo, async (repo) => {
          const reply = await repo.replyToReviewComment(number, comment, text);
          return { exitCode: 0, stdout: `Replied with comment ${reply.id} on ${ws.repo}#${number}.\n` };
        });
      },
    }),
    "gh pr merge": cliCommand({
      summary: "Merge an open pull request at the head you last saw",
      description:
        "Merges only while the pull request's head is still the commit `bb pstack gh pr view` showed, so a push after you checked is never merged unseen. Branch protection and required checks still apply.",
      positionals: [{ name: "number", description: "Pull request number", required: true }],
      options: {
        method: { type: "string", description: "merge | squash | rebase (default squash)" },
        sha: { type: "string", description: "Head commit you verified (defaults to the current head)" },
      },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        refuseIssueWorker(ws.threadId, "merge pull requests");
        const method = input.options.method ?? "squash";
        if (method !== "merge" && method !== "squash" && method !== "rebase") throw new PluginCliError(`--method must be merge, squash or rebase, not ${method}`, { code: "invalid_method" });
        return withRepo(ws.repo, async (repo) => {
          const pull = await findPull(repo, ws, input.positionals.number);
          if (pull.state !== "open") throw new PluginCliError(`#${pull.number} is ${pull.state}`, { code: "pull_not_open" });
          const { sha } = await repo.mergePull(pull.number, { sha: input.options.sha ?? pull.headSha, method });
          return { exitCode: 0, stdout: `Merged ${pull.url} as ${sha}.\n` };
        });
      },
    }),
    "gh issue view": cliCommand({
      summary: "Show an issue with its comments",
      positionals: [{ name: "number", description: "Issue number", required: true }],
      options: { json: { type: "boolean", description: "Emit the issue and its comments as JSON" } },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        const number = positiveInt(input.positionals.number, "issue");
        return withRepo(ws.repo, async (repo) => {
          const issue = await repo.issueDetail(number);
          if (!issue) throw new PluginCliError(`${ws.repo} has no issue #${number}`, { code: "issue_not_found" });
          return input.options.json ? json(issue) : { exitCode: 0, stdout: `${formatIssue(issue)}\n` };
        });
      },
    }),
    "gh issue comment": cliCommand({
      summary: "Comment on an issue",
      positionals: [{ name: "number", description: "Issue number", required: true }],
      options: bodyOptions,
      constraints: [{ kind: "exactly-one", options: ["body", "body-file"] }],
      async run(input, ctx) {
        const ws = await workspace(ctx);
        const number = positiveInt(input.positionals.number, "issue");
        const text = (await body(input.options, ctx, ws.threadId))!;
        return withRepo(ws.repo, async (repo) => {
          await repo.comment(number, text);
          return { exitCode: 0, stdout: `Commented on ${ws.repo}#${number}.\n` };
        });
      },
    }),
    "gh checks": cliCommand({
      summary: "List CI check runs and commit statuses on a pull request's head, or on this worktree's HEAD",
      positionals: [{ name: "number", description: "Pull request number (defaults to the worktree's HEAD commit)" }],
      options: { json: { type: "boolean", description: "Emit { sha, checks } as JSON" } },
      async run(input, ctx) {
        const ws = await workspace(ctx);
        return withRepo(ws.repo, async (repo) => {
          const sha = input.positionals.number !== undefined ? (await findPull(repo, ws, input.positionals.number)).headSha : ws.headSha;
          if (!sha) throw new PluginCliError("the worktree has no commit", { code: "no_commit" });
          const checks = await repo.checks(sha);
          return input.options.json ? json({ sha, checks }) : { exitCode: 0, stdout: `${formatChecks(sha, checks)}\n` };
        });
      },
    }),
  };
}

/**
 * Whether HEAD has a commit the default branch lacks. Read from the worktree against `origin/<default>`; when that
 * ref is missing locally, only HEAD sitting exactly at the remote default tip counts as nothing.
 */
async function hasOwnCommits(bb: BbPluginApi, ws: Workspace, defaultBranch: string, defaultSha: string | null): Promise<boolean> {
  if (ws.headSha === defaultSha) return false;
  const status = await bb.sdk.environments.status({ environmentId: ws.environmentId, mergeBaseBranch: `origin/${defaultBranch}` }).catch(() => null);
  if (status?.outcome !== "available" || !status.workspace.mergeBase) return true;
  return status.workspace.mergeBase.aheadCount > 0;
}

async function findPull(repo: RepoClient, ws: Workspace, number: string | undefined): Promise<PullDetail> {
  if (number !== undefined) {
    const pull = await repo.pull(positiveInt(number, "pull request"));
    if (!pull) throw new PluginCliError(`${ws.repo} has no pull request #${number}`, { code: "pull_not_found" });
    return pull;
  }
  if (!ws.branch) throw new PluginCliError("the worktree is not on a branch", { code: "detached_head", hint: "Pass the pull request number." });
  const pull = await repo.pullForBranch(ws.branch);
  if (!pull) throw new PluginCliError(`no pull request has ${ws.branch} as its head`, { code: "pull_not_found", hint: "Open one with `bb pstack gh pr create`." });
  return pull;
}
