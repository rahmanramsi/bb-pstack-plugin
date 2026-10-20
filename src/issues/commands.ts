/**
 * `bb pstack issues …` and the issue settings. Decisions come from job.ts; the operations from engine.ts.
 */
import { PluginCliError, cliCommand, type BbPluginApi, type PluginCliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readThreadFile } from "../thread-files.ts";
import { issueBoard, listed, repoView, type ListedJob, type RepoView } from "./board.ts";
import { FEEDBACK_QUIET_MS, JOB_ID, MAX_FEEDBACK_ROUNDS, machineLabel, type JobId, type JobState, type JobView, type RepoName } from "./job.ts";
import type { IssueStore } from "./store.ts";

/** What `bb pstack issues adopt` did: a new job, the open job that already owns the pull request, or why neither. */
export type AdoptOutcome = { kind: "adopted"; job: JobView; generation: number } | { kind: "already"; job: JobView } | { kind: "refused"; reasons: string[] };

/** `hostId` null: each job's machine is picked when the job starts. */
export type RepoMapping = { repo: RepoName; projectId: string; hostId: string | null };

/** `issueRepos`: one `owner/name project=<id> [host=<id>|host=auto]` line per repository; `#` starts a comment. */
export function parseIssueRepos(text: string): { ok: true; repos: RepoMapping[] } | { ok: false; errors: string[] } {
  const repos: RepoMapping[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") return;
    const match = /^([\w.-]+\/[\w.-]+)\s+project=(\S+)(?:\s+host=(\S+))?$/.exec(line);
    if (!match) {
      errors.push(`line ${index + 1}: expected "owner/name project=<projectId> [host=<hostId>|host=auto]"`);
      return;
    }
    const repo = match[1]!.toLowerCase() as RepoName;
    const host = match[3];
    if (repos.some((existing) => existing.repo === repo)) errors.push(`line ${index + 1}: ${repo} appears twice`);
    else repos.push({ repo, projectId: match[2]!, hostId: host === undefined || host === "auto" ? null : host });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, repos };
}

/**
 * Spread into the plugin's single bb.settings.define call. A secret cannot be multi-line, so the private key is stored
 * as base64 of the PEM. Schemas are synchronous and do not transform.
 */
export const ISSUE_SETTINGS = {
  githubAppId: {
    type: "string",
    label: "GitHub App id",
    description: "Numeric id of the GitHub App that pstack acts as for issue workers.",
    experimental_schema: z.string().regex(/^(\d+)?$/, "a number"),
    default: "",
  },
  githubPrivateKey: {
    type: "string",
    label: "GitHub App private key",
    description: "The App's PEM private key, base64-encoded on one line: base64 -w0 app.private-key.pem",
    secret: true,
    default: "",
  },
  issueRepos: {
    type: "string",
    label: "Issue repositories",
    description:
      "One `owner/name project=<projectId> [host=<hostId>]` line per repository where pstack runs issue workers. Without `host=`, or with `host=auto`, each job runs on the machine with the most free slots among those with a checkout of the project and the issue worker's model, never the bb server's machine. The agent label starts work automatically; open issues can also be started from the Issues panel.",
    experimental_multiline: true,
    experimental_schema: z.string().superRefine((value, ctx) => {
      const parsed = parseIssueRepos(value);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.errors.join("; ") });
    }),
    default: "",
  },
} as const;

function jobId(value: string): JobId {
  if (JOB_ID.test(value)) return value as JobId;
  throw new PluginCliError(`"${value}" is not an issue job id`, {
    code: "invalid_job_id",
    hint: "Job ids look like psi_ followed by a UUID, as printed by `bb pstack issues list`.",
  });
}

