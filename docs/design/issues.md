# GitHub issues to pull requests

## Problem

A team wants to hand a GitHub issue to an agent and get back a pull request that went through `/poteto-mode`. When a reviewer comments on that pull request, the same agent should continue the work. A person should only need to add a label and review code.

pstack already runs rigorous work in a thread. It does not watch GitHub, own a pull request across review rounds, or keep GitHub credentials away from the agent.

The bb Plugin SDK and the deployment set these limits:

- Plugin server code and services run on the bb server machine. Threads and their worktrees run on enrolled hosts, usually other machines.
- `threads.spawn` has no idempotency key.
- A secret setting is stored in a 0600 file on the server and cannot be multi-line.
- The server can run code on a host only through the plugin's `bb.host` entry and typed host RPC. That API is experimental.
- A playbook checklist is created once per thread, so after the first round `gate pr` passes without new work.

## Usage

Setup, done once by a person:

1. Create a GitHub App with these repository permissions: Contents read and write, Pull requests read and write, Issues read and write, Checks read, Metadata read. Leave webhooks off.
2. Install the App on the target repositories.
3. Configure pstack:

```sh
bb plugin config pstack set githubAppId 123456
bb plugin config pstack set githubPrivateKey "$(base64 -w0 app.private-key.pem)"   # secret
bb plugin config pstack set issueRepos "acme/web project=proj_abc host=host_def"
```

Each `issueRepos` line maps one repository to the bb project that holds its checkout and the host that runs its workers. The host must not be the server machine.

Daily use happens on GitHub:

| Who | Action | Result |
|---|---|---|
| A user with write access | Adds the `agent` label to an issue | A worker thread starts. The issue gets `agent:working` and one status comment. |
| Worker | Finishes | A draft pull request with the `agent` label, `Closes #<n>` in the body, and the issue moves to `agent:review`. |
| Worker | Cannot proceed without an answer | Questions are posted on the issue, which moves to `agent:needs-info`. A reply from the author or a collaborator resumes the worker. |
| Reviewer | Submits a review, writes an inline comment, or writes a pull request comment that starts with `/agent` | After 2 minutes without new feedback, the worker starts one round with all of it. |
| CI | Fails on a commit the App pushed | The worker starts a round to fix it. |
| GitHub | Reports a merge conflict | The worker merges the base branch and resolves the conflict. |
| A user with write access | Comments `/agent stop`, or removes the `agent` label | The worker stops and the job ends. |

Operators inspect jobs from bb:

```sh
bb pstack issues list                 # jobs per repository and their state
bb pstack issues show <job>           # rounds, thread, pull request, last error
bb pstack issues stop <job>
```

The worker thread uses one command:

```sh
bb pstack issues report --result-file -
```

```json
{
  "outcome": "changes",
  "pr": { "title": "fix(login): keep the submit button above the footer", "body": "## Why\n…" },
  "replies": [{ "commentId": 1234567, "body": "Moved the check into `parseInput` in 9f3c2e1." }],
  "verification": ["npm test -- login: 14 passed"],
  "summary": "Footer overlap fixed; visual test added for 375px."
}
```

`outcome` is `changes`, `needs-info` (with `questions`), or `no-change` (with `summary` as the reason). `pr` is required on the first `changes` round and optional later. `replies` must answer every comment id the round listed.

## Shape

**One issue is one job.** A job owns one worker thread, one branch `agent/issue-<n>-<slug>`, and at most one pull request. The job row is unique on `(repo, issue)`.

**The agent holds no GitHub credentials.** The worker edits code and makes local commits in its worktree, then reports. The service performs every GitHub write: push, pull request create and edit, replies, labels, status comment, and review re-requests. A worker that follows injected instructions from an issue or comment can still change only its own branch, and only through a report the service validates. Workers run on hosts that do not store the App key. The worker host should not have a `gh` login with write access to the repository.

**Polling, not webhooks.** The server has no stable public endpoint, and polling resumes from a cursor after downtime. The `pstack-issues` service polls each repository every 60 s with an installation token. Requests send `If-None-Match`, and a 304 response does not count against the rate limit.

- Open issues labeled `agent`. Items with a `pull_request` field are skipped, because GitHub lists pull requests as issues.
- Issue comments, review comments, and reviews since the cursor.
- Check runs and `mergeable` for the head commit of each open job pull request.

