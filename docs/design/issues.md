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
| Reviewer | Submits a review, writes an inline comment, or writes a pull request comment that mentions the App, such as `@pstack-agent also cover 320px` | After 2 minutes without new feedback, the worker starts one round with all of it. |
| CI | Fails on a commit the App pushed | The worker starts a round to fix it. |
| GitHub | Reports a merge conflict | The worker merges the base branch and resolves the conflict. |
| A user with write access | Comments `@pstack-agent stop`, or removes the `agent` label | The worker stops and the job ends. |
| A user with write access | Adds the `agent` label to an issue that has sub-issues | Each open sub-issue gets its own worker, with the parent issue as context. A sub-issue blocked by an open issue waits until that issue closes. The parent gets one status comment that the service edits, and closes once every sub-issue is closed. Stopping the parent, removing its label, or closing it stops the unfinished sub-issue jobs. |

Operators inspect jobs from bb:

```sh
bb pstack issues list                 # each repository's last poll and its error, then its jobs and their state
bb pstack issues show <job>           # thread, pull request, last error, and the repository's last poll
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
  "verification": ["npm test -- login: 14 passed"],
  "summary": "Footer overlap fixed; visual test added for 375px."
}
```

In the first round, `outcome` is `changes` (with `pr.title` and `pr.body`), `needs-info` (with `questions`), or `no-change` (with `summary` as the reason posted on the issue). A feedback round's report answers the round's comments:

```json
{
  "outcome": "changes",
  "round": 1,
  "replies": [
    { "kind": "review-comment", "commentId": 1234567, "body": "Moved the check into `parseInput` in 9f3c2e1." },
    { "kind": "review", "commentId": 7654321, "body": "Kept the retry: the upload API drops one request in a few hundred." }
  ],
  "verification": ["npm test -- login: 15 passed"],
  "summary": "Moved the check and explained the retry."
}
```

There `outcome` is `changes` or `no-change`. `round` is the feedback round the message named. `replies` has exactly one entry for each item the round listed, named by its `kind` (`review`, `review-comment`, or `pr-comment`) and `commentId`. `pr.body` is optional and replaces the pull request description. A feedback report has no `pr.title`. The two rounds have separate schemas, and the service picks the one for the job's current round.

A rejected report exits 1 and prints every reason. These exit 1 too, and none counts as a rejection:

- `invalid_report`: the report is not JSON or breaks its round's schema, such as a first `changes` report without `pr`, or a question in a feedback round.
- `other_round`: the report names a feedback round other than the current one. It comes from a repeated copy of an earlier round's message.
- `remote_moved`: the branch moved on GitHub since the round started. The worker merges `origin/<branch>` and reports again.
- `unavailable`: pstack cannot check the report yet, for example while the worktree status is unavailable, while the round is still being handed to the worker, or before pstack has confirmed the thread as the job's worker.

## Shape

**One label event is one job.** A job owns one worker thread, one branch `agent/issue-<n>-<slug>`, and at most one pull request. A partial unique index allows one open job per `(repo, issue)`. Re-adding the `agent` label after a job ended starts a new job, and its branch gets the suffix `-<generation>` (`agent/issue-41-submit-button-2`), so it never collides with the earlier pull request.

**The agent holds no GitHub credentials.** The worker edits code and makes local commits in its worktree, then reports. The service performs every GitHub write: push, pull request create and edit, replies, labels, status comment, and review re-requests. A worker that follows injected instructions from an issue or comment can still change only its own branch, and only through a report the service validates. Workers run on hosts that do not store the App key. The worker host should not have a `gh` login with write access to the repository.

**Polling, not webhooks.** The server has no stable public endpoint, and polling resumes from a cursor after downtime. The `pstack-issues` service polls each repository every 60 s with an installation token. Requests send `If-None-Match`, and a 304 response does not count against the rate limit.

- Open issues labeled `agent`. Items with a `pull_request` field are skipped, because GitHub lists pull requests as issues.
- For each open job: its issue's comments since the job started, for `@<app> stop`.
- For each open job's pull request: its inline review comments and its conversation comments since its cursor, its reviews, and its state (open, merged, or closed). Each list keeps its own ETag, and a 304 keeps the last known reviews and pull request state.
- Later: check runs and `mergeable` for the head commit of each open job pull request.

