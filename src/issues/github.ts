/**
 * The GitHub App client. createGitHub(...).repo(name) returns a client that holds a valid installation token for that
 * repository. App JWTs, installation lookup, token caching, ETags, pagination, rate-limit headers, the permission
 * cache and the REST wire format stay in here. Callers see domain types and three error classes.
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { z } from "zod";
import type { PolledFeedback, PullState, RepoName, Sha } from "./job.ts";
import { CONVENTIONAL_TITLE } from "./text.ts";

export type GitHubCredentials = { appId: string; privateKey: string };

export type GitHubOptions = {
  /** Null while unset. Throws GitHubSetupError when the settings are present but unusable. */
  credentials: () => GitHubCredentials | null;
  fetch?: typeof globalThis.fetch;
  /** Default https://api.github.com. */
  apiUrl?: string;
  /** Default https://github.com. */
  gitUrl?: string;
  clock?: () => number;
  /** Default 20 s. Each request is aborted after this long, so a hung connection cannot hold a job's effect. */
  requestTimeoutMs?: number;
};

/** 5xx, 429, rate limits and network errors. `notBefore` comes from Retry-After or X-RateLimit-Reset. */
export class GitHubTransientError extends Error {
  readonly notBefore: number | null;
  readonly uncertain: boolean;
  constructor(message: string, notBefore: number | null, uncertain = false) {
    super(message);
    this.notBefore = notBefore;
    this.uncertain = uncertain;
  }
}

