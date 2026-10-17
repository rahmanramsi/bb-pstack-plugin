/**
 * The GitHub App client. createGitHub(...).repo(name) returns a client that holds a valid installation token for that
 * repository. App JWTs, installation lookup, token caching, ETags, pagination, rate-limit headers, the permission
 * cache and the REST wire format stay in here. Callers see domain types and three error classes.
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
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
  constructor(message: string, notBefore: number | null) {
    super(message);
    this.notBefore = notBefore;
  }
}

/** A response that retrying will not change. */
export class GitHubPermanentError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The App is not installed on the repository, or its credentials are missing or rejected. */
export class GitHubSetupError extends Error {}

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export const CAN_TRIGGER: ReadonlySet<Permission> = new Set(["admin", "maintain", "write"]);

export type LabeledIssue = { number: number; title: string; body: string; url: string; author: string; updatedAt: number };
export type LabelEvent = { id: number; actor: string; at: number };
/** Opaque to callers, who store it and hand it back. */
export type PollCursor = { readonly __brand: "PollCursor" };
/** Opaque to callers, like PollCursor: per pull request list cursors, ETags, and the last known review states. */
export type FeedbackCursor = { readonly __brand: "FeedbackCursor" };

export type RepoClient = {
  readonly name: RepoName;
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
  /** An issue comment by the App containing `marker`, posted at or after `since`. */
  findComment(issue: number, marker: string, since: number): Promise<{ id: number } | null>;
  /** An inline review comment by the App on pull request `pr` containing `marker`, posted at or after `since`. */
  findReviewComment(pr: number, marker: string, since: number): Promise<{ id: number } | null>;
  /**
   * Reviews, inline comments and conversation comments on each pull request since the cursor, and each one's state.
   * Unchanged lists answer 304 and cost no rate limit. Items can repeat across calls; callers dedupe on the id.
   */
  feedback(cursor: FeedbackCursor | null, pulls: readonly number[]): Promise<{ items: PolledFeedback[]; pulls: { number: number; state: PullState }[]; next: FeedbackCursor }>;
  addLabels(issue: number, labels: readonly string[]): Promise<void>;
  /** A label that is not on the issue is success. */
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<{ id: number }>;
  createDraftPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  editPull(pr: number, input: { body: string }): Promise<void>;
  /** Answers an inline review comment in its own thread. */
  replyToReviewComment(pr: number, commentId: number, body: string): Promise<{ id: number }>;
  /** Requests a review from each user who can be asked; a user GitHub refuses (422) is dropped, not an error. */
  requestReviewers(pr: number, reviewers: readonly string[]): Promise<{ requested: string[]; dropped: string[] }>;
  /** A fresh token for this one repository with only `contents: write`, and the HTTPS remote. Revoke it after the push. */
  pushCredentials(): Promise<{ remoteUrl: string; token: string }>;
  revoke(token: string): Promise<void>;
};

export type GitHub = {
  /** A client for one repository. With `signal`, every request it makes, token minting included, ends when it aborts. */
  repo(name: RepoName, signal?: AbortSignal): RepoClient;
};

type Cursor = { since: string | null; etag: string | null };
type PullCursor = {
  reviewComments: Cursor | null;
  comments: Cursor | null;
  reviews: { etag: string | null; states: Record<string, string> } | null;
  pull: { etag: string | null; state: PullState } | null;
};
type Cached<T> = { value: T; until: number };

type RawUser = { login: string } | null;
type RawReviewComment = { id: number; body: string; user: RawUser; path: string; line: number | null; original_line?: number | null; diff_hunk: string; in_reply_to_id?: number; pull_request_review_id: number | null; created_at: string; updated_at: string };
type RawComment = { id: number; body: string | null; user: RawUser; created_at: string; updated_at: string };
type RawReview = { id: number; body: string | null; user: RawUser; state: string; submitted_at?: string | null };

