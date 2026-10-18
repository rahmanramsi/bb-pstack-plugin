---
name: github
description: "Use for any GitHub operation from an agent thread when pstack's GitHub App is configured: push a branch, fetch, open, view, edit, comment on, reply to or merge a pull request, read or comment on an issue, or read CI checks. Agents hold no GitHub token, so plain `git push`, `gh` and `gh api` are not authenticated; `bb pstack gh` acts as the pstack GitHub App instead."
---

# GitHub through pstack

**Agents hold no GitHub token. Every GitHub write and every private read goes through `bb pstack gh`, which acts as the pstack GitHub App on the repository behind this worktree's `origin`.**

pstack mints a short-lived installation token for each call and keeps it on the server or inside one git child process on your machine. It never reaches your environment, so there is nothing to export, cache or print. A plain `git push`, `gh pr create` or `gh api` fails for lack of credentials. Do not try to log in, look for a token, or ask for one. Use the commands below.

The repository comes from `remote.origin.url` in this worktree's own git config and must be on github.com. Run the commands from the thread that owns the worktree. Work on another repository from a thread in that repository's project.

## Commands

| Need | Command |
|---|---|
| Update `origin/*` | `bb pstack gh fetch` |
| Publish your branch | `bb pstack gh push [--branch <name>] [--force-with-lease]` |
| Open a pull request | `bb pstack gh pr create --title <title> --body-file <file> [--base <branch>] [--draft]` |
| Read a pull request | `bb pstack gh pr view [<number>] [--json]` |
| Change title, description or base | `bb pstack gh pr edit [<number>] [--title …] [--base …] [--body-file …]` |
| Comment on a pull request | `bb pstack gh pr comment [<number>] --body-file <file>` |
| Read reviews and inline threads | `bb pstack gh pr feedback [<number>] [--json]` |
| Answer an inline review thread | `bb pstack gh pr reply <number> <thread-id> --body-file <file>` (the id `pr feedback` prints as `thread <id>`) |
| Merge | `bb pstack gh pr merge <number> [--method squash\|merge\|rebase] [--sha <verified-head>]` |
| Read an issue and its comments | `bb pstack gh issue view <number> [--json]` |
| Comment on an issue | `bb pstack gh issue comment <number> --body-file <file>` |
| CI status | `bb pstack gh checks [<pr-number>] [--json]` |

A pull request number defaults to the one whose head is your current branch. Put Markdown in a file and pass `--body-file`, since a body written inline in a shell command breaks on quotes and backticks. `--body` is fine for one short line.

## Rules the commands enforce

- **Push publishes committed HEAD only.** Commit first. Uncommitted changes stay local, and the output says so.
- **No blind force push.** The remote branch must be absent or an ancestor of HEAD. When someone else pushed, `push` is rejected with `not-descendant` or `stale-remote`: run `bb pstack gh fetch`, rebase or merge `origin/<branch>`, and push again. After a rebase you made on purpose, `push --force-with-lease` replaces the branch, but only while it is still at the commit pstack read just before the push.
- **The default branch is never pushed.** Land changes through a pull request.
- **Pull requests open ready for review.** Pass `--draft` only when the playbook asks for a draft.
- **In poteto mode, `pr create` waits for `bb pstack gate pr`.** It refuses while checklist steps are open, the same as the gate itself.
- **Merges are pinned to a head.** `pr merge` merges only while the head is the commit you verified (`--sha`, defaulting to the head it reads now). Branch protection and required checks still apply.
- **Issue workers do not push, open, edit or merge.** An issue worker hands its result to `bb pstack issues report`, and pstack pushes and opens the pull request itself.

## When a command fails

- `pstack has no GitHub App`: a person has to set `githubAppId` and `githubPrivateKey` in the pstack plugin settings.
- `the GitHub App installation for <repo> is gone`, or another setup error: the App is not installed on that repository. Tell the user. Do not look for another way in.
- `403` with `lack a permission`: the App was installed without the permission this operation needs, such as checks, pull requests, issues or workflows. Report which operation failed. A person grants the permission in the App's settings.
- `push rejected (remote-rejected)`: a branch rule, hook, or a workflow file under `.github/workflows` that the App may not write. Read the detail and fix the cause. Do not retry unchanged.
- `push failed` or `fetch failed` with nothing refused: a network problem. Retry once.

Operations not listed here, such as releases, labels, review requests or arbitrary API calls, are not available to agents. Say what you need and leave it to a person.