Each job is polled on its own. Its cursor, its pull request's last state, and its last poll error live in `issue_job_polls`, and the cursor's shape belongs to `github.ts`. A job GitHub cannot read keeps its last cursor and state and records the error, which `issues list` and `issues show` print. Every other job still gets its feedback. The pull request state is read from the store, so a restarted service acts on it before the next poll answers. A poll's new feedback, state and cursor are written in one transaction.

Feedback is read per pull request rather than repository-wide. A repository-wide list has no good starting cursor for its first read, and a comment that lands between a pull request's creation and the job recording it would be dropped for good. Per pull request, the first read starts at the pull request's beginning, and an unchanged list still costs nothing.

GitHub dates a review's inline comments from when they were drafted, not when the review was submitted. A review submitted after the App's replies can hold comments older than the inline cursor. So each review the reviews list shows for the first time has its comments read through `GET /pulls/{n}/reviews/{id}/comments`, except the App's own reviews, which are its replies. The inline list also reads 10 minutes behind its cursor, because GitHub's lists are eventually consistent. Items read twice are deduped by id. An inline comment whose review the reviews list does not show yet is not stored on that poll, because without its review's state the approved-review rule cannot be applied. A later poll reads it again.

**Who can trigger.** The service accepts a label, comment, or review only from a user with write, maintain, or admin permission on the repository. It reads the permission from `GET /repos/{owner}/{repo}/collaborators/{user}/permission` and caches it for 10 minutes. It ignores everything authored by the App. Other users are ignored without a reply.

**What counts as feedback.** The rules are the pure `counts()` in `job.ts`:

- A comment in the pull request's conversation counts only when it mentions the App by its slug, `@<app>` or `@<app>[bot]`, anywhere in its own text and case-insensitive. Quoted lines (`>`) do not count, because they repeat someone else's words, and the App's own replies quote with mentions neutralized, so it never mentions itself. `@<app> stop` is a command, not feedback. The slug comes from `GET /app`. This is the convention other GitHub App bots use, such as `@dependabot rebase`. Pick a slug no GitHub user owns, or that user is notified by every mention.
- Inline review comments and review bodies always count, except that a review whose state is `APPROVED` or `DISMISSED` counts for nothing, its inline comments included. `CHANGES_REQUESTED` and `COMMENTED` count.
- A review with an empty body is not stored: its inline comments arrive on their own, and there is nothing else to answer.

Feedback that does not count is not stored.

**Stopping from GitHub.** A comment that says `@<app> stop` in its own text, on the issue or on the job's pull request, stops the job. Its author needs write access and must not be the App, and it must be written after the job started. It takes the same path as `bb pstack issues stop`, so the worker stops and the status labels go.

**Job states.**

```
detected ─► working ─┬─► needs-info ──(answer)──► working
                     ├─► done (no-change)
                     └─► review ──(feedback, CI failure, conflict)──► addressing ──► review
review, addressing ──(merged or closed)──► done
any ──(@<app> stop, label removed)──► stopped
any ──(feedback round limit, branch gone, unconfirmed write, gone worker thread)──► stuck
```

Step 2 builds feedback as the trigger for `addressing`, and `@<app> stop` comments. CI failures and conflicts come in step 4, and `needs-info` answers and the label removal in step 3.

`working`, `needs-info`, `review`, and `stuck` map to the labels `agent:working`, `agent:needs-info`, `agent:review`, and `agent:stuck`. The issue has one status comment that the service edits. It states the current state and links the pull request, and nothing else.

**The job row is the state machine, and transit states carry the outbox.** A job is either in a resting state (`queued`, `working`, `needs-info`, `review`, `addressing`, and the terminal `done`, `stopped`, `stuck`, `ignored`) or in a transit state (`starting`, `publishing`, `asking`, `closing`, `stopping`, `sticking`, `sending`, `respawning`, `republishing`, `replying`). A transit state carries the list of writes it still owes, in `effects_json` on the job row, and enters its resting state when the last one succeeds. So "writes are pending" and "the job is in transit" are one fact. A SQL `CHECK` enforces it, and a job can never reach `review` with its pull request unopened.

