/**
 * The GitHub App client. createGitHub(...).repo(name) returns a client that holds a valid installation token for that
 * repository. App JWTs, installation lookup, token caching, ETags, pagination, rate-limit headers, the permission
 * cache and the REST wire format stay in here. Callers see domain types and three error classes.
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { CONVENTIONAL_TITLE, type RepoName, type Sha } from "./job.ts";

export type GitHubCredentials = { appId: string; privateKey: string };

export type GitHubOptions = {
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
  addLabels(issue: number, labels: readonly string[]): Promise<void>;
  /** A label that is not on the issue is success. */
  removeLabel(issue: number, label: string): Promise<void>;
  comment(issue: number, body: string): Promise<{ id: number }>;
  createDraftPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  /** A fresh token for this one repository with only `contents: write`, and the HTTPS remote. Revoke it after the push. */
  pushCredentials(): Promise<{ remoteUrl: string; token: string }>;
  revoke(token: string): Promise<void>;
};

export type GitHub = {
  /** A client for one repository. With `signal`, every request it makes, token minting included, ends when it aborts. */
  repo(name: RepoName, signal?: AbortSignal): RepoClient;
};

type Cursor = { since: string | null; etag: string | null };
type Cached<T> = { value: T; until: number };

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
        const previous = cursor as unknown as Cursor | null;
        const query = new URLSearchParams({ labels: label, state: "open", sort: "updated", direction: "asc", per_page: "100" });
        if (previous?.since) query.set("since", previous.since);
        const path = `${base}/issues?${query}`;
        const first = await request(auth, "GET", path, { etag: previous?.etag ?? null });
        if (first.status === 304) return { changed: false };
        const raw = await pages<{ number: number; title: string; body: string | null; html_url: string; user: { login: string }; updated_at: string; pull_request?: unknown }>(auth, path, first);
        const issues = raw
          .filter((item) => item.pull_request === undefined)
          .map((item) => ({ number: item.number, title: item.title, body: item.body ?? "", url: item.html_url, author: item.user.login, updatedAt: Date.parse(item.updated_at) }));
        const newest = raw.map((item) => item.updated_at).sort().at(-1) ?? previous?.since ?? null;
        // The ETag belongs to the URL it came from; a new `since` makes a new URL, so the old tag would never match.
        const etag = newest === (previous?.since ?? null) ? first.headers.get("etag") : null;
        return { changed: true, issues, next: { since: newest, etag } as unknown as PollCursor };
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