**Who can trigger.** The service accepts a label, comment, or review only from a user with write, maintain, or admin permission on the repository. It reads the permission from `GET /repos/{owner}/{repo}/collaborators/{user}/permission` and caches it for 10 minutes. It ignores everything authored by the App. Other users are ignored without a reply.

**Job states.**

```
detected ─► working ─┬─► needs-info ──(answer)──► working
                     ├─► done (no-change)
                     └─► review ──(feedback, CI failure, conflict)──► addressing ──► review
review ──(merged or closed)──► done
any ──(/agent stop, label removed)──► stopped
any ──(round limit, timeout, repeated invalid report)──► stuck
```

`working`, `needs-info`, `review`, and `stuck` map to the labels `agent:working`, `agent:needs-info`, `agent:review`, and `agent:stuck`. The issue has one status comment that the service edits. It states the current state and links the pull request, and nothing else.

**A pure reconciler.** As in `src/runner.ts`, `plan(job, pendingEvents, now)` returns actions: spawn, send round, push, open or update the pull request, reply, set labels, edit the status comment, stop, and finish. The engine applies each action through a compare-and-set transition in the store. The poller, thread events, a 15 s tick, and startup all call the same `tick(jobId)`.

**Rounds.** A round is one message to the worker and one report back. Events that arrive while a round runs wait for the next round. Feedback is debounced: a round starts 2 minutes after the last event, so one review with ten inline comments becomes one round. The round message stands alone. It contains the pull request URL, every comment with its id, file, line, body, and diff hunk, and a short summary of earlier rounds. The worker can act on it after context compaction, and a replacement thread can act on it if the original is gone.

**The worker decides the effort.** The first round runs `/poteto-mode`. In a feedback round the worker reads the comments and chooses: mechanical feedback such as a rename, a typo, or a removed log line is applied directly, and anything that changes behavior or design goes through `/poteto-mode` again. Either way the report needs `verification`.

**Report validation.** The service rejects a report and tells the worker why when any check fails:

- The worktree has uncommitted changes.
- `changes` without a new commit since the round started, or `no-change` and `needs-info` with one.
- The first round's thread checklist fails `gate pr`.
- `verification` is empty.
- A listed comment id has no reply, or a reply names an id the round did not list.
- The title is not one line of 10 to 72 characters, or it does not follow the repository's title convention. The convention is Conventional Commits when the last 20 merged pull requests mostly use it.
- The body is empty, longer than 10,000 characters, or describes the process instead of the change. It must not name the playbook, checklist, gate, rounds, threads, prompts, or the agent.

Before posting, the service neutralizes `@mentions` into code spans, removes `Closes`, `Fixes`, and `Resolves` keywords, and appends `Closes #<n>`. After two rejected reports in one round, the job moves to `stuck`.

**What the pull request shows.** The body describes the change for a reviewer who never saw the issue thread. It has no link to bb, no round history, and no status. The `agent` label marks the pull request as agent work. Replies to comments describe the code change and the commit, for example `Moved the check into parseInput in 9f3c2e1.` If the repository has `.github/pull_request_template.md`, the worker fills that template. Otherwise it follows the descriptions section of Opening a PR.

**The pull request tool.** Opening a PR tells the agent to use a run's built-in PR tool instead of a forge CLI. For an issue worker, `bb pstack issues report` is that tool. The worker prompt says so and forbids `git push`, `gh`, and branch changes. The worker may rebase its own commits before the first push. After that it adds commits and never rewrites pushed history. It resolves conflicts by merging the base branch.

**Push through the host entry.** The worktree lives on a host, and the token lives on the server. pstack gains a `bb.host` entry with one RPC method, `push({ worktreePath, remoteUrl, refspec, expectedRemoteSha, token })`. The server mints a fresh installation token and calls the method on the worktree's host. The host runs `git push` with the token in a one-shot `http.extraHeader` passed through `GIT_CONFIG_*` environment variables, so it never appears in a URL, the process list, the git config, or the worker's environment. The refspec is `HEAD:refs/heads/agent/issue-<n>-<slug>`, so the local branch name bb chose for the worktree does not matter. The push is never forced. `expectedRemoteSha` makes a push that does not fast-forward fail instead of overwriting.