| Transit state | Effects, in order | Then |
|---|---|---|
| `starting` | label the issue `agent:working`, spawn the worker | `working` |
| `publishing` | push the reported commit, open the draft pull request, label it `agent`, relabel the issue `agent:review` | `review` |
| `asking` | post the questions, relabel the issue `agent:needs-info` | `needs-info` |
| `closing` | post the no-change reason, remove `agent:working`; or, for a merged or closed pull request, stop the worker and remove every status label | `done` |
| `stopping` | stop the worker, remove `agent:working`, `agent:needs-info` and `agent:review` | `stopped` |
| `sticking` | stop the worker, remove `agent:working`, `agent:needs-info` and `agent:review` | `stuck` |
| `sending` | relabel the issue `agent:working`, send the round message to the worker | `addressing` |
| `respawning` | relabel the issue `agent:working`, spawn a replacement worker from `origin/<branch>` with the round message, check that its worktree contains the round's base | `addressing` |
| `republishing` | push the new commit on top of the pushed one, post each reply, edit the description if the report replaced it, re-request review, relabel the issue `agent:review` | `review` |
| `replying` | post each reply, re-request review, relabel the issue `agent:review` | `review` |

The relabel comes first in `sending` and `respawning`, so the worker never gets the round before the job waits for its report. A report that arrives while the round is still being handed over exits with `unavailable`. Both states read the pull request's state, and a merged or closed pull request ends the job before the message or the spawn. When the replacement's worktree does not contain the round's base, the worker is sent a note, steered into its running turn, to fetch and merge `origin/<branch>` before it commits.

**A pure core.** `src/issues/job.ts` imports only zod and SDK types. `plan(job, facts)` returns at most one action, `settle(job, outcome, now)` turns an effect's outcome into the next change, and `acceptReport(job, report, facts)` is the only way out of `working` and `addressing`. `EFFECT_POLICY` in the same file gives each effect its lease and one recovery for a claim that never settled: `replay` runs it again (labels, stopping the worker, the round message, review requests, description edits, the replacement's worktree check), `probe` looks for its trace and runs it again only when there is none (push, pull request, comment, reply), and `once` looks for its trace and never runs it again (spawn). The engine's handler type follows from it, so an effect has a probe exactly when its policy uses one. The engine gathers facts, applies the action, and writes every change with `store.write(id, version, change)`, one `UPDATE` guarded by the row's version. The poller, thread events, the 15 s sweep, and the report command all end in the same `tick(jobId)`, which runs one reconcile per job at a time.

**One slow job holds back no other.** Each sweep starts the reconciles of the jobs that can act now without waiting for them: jobs whose next step depends on facts outside the row (`queued`, `working`, `review`, `addressing`), and transit jobs whose lease and backoff have passed. A job in `review` reads only its pending feedback and its pull request's state from the store on each sweep. The worker thread, the earlier rounds' summaries and the branch's head on GitHub are read only once a round is due (`ROUND_FACTS`), so a pull request that waits days for review costs no bb or GitHub call per sweep. A job resting in `needs-info` is not swept. Every GitHub request times out after 20 s. An effect gets its claim's lease end, less 5 s to settle, as a deadline, and its GitHub, SDK and host calls end by then. The host push ends 30 s earlier, so the token can still be revoked within the lease.

**Rounds.** A round is one message to the worker and one report back. Round 1 is the issue. Each later round answers feedback on the pull request.

- The poller stores each counted item in `issue_feedback` as pending. Feedback that arrives while a round runs stays pending for the next one.
- A job in `review` starts a round once its newest pending item has been visible for 2 minutes, so one review with ten inline comments becomes one round. An item is visible from its review's submission for a review and its inline comments, and otherwise from the comment's last update. The round also needs the pull request's state from a successful poll.
- The round starts in one store transaction: the job moves to `sending`, or to `respawning` when its thread is archived, deleted or failed, with the round ordinal plus one. The round's row is inserted in `issue_rounds`, and every item the message lists is marked with the round. An item is never sent in two rounds. The store refuses a round start that does not list every pending item. An item polled while the round was being planned then restarts the quiet period instead of starting a round of its own.
- The round's base is the branch's head on GitHub when the round starts, kept on the job (`round_base`) and the round's row. A reviewer who commits a suggestion or presses Update branch moves it past the last push. The round's commit must contain the base, and its push expects it. When the branch moves again during the round, the report is refused with `remote_moved`, which does not count, and the base moves to the new head. A branch that no longer exists sticks the job.
- The message is built from those items and stored in the effect, so a replay sends the same text. It stands alone. It holds the pull request URL and branch, the round number of 5, and the issue. Each item comes with its kind and id, author, file, line, diff hunk and body. An inline follow-up also shows the thread comment it answers. A one-line summary of each earlier round follows, then the rules. When the branch moved since the last push, the message says so and tells the worker to run `git fetch origin` and merge `origin/<branch>` before it commits. Comment text is fenced and marked as data from a GitHub user. The message also says that a repeated copy needs no work.
- `addressing` behaves like `working`: reminders to an idle worker, rejected reports that go back to the worker, and `stop`.
- A merged or closed pull request ends a job in `review` or `addressing`: it stops the worker and removes the status labels.
- A replacement worker is a spawn of its own, keyed by the round, and starts from the pushed branch with the settings the first worker used.