/** A response that retrying will not change. */
export class GitHubPermanentError extends Error {
  readonly status: number;
  readonly code: "denied" | "missing-capability" | "invalid" | "not-found";
  constructor(message: string, status: number, code: GitHubPermanentError["code"] = status === 401 || status === 403 ? "denied" : status === 404 ? "not-found" : "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The App is not installed on the repository, or its credentials are missing or rejected. */
export class GitHubSetupError extends Error {}

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export const CAN_TRIGGER: ReadonlySet<Permission> = new Set(["admin", "maintain", "write"]);

/** `subIssues` counts the issue's sub-issues, open or closed. */
export type LabeledIssue = { number: number; title: string; body: string; url: string; author: string; updatedAt: number; subIssues: number };
export type RepositoryIssue = LabeledIssue & { state: "open" | "closed"; labels: string[] };
/** A sub-issue in this repository, without its blockers. */
export type ListedSubIssue = { number: number; title: string; body: string; url: string; author: string; state: "open" | "closed" };
export type LabelEvent = { id: number; actor: string; at: number };
/** Opaque to callers, who store it and hand it back. */
export type PollCursor = { readonly __brand: "PollCursor" };
/** Opaque to callers, like PollCursor: one job's list cursors, ETags, and its pull request's last known reviews. */
export type ActivityCursor = { readonly __brand: "ActivityCursor" };
export type PullDetail = {
  number: number; url: string; title: string; body: string; author: string; state: PullState; draft: boolean;
  head: string; headSha: string; base: string;
  /** `owner/name` of the head branch's repository, lowercased; null when that fork was deleted. */
  headRepo: string | null;
};
export type IssueDetail = {
  number: number; url: string; title: string; body: string; author: string; state: "open" | "closed"; labels: string[];
  pull: boolean; comments: PolledComment[];
};
export type PullFeedback = {
  reviews: { id: number; author: string; state: string; body: string; submittedAt: number }[];
  inline: { id: number; author: string; path: string; line: number | null; inReplyTo: number | null; body: string; createdAt: number }[];
  conversation: PolledComment[];
};
/** `conclusion` is null while the check runs. */
export type CheckResult = { name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null; url: string | null };

/** A comment in an issue's conversation. */
export type PolledComment = { id: number; author: string; body: string; createdAt: number };

const WireSha = z.string().regex(/^[0-9a-f]{40}$/).transform((value) => value as Sha);
const WireRepo = z.string().regex(/^[^/\s]+\/[^/\s]+$/).transform((value) => value.toLowerCase() as RepoName);
const GrantSchema = z.enum(["none", "read", "write"]);
export type Grant = z.infer<typeof GrantSchema>;
const TargetSchema = z.object({ pr: z.number().int().positive(), head: WireSha, base: WireSha });
export type Target = z.infer<typeof TargetSchema>;
const CapabilitiesSchema = z.object({
  repositoryId: z.number().int().positive(), archived: z.boolean(), defaultBranch: z.string().min(1),
  defaultHead: WireSha, observedAt: z.number(),
  permissions: z.object({ contents: GrantSchema, issues: GrantSchema, pullRequests: GrantSchema,
    workflows: GrantSchema, checks: GrantSchema, statuses: GrantSchema }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
const CheckStateSchema = z.enum(["pending", "success", "neutral", "skipped", "failure", "cancelled", "unknown"]);
export type CheckState = z.infer<typeof CheckStateSchema>;
const CheckSchema = z.object({
  id: z.string(), name: z.string(), source: z.enum(["check-run", "status"]), appId: z.number().nullable(),
  head: WireSha, state: CheckStateSchema, url: z.string().nullable(),
});
export type Check = z.infer<typeof CheckSchema>;
const RequiredCheckSchema = z.object({
  name: z.string(), source: z.enum(["check-run", "status", "either"]), appId: z.number().nullable(),
  accepted: z.array(z.enum(["success", "neutral", "skipped"])).readonly(),
});
export type RequiredCheck = z.infer<typeof RequiredCheckSchema>;
const ReviewSnapshotSchema = TargetSchema.extend({
  url: z.string(), state: z.enum(["open", "merged", "closed"]), draft: z.boolean(),
  headRepository: WireRepo.nullable(), headBranch: z.string(), baseBranch: z.string(),
  mergeability: z.enum(["clean", "conflicting", "unknown"]), observedAt: z.number(), complete: z.boolean(),
  checks: z.array(CheckSchema).readonly(),
  required: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), checks: z.array(RequiredCheckSchema).readonly(), blockers: z.array(z.string()).readonly() }),
    z.object({ kind: z.literal("unavailable"), reason: z.string(),
      checks: z.array(RequiredCheckSchema).readonly().optional(), blockers: z.array(z.string()).readonly().optional() }),
  ]),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;
export type DraftResult =
  | { kind: "observed" | "stale" | "closed"; snapshot: ReviewSnapshot }
  | { kind: "missing" };

export type RepoClient = {
  readonly name: RepoName;
  capabilities(input: { fresh: boolean }): Promise<Capabilities>;
  reviewSnapshot(pr: number): Promise<ReviewSnapshot | null>;
  setDraft(input: { expected: Target; draft: boolean }): Promise<DraftResult>;
  upsertIssueStatus(input: { issue: number; marker: string; revision: number; body: string }): Promise<{ commentId: number }>;
  /** All issues, including closed ones, excluding pull requests. Cached for one minute unless fresh. */
  repositoryIssues(fresh?: boolean): Promise<RepositoryIssue[]>;
  /** `<slug>[bot]`. Events by it are never triggers. */
  appLogin(): Promise<string>;
  /**
   * Open issues labeled `label` updated since the cursor, pull requests dropped. A 304 returns `changed: false` and
   * costs no rate limit. The boundary item can be read twice; triggers dedupe on the event id.
   */
  labeledIssues(label: string, cursor: PollCursor | null): Promise<{ changed: false } | { changed: true; issues: LabeledIssue[]; next: PollCursor }>;
  latestLabelEvent(issue: number, label: string): Promise<LabelEvent | null>;
  /** Cached 10 minutes per user. */
  permission(user: string): Promise<Permission>;
  /** Cached 1 hour. */
  defaultBranch(): Promise<string>;
  /** Cached 1 hour. Conventional when most of the last 20 merged pull requests' titles follow Conventional Commits. */
  titleConvention(): Promise<"conventional" | "free">;
  branchSha(branch: string): Promise<Sha | null>;
  /** A pull request, open or closed, whose head is this repository's `branch`. */
  findPull(branch: string): Promise<{ number: number; url: string } | null>;
  /** An issue comment by the App whose last line is `marker`, posted at or after `since`. */
  findComment(issue: number, marker: string, since: number): Promise<{ id: number } | null>;
  /** An inline review comment by the App on pull request `pr` whose last line is `marker`, posted at or after `since`. */
  findReviewComment(pr: number, marker: string, since: number): Promise<{ id: number } | null>;
  /**
   * One job's activity since the cursor: the issue's comments, from `since` on the first read, and, once the job has
   * a pull request, its reviews, inline comments and conversation comments, and its state. Unchanged lists answer 304
   * and cost no rate limit. Items can repeat across calls; callers dedupe on the id.
   */
  activity(
    target: { issue: number; since: number; pr: number | null },
    cursor: ActivityCursor | null,
  ): Promise<{ issueComments: PolledComment[]; pull: { state: PullState; items: PolledFeedback[] } | null; next: ActivityCursor }>;
  /** An issue's state and labels. */
  issue(issue: number): Promise<{ open: boolean; labels: string[] }>;
  /** The issue's sub-issues in this repository; ones in another repository are left out. */
  subIssues(issue: number): Promise<ListedSubIssue[]>;
  /** The issue's open blockers, as `#n` in this repository or `owner/repo#n` in another. */
  blockedBy(issue: number): Promise<string[]>;
  closeIssue(issue: number): Promise<void>;
  editComment(id: number, body: string): Promise<void>;
  addLabels(issue: number, labels: readonly string[]): Promise<void>;
  /** A label that is not on the issue is success. */
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<{ id: number }>;
  createDraftPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  createPull(input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  editPull(pr: number, input: { title?: string; body?: string; base?: string }): Promise<void>;
  /** Merges an open pull request whose head is still `sha`. GitHub answers 405 when it cannot merge, 409 when the head moved. */
  mergePull(pr: number, input: { sha: string; method: "merge" | "squash" | "rebase" }): Promise<{ sha: string }>;
  /** A pull request with its head commit, or null when there is none with that number. */
  pull(pr: number): Promise<PullDetail | null>;
  /** The newest pull request, open or closed, whose head is this repository's `branch`. */
  pullForBranch(branch: string): Promise<PullDetail | null>;
  /** An issue with its conversation, or null when there is none with that number. Pull requests are issues too. */
  issueDetail(issue: number): Promise<IssueDetail | null>;
  closePull(pr: number): Promise<void>;
  /** A branch that does not exist is success. */
  deleteBranch(branch: string): Promise<void>;
  /** A pull request's reviews, inline review comments and conversation comments, oldest first. */
  feedback(pr: number): Promise<PullFeedback>;
  /** Check runs and commit statuses on a commit. */
  checks(sha: string): Promise<CheckResult[]>;
  /** A fresh token for this one repository with only `contents: read`, and the HTTPS remote. Revoke it after the fetch. */
  fetchCredentials(): Promise<{ remoteUrl: string; token: string }>;
  /** Answers in an inline thread. `commentId` must be the thread's first comment: GitHub refuses replies to replies. */
  replyToReviewComment(pr: number, commentId: number, body: string): Promise<{ id: number }>;
  /** An inline review comment's author and text, or null when it no longer exists. */
  reviewComment(id: number): Promise<{ author: string; body: string } | null>;
  /** Requests a review from each user who can be asked; a user GitHub refuses (422) is dropped, not an error. */
  requestReviewers(pr: number, reviewers: readonly string[]): Promise<{ requested: string[]; dropped: string[] }>;
  /** A fresh token for this repository with contents write and, only when requested and granted, workflows write. The caller revokes it. */
  pushCredentials(input?: { workflows: boolean }): Promise<{ remoteUrl: string; token: string }>;
  revoke(token: string): Promise<void>;
};

export type GitHub = {
  /** A client for one repository. With `signal`, every request it makes, token minting included, ends when it aborts. */
  repo(name: RepoName, signal?: AbortSignal): RepoClient;
};

type Cursor = { since: string | null; etag: string | null };
/** A review as last listed: its state, and when it was submitted. */
type KnownReview = { state: string; submittedAt: number };
type JobCursor = { issue: Cursor | null; pull: PullCursor | null };
type PullCursor = {
  reviewComments: Cursor | null;
  comments: Cursor | null;
  reviews: { etag: string | null; known: Record<string, KnownReview> } | null;
  pull: { etag: string | null; state: PullState } | null;
};
type Cached<T> = { value: T; until: number };
type RawLinkedIssue = { number: number; title: string; body?: string | null; user?: RawUser; html_url: string; state: string; repository_url?: string; repository?: { full_name: string } };
/** "owner/name" lowercased, from the issue's repository or its API URL. */
const repoOf = (item: RawLinkedIssue) => (item.repository?.full_name ?? item.repository_url?.replace(/^.*\/repos\//, "") ?? "").toLowerCase();

type RawUser = { login: string } | null;
type RawReviewComment = { id: number; body: string; user: RawUser; path: string; line: number | null; original_line?: number | null; diff_hunk: string; in_reply_to_id?: number; pull_request_review_id: number | null; created_at: string; updated_at: string };
type RawComment = { id: number; body: string | null; user: RawUser; created_at: string; updated_at: string };
type RawPull = {
  number: number; html_url: string; title: string; body: string | null; user: RawUser; state: string; draft?: boolean;
  merged_at?: string | null; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string };
};
const pullDetail = (json: RawPull): PullDetail => ({
  number: json.number, url: json.html_url, title: json.title, body: json.body ?? "", author: json.user?.login ?? "ghost",
  state: json.state === "open" ? "open" : json.merged_at ? "merged" : "closed", draft: json.draft ?? false,
  head: json.head.ref, headSha: json.head.sha, base: json.base.ref, headRepo: json.head.repo?.full_name.toLowerCase() ?? null,
});
type RawReview = { id: number; body: string | null; user: RawUser; state: string; submitted_at?: string | null };

/** Whether the last line of a body is `marker`: the App appends its marker there, after any text it quotes. */
const endsWith = (body: string, marker: string) => body.trimEnd().split("\n").at(-1) === marker;

const InstallationSchema = z.object({ id: z.number().int().positive(), permissions: z.record(z.string(), GrantSchema), suspended_at: z.string().nullable().optional() });
const RepositorySchema = z.object({ id: z.number().int().positive(), archived: z.boolean(), default_branch: z.string().min(1) });
const RefSchema = z.object({ object: z.object({ sha: WireSha }) });
const SnapshotPullSchema = z.object({
  number: z.number().int().positive(), node_id: z.string().min(1), html_url: z.string(), state: z.enum(["open", "closed"]),
  draft: z.boolean(), merged_at: z.string().nullable(), mergeable: z.boolean().nullable(), mergeable_state: z.string(),
  head: z.object({ sha: WireSha, ref: z.string(), repo: z.object({ full_name: WireRepo }).nullable() }),
  base: z.object({ sha: WireSha, ref: z.string(), repo: z.object({ full_name: WireRepo }) }),
});
type SnapshotPull = z.infer<typeof SnapshotPullSchema>;
const SuiteSchema = z.object({ id: z.number().int().positive(), head_sha: WireSha, status: z.string(), conclusion: z.string().nullable(), app: z.object({ id: z.number().int().positive(), slug: z.string().optional() }) });
const RunSchema = z.object({ id: z.number().int().positive(), name: z.string(), head_sha: WireSha,
  status: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable(), app: z.object({ id: z.number().int().positive() }) });
const StatusSchema = z.object({ id: z.number().int().positive(), context: z.string(), state: z.string(), target_url: z.string().nullable(), created_at: z.string().datetime() });
const StatusCommentSchema = z.object({ id: z.number().int().positive(), created_at: z.string().datetime(), body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  performed_via_github_app: z.object({ id: z.number().int().positive() }).nullable(), issue_url: z.string() });
const PolicyCheckSchema = z.object({ context: z.string(), app_id: z.number().nullable().optional(), integration_id: z.number().nullable().optional() });
const RulesSchema = z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }));
const RuleChecksSchema = z.object({ required_status_checks: z.array(PolicyCheckSchema), strict_required_status_checks_policy: z.boolean() });
const LegacyPolicySchema = z.object({
  required_status_checks: z.object({ contexts: z.array(z.string()), checks: z.array(PolicyCheckSchema).optional(), strict: z.boolean() }).nullable().optional(),
  required_conversation_resolution: z.object({ enabled: z.boolean() }).optional(),
  required_signatures: z.object({ enabled: z.boolean() }).optional(),
}).passthrough();

function parsed<T>(schema: z.ZodType<T>, json: unknown, context: string): T {
  const result = schema.safeParse(json);
  if (!result.success) throw new GitHubTransientError(`invalid GitHub response for ${context}: ${result.error.message}`, null);
  return result.data;
}

function checkState(status: string, conclusion: string | null): CheckState {
  if (status !== "completed") return ["queued", "in_progress", "waiting", "requested", "pending"].includes(status) ? "pending" : "unknown";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" || conclusion === "cancelled") return conclusion;
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion ?? "")) return "failure";
  return "unknown";
}