**Workers.** The service spawns a visible thread in the mapped project. Its environment is `{ type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }`. It sets `pluginMetadata: { pstackIssue: 1, jobId }` and uses the model of the new `issue worker` role, which falls back to `feature`. The service refuses a `host` that equals the server's `primaryHostId`.

**No duplicate threads or GitHub writes.** An attempt row is stored as `issued` before `threads.spawn`. On a spawn error or restart, the service looks for the thread through `threads.list({ originPluginId })` and plugin metadata. If it finds the thread, it adopts it. If not, the job moves to `stuck` instead of risking a second worker. Every GitHub write is first stored in an outbox with an idempotency key, such as `pr:<job>`, `reply:<commentId>`, or `push:<job>:<sha>`. Before retrying, the service checks GitHub: it looks for an open pull request from the head branch, an existing App reply to the comment, or the remote branch at that commit.

**Limits.** These are settings with defaults: 3 jobs at a time, 5 feedback rounds per pull request, 3 CI rounds, and 60 minutes per round. Past a limit the job moves to `stuck`, and the status comment mentions the user who added the label.

**Draft and ready.** The pull request opens as a draft. The service marks it ready after the first round once CI on its head commit passes. This differs from Opening a PR, which opens every pull request ready. Here the service owns readiness, and a red first push is common.

**Store.** New append-only migrations in `src/store.ts`:

- `issue_repos`: repository, cursor, and ETags.
- `issue_jobs`: repository, issue, project, host, branch, thread, pull request, state, round counters, and deadline.
- `issue_rounds`: job, ordinal, kind (`initial`, `feedback`, `ci`, `conflict`, `answer`), start commit, listed comment ids, report, and result.
- `issue_events`: GitHub event ids already consumed.
- `issue_outbox`: idempotency key, action, payload, state, and attempts.

**Modules.** The feature lives under `src/issues/`:

- `github-auth.ts`: App JWT and cached installation tokens.
- `github.ts`: the REST client.
- `poller.ts`: turns responses into events.
- `engine.ts`: `plan()` and `apply()`.
- `report.ts`: the report schema, validation, and body assembly.
- `prompts.ts`: the worker prompts.
- `commands.ts`: `bb pstack issues`.

The host entry is `src/host.ts`, and its contract is in `src/host-contract.ts`. The UI panel comes last and reads jobs over RPC like the run views.

## Rollout

1. App auth, polling for labeled issues, store, spawn, `report`, push, and draft pull request on one sandbox repository.
2. Feedback rounds: reviews and comments, debounce, replies, and review re-requests.
3. `needs-info`, `/agent stop`, labels, the status comment, and draft to ready.
4. CI failures and merge conflicts as round triggers.
5. The jobs panel in the pstack UI.

## Tradeoffs accepted

- We accept up to 60 s of latency plus a 2 minute debounce, in exchange for no public endpoint and no lost events after downtime.
- We accept a job that stops at `stuck` after an ambiguous spawn failure, in exchange for never running two workers on one branch.
- We accept that the token briefly exists in the host plugin process during a push, in exchange for a plain `git push` that handles binaries, renames, and file modes.
- We accept that the worker judges whether feedback is mechanical, in exchange for cheaper rounds on small comments. Every round still needs verification evidence.
- We accept the experimental host RPC API, isolated in one small module.

## Alternatives considered

- **Webhooks through a bb connect tunnel.** These respond faster. They lost because they need a stable public URL and signature checks, and they drop events while the server is down.
- **The agent pushes and opens the pull request with `gh`.** This is simpler. It lost because an injected instruction could then push anywhere the token reaches, and pull request identity and idempotency would depend on agent behavior.
- **Rebuilding commits through the Git Data API from the server.** The token never leaves the server. It lost because blobs, trees, renames, modes, and large files need a lot of code, and the commit SHAs on GitHub would differ from the worker's local SHAs.
- **A scheduled agent that checks GitHub.** It needs no new service. It lost because every tick spends tokens to find nothing new.

## Open questions and risks

- Should re-adding the `agent` label to a stopped or done issue resume the old job or start a new one?
- An issue edited after work starts is sent to the worker as a note. Is that enough, or should a large edit restart the job?
- Two jobs that touch the same files are not coordinated. Conflicts surface as conflict rounds.
- What permission mode should worker threads use? Autonomous work needs one that does not block on approval prompts.
- The host RPC API is experimental. A breaking SDK change affects only `src/host.ts` and its contract.