**The worker decides the effort.** The first round runs `/poteto-mode`. In a feedback round the worker reads the comments and chooses: mechanical feedback such as a rename, a typo, or a removed log line is applied directly, and anything that changes behavior or design goes through `/poteto-mode` again. Either way the report needs `verification`.

**Replies.** An inline review comment is answered in its thread. GitHub takes replies only on a thread's first comment ("Replies to replies are not supported"), so a follow-up inside a thread is answered on the comment its `in_reply_to_id` names. A review body or a conversation comment has no thread, so its answer is one conversation comment that quotes the first line of what it answers. Every reply carries its effect's key as an HTML marker on its last line, and the probe after a crash matches a marker only there. Every other `<!-- pstack:… -->` marker is removed from posted text first, including the reviewer's quoted line, so no one can plant a sibling reply's marker. A 404 from the reply endpoint drops the reply only when `GET /pulls/comments/{id}` confirms the thread's comment is gone. Any other 404 is an error. The round then re-requests review from every author it answered. GitHub refuses a request for some users, such as the pull request's author, and those are dropped.

A round ends when the job leaves it: back in review, waiting in `needs-info`, or on its way to an end. `job.ts` marks that change with `finishRound`, and the store stamps the round's `finished_at` only then and only once, so a later merge or stop does not move it.

**Report validation.** The service rejects a report and tells the worker why when any check fails:

- The worktree has uncommitted or untracked changes.
- `changes` without a new commit, or `no-change` and `needs-info` with one. On the first round, a new commit means `environments.status` with `mergeBaseBranch: "origin/<base>"` reports `workspace.mergeBase.aheadCount > 0`. On later rounds, HEAD differs from the round's base, and the host still refuses a commit that does not descend from it. Neither needs a start commit captured before the worker begins.
- In a feedback round, HEAD does not contain the round's base: it is neither HEAD nor among the commits `environments.status` lists ahead of `origin/<base>`.
- The first round's thread checklist fails `gate pr`. Later rounds do not check the gate: the checklist was made once, for the first round.
- `verification` is empty.
- The replies do not answer each listed item exactly once, by kind and id.
- The first `changes` report has no `pr.title` or `pr.body`, the title is not one line of 10 to 72 characters, or it does not follow the repository's title convention. The convention is Conventional Commits when the last 20 merged pull requests mostly use it.
- A reply is longer than GitHub's 65,536 characters as it would be posted, quoted and with its marker.
- The body is empty, longer than 10,000 characters, or describes the process instead of the change. The check matches whole phrases such as `poteto-mode`, `pstack`, `playbook`, `the checklist`, `gate pr`, `this round`, and `the agent`, not bare words, so "thread pool", "user agent", and "round the timestamp" pass. The title, the text posted on the issue, and every reply get the same check.

Before posting, the service neutralizes `@mentions` into code spans in everything it posts. In the pull request body it also removes `Closes`, `Fixes`, and `Resolves` keywords and appends `Closes #<n>`. A rejected report goes back to the worker with every reason, however many times. It never ends the job.

**What the pull request shows.** The body describes the change for a reviewer who never saw the issue thread. It has no link to bb, no round history, and no status. The `agent` label marks the pull request as agent work. Replies to comments describe the code change and the commit, for example `Moved the check into parseInput in 9f3c2e1.` If the repository has `.github/pull_request_template.md`, the worker fills that template. Otherwise it follows the descriptions section of Opening a PR.