function age(from: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function stateLabel(job: JobView): string {
  if (!job.next) return job.state;
  const retry = job.next.retryAt ? `, retry ${new Date(job.next.retryAt).toISOString().slice(11, 16)}` : "";
  return `${job.state} → ${job.next.state}: ${job.next.op}${job.next.tries > 0 ? `, try ${job.next.tries + 1}` : ""}${retry}`;
}

const ROW_ERRORS: ReadonlySet<JobState> = new Set(["ignored", "stuck", "queued", "review"]);

function formatList(repos: readonly RepoView[], jobs: readonly ListedJob[], now: number): string {
  if (repos.length === 0 && jobs.length === 0) return "No issue jobs.";
  return repos
    .map(({ repo, polledAt, error }) => {
      const header = `${repo}  ${polledAt === null ? "not polled yet" : `polled ${age(polledAt, now)}`}`;
      const rows = jobs
        .filter((job) => job.repo === repo)
        .map((job) => {
          const parts = [`#${job.issue}`, stateLabel(job), machineLabel(job.host), job.pr ? `PR #${job.pr.number}` : null, job.threadId, job.id, age(job.createdAt, now)];
          const detail = ROW_ERRORS.has(job.state) ? job.error : null;
          const row = `  ${parts.filter(Boolean).join("  ")}${detail ? `  ${detail}` : ""}`;
          return job.poll.error ? `${row}\n    poll error: ${job.poll.error}` : row;
        });
      return [header, ...(error ? [`  poll error: ${error}`] : []), ...rows].join("\n");
    })
    .join("\n\n");
}

function formatShow(job: ListedJob, repo: RepoView, now: number): string {
  const rows: [string, string | null][] = [
    ["state", stateLabel(job)],
    ["issue", job.issueUrl],
    ["triggered by", `@${job.triggeredBy}`],
    ["branch", job.branch],
    ["machine", job.host.id === null ? "picked when the job starts" : `${job.host.id} (${job.host.pinned ? "pinned by issueRepos" : "picked automatically"})`],
    ["thread", job.threadId],
    ["pull request", job.pr?.url ?? null],
    ["pushed", job.pushedSha],
    ["round", job.round > 1 ? `feedback round ${job.round - 1} of ${MAX_FEEDBACK_ROUNDS}` : null],
    ["summary", job.summary],
    ["outcome", job.outcome],
    ["limitation", job.limitation],
    ["delivery", job.delivery.error ?? (job.delivery.pending ? "pending" : "delivered")],
    ["error", job.error],
    ["polled", job.poll.polledAt === null ? "not yet" : age(job.poll.polledAt, now)],
    ["poll error", job.poll.error],
    ["repo polled", repo.polledAt === null ? "not yet" : age(repo.polledAt, now)],
    ["repo error", repo.error],
  ];
  return [`${job.id} ${job.repo}#${job.issue}`, ...rows.filter(([, value]) => value).map(([label, value]) => `  ${label.padEnd(12)}  ${value}`)].join("\n");
}

export function issueCommands(deps: {
  bb: BbPluginApi;
  store: IssueStore;
  /** The configured repositories, listed even before they have jobs. */
  repos: () => readonly RepoMapping[];
  clock: () => number;
  report(threadId: string, text: string): Promise<{ ok: true; message: string } | { ok: false; code: string; message: string }>;
  sync(threadId: string): Promise<{ ok: true; message: string } | { ok: false; code: string; message: string }>;
  stop(id: JobId, by: string): Promise<boolean>;
  retry(id: JobId, by: string): Promise<{ ok: true; id: JobId } | { ok: false; code: string; message: string }>;
  adopt(input: { repo: string; pr: number; issue: number | null }): Promise<AdoptOutcome>;
}): Record<string, PluginCliCommand> {
  const { bb, store } = deps;
  const json = (value: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });

  return {
    "issues list": cliCommand({
      summary: "List each repository's last poll and its issue jobs with their state, pull request and worker thread",
      options: {
        repo: { type: "string", description: "Only this owner/name" },
        all: { type: "boolean", description: "Include finished, stopped and ignored jobs, and stuck jobs a newer job for the issue replaced" },
        json: { type: "boolean", description: "Emit { repos, jobs } as JSON" },
      },
      run(input) {
        const only = input.options.repo?.toLowerCase() as RepoName | undefined;
        const board = issueBoard(store, deps.repos().map((mapping) => mapping.repo), { repo: only, all: input.options.all ?? false });
        return input.options.json ? json(board) : { exitCode: 0, stdout: `${formatList(board.repos, board.jobs, deps.clock())}\n` };
      },
    }),
    "issues show": cliCommand({
      summary: "Show one issue job: thread, branch, pull request, pending GitHub write, last error, and the last polls of its issue, pull request and repository",
      positionals: [{ name: "job", description: "Job id (psi_…)", required: true }],
      options: { json: { type: "boolean", description: "Emit the job view as JSON" } },
      run(input) {
        const job = store.get(jobId(input.positionals.job));
        if (!job) throw new PluginCliError(`no issue job ${input.positionals.job}`, { code: "job_not_found" });
        const view = listed(store, job);
        return input.options.json ? json(view) : { exitCode: 0, stdout: `${formatShow(view, repoView(store, job.repo), deps.clock())}\n` };
      },
    }),
    "issues stop": cliCommand({
      summary: "Stop an issue job: stop its worker and remove agent:working from the issue",
      positionals: [{ name: "job", description: "Job id (psi_…)", required: true }],
      async run(input, ctx) {
        const id = jobId(input.positionals.job);
        if (ctx.threadId && store.byThread(ctx.threadId)) {
          throw new PluginCliError("an issue worker cannot stop issue jobs", { code: "worker_cannot_stop" });
        }
        if (!store.get(id)) throw new PluginCliError(`no issue job ${id}`, { code: "job_not_found" });
        const stopped = await deps.stop(id, ctx.threadId ? `thread ${ctx.threadId}` : "the bb CLI");
        return { exitCode: 0, stdout: stopped ? `Stopping ${id}.\n` : `${id} already ended.\n` };
      },
    }),
    "issues retry": cliCommand({
      summary: "Start a new job for the issue of a stuck or stopped job, once the cause is fixed",
      positionals: [{ name: "job", description: "Job id (psi_…)", required: true }],
      async run(input, ctx) {
        const id = jobId(input.positionals.job);
        if (ctx.threadId && store.byThread(ctx.threadId)) {
          throw new PluginCliError("an issue worker cannot retry issue jobs", { code: "worker_cannot_retry" });
        }
        const result = await deps.retry(id, ctx.threadId ? `thread ${ctx.threadId}` : "the bb CLI");
        if (!result.ok) throw new PluginCliError(result.message, { code: result.code });
        return { exitCode: 0, stdout: `Retrying ${id} as ${result.id}.\n` };
      },
    }),
    "issues adopt": cliCommand({
      summary: "Give an open pull request the App opened to a new issue job, which answers its review feedback",
      description:
        `For a pull request whose job ended, such as a stuck one. The pull request must be open, opened by the App from this repository's agent/issue-<n>-<slug> branch against the default branch, and its issue open. The job waits until review feedback has been quiet for ${FEEDBACK_QUIET_MS / 60_000} minutes, then starts a worker from the default branch that merges the pull request's branch and answers the feedback as feedback round 1. Adopting a pull request again prints the job that owns it.`,
      options: {
        repo: { type: "string", required: true, description: "owner/name, as configured in issueRepos" },
        pr: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, required: true, description: "The pull request's number" },
        issue: { type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER, description: "The issue it resolves; must match the number in its branch, which is the default" },
        json: { type: "boolean", description: "Emit { kind, job } as JSON" },
      },
      async run(input, ctx) {
        if (ctx.threadId && store.byThread(ctx.threadId)) {
          throw new PluginCliError("an issue worker cannot adopt pull requests", { code: "worker_cannot_adopt" });
        }
        const pr = input.options.pr!;
        const result = await deps.adopt({ repo: input.options.repo!.toLowerCase(), pr, issue: input.options.issue ?? null });
        if (result.kind === "refused") {
          throw new PluginCliError([`PR #${pr} cannot be adopted:`, ...result.reasons.map((reason) => `  - ${reason}`)].join("\n"), { code: "adopt_refused" });
        }
        if (input.options.json) return json(result);
        const { job } = result;
        if (result.kind === "already") return { exitCode: 0, stdout: `PR #${pr} is already owned by ${job.id} (${job.state}).\n` };
        const quiet = FEEDBACK_QUIET_MS / 60_000;
        return { exitCode: 0, stdout: `Adopted PR #${pr} (${job.branch}) for issue #${job.issue} as ${job.id}; generation ${result.generation}.\nIts first feedback round starts once review feedback has been quiet for ${quiet} minutes.\n` };
      },
    }),
    "issues report": cliCommand({
      summary: "Issue workers only: hand your result to pstack, which pushes your commit and opens the pull request",
      description:
        "Write the report JSON to a file on this machine and pass its path. A rejected report exits 1 with every reason; fix them and report again. The second rejection ends the job.",
      options: {
        file: { type: "string", description: "Report JSON on this thread's machine; a relative path resolves against the current directory" },
      },
      constraints: [{ kind: "exactly-one", options: ["file"] }],
      async run(input, ctx) {
        if (!ctx.threadId) throw new PluginCliError("only an issue worker thread can report", { code: "thread_required" });
        const text = await readThreadFile(bb, { threadId: ctx.threadId, cwd: ctx.cwd, path: input.options.file!, errorCode: "report_file_unreadable" });
        const result = await deps.report(ctx.threadId, text);
        if (!result.ok) throw new PluginCliError(result.message, { code: result.code });
        return { exitCode: 0, stdout: `${result.message}\n` };
      },
    }),
    "issues sync": cliCommand({
      summary: "Issue workers only: while the pull request is in review, have pstack push a merge that resolves a conflict",
      description:
        "Commit the merge of origin/<base> (or of the branch's head on GitHub) first. HEAD must contain the branch's head on GitHub, so the push only adds commits. It is not a feedback round: no replies are posted and no review is requested.",
      async run(_input, ctx) {
        if (!ctx.threadId) throw new PluginCliError("only an issue worker thread can sync", { code: "thread_required" });
        const result = await deps.sync(ctx.threadId);
        if (!result.ok) throw new PluginCliError(result.message, { code: result.code });
        return { exitCode: 0, stdout: `${result.message}\n` };
      },
    }),
  };
}
