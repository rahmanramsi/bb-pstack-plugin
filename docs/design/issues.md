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

The worker thread uses one command. The plugin CLI has no stdin, so the worker writes the report to a file on its machine and passes the path:

```sh
bb pstack issues report --file "$BB_THREAD_STORAGE/report.json"
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

A rejected report exits 1 and prints every reason. When pstack cannot check a report yet, for example while the worktree status is unavailable, the command exits 1 with code `unavailable`, and the attempt does not count as a rejection.

## Shape

**One label event is one job.** A job owns one worker thread, one branch `agent/issue-<n>-<slug>`, and at most one pull request. A partial unique index allows one open job per `(repo, issue)`. Re-adding the `agent` label after a job ended starts a new job, and its branch gets the suffix `-<generation>` (`agent/issue-41-submit-button-2`), so it never collides with the earlier pull request.

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

**The job row is the state machine, and transit states carry the outbox.** A job is either in a resting state (`queued`, `working`, `needs-info`, `review`, and the terminal `done`, `stopped`, `stuck`, `ignored`) or in a transit state (`starting`, `publishing`, `asking`, `closing`, `stopping`, `sticking`). A transit state carries the list of writes it still owes, in `effects_json` on the job row, and enters its resting state when the last one succeeds. So "writes are pending" and "the job is in transit" are one fact. A SQL `CHECK` enforces it, and a job can never reach `review` with its pull request unopened.

| Transit state | Effects, in order | Then |
|---|---|---|
| `starting` | label the issue `agent:working`, spawn the worker | `working` |
| `publishing` | push the reported commit, open the draft pull request, label it `agent`, relabel the issue `agent:review` | `review` |
| `asking` | post the questions, relabel the issue `agent:needs-info` | `needs-info` |
| `closing` | post the no-change reason, remove `agent:working` | `done` |
| `stopping` | stop the worker, remove `agent:working` | `stopped` |
| `sticking` | stop the worker, remove `agent:working` | `stuck` |

**A pure core.** `src/issues/job.ts` imports nothing but zod. `plan(job, facts)` returns at most one action, `settle(job, outcome, now)` turns an effect's outcome into the next change, and `acceptReport(job, report, facts)` is the only way out of `working`. `EFFECT_POLICY` in the same file says, per effect, whether to probe before a retry, whether a negative probe allows running it again, and how long a claim holds. The engine gathers facts, applies the action, and writes every change with `store.write(id, version, change)`, one `UPDATE` guarded by the row's version. The poller, thread events, the 15 s sweep, and the report command all end in the same `tick(jobId)`.

**Rounds.** A round is one message to the worker and one report back. Events that arrive while a round runs wait for the next round. Feedback is debounced: a round starts 2 minutes after the last event, so one review with ten inline comments becomes one round. The round message stands alone. It contains the pull request URL, every comment with its id, file, line, body, and diff hunk, and a short summary of earlier rounds. The worker can act on it after context compaction, and a replacement thread can act on it if the original is gone.

**The worker decides the effort.** The first round runs `/poteto-mode`. In a feedback round the worker reads the comments and chooses: mechanical feedback such as a rename, a typo, or a removed log line is applied directly, and anything that changes behavior or design goes through `/poteto-mode` again. Either way the report needs `verification`.

**Report validation.** The service rejects a report and tells the worker why when any check fails:

- The worktree has uncommitted or untracked changes.
- `changes` without a new commit, or `no-change` and `needs-info` with one. On the first round, a new commit means `environments.status` with `mergeBaseBranch: "origin/<base>"` reports `workspace.mergeBase.aheadCount > 0`. On later rounds, HEAD differs from the commit pstack last pushed. Neither needs a start commit captured before the worker begins.
- The first round's thread checklist fails `gate pr`.
- `verification` is empty.
- A listed comment id has no reply, or a reply names an id the round did not list.
- The title is not one line of 10 to 72 characters, or it does not follow the repository's title convention. The convention is Conventional Commits when the last 20 merged pull requests mostly use it.
- The body is empty, longer than 10,000 characters, or describes the process instead of the change. The check matches whole phrases such as `poteto-mode`, `pstack`, `playbook`, `the checklist`, `gate pr`, `this round`, and `the agent`, not bare words, so "thread pool", "user agent", and "round the timestamp" pass. The title and the text posted on the issue get the same check.

Before posting, the service neutralizes `@mentions` into code spans, removes `Closes`, `Fixes`, and `Resolves` keywords, and appends `Closes #<n>`. After two rejected reports in one round, the job moves to `stuck`.