const PERMISSION_TTL = 10 * 60_000;
/**
 * The inline comment list is read again from this long before the newest comment seen, because GitHub's lists are
 * eventually consistent. Items read twice are deduped by id.
 */
const INLINE_OVERLAP_MS = 10 * 60_000;
const REPO_TTL = 60 * 60_000;
const ROLES: ReadonlySet<string> = new Set(["admin", "maintain", "write", "triage", "read"]);

export function createGitHub(options: GitHubOptions): GitHub {
  const fetch = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const gitUrl = (options.gitUrl ?? "https://github.com").replace(/\/$/, "");
  const clock = options.clock ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;

  let identity: string | null = null;
  let jwt: Cached<string> | null = null;
  let appSlug: string | null = null;
  const installations = new Map<string, number>();
  const tokens = new Map<number, Cached<string>>();
  const cache = new Map<string, Cached<unknown>>();

  function credentials(): GitHubCredentials {
    const current = options.credentials();
    if (!current) throw new GitHubSetupError("set githubAppId and githubPrivateKey to use issue workers");
    const key = `${current.appId}:${createHash("sha256").update(current.privateKey).digest("hex")}`;
    if (key !== identity) {
      identity = key;
      jwt = null;
      appSlug = null;
      installations.clear();
      tokens.clear();
      cache.clear();
    }
    return current;
  }

  function appJwt(): string {
    const { appId, privateKey } = credentials();
    const now = clock();
    if (jwt && jwt.until > now) return jwt.value;
    const seconds = Math.floor(now / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
    jwt = { value: `${unsigned}.${signature}`, until: now + 8 * 60_000 };
    return jwt.value;
  }

  type Auth = ({ kind: "app" } | { kind: "repo"; repo: RepoName } | { kind: "token"; token: string }) & { signal?: AbortSignal | undefined };
  type Reply = { status: number; headers: Headers; json: unknown };

  function notBefore(headers: Headers): number | null {
    const retryAfter = headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) return clock() + Number(retryAfter) * 1000;
    if (retryAfter && Number.isFinite(Date.parse(retryAfter))) return Math.max(clock(), Date.parse(retryAfter));
    const reset = headers.get("x-ratelimit-reset");
    if (headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) return Number(reset) * 1000;
    return null;
  }

  async function send(method: string, url: string, authorization: string, init: { body?: unknown; etag?: string | null; signal?: AbortSignal | undefined }): Promise<Reply> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization,
          "x-github-api-version": "2022-11-28",
          "user-agent": "bb-plugin-pstack",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.etag ? { "if-none-match": init.etag } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      text = await response.text();
    } catch (error) {
      throw new GitHubTransientError(`${method} ${url}: ${error instanceof Error ? error.message : String(error)}`, null, method !== "GET");
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, headers: response.headers, json };
  }

  function failure(method: string, path: string, reply: Reply): Error {
    const message = `GitHub ${method} ${path}: ${reply.status} ${(reply.json as { message?: string } | null)?.message ?? ""}`.trim();
    const retryAt = notBefore(reply.headers);
    if (reply.status >= 500 || reply.status === 429 || (reply.status === 403 && retryAt !== null)) return new GitHubTransientError(message, retryAt, method !== "GET");
    return new GitHubPermanentError(message, reply.status);
  }

  async function installationId(repo: RepoName, signal: AbortSignal | undefined): Promise<number> {
    credentials();
    const known = installations.get(repo);
    if (known !== undefined) return known;
    const path = `/repos/${repo}/installation`;
    const reply = await send("GET", `${apiUrl}${path}`, `Bearer ${appJwt()}`, { signal });
    if (reply.status === 404) throw new GitHubSetupError(`the GitHub App is not installed on ${repo}`);
    if (reply.status === 401) throw new GitHubSetupError(`GitHub rejected the App credentials (${(reply.json as { message?: string })?.message ?? "401"})`);
    if (reply.status !== 200) throw failure("GET", path, reply);
    const id = (reply.json as { id: number }).id;
    installations.set(repo, id);
    return id;
  }

  async function mintToken(repo: RepoName, signal: AbortSignal | undefined, scope?: object): Promise<{ token: string; expiresAt: number }> {
    const id = await installationId(repo, signal);
    const path = `/app/installations/${id}/access_tokens`;
    const reply = await send("POST", `${apiUrl}${path}`, `Bearer ${appJwt()}`, { signal, ...(scope ? { body: scope } : {}) });
    if (reply.status === 404) {
      installations.delete(repo);
      throw new GitHubSetupError(`the GitHub App installation for ${repo} is gone`);
    }
    if (reply.status === 401) throw new GitHubSetupError("GitHub rejected the App credentials while minting an installation token");
    if (reply.status !== 201) throw failure("POST", path, reply);
    const body = reply.json as { token: string; expires_at: string };
    return { token: body.token, expiresAt: Date.parse(body.expires_at) };
  }

  async function installationToken(repo: RepoName, signal: AbortSignal | undefined): Promise<string> {
    const id = await installationId(repo, signal);
    const cached = tokens.get(id);
    if (cached && cached.until > clock()) return cached.value;
    const minted = await mintToken(repo, signal);
    tokens.set(id, { value: minted.token, until: minted.expiresAt - 15 * 60_000 });
    return minted.token;
  }

  async function request(auth: Auth, method: string, path: string, init: { body?: unknown; etag?: string | null } = {}): Promise<Reply> {
    const url = path.startsWith("http") ? path : `${apiUrl}${path}`;
    if (new URL(url).origin !== new URL(apiUrl).origin) throw new GitHubPermanentError("GitHub pagination left the configured API origin", 422);
    const authorization = async () =>
      auth.kind === "app" ? `Bearer ${appJwt()}` : auth.kind === "token" ? `Bearer ${auth.token}` : `Bearer ${await installationToken(auth.repo, auth.signal)}`;
    const sent = { ...init, signal: auth.signal };
    let reply = await send(method, url, await authorization(), sent);
    if (reply.status === 401 && auth.kind === "repo") {
      tokens.delete(await installationId(auth.repo, auth.signal));
      reply = await send(method, url, await authorization(), sent);
    }
    if (reply.status === 401 && auth.kind !== "token") throw new GitHubSetupError(`GitHub rejected the App credentials on ${method} ${path}`);
    if (reply.status === 403 && auth.kind === "repo" && notBefore(reply.headers) === null) {
      cache.delete(`capabilities:${auth.repo}`);
      const id = installations.get(auth.repo);
      if (id !== undefined) tokens.delete(id);
      installations.delete(auth.repo);
    }
    return reply;
  }

  async function call<T>(auth: Auth, method: string, path: string, init: { body?: unknown; ok?: readonly number[] } = {}): Promise<{ status: number; json: T }> {
    const reply = await request(auth, method, path, init);
    if (reply.status >= 200 && reply.status < 300) return { status: reply.status, json: reply.json as T };
    if (init.ok?.includes(reply.status)) return { status: reply.status, json: reply.json as T };
    if (reply.status === 401 && auth.kind !== "token") throw new GitHubSetupError(`GitHub rejected the App credentials on ${method} ${path}`);
    throw failure(method, path, reply);
  }

  const nextLink = (headers: Headers): string | null => /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1] ?? null;

  async function pages<T>(auth: Auth, path: string, first?: Reply): Promise<T[]> {
    const items: T[] = [];
    let reply = first ?? (await request(auth, "GET", path));
    for (;;) {
      if (reply.status !== 200) throw failure("GET", path, reply);
      items.push(...(parsed(z.array(z.unknown()), reply.json, `list ${path}`) as T[]));
      const next = nextLink(reply.headers);
      if (!next) return items;
      reply = await request(auth, "GET", next);
    }
  }

  /**
   * A list read with the cursor's ETag. Null on 304. With `since`, the cursor moves to the newest `updated_at` seen; a
   * new `since` makes a new URL, so the old tag would never match and is dropped. Without `since`, a list longer than
   * one page keeps no tag: its first page stays the same while a later one grows.
   */
  async function list<T>(auth: Auth, path: string, query: Record<string, string>, cursor: Cursor | null, since: boolean, overlapMs = 0): Promise<{ items: T[]; next: Cursor } | null> {
    const params = new URLSearchParams({ ...query, per_page: "100" });
    if (since && cursor?.since) params.set("since", overlapMs > 0 ? new Date(Date.parse(cursor.since) - overlapMs).toISOString() : cursor.since);
    const url = `${path}?${params}`;
    const first = await request(auth, "GET", url, { etag: cursor?.etag ?? null });
    if (first.status === 304) return null;
    const items = await pages<T>(auth, url, first);
    const previous = cursor?.since ?? null;
    const newest = since ? (items.map((item) => (item as { updated_at?: string }).updated_at ?? "").sort().at(-1) || previous) : null;
    const keep = since ? newest === previous : nextLink(first.headers) === null;
    return { items, next: { since: newest, etag: keep ? first.headers.get("etag") : null } };
  }

  async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    credentials();
    const hit = cache.get(key);
    if (hit && hit.until > clock()) return hit.value as T;
    const value = await load();
    cache.set(key, { value, until: clock() + ttl });
    return value;
  }

  function repo(name: RepoName, signal?: AbortSignal): RepoClient {
    const auth: Auth = { kind: "repo", repo: name, signal };
    const base = `/repos/${name}`;
    const appLogin = async () => {
      credentials();
      if (appSlug === null) appSlug = (await call<{ slug: string }>({ kind: "app", signal }, "GET", "/app")).json.slug;
      return `${appSlug}[bot]`;
    };
    async function capabilities(input: { fresh: boolean }): Promise<Capabilities> {
      credentials();
      const key = `capabilities:${name}`;
      if (input.fresh) {
        cache.delete(key);
        const id = installations.get(name);
        if (id !== undefined) tokens.delete(id);
        installations.delete(name);
      }
      return cached(key, 60_000, async () => {
        const installation = await request({ kind: "app", signal }, "GET", `${base}/installation`);
        if (installation.status === 404) throw new GitHubSetupError(`the GitHub App is not installed on ${name}`);
        if (installation.status === 401) throw new GitHubSetupError("GitHub rejected the App credentials");
        if (installation.status !== 200) throw failure("GET", `${base}/installation`, installation);
        const grants = parsed(InstallationSchema, installation.json, "installation grants");
        if (grants.suspended_at) throw new GitHubSetupError(`the GitHub App installation for ${name} is suspended`);
        installations.set(name, grants.id);
        const repository = parsed(RepositorySchema, (await call(auth, "GET", base)).json, "repository capabilities");
        const ref = parsed(RefSchema, (await call(auth, "GET", `${base}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`)).json, "default branch");
        const permission = (key: string): Grant => grants.permissions[key] ?? "none";
        return CapabilitiesSchema.parse({ repositoryId: repository.id, archived: repository.archived,
          defaultBranch: repository.default_branch, defaultHead: ref.object.sha, observedAt: clock(),
          permissions: { contents: permission("contents"), issues: permission("issues"), pullRequests: permission("pull_requests"),
            workflows: permission("workflows"), checks: permission("checks"), statuses: permission("statuses") } });
      });
    }

    async function snapshotPull(pr: number): Promise<SnapshotPull | null> {
      const reply = await request(auth, "GET", `${base}/pulls/${pr}`);
      if (reply.status === 404) {
        // GitHub also masks inaccessible resources with 404.
        const grants = await capabilities({ fresh: true });
        if (grants.permissions.pullRequests === "none") throw new GitHubPermanentError("pull request access is unavailable", 403, "missing-capability");
        return null;
      }
      if (reply.status !== 200) throw failure("GET", `${base}/pulls/${pr}`, reply);
      const pull = parsed(SnapshotPullSchema, reply.json, "pull request snapshot");
      if (pull.number !== pr || pull.base.repo.full_name !== name) throw new GitHubTransientError("pull request identity does not match repository/number", null);
      return pull;
    }

    async function checkObservations(head: Sha): Promise<{ checks: Check[]; complete: boolean }> {
      const checks: Check[] = [];
      let complete = true;
      async function collection<T>(path: string, field: string, schema: z.ZodType<T>): Promise<T[]> {
        const items: T[] = [];
        let url: string | null = path;
        let total = 0;
        while (url) {
          const reply = await request(auth, "GET", url);
          if (reply.status !== 200) throw failure("GET", url, reply);
          const page = parsed(z.object({ total_count: z.number().int().nonnegative() }).catchall(z.unknown()), reply.json, field);
          total = Math.max(total, page.total_count);
          items.push(...parsed(z.array(schema), page[field], field));
          url = nextLink(reply.headers);
        }
        if (items.length < total) complete = false;
        return items;
      }
      const suites = await collection(`${base}/commits/${head}/check-suites?per_page=100`, "check_suites", SuiteSchema);
      const newestRuns = new Map<string, z.infer<typeof RunSchema>>();
      for (const suite of suites) {
        if (suite.head_sha !== head) complete = false;
        const runs = await collection(`${base}/check-suites/${suite.id}/check-runs?filter=all&per_page=100`, "check_runs", RunSchema);
        for (const run of runs) {
          if (run.head_sha !== head || run.app.id !== suite.app.id) complete = false;
          const key = `${run.app.id}:${run.name}`;
          if ((newestRuns.get(key)?.id ?? -1) < run.id) newestRuns.set(key, run);
        }
        const state = checkState(suite.status, suite.conclusion);
        if (runs.length === 0 && !["success", "neutral", "skipped"].includes(state)) {
          checks.push({ id: `check-suite:${suite.id}`, name: suite.app.slug ?? `App ${suite.app.id}`, source: "check-run", appId: suite.app.id,
            head: suite.head_sha, state, url: null });
        }
      }
      for (const run of newestRuns.values()) checks.push({ id: `check-run:${run.id}`, name: run.name, source: "check-run", appId: run.app.id,
        head: run.head_sha, state: checkState(run.status, run.conclusion), url: run.html_url });
      const statuses = parsed(z.array(StatusSchema), await pages<unknown>(auth, `${base}/commits/${head}/statuses?per_page=100`), "commit statuses");
      const newest = new Map<string, z.infer<typeof StatusSchema>>();
      for (const status of statuses) {
        const old = newest.get(status.context);
        if (!old || Date.parse(status.created_at) > Date.parse(old.created_at) || (status.created_at === old.created_at && status.id > old.id)) newest.set(status.context, status);
      }
      for (const status of newest.values()) checks.push({ id: `status:${status.id}`, name: status.context, source: "status", appId: null,
        head, state: status.state === "error" ? "failure" : CheckStateSchema.catch("unknown").parse(status.state), url: status.target_url });
      return { checks, complete };
    }

    async function requiredPolicy(pull: SnapshotPull): Promise<ReviewSnapshot["required"]> {
      const branch = encodeURIComponent(pull.base.ref);
      const checks: RequiredCheck[] = [];
      const blockers: string[] = [];
      const limitations: string[] = [];
      const unavailable = (reason: string): ReviewSnapshot["required"] => ({ kind: "unavailable", reason, checks, blockers });
      const add = (item: z.infer<typeof PolicyCheckSchema>) => checks.push({ name: item.context, source: "either",
        appId: (item.app_id ?? item.integration_id ?? -1) > 0 ? item.app_id ?? item.integration_id ?? null : null,
        accepted: ["success", "neutral", "skipped"] });
      const strict = (enabled: boolean) => { if (enabled && pull.mergeable_state === "behind") blockers.push("base branch must be incorporated into the head"); };
      try {
        const branchReply = await request(auth, "GET", `${base}/branches/${branch}`);
        if (branchReply.status !== 200) {
          if ([403, 404].includes(branchReply.status) && notBefore(branchReply.headers) === null) return unavailable(`branch policy observation returned ${branchReply.status}`);
          throw failure("GET", `${base}/branches/${branch}`, branchReply);
        }
        const branchInfo = parsed(z.object({ protected: z.boolean(), commit: z.object({ sha: WireSha }) }), branchReply.json, "branch protection summary");
        if (branchInfo.commit.sha !== pull.base.sha) return unavailable("base changed during policy observation");
        let rulesUrl: string | null = `${base}/rules/branches/${branch}?per_page=100`;
        while (rulesUrl) {
          const reply = await request(auth, "GET", rulesUrl);
          if (reply.status !== 200) throw failure("GET", rulesUrl, reply);
          const rules = parsed(RulesSchema, reply.json, "active branch rules");
          for (const rule of rules) {
            if (rule.type === "required_status_checks") {
              const parameters = parsed(RuleChecksSchema, rule.parameters, "required status check rule");
              parameters.required_status_checks.forEach(add);
              strict(parameters.strict_required_status_checks_policy);
            } else if (rule.type === "pull_request") {
              const parameters = parsed(z.object({ required_review_thread_resolution: z.boolean() }), rule.parameters, "pull request rule");
              if (parameters.required_review_thread_resolution) limitations.push("required review thread resolution cannot be established from this snapshot");
            } else if (!["creation", "deletion", "non_fast_forward", "required_linear_history"].includes(rule.type)) {
              limitations.push(`unsupported branch requirement ${rule.type}`);
            }
          }
          rulesUrl = nextLink(reply.headers);
        }
        if (branchInfo.protected) {
          const protection = await request(auth, "GET", `${base}/branches/${branch}/protection`);
          if (protection.status !== 200) {
            if ([403, 404].includes(protection.status) && notBefore(protection.headers) === null) return unavailable(`classic branch protection is unavailable (${protection.status})`);
            throw failure("GET", `${base}/branches/${branch}/protection`, protection);
          }
          const legacy = parsed(LegacyPolicySchema, protection.json, "classic branch protection");
          if (legacy.required_conversation_resolution?.enabled || legacy.required_signatures?.enabled) limitations.push("classic protection contains requirements not observed by this snapshot");
          if (legacy.required_status_checks) {
            const required = legacy.required_status_checks;
            (required.checks ?? []).forEach(add);
            const unbound = required.contexts.filter((context) => !required.checks?.some((check) => check.context === context));
            if (unbound.length) {
              unbound.forEach((context) => add({ context }));
              limitations.push("classic required status contexts lack observable App bindings");
            }
            strict(required.strict);
          }
        }
        return limitations.length ? unavailable(limitations.join("; ")) : { kind: "known", checks, blockers };
      } catch (error) {
        if (error instanceof GitHubPermanentError && [403, 404].includes(error.status)) return unavailable(error.message);
        throw error;
      }
    }

    async function reviewSnapshot(pr: number): Promise<ReviewSnapshot | null> {
      const before = await snapshotPull(pr);
      if (!before) return null;
      const observations = await checkObservations(before.head.sha);
      const required = await requiredPolicy(before);
      const after = await snapshotPull(pr);
      if (!after) return null;
      return ReviewSnapshotSchema.parse({ pr, head: after.head.sha, base: after.base.sha, url: after.html_url,
        state: after.state === "open" ? "open" : after.merged_at ? "merged" : "closed", draft: after.draft,
        headRepository: after.head.repo?.full_name ?? null, headBranch: after.head.ref, baseBranch: after.base.ref,
        mergeability: after.mergeable === null ? "unknown" : after.mergeable ? "clean" : "conflicting", observedAt: clock(),
        complete: observations.complete && JSON.stringify(before) === JSON.stringify(after), checks: observations.checks, required });
    }

    async function setDraft(input: { expected: Target; draft: boolean }): Promise<DraftResult> {
      const classify = (snapshot: ReviewSnapshot | null): DraftResult => !snapshot ? { kind: "missing" }
        : snapshot.state !== "open" ? { kind: "closed", snapshot }
        : snapshot.head !== input.expected.head || snapshot.base !== input.expected.base || !snapshot.complete ? { kind: "stale", snapshot }
        : { kind: "observed", snapshot };
      const before = classify(await reviewSnapshot(input.expected.pr));
      if (before.kind !== "observed" || before.snapshot.draft === input.draft) return before;
      const pull = await snapshotPull(input.expected.pr);
      if (!pull) return { kind: "missing" };
      if (pull.head.sha !== input.expected.head || pull.base.sha !== input.expected.base || pull.state !== "open") return classify(await reviewSnapshot(input.expected.pr));
      const mutation = input.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      const inputType = input.draft ? "ConvertPullRequestToDraftInput" : "MarkPullRequestReadyForReviewInput";
      try {
        const reply = await request(auth, "POST", "/graphql", { body: {
          query: `mutation($input: ${inputType}!) { ${mutation}(input: $input) { pullRequest { id isDraft } } }`,
          variables: { input: { pullRequestId: pull.node_id } },
        } });
        if (reply.status !== 200) throw failure("POST", "/graphql", reply);
        const result = parsed(z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).optional() }), reply.json, "draft mutation");
        if (result.errors?.length) {
          const denied = result.errors.some((error) => error.type === "FORBIDDEN" || error.type === "INSUFFICIENT_SCOPES");
          const message = result.errors.map((error) => error.message).join("; ");
          if (denied) throw new GitHubPermanentError(message, 403);
          const retryAt = notBefore(reply.headers);
          const rateLimited = result.errors.some((error) => error.type === "RATE_LIMITED");
          const serviceFault = result.errors.some((error) => ["INTERNAL", "SERVICE_UNAVAILABLE", "TIMEOUT"].includes(error.type ?? "")
            || (!error.type && /^(Something went wrong while executing your query|We couldn't respond to your request in time)/.test(error.message)));
          if (rateLimited || serviceFault || (retryAt !== null && result.errors.every((error) => !error.type))) {
            throw new GitHubTransientError(message, retryAt ?? (rateLimited ? clock() + 60_000 : null), true);
          }
          throw new GitHubPermanentError(message, 422);
        }
        parsed(z.object({ [mutation]: z.object({ pullRequest: z.object({ id: z.literal(pull.node_id), isDraft: z.boolean() }) }) }), result.data, "draft mutation result");
      } catch (error) {
        if (!(error instanceof GitHubTransientError)) throw error;
        let snapshot: ReviewSnapshot | null;
        try {
          snapshot = await reviewSnapshot(input.expected.pr);
        } catch (probeError) {
          if (!(probeError instanceof GitHubTransientError)) throw probeError;
          const cooldowns = [error.notBefore, probeError.notBefore].filter((time) => time !== null);
          throw new GitHubTransientError(`${error.message}; draft observation failed: ${probeError.message}`,
            cooldowns.length ? Math.max(...cooldowns) : null, true);
        }
        const observed = classify(snapshot);
        if (observed.kind !== "observed" || observed.snapshot.draft === input.draft) return observed;
        throw error;
      }
      const after = classify(await reviewSnapshot(input.expected.pr));
      if (after.kind === "observed" && after.snapshot.draft !== input.draft) throw new GitHubTransientError("draft mutation has not been observed", null, true);
      return after;
    }

    async function upsertIssueStatus(input: { issue: number; marker: string; revision: number; body: string }): Promise<{ commentId: number }> {
      if (!Number.isSafeInteger(input.issue) || input.issue < 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !/^<!--[^\r\n]+-->$/.test(input.marker)) {
        throw new GitHubPermanentError("invalid issue status identity or revision", 422);
      }
      const login = await appLogin();
      const appId = Number(credentials().appId);
      const body = `${input.body.trimEnd()}\n\n<!-- pstack:status-revision:${input.revision} -->\n${input.marker}`;
      const owned = (comment: z.infer<typeof StatusCommentSchema>) => comment.user?.login === login && comment.user.type === "Bot"
        && comment.performed_via_github_app?.id === appId && endsWith(comment.body ?? "", input.marker)
        && comment.issue_url === `${apiUrl}${base}/issues/${input.issue}`;
      const find = async () => parsed(z.array(StatusCommentSchema), await pages<unknown>(auth, `${base}/issues/${input.issue}/comments?per_page=100`), "status comments")
        .filter(owned).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
      for (let attempt = 0; attempt < 3; attempt++) {
        let comments = await find();
        let keeper = comments[0];
        if (!keeper) {
          try {
            const created = await call(auth, "POST", `${base}/issues/${input.issue}/comments`, { body: { body } });
            parsed(z.object({ id: z.number().int().positive() }), created.json, "created status comment");
          } catch (error) {
            if (!(error instanceof GitHubTransientError)) throw error;
            comments = await find();
            if (comments.length === 0) throw error;
          }
          comments = await find();
          keeper = comments[0];
          if (!keeper) throw new GitHubTransientError("created status comment is not yet observable", null, true);
        }
        const current = await call(auth, "GET", `${base}/issues/comments/${keeper.id}`, { ok: [404] });
        if (current.status === 404) continue;
        keeper = parsed(StatusCommentSchema, current.json, "current status comment");
        if (!owned(keeper)) continue;
        if (keeper.body !== body) {
          try {
            const edited = await call(auth, "PATCH", `${base}/issues/comments/${keeper.id}`, { body: { body }, ok: [404] });
            if (edited.status === 404) continue;
          } catch (error) {
            if (!(error instanceof GitHubTransientError)) throw error;
            const probe = await call(auth, "GET", `${base}/issues/comments/${keeper.id}`, { ok: [404] });
            if (probe.status === 404) continue;
            const observed = parsed(StatusCommentSchema, probe.json, "status edit probe");
            if (!owned(observed) || observed.body !== body) throw error;
          }
        }
        comments = await find();
        if (comments[0]?.id !== keeper.id) continue;
        for (const duplicate of comments.slice(1)) {
          const probe = await call(auth, "GET", `${base}/issues/comments/${duplicate.id}`, { ok: [404] });
          if (probe.status === 404) continue;
          if (!owned(parsed(StatusCommentSchema, probe.json, "duplicate status comment"))) continue;
          await call(auth, "DELETE", `${base}/issues/comments/${duplicate.id}`, { ok: [404] });
        }
        const final = await call(auth, "GET", `${base}/issues/comments/${keeper.id}`, { ok: [404] });
        if (final.status === 404) continue;
        const observed = parsed(StatusCommentSchema, final.json, "delivered status comment");
        if (owned(observed) && observed.body === body) return { commentId: keeper.id };
      }
      throw new GitHubTransientError("issue status changed during reconciliation", null, true);
    }

    /** One pull request's feedback since its cursor, and its state. */
    async function pullActivity(pr: number, cursor: PullCursor | null): Promise<{ state: PullState; items: PolledFeedback[]; next: PullCursor }> {
      const was = cursor ?? { reviewComments: null, comments: null, reviews: null, pull: null };
      const author = (user: RawUser) => user?.login ?? "ghost";
      // Comments before reviews: a comment's review exists by the time the comment is listed, so the review list
      // read after it knows that review's state.
      const inline = await list<RawReviewComment>(auth, `${base}/pulls/${pr}/comments`, { sort: "updated", direction: "asc" }, was.reviewComments, true, INLINE_OVERLAP_MS);
      const conversation = await list<RawComment>(auth, `${base}/issues/${pr}/comments`, { sort: "updated", direction: "asc" }, was.comments, true);
      const reviews = await list<RawReview>(auth, `${base}/pulls/${pr}/reviews`, {}, was.reviews && { since: null, etag: was.reviews.etag }, false);
      const before = was.reviews?.known ?? {};
      const known: Record<string, KnownReview> = reviews
        ? Object.fromEntries(reviews.items.flatMap((review) => (review.submitted_at ? [[review.id, { state: review.state, submittedAt: Date.parse(review.submitted_at) }]] : [])))
        : before;
      const pull = await request(auth, "GET", `${base}/pulls/${pr}`, { etag: was.pull?.etag ?? null });
      let state: PullState;
      if (pull.status === 304 && was.pull) state = was.pull.state;
      else if (pull.status === 200) {
        const json = pull.json as { state: string; merged?: boolean; merged_at?: string | null };
        state = json.state === "open" ? "open" : json.merged || json.merged_at ? "merged" : "closed";
      } else throw failure("GET", `${base}/pulls/${pr}`, pull);

      // A new review's inline comments keep the times they were drafted at, which can be older than the inline
      // cursor, so they are read through the review itself. The App's own reviews are its replies.
      const login = await appLogin();
      const fresh = (reviews?.items ?? []).filter((review) => review.submitted_at && !before[review.id] && review.user?.login !== login);
      const drafted = (await Promise.all(fresh.map((review) => pages<RawReviewComment>(auth, `${base}/pulls/${pr}/reviews/${review.id}/comments?per_page=100`)))).flat();

      const items: PolledFeedback[] = [];
      const none = { path: null, line: null, diffHunk: null, inReplyTo: null, reviewId: null };
      const seen = new Set<number>();
      for (const comment of [...(inline?.items ?? []), ...drafted]) {
        const reviewId = comment.pull_request_review_id ?? null;
        const review = reviewId === null ? null : known[reviewId];
        // A comment whose review is not listed yet cannot be classified; the overlapping cursor reads it again.
        if (seen.has(comment.id) || review === undefined) continue;
        seen.add(comment.id);
        items.push({
          kind: "review-comment",
          id: comment.id,
          pr,
          author: author(comment.user),
          body: comment.body,
          path: comment.path,
          line: comment.line ?? comment.original_line ?? null,
          diffHunk: comment.diff_hunk,
          inReplyTo: comment.in_reply_to_id ?? null,
          reviewId,
          createdAt: Date.parse(comment.created_at),
          postedAt: review?.submittedAt ?? Date.parse(comment.updated_at),
          reviewState: review?.state ?? null,
        });
      }
      for (const comment of conversation?.items ?? []) {
        items.push({ kind: "pr-comment", id: comment.id, pr, author: author(comment.user), body: comment.body ?? "", ...none, createdAt: Date.parse(comment.created_at), postedAt: Date.parse(comment.updated_at), reviewState: null });
      }
      for (const review of reviews?.items ?? []) {
        if (!review.submitted_at) continue;
        const submitted = Date.parse(review.submitted_at);
        items.push({ kind: "review", id: review.id, pr, author: author(review.user), body: review.body ?? "", ...none, createdAt: submitted, postedAt: submitted, reviewState: review.state });
      }
      const next: PullCursor = {
        reviewComments: inline?.next ?? was.reviewComments,
        comments: conversation?.next ?? was.comments,
        reviews: reviews ? { etag: reviews.next.etag, known } : was.reviews,
        pull: { etag: pull.status === 200 ? pull.headers.get("etag") : (was.pull?.etag ?? null), state },
      };
      return { state, items, next };
    }

    return {
      name,
      appLogin,
      capabilities,
      reviewSnapshot,
      setDraft,
      upsertIssueStatus,
      async repositoryIssues(fresh = false) {
        const load = async (): Promise<RepositoryIssue[]> => {
          const items = await pages<{ number: number; title: string; body: string | null; html_url: string; user: { login: string }; updated_at: string; state: "open" | "closed"; labels: ({ name: string } | string)[]; pull_request?: unknown; sub_issues_summary?: { total: number } }>(auth, `${base}/issues?state=all&sort=updated&direction=desc&per_page=100`);
          return items.filter((item) => item.pull_request === undefined).map((item) => ({
            number: item.number, title: item.title, body: item.body ?? "", url: item.html_url, author: item.user.login,
            updatedAt: Date.parse(item.updated_at), subIssues: item.sub_issues_summary?.total ?? 0,
            state: item.state, labels: item.labels.map((label) => typeof label === "string" ? label : label.name),
          }));
        };
        return fresh ? load() : cached(`issues:${name}`, 60_000, load);
      },
      async labeledIssues(label, cursor) {
        type RawIssue = { number: number; title: string; body: string | null; html_url: string; user: { login: string }; updated_at: string; pull_request?: unknown; sub_issues_summary?: { total: number } };
        const read = await list<RawIssue>(auth, `${base}/issues`, { labels: label, state: "open", sort: "updated", direction: "asc" }, cursor as unknown as Cursor | null, true);
        if (!read) return { changed: false };
        const issues = read.items
          .filter((item) => item.pull_request === undefined)
          .map((item) => ({ number: item.number, title: item.title, body: item.body ?? "", url: item.html_url, author: item.user.login, updatedAt: Date.parse(item.updated_at), subIssues: item.sub_issues_summary?.total ?? 0 }));
        return { changed: true, issues, next: read.next as unknown as PollCursor };
      },
      async latestLabelEvent(issue, label) {
        const events = await pages<{ id: number; event: string; label?: { name: string }; actor: { login: string } | null; created_at: string }>(
          auth,
          `${base}/issues/${issue}/events?per_page=100`,
        );
        const event = events.filter((item) => item.event === "labeled" && item.label?.name === label && item.actor).at(-1);
        return event ? { id: event.id, actor: event.actor!.login, at: Date.parse(event.created_at) } : null;
      },
      permission(user) {
        return cached(`permission:${name}:${user.toLowerCase()}`, PERMISSION_TTL, async () => {
          const { status, json } = await call<{ permission: string; role_name?: string }>(auth, "GET", `${base}/collaborators/${encodeURIComponent(user)}/permission`, { ok: [404] });
          if (status === 404) return "none";
          const role = json.role_name && ROLES.has(json.role_name) ? json.role_name : json.permission;
          return (ROLES.has(role) ? role : "none") as Permission;
        });
      },
      defaultBranch() {
        return cached(`default:${name}`, REPO_TTL, async () => (await call<{ default_branch: string }>(auth, "GET", base)).json.default_branch);
      },
      titleConvention() {
        return cached(`convention:${name}`, REPO_TTL, async () => {
          const { json } = await call<{ title: string; merged_at: string | null }[]>(auth, "GET", `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
          const titles = json.filter((pull) => pull.merged_at).slice(0, 20).map((pull) => pull.title);
          return titles.filter((title) => CONVENTIONAL_TITLE.test(title)).length * 2 > titles.length ? "conventional" : "free";
        });
      },
      async branchSha(branch) {
        const { status, json } = await call<{ object: { sha: string } }>(auth, "GET", `${base}/git/ref/heads/${branch}`, { ok: [404] });
        return status === 404 ? null : (json.object.sha as Sha);
      },
      async findPull(branch) {
        const owner = name.split("/")[0]!;
        const { json } = await call<{ number: number; html_url: string }[]>(auth, "GET", `${base}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
        const pull = json[0];
        return pull ? { number: pull.number, url: pull.html_url } : null;
      },
      async findComment(issue, marker, since) {
        const login = await appLogin();
        const comments = await pages<{ id: number; body: string; user: { login: string } | null }>(
          auth,
          `${base}/issues/${issue}/comments?since=${new Date(since).toISOString()}&per_page=100`,
        );
        const found = comments.find((comment) => comment.user?.login === login && endsWith(comment.body, marker));
        return found ? { id: found.id } : null;
      },
      async findReviewComment(pr, marker, since) {
        const login = await appLogin();
        const comments = await pages<{ id: number; body: string; user: RawUser }>(auth, `${base}/pulls/${pr}/comments?since=${new Date(since).toISOString()}&per_page=100`);
        const found = comments.find((comment) => comment.user?.login === login && endsWith(comment.body, marker));
        return found ? { id: found.id } : null;
      },
      async activity(target, cursor) {
        const was = (cursor as unknown as JobCursor | null) ?? { issue: null, pull: null };
        const issue = await list<RawComment>(auth, `${base}/issues/${target.issue}/comments`, { sort: "updated", direction: "asc" }, was.issue ?? { since: new Date(target.since).toISOString(), etag: null }, true);
        const issueComments = (issue?.items ?? []).map((comment) => ({ id: comment.id, author: comment.user?.login ?? "ghost", body: comment.body ?? "", createdAt: Date.parse(comment.created_at) }));
        const pull = target.pr === null ? null : await pullActivity(target.pr, was.pull);
        const next: JobCursor = { issue: issue?.next ?? was.issue, pull: pull?.next ?? was.pull };
        return { issueComments, pull: pull && { state: pull.state, items: pull.items }, next: next as unknown as ActivityCursor };
      },
      async issue(issue) {
        const { json } = await call<{ state: string; labels: ({ name: string } | string)[] }>(auth, "GET", `${base}/issues/${issue}`);
        return { open: json.state === "open", labels: json.labels.map((label) => (typeof label === "string" ? label : label.name)) };
      },
      async subIssues(issue) {
        const items = await pages<RawLinkedIssue>(auth, `${base}/issues/${issue}/sub_issues?per_page=100`);
        return items
          .filter((item) => repoOf(item) === name)
          .map((item) => ({ number: item.number, title: item.title, body: item.body ?? "", url: item.html_url, author: item.user?.login ?? "ghost", state: item.state === "open" ? ("open" as const) : ("closed" as const) }));
      },
      async blockedBy(issue) {
        const items = await pages<RawLinkedIssue>(auth, `${base}/issues/${issue}/dependencies/blocked_by?per_page=100`);
        return items.filter((item) => item.state === "open").map((item) => (repoOf(item) === name ? `#${item.number}` : `${repoOf(item)}#${item.number}`));
      },
      async closeIssue(issue) {
        await call(auth, "PATCH", `${base}/issues/${issue}`, { body: { state: "closed", state_reason: "completed" } });
      },
      async editComment(id, body) {
        await call(auth, "PATCH", `${base}/issues/comments/${id}`, { body: { body } });
      },
      async addLabels(issue, labels) {
        await call(auth, "POST", `${base}/issues/${issue}/labels`, { body: { labels } });
      },
      async removeLabel(issue, label) {
        await call(auth, "DELETE", `${base}/issues/${issue}/labels/${encodeURIComponent(label)}`, { ok: [404] });
      },
      async comment(issue, body) {
        return { id: (await call<{ id: number }>(auth, "POST", `${base}/issues/${issue}/comments`, { body: { body } })).json.id };
      },
      async createDraftPull(input) {
        const { json } = await call<{ number: number; html_url: string }>(auth, "POST", `${base}/pulls`, { body: { ...input, draft: true } });
        return { number: json.number, url: json.html_url };
      },
      async createPull(input) {
        const { json } = await call<{ number: number; html_url: string }>(auth, "POST", `${base}/pulls`, { body: input });
        return { number: json.number, url: json.html_url };
      },
      async pull(pr) {
        const { status, json } = await call<RawPull>(auth, "GET", `${base}/pulls/${pr}`, { ok: [404] });
        return status === 404 ? null : pullDetail(json);
      },
      async pullForBranch(branch) {
        const owner = name.split("/")[0]!;
        const { json } = await call<RawPull[]>(auth, "GET", `${base}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=created&direction=desc&per_page=10`);
        return json[0] ? pullDetail(json[0]) : null;
      },
      async issueDetail(issue) {
        type RawIssue = { number: number; html_url: string; title: string; body: string | null; user: RawUser; state: string; labels: ({ name: string } | string)[]; pull_request?: unknown };
        const { status, json } = await call<RawIssue>(auth, "GET", `${base}/issues/${issue}`, { ok: [404] });
        if (status === 404) return null;
        const comments = await pages<RawComment>(auth, `${base}/issues/${issue}/comments?per_page=100`);
        return {
          number: json.number, url: json.html_url, title: json.title, body: json.body ?? "", author: json.user?.login ?? "ghost",
          state: json.state === "open" ? "open" : "closed", labels: json.labels.map((label) => (typeof label === "string" ? label : label.name)),
          pull: json.pull_request !== undefined,
          comments: comments.map((comment) => ({ id: comment.id, author: comment.user?.login ?? "ghost", body: comment.body ?? "", createdAt: Date.parse(comment.created_at) })),
        };
      },
      async closePull(pr) {
        await call(auth, "PATCH", `${base}/pulls/${pr}`, { body: { state: "closed" } });
      },
      async deleteBranch(branch) {
        await call(auth, "DELETE", `${base}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { ok: [404, 422] });
      },
      async feedback(pr) {
        const [reviews, inline, conversation] = await Promise.all([
          pages<RawReview>(auth, `${base}/pulls/${pr}/reviews?per_page=100`),
          pages<RawReviewComment>(auth, `${base}/pulls/${pr}/comments?per_page=100`),
          pages<RawComment>(auth, `${base}/issues/${pr}/comments?per_page=100`),
        ]);
        return {
          reviews: reviews.flatMap((review) => (review.submitted_at ? [{ id: review.id, author: review.user?.login ?? "ghost", state: review.state, body: review.body ?? "", submittedAt: Date.parse(review.submitted_at) }] : [])),
          inline: inline.map((comment) => ({ id: comment.id, author: comment.user?.login ?? "ghost", path: comment.path, line: comment.line ?? comment.original_line ?? null, inReplyTo: comment.in_reply_to_id ?? null, body: comment.body, createdAt: Date.parse(comment.created_at) })),
          conversation: conversation.map((comment) => ({ id: comment.id, author: comment.user?.login ?? "ghost", body: comment.body ?? "", createdAt: Date.parse(comment.created_at) })),
        };
      },
      async checks(sha) {
        type RawRun = { name: string; status: CheckResult["status"]; conclusion: string | null; html_url: string | null };
        const runs: RawRun[] = [];
        let url: string | null = `${base}/commits/${sha}/check-runs?per_page=100`;
        while (url) {
          const reply = await request(auth, "GET", url);
          if (reply.status !== 200) throw failure("GET", url, reply);
          runs.push(...(reply.json as { check_runs: RawRun[] }).check_runs);
          url = nextLink(reply.headers);
        }
        const { json } = await call<{ statuses: { context: string; state: string; target_url: string | null }[] }>(auth, "GET", `${base}/commits/${sha}/status`);
        return [
          ...runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url })),
          ...json.statuses.map((item) => ({
            name: item.context,
            status: item.state === "pending" ? ("in_progress" as const) : ("completed" as const),
            conclusion: item.state === "pending" ? null : item.state,
            url: item.target_url,
          })),
        ];
      },
      async fetchCredentials() {
        const { token } = await mintToken(name, signal, { repositories: [name.split("/")[1]], permissions: { contents: "read" } });
        return { remoteUrl: `${gitUrl}/${name}.git`, token };
      },
      async mergePull(pr, input) {
        const { json } = await call<{ sha: string }>(auth, "PUT", `${base}/pulls/${pr}/merge`, { body: { sha: input.sha, merge_method: input.method } });
        return { sha: json.sha };
      },
      async editPull(pr, input) {
        await call(auth, "PATCH", `${base}/pulls/${pr}`, { body: input });
      },
      async replyToReviewComment(pr, commentId, body) {
        return { id: (await call<{ id: number }>(auth, "POST", `${base}/pulls/${pr}/comments/${commentId}/replies`, { body: { body } })).json.id };
      },
      async reviewComment(id) {
        const { status, json } = await call<{ body: string; user: RawUser }>(auth, "GET", `${base}/pulls/comments/${id}`, { ok: [404] });
        return status === 404 ? null : { author: json.user?.login ?? "ghost", body: json.body };
      },
      async requestReviewers(pr, reviewers) {
        const ask = async (users: readonly string[]) =>
          (await call(auth, "POST", `${base}/pulls/${pr}/requested_reviewers`, { body: { reviewers: users }, ok: [422] })).status !== 422;
        if (reviewers.length === 0 || (await ask(reviewers))) return { requested: [...reviewers], dropped: [] };
        // GitHub refuses the whole request when one reviewer cannot be asked, without saying which.
        const requested: string[] = [];
        const dropped: string[] = [];
        for (const reviewer of reviewers) ((await ask([reviewer])) ? requested : dropped).push(reviewer);
        return { requested, dropped };
      },
      async pushCredentials(input = { workflows: false }) {
        if (input.workflows) {
          const grants = await capabilities({ fresh: true });
          if (grants.permissions.workflows !== "write" || grants.permissions.contents !== "write") {
            throw new GitHubPermanentError("workflow changes require existing contents and workflows write grants", 403, "missing-capability");
          }
        }
        const { token } = await mintToken(name, signal, { repositories: [name.split("/")[1]], permissions: { contents: "write", ...(input.workflows ? { workflows: "write" } : {}) } });
        return { remoteUrl: `${gitUrl}/${name}.git`, token };
      },
      async revoke(token) {
        await call({ kind: "token", token, signal }, "DELETE", "/installation/token");
      },
    };
  }

  return { repo };
}

/** Decodes the base64 secret setting into PEM text. */
export function decodePrivateKey(base64: string): { ok: true; pem: string } | { ok: false; error: string } {
  const pem = Buffer.from(base64.trim(), "base64").toString("utf8");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return { ok: false, error: "githubPrivateKey is not a base64-encoded PEM private key" };
  try {
    createPrivateKey(pem);
    return { ok: true, pem };
  } catch (error) {
    return { ok: false, error: `githubPrivateKey is not a usable private key: ${error instanceof Error ? error.message : String(error)}` };
  }
}