**The pull request tool.** Opening a PR tells the agent to use a run's built-in PR tool instead of a forge CLI. For an issue worker, `bb pstack issues report` is that tool. The worker prompt says so and forbids `git push`, `gh`, and branch changes. The worker may rebase its own commits before the first push. After that it adds commits and never rewrites pushed history. It resolves conflicts by merging the base branch.

**Push through the host entry.** The worktree lives on a host, and the token lives on the server. pstack has a `bb.host` entry (`src/host.ts`) with one RPC method, `push({ worktreePath, remoteUrl, branch, sha, expectedRemoteSha, token })`. The caller names a commit and a branch, never a refspec. The host builds `<sha>:refs/heads/<branch>` itself, and the contract admits only branches that match `agent/issue-<n>-<slug>` and full 40-character commit ids.

- **The validated commit, not HEAD.** The accepted report records the worktree's head commit, and pstack pushes that commit. A commit the worker makes after its report is not published unreviewed.
- **From a scratch repository.** The worker controls the worktree's git config and hooks, so a `git push` inside it could follow a planted `url.<x>.insteadOf` to another host, a `credential.helper`, or a pre-push hook. The host instead creates a temporary bare repository that borrows the worktree's objects read-only through `objects/info/alternates`, and pushes from there with a clean environment: no system or global config, hooks disabled, no credential helper, redirects off, and only the remote URL's protocol allowed.
- **A scoped token, revoked after use.** For each push the server mints a fresh installation token for that one repository with only `contents: write`, and revokes it in a `finally` block when the push returns. The token reaches git only as an `http.<remote>.extraHeader` in `GIT_CONFIG_*` environment variables, so it never appears in argv, a URL, a file, or the worker's environment.
- **Never a rewrite.** The host checks that `sha` descends from `expectedRemoteSha` first, then pushes with `--force-with-lease=refs/heads/<branch>:<expected>`. The lease makes the remote check atomic, and an empty expected value means the branch must not exist yet. A remote that moved fails the push as `stale-remote`. Before the server treats that as final, it reads the branch head: a push whose claim outlived its lease can land the same commit first, and a branch already at `sha` counts as pushed.
- **The remote's verdict, read per ref.** The host reads the `--porcelain` status line of the pushed ref. A refused ref is `rejected`: `stale-remote` for a failed lease or fast-forward check, and `remote-rejected` for anything else the remote refused, such as a repository rule, a pre-receive hook, a large file, or a workflow file the contents-only token may not write. The detail carries the remote's reason, and the job sticks with it instead of retrying. `failed`, which is retried, means git exited without refusing the ref: network, timeout, or a 5xx.

**Workers.** The service spawns a visible thread in the mapped project. Its environment is `{ type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "origin/<base>" } } }`, where `<base>` is the repository's GitHub default branch. That is the ref report validation counts new commits against and the pull request targets, so a fresh worktree has nothing ahead of it whatever the project's own worktree base is. It sets `pluginMetadata: { pstackIssue: 1, jobId }` and uses the model of the `issue worker` role, which falls back to `feature, refactoring` until it is configured. The permission mode is the project's default execution mode, and the field is left out when the project has none. The service refuses a `host` that equals the server's `primaryHostId` and records the refusal as the repository's poll error.

Before the start, the service resolves the worker and checks its `provider/model/level` against the mapped host's provider catalog. Any problem, whether only an operator can fix it (an unconfigured role, a model the host lacks, a reasoning level bb does not know) or it may pass (an offline host, a catalog that failed to load), stays on the queued job as its error, before any label or spawn. The job retries on every sweep and starts once the problem is gone.

**No duplicate threads or GitHub writes.** Every effect, the spawn included, is claimed before it runs. The engine writes `tries + 1` and a lease to the row, then makes the call, then settles the outcome. After a crash the lease expires and the next claim probes for the effect's trace before running it again. A pushed commit is found as the remote branch at that commit, a pull request as any pull request from the head branch, and a comment as an App comment that carries the effect's key in an HTML marker. A probe that finds nothing lets a push, a pull request, or a comment run again. A spawn never runs twice, because no SDK error proves the thread was not created. Its probe looks for a thread in the job's project whose plugin metadata names the job, created since the job was and not bound to another job. It reads each page's metadata in one `threads.experimental_listPluginMetadata` call, and stops paging at the first unpinned thread older than the job, because bb lists pinned threads first and then newest first. If none appears within 5 minutes of the first claim, the job moves to `stuck`. A thread that names a job not waiting for it is stopped. Metadata only points at a job. The store's thread binding, not metadata, decides who may report.