**What the pull request shows.** The body describes the change for a reviewer who never saw the issue thread. It has no link to bb, no round history, and no status. The `agent` label marks the pull request as agent work. Replies to comments describe the code change and the commit, for example `Moved the check into parseInput in 9f3c2e1.` If the repository has `.github/pull_request_template.md`, the worker fills that template. Otherwise it follows the descriptions section of Opening a PR.

**The pull request tool.** Opening a PR tells the agent to use a run's built-in PR tool instead of a forge CLI. For an issue worker, `bb pstack issues report` is that tool. The worker prompt says so and forbids `git push`, `gh`, and branch changes. The worker may rebase its own commits before the first push. After that it adds commits and never rewrites pushed history. It resolves conflicts by merging the base branch.

**Push through the host entry.** The worktree lives on a host, and the token lives on the server. pstack has a `bb.host` entry (`src/host.ts`) with one RPC method, `push({ worktreePath, remoteUrl, branch, sha, expectedRemoteSha, token })`. The caller names a commit and a branch, never a refspec. The host builds `<sha>:refs/heads/<branch>` itself, and the contract admits only branches that match `agent/issue-<n>-<slug>` and full 40-character commit ids.

- **The validated commit, not HEAD.** The accepted report records the worktree's head commit, and pstack pushes that commit. A commit the worker makes after its report is not published unreviewed.
- **From a scratch repository.** The worker controls the worktree's git config and hooks, so a `git push` inside it could follow a planted `url.<x>.insteadOf` to another host, a `credential.helper`, or a pre-push hook. The host instead creates a temporary bare repository that borrows the worktree's objects read-only through `objects/info/alternates`, and pushes from there with a clean environment: no system or global config, hooks disabled, no credential helper, redirects off, and only the remote URL's protocol allowed.
- **A scoped token, revoked after use.** For each push the server mints a fresh installation token for that one repository with only `contents: write`, and revokes it in a `finally` block when the push returns. The token reaches git only as an `http.<remote>.extraHeader` in `GIT_CONFIG_*` environment variables, so it never appears in argv, a URL, a file, or the worker's environment.
- **Never a rewrite.** The host checks that `sha` descends from `expectedRemoteSha` first, then pushes with `--force-with-lease=refs/heads/<branch>:<expected>`. The lease makes the remote check atomic, and an empty expected value means the branch must not exist yet. A remote that moved fails the push as `stale-remote`.

**Workers.** The service spawns a visible thread in the mapped project. Its environment is `{ type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }`. It sets `pluginMetadata: { pstackIssue: 1, jobId }` and uses the model of the `issue worker` role, which falls back to `feature, refactoring` until it is configured. The permission mode is the project's default execution mode, and the field is left out when the project has none. The service refuses a `host` that equals the server's `primaryHostId` and records the refusal as the repository's poll error.

**No duplicate threads or GitHub writes.** Every effect, the spawn included, is claimed before it runs. The engine writes `tries + 1` and a lease to the row, then makes the call, then settles the outcome. After a crash the lease expires and the next claim probes for the effect's trace before running it again. A pushed commit is found as the remote branch at that commit, a pull request as any pull request from the head branch, and a comment as an App comment that carries the effect's key in an HTML marker. A probe that finds nothing lets a push, a pull request, or a comment run again. A spawn never runs twice, because no SDK error proves the thread was not created. Its probe looks for a thread in the job's project whose plugin metadata names the job, created after the claim and not bound to another job. If none appears within 5 minutes of the first claim, the job moves to `stuck`. A thread that names a job not waiting for it is stopped. Metadata only points at a job. The store's thread binding, not metadata, decides who may report.

**Limits.** Step 1 uses constants: 3 jobs in `starting`, `working`, or `publishing` at a time, 60 minutes per round, two reminders to an idle worker that has not reported, and two rejected reports. Past a limit the job moves to `stuck`, which stops the worker and removes `agent:working`. Later steps make the limits settings and add 5 feedback rounds per pull request and 3 CI rounds.

**Draft and ready.** The pull request opens as a draft. The service marks it ready after the first round once CI on its head commit passes. This differs from Opening a PR, which opens every pull request ready. Here the service owns readiness, and a red first push is common.

**Store.** Step 1 appends two tables to the migrations in `src/store.ts`:

- `issue_repos`: repository, the poll cursor (`since` and the ETag), the last poll time, and the last poll error.
- `issue_jobs`: one row per label event, unique on the event id. It holds the trigger, the issue snapshot, project, host, branch, generation, state, the outbox and its claim bookkeeping (`effects_json`, `effect_tries`, `effect_first_at`, `effect_lease_until`, `effect_next_at`), thread, deadline, rejections, reminders, the accepted report, the pushed commit, the pull request, the last error, and a version for compare-and-set writes. Its `CHECK` state lists repeat `job.ts`, and a test fails when they disagree.

A label from a user without write access becomes an `ignored` row with the reason, so `bb pstack issues list --all` explains why a label did nothing. Later steps add `issue_rounds` and `issue_events` for feedback rounds. There is no separate outbox table. The outbox has one writer, the job, so it lives on the job's row.

**Modules.** The feature lives under `src/issues/`:

- `job.ts`: the state machine, `plan`, `settle`, `acceptReport`, `EFFECT_POLICY`, the report schema, the pull request body, and the worker prompts. Pure.
- `store.ts`: SQL for `issue_repos` and `issue_jobs`.
- `github.ts`: the GitHub App client. It owns the App JWT, installation tokens, ETags, pagination, rate limits, and the permission cache, and maps responses to domain types and three error classes.
- `engine.ts`: `createIssues()`, the one surface `server.ts` uses. It returns the CLI commands, `register()` for thread events and the `pstack-issues` service, `instructions(threadId)`, and `isWorker(threadId)`. Its `EFFECTS` table says how to perform and probe each effect; a missing entry fails the build.
- `commands.ts`: `bb pstack issues` and the settings.

The host entry is `src/host.ts`, and its contract is in `src/host-contract.ts`. `src/thread-files.ts` reads a file on the invoking thread's machine for both `run start --file` and `issues report --file`. The UI panel comes last and reads jobs over RPC like the run views.

## Rollout

1. App auth, polling for labeled issues, store, spawn, `report`, push, and draft pull request on one sandbox repository.
2. Feedback rounds: reviews and comments, debounce, replies, and review re-requests.
3. `needs-info`, `/agent stop`, labels, the status comment, and draft to ready.
4. CI failures and merge conflicts as round triggers.
5. The jobs panel in the pstack UI.

## Tradeoffs accepted

- We accept up to 60 s of latency plus a 2 minute debounce, in exchange for no public endpoint and no lost events after downtime.
- We accept a job that stops at `stuck` after an ambiguous spawn failure, in exchange for never running two workers on one branch.
- We accept that the token briefly exists in the host plugin process and the git child processes during a push, in exchange for a plain `git push` that handles binaries, renames, and file modes. The worker probably runs as the same OS user as the host daemon, so it could read the token from `/proc/<pid>/environ` while a push runs. The token is limited to one repository and `contents: write` and is revoked when the push returns, so the exposure is one repository's branches for the length of one push. Branch protection on the default branch limits it further.
- We accept that a `stop` racing an in-flight effect drops that effect's result. A pull request opened in the race stays open but unrecorded.
- We accept that recovery waits out a lease, up to 11 minutes after a crash during a push, in exchange for no in-memory record of in-flight work.
- We accept that the worker judges whether feedback is mechanical, in exchange for cheaper rounds on small comments. Every round still needs verification evidence.
- We accept the experimental host RPC API, isolated in one small module.

## Alternatives considered

- **Webhooks through a bb connect tunnel.** These respond faster. They lost because they need a stable public URL and signature checks, and they drop events while the server is down.
- **The agent pushes and opens the pull request with `gh`.** This is simpler. It lost because an injected instruction could then push anywhere the token reaches, and pull request identity and idempotency would depend on agent behavior.
- **Rebuilding commits through the Git Data API from the server.** The token never leaves the server. It lost because blobs, trees, renames, modes, and large files need a lot of code, and the commit SHAs on GitHub would differ from the worker's local SHAs.
- **A scheduled agent that checks GitHub.** It needs no new service. It lost because every tick spends tokens to find nothing new.

## Open questions and risks

- An issue edited after work starts is sent to the worker as a note. Is that enough, or should a large edit restart the job?
- Two jobs that touch the same files are not coordinated. Conflicts surface as conflict rounds.
- Workers use the project's default permission mode. A project whose default is `accept-edits` may stall an unattended worker on approval prompts until the round's 60 minutes run out.
- Whether bb logs host RPC payloads, which carry the push token, is unverified.
- The reminder to an idle worker compares the thread's `updatedAt` with the job's last write. If bb does not bump `updatedAt` when a turn ends, no reminder is sent and the job sticks at the round's deadline instead.
- The host RPC API is experimental. A breaking SDK change affects only `src/host.ts` and its contract.