const PERMISSION_TTL = 10 * 60_000;
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
      throw new GitHubTransientError(`${method} ${url}: ${error instanceof Error ? error.message : String(error)}`, null);
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
    if (reply.status >= 500 || reply.status === 429 || (reply.status === 403 && retryAt !== null)) return new GitHubTransientError(message, retryAt);
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
    const authorization = async () =>
      auth.kind === "app" ? `Bearer ${appJwt()}` : auth.kind === "token" ? `Bearer ${auth.token}` : `Bearer ${await installationToken(auth.repo, auth.signal)}`;
    const sent = { ...init, signal: auth.signal };
    let reply = await send(method, url, await authorization(), sent);
    if (reply.status === 401 && auth.kind === "repo") {
      tokens.delete(await installationId(auth.repo, auth.signal));
      reply = await send(method, url, await authorization(), sent);
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
      items.push(...(reply.json as T[]));
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
  async function list<T>(auth: Auth, path: string, query: Record<string, string>, cursor: Cursor | null, since: boolean): Promise<{ items: T[]; next: Cursor } | null> {
    const params = new URLSearchParams({ ...query, per_page: "100" });
    if (since && cursor?.since) params.set("since", cursor.since);
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
      if (appSlug === null) appSlug = (await call<{ slug: string }>({ kind: "app", signal }, "GET", "/app")).json.slug;
      return `${appSlug}[bot]`;
    };
    return {
      name,
      appLogin,
      async labeledIssues(label, cursor) {
        type RawIssue = { number: number; title: string; body: string | null; html_url: string; user: { login: string }; updated_at: string; pull_request?: unknown };
        const read = await list<RawIssue>(auth, `${base}/issues`, { labels: label, state: "open", sort: "updated", direction: "asc" }, cursor as unknown as Cursor | null, true);
        if (!read) return { changed: false };
        const issues = read.items
          .filter((item) => item.pull_request === undefined)
          .map((item) => ({ number: item.number, title: item.title, body: item.body ?? "", url: item.html_url, author: item.user.login, updatedAt: Date.parse(item.updated_at) }));
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
        const found = comments.find((comment) => comment.user?.login === login && comment.body.includes(marker));
        return found ? { id: found.id } : null;
      },
      async findReviewComment(pr, marker, since) {
        const login = await appLogin();
        const comments = await pages<{ id: number; body: string; user: RawUser }>(auth, `${base}/pulls/${pr}/comments?since=${new Date(since).toISOString()}&per_page=100`);
        const found = comments.find((comment) => comment.user?.login === login && comment.body.includes(marker));
        return found ? { id: found.id } : null;
      },
      async feedback(cursor, pulls) {
        const previous = (cursor as unknown as Record<string, PullCursor> | null) ?? {};
        const items: PolledFeedback[] = [];
        const states: { number: number; state: PullState }[] = [];
        const next: Record<string, PullCursor> = {};
        const author = (user: RawUser) => user?.login ?? "ghost";
        for (const pr of pulls) {
          const was = previous[pr] ?? { reviewComments: null, comments: null, reviews: null, pull: null };
          // Comments before reviews: a comment's review exists by the time the comment is listed, so the review list
          // read after it knows that review's state.
          const inline = await list<RawReviewComment>(auth, `${base}/pulls/${pr}/comments`, { sort: "updated", direction: "asc" }, was.reviewComments, true);
          const conversation = await list<RawComment>(auth, `${base}/issues/${pr}/comments`, { sort: "updated", direction: "asc" }, was.comments, true);
          const reviews = await list<RawReview>(auth, `${base}/pulls/${pr}/reviews`, {}, was.reviews && { since: null, etag: was.reviews.etag }, false);
          const reviewStates = reviews ? Object.fromEntries(reviews.items.map((review) => [review.id, review.state])) : (was.reviews?.states ?? {});
          const pull = await request(auth, "GET", `${base}/pulls/${pr}`, { etag: was.pull?.etag ?? null });
          let state: PullState;
          if (pull.status === 304 && was.pull) state = was.pull.state;
          else if (pull.status === 200) {
            const json = pull.json as { state: string; merged?: boolean; merged_at?: string | null };
            state = json.state === "open" ? "open" : json.merged || json.merged_at ? "merged" : "closed";
          } else throw failure("GET", `${base}/pulls/${pr}`, pull);

          const none = { path: null, line: null, diffHunk: null, inReplyTo: null, reviewId: null };
          for (const comment of inline?.items ?? []) {
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
              reviewId: comment.pull_request_review_id,
              createdAt: Date.parse(comment.created_at),
              reviewState: comment.pull_request_review_id === null ? null : (reviewStates[comment.pull_request_review_id] ?? null),
            });
          }
          for (const comment of conversation?.items ?? []) {
            items.push({ kind: "pr-comment", id: comment.id, pr, author: author(comment.user), body: comment.body ?? "", ...none, createdAt: Date.parse(comment.created_at), reviewState: null });
          }
          for (const review of reviews?.items ?? []) {
            if (!review.submitted_at) continue;
            items.push({ kind: "review", id: review.id, pr, author: author(review.user), body: review.body ?? "", ...none, createdAt: Date.parse(review.submitted_at), reviewState: review.state });
          }
          states.push({ number: pr, state });
          next[pr] = {
            reviewComments: inline?.next ?? was.reviewComments,
            comments: conversation?.next ?? was.comments,
            reviews: reviews ? { etag: reviews.next.etag, states: reviewStates } : was.reviews,
            pull: { etag: pull.status === 200 ? pull.headers.get("etag") : (was.pull?.etag ?? null), state },
          };
        }
        return { items, pulls: states, next: next as unknown as FeedbackCursor };
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
      async editPull(pr, input) {
        await call(auth, "PATCH", `${base}/pulls/${pr}`, { body: input });
      },
      async replyToReviewComment(pr, commentId, body) {
        return { id: (await call<{ id: number }>(auth, "POST", `${base}/pulls/${pr}/comments/${commentId}/replies`, { body: { body } })).json.id };
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
      async pushCredentials() {
        const { token } = await mintToken(name, signal, { repositories: [name.split("/")[1]], permissions: { contents: "write" } });
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