**A job ends only for safety or by a person.** The goal is a pull request, so nothing that may pass ends a job and throws its work away. A worker that runs long keeps working: `deadline` is recorded but no longer enforced. A worker thread in an error state, such as one whose provider ran out of quota, leaves the job waiting with the reason as its error, because bb retries the turn and the thread may come back and report. A role or host problem keeps the job queued with its error until it is fixed. The job moves to `stuck` only when its worker thread is archived or deleted, its branch is gone from GitHub, a write cannot be confirmed, or its feedback rounds run out.

**Limits.** These are constants:

- No cap on concurrent jobs in pstack. A queued job starts as soon as its worker resolves, and bb's per-machine and global concurrency limits decide when worker threads run.
- Two reminders to an idle worker that has not reported. After them the job keeps waiting, with the reason as its error.
- 5 feedback rounds per pull request (`MAX_FEEDBACK_ROUNDS`). New feedback after the fifth sticks the job with the reason.
- 2 minutes of quiet after the newest pending feedback (`FEEDBACK_QUIET_MS`) before a round starts.

Past the feedback round limit the job moves to `stuck`, which stops the worker and removes its status labels. Later steps make the limits settings and add 3 CI rounds.

**Reminders.** A `/poteto-mode` worker goes idle while its own pstack runs and child threads work, and their results wake it. An idle worker with an active run or child is waiting, not stopped, and gets no reminder. When it has stopped without reporting, the reminder also names `gate pr`'s open steps if the gate fails. This is the only reminder an issue worker gets: the checklist's idle nudge skips every thread pstack launched, so it never wakes a worker whose job has ended.

**Draft and ready.** The pull request opens as a draft. The service marks it ready after the first round once CI on its head commit passes. This differs from Opening a PR, which opens every pull request ready. Here the service owns readiness, and a red first push is common.

**Store.** The migrations in `src/store.ts` hold four tables:

- `issue_repos`: repository, the label poll cursor (`since` and the ETag), the last poll time, and the last poll error. Its `feedback_json` column is no longer read.
- `issue_job_polls`: one row per polled job: its cursor, its pull request's last state, when it was last polled, and the last error.
- `issue_jobs`: one row per label event, unique on the event id. It holds the trigger, the issue snapshot, project, host, branch, generation, state, the outbox and its claim bookkeeping (`effects_json`, `effect_tries`, `effect_first_at`, `effect_lease_until`, `effect_next_at`), thread, deadline, rejections, reminders, the accepted report, the pushed commit, the pull request, the current round and its base, the worker's settings, the last error, and a version for compare-and-set writes. Its `CHECK` state lists repeat `job.ts`, and a test fails when they disagree. Step 2 rebuilt the table, because SQLite cannot alter a `CHECK`; existing jobs are in round 1.
- `issue_rounds`: one row per round, keyed by job and ordinal. It holds the kind (`initial` or `feedback`), when the round started, the branch head it started from, the accepted report, the commit it pushed, and when it ended.
- `issue_feedback`: one row per counted review, inline comment, or conversation comment that mentions the App, keyed by repository, kind, and GitHub id, which dedupes repeated polls. It holds the job, the pull request, the author, the body, and the file, line, diff hunk and review of an inline comment. A follow-up also holds the thread comment it answers, with that comment's author and text. Each row records when it was made and when it became visible. `round` is null while the item waits, and is set to the round that sent it.

`store.write` is the one write path for the job, its rounds and its feedback's round. In one transaction it updates the job, and a round start inserts the round's row and marks its feedback. The current round's row then records the report, the pushed commit, and the end when the change says so. The items a round must answer are the feedback rows marked with it, so the round has no second list that could disagree.

A label from a user without write access becomes an `ignored` row with the reason, so `bb pstack issues list --all` explains why a label did nothing. There is no separate outbox table. The outbox has one writer, the job, so it lives on the job's row.

**Modules.** The feature lives under `src/issues/`:

- `job.ts`: the state machine, `plan`, `settle`, `acceptReport`, `EFFECT_POLICY`, the report schemas, and which feedback and commands count. Pure.
- `text.ts`: the worker and round prompts, the reminder, and the checks and sanitizing applied to everything posted on GitHub. Pure.
- `store.ts`: SQL for `issue_repos`, `issue_jobs`, `issue_rounds`, and `issue_feedback`.
- `github.ts`: the GitHub App client. It owns the App JWT, installation tokens, ETags, pagination, rate limits, and the permission cache, and maps responses to domain types and three error classes.
- `engine.ts`: `createIssues()`, the one surface `server.ts` uses. It returns the CLI commands, `register()` for thread events and the `pstack-issues` service, `instructions(threadId)`, and `sweep()`, one awaited pass of the service for tests. Its `EFFECTS` table says how to perform and probe each effect; a missing entry or a probe its policy does not use fails the build.
- `commands.ts`: `bb pstack issues` and the settings.

The engine tests share `engine-harness.ts`, a loopback fake GitHub and a fake bb SDK. `engine.test.ts` covers the first round and `engine.feedback.test.ts` the feedback rounds.

The host entry is `src/host.ts`, and its contract is in `src/host-contract.ts`. `src/thread-files.ts` reads a file on the invoking thread's machine for both `run start --file` and `issues report --file`. The UI panel comes last and reads jobs over RPC like the run views.

## Rollout

1. App auth, polling for labeled issues, store, spawn, `report`, push, and draft pull request on one sandbox repository.
2. Feedback rounds: reviews and comments, debounce, replies, and review re-requests. Built.
3. `needs-info` answers, stopping when the label is removed, labels, the status comment, and draft to ready.
4. CI failures and merge conflicts as round triggers.
5. The jobs panel in the pstack UI.

## Tradeoffs accepted

- We accept up to 60 s of latency plus a 2 minute debounce, in exchange for no public endpoint and no lost events after downtime.
- We accept a job that stops at `stuck` after an ambiguous spawn failure, in exchange for never running two workers on one branch.
- We accept that the token briefly exists in the host plugin process and the git child processes during a push, in exchange for a plain `git push` that handles binaries, renames, and file modes. The worker probably runs as the same OS user as the host daemon, so it could read the token from `/proc/<pid>/environ` while a push runs. The token is limited to one repository and `contents: write` and is revoked when the push returns, so the exposure is normally one repository's branches for the length of one push. If the server stops mid-push, the revoke never runs and the token stays valid until it expires, up to one hour. Branch protection on the default branch limits it further.
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
- Workers use the project's default permission mode. A project whose default is `accept-edits` may stall an unattended worker on approval prompts until the round's 4 hours run out.
- Whether bb logs host RPC payloads, which carry the push token, is unverified.
- The reminder to an idle worker compares the thread's `updatedAt` with the job's last write. If bb does not bump `updatedAt` when a turn ends, no reminder is sent and the job sticks at the round's deadline instead. When pstack cannot count the worker's active runs and children, it treats the worker as waiting, with the same fallback.
- The spawn probe's early stop relies on bb listing pinned threads first and then newest first. That order is observed, not documented. If it changes, the probe can miss a late thread, and the job sticks after the spawn's grace period.
- Whether bb fetches before creating a worktree from `origin/<base>` is unverified. A stale remote-tracking ref only makes the worker start from an older base; the new-commit check measures against the same ref.
- The host RPC API is experimental. A breaking SDK change affects only `src/host.ts` and its contract.
- A replacement worker starts from `origin/<branch>`. If the host's checkout has never fetched the branch, the spawn fails, and the job sticks after the spawn's grace period. A stale fetch only earns the worker a note to merge.
- Whether a round's commit contains its base is read from the commits `environments.status` lists ahead of `origin/<base>`. Whether bb caps that list is unverified. A cap could reject a report that contains the base when the worker added many commits.
- Answering a follow-up on the comment its `in_reply_to_id` names assumes GitHub sets that field to the thread's first comment for replies made in the web UI. The REST docs require a top-level comment for replies but do not say what `in_reply_to_id` holds for a reply to a reply.
- Feedback is stored when it is polled. A review dismissed after that, but before its round starts, is still sent and answered.
- The round message is queued behind a turn that is still running, never steered into it. A worker that never goes idle sticks at the round's deadline.
