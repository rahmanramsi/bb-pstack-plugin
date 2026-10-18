import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { GitHubPermanentError, GitHubSetupError, GitHubTransientError, createGitHub, decodePrivateKey, type GitHubOptions } from "./github.ts";
import type { RepoName } from "./job.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const REPO = "acme/web" as RepoName;
const NOW = Date.parse("2026-10-17T12:00:00Z");

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };
/** A route that returns null never answers. */
type Route = (request: Seen) => { status: number; json?: unknown; headers?: Record<string, string> } | null;

let server: ReturnType<typeof createServer>;
let base = "";
let routes: Record<string, Route> = {};
let seen: Seen[] = [];

before(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const entry: Seen = { method: request.method!, path: request.url!, headers: request.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const route = routes[`${entry.method} ${entry.path}`] ?? routes[`${entry.method} ${entry.path.split("?")[0]}`];
      const reply = route ? route(entry) : { status: 404, json: { message: "Not Found" } };
      if (!reply) return;
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

let minted = 0;
function setup(overrides: Partial<GitHubOptions> = {}) {
  seen = [];
  minted = 0;
  const clock = { now: NOW };
  routes = {
    "GET /repos/acme/web/installation": () => ({ status: 200, json: { id: 77 } }),
    "POST /app/installations/77/access_tokens": () => ({ status: 201, json: { token: `ghs_${++minted}`, expires_at: new Date(clock.now + 60 * 60_000).toISOString() } }),
  };
  const github = createGitHub({ credentials: () => ({ appId: "123", privateKey }), apiUrl: base, gitUrl: "https://github.example", clock: () => clock.now, ...overrides });
  return { github, repo: github.repo(REPO), clock };
}

const authOf = (request: Seen) => String(request.headers.authorization);

/** Pull request 7's activity, read for issue 41, whose own comments are empty. */
async function pullOf(repo: ReturnType<typeof setup>["repo"], cursor: Parameters<ReturnType<typeof setup>["repo"]["activity"]>[1]) {
  routes["GET /repos/acme/web/issues/41/comments"] ??= () => ({ status: 200, json: [] });
  const result = await repo.activity({ issue: 41, since: 0, pr: 7 }, cursor);
  seen = seen.filter((request) => !request.path.startsWith("/repos/acme/web/issues/41/"));
  return { state: result.pull!.state, items: result.pull!.items, next: result.next };
}

test("the App JWT is RS256 with GitHub's claims, and the installation token is cached until near expiry", async () => {
  const { repo, clock } = setup();
  routes["GET /repos/acme/web"] = () => ({ status: 200, json: { default_branch: "main" } });
  assert.equal(await repo.defaultBranch(), "main");

  const jwt = authOf(seen.find((request) => request.path === "/repos/acme/web/installation")!).replace("Bearer ", "");
  const [header, payload, signature] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url"));
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "123" });
  assert.equal(authOf(seen.at(-1)!), "Bearer ghs_1");

  routes["GET /repos/acme/web/git/ref/heads/agent/issue-1-x"] = () => ({ status: 200, json: { object: { sha: "b".repeat(40) } } });
  await repo.branchSha("agent/issue-1-x");
  assert.equal(minted, 1);
  clock.now += 50 * 60_000;
  await repo.branchSha("agent/issue-1-x");
  assert.equal(minted, 2, "a token within 15 minutes of expiry is replaced");
  assert.equal(authOf(seen.at(-1)!), "Bearer ghs_2");
});

test("labeled issues drop pull requests, follow pagination, and a 304 reports no change", async () => {
  const { repo } = setup();
  const issue = (number: number, updated: string, extra = {}) => ({ number, title: `t${number}`, body: null, html_url: `https://github.com/acme/web/issues/${number}`, user: { login: "maya" }, updated_at: updated, ...extra });
  routes["GET /repos/acme/web/issues"] = (request) => {
    if (request.path.includes("page=2")) return { status: 200, json: [issue(3, "2026-10-17T11:00:00Z")] };
    if (request.headers["if-none-match"] === 'W/"v1"') return { status: 304 };
    return {
      status: 200,
      json: [issue(1, "2026-10-17T09:00:00Z"), issue(2, "2026-10-17T10:00:00Z", { pull_request: {} })],
      headers: { etag: 'W/"v1"', link: `<${base}/repos/acme/web/issues?page=2>; rel="next"` },
    };
  };
  const first = await repo.labeledIssues("agent", null);
  assert.ok(first.changed);
  assert.deepEqual(first.issues.map((item) => [item.number, item.body]), [[1, ""], [3, ""]]);
  assert.match(seen[2]!.path, /labels=agent&state=open/);

  const second = await repo.labeledIssues("agent", first.next);
  assert.ok(second.changed, "a new since is a new URL, so the first ETag is not sent");
  assert.match(seen.at(-2)!.path, /since=2026-10-17T11%3A00%3A00Z/);
  const third = await repo.labeledIssues("agent", second.next);
  assert.deepEqual(third, { changed: false });
  assert.equal(seen.at(-1)!.headers["if-none-match"], 'W/"v1"');
});

test("the issue catalog includes all labels and states, follows pages, drops PRs and refreshes its cache", async () => {
  const { repo, clock } = setup();
  const issue = (number: number, extra = {}) => ({ number, title: `Issue ${number}`, body: null, html_url: `https://github.com/acme/web/issues/${number}`, user: { login: "maya" }, updated_at: new Date(NOW).toISOString(), state: "open", labels: [], ...extra });
  routes["GET /repos/acme/web/issues"] = (request) => request.path.includes("page=2")
    ? { status: 200, json: [issue(3, { state: "closed", labels: [{ name: "bug" }] })] }
    : { status: 200, json: [issue(1), issue(2, { pull_request: {} })], headers: { link: `<${base}/repos/acme/web/issues?page=2>; rel="next"` } };
  assert.deepEqual((await repo.repositoryIssues()).map((item) => [item.number, item.state, item.labels]), [[1, "open", []], [3, "closed", ["bug"]]]);
  assert.ok(seen.some((request) => request.path.includes("state=all") && !request.path.includes("labels=")));
  const requests = seen.length;
  await repo.repositoryIssues();
  assert.equal(seen.length, requests);
  await repo.repositoryIssues(true);
  assert.equal(seen.length, requests + 2);
  clock.now += 60_000;
  await repo.repositoryIssues();
  assert.equal(seen.length, requests + 4);
});

test("a 401 drops the cached token and retries once with a fresh one", async () => {
  const { repo } = setup();
  let calls = 0;
  routes["POST /repos/acme/web/issues/5/comments"] = () => (++calls === 1 ? { status: 401, json: { message: "Bad credentials" } } : { status: 201, json: { id: 9 } });
  assert.deepEqual(await repo.comment(5, "hi"), { id: 9 });
  assert.deepEqual(seen.filter((request) => request.path.endsWith("/comments")).map(authOf), ["Bearer ghs_1", "Bearer ghs_2"]);
});

test("errors come out as transient with a retry time, permanent with a status, or setup", async () => {
  const { repo, clock } = setup();
  routes["POST /repos/acme/web/issues/5/labels"] = () => ({ status: 502, json: { message: "Bad Gateway" } });
  await assert.rejects(repo.addLabels(5, ["agent:working"]), (error) => error instanceof GitHubTransientError && error.notBefore === null);

  routes["POST /repos/acme/web/issues/5/labels"] = () => ({ status: 429, headers: { "retry-after": "30" } });
  await assert.rejects(repo.addLabels(5, ["agent:working"]), (error) => error instanceof GitHubTransientError && error.notBefore === clock.now + 30_000);

  const reset = Math.floor(NOW / 1000) + 600;
  routes["POST /repos/acme/web/issues/5/labels"] = () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
  await assert.rejects(repo.addLabels(5, ["agent:working"]), (error) => error instanceof GitHubTransientError && error.notBefore === reset * 1000);

  routes["POST /repos/acme/web/pulls"] = () => ({ status: 422, json: { message: "A pull request already exists" } });
  await assert.rejects(repo.createDraftPull({ head: "h", base: "main", title: "t", body: "b" }), (error) => error instanceof GitHubPermanentError && error.status === 422);

  const uninstalled = setup();
  routes["GET /repos/acme/web/installation"] = () => ({ status: 404 });
  await assert.rejects(uninstalled.repo.defaultBranch(), GitHubSetupError);
  await assert.rejects(createGitHub({ credentials: () => null, apiUrl: base }).repo(REPO).defaultBranch(), GitHubSetupError);
});

test("push credentials are minted fresh for one repository with contents write, and revoke deletes that token", async () => {
  const { repo } = setup();
  const first = await repo.pushCredentials();
  const second = await repo.pushCredentials();
  assert.deepEqual(first, { remoteUrl: "https://github.example/acme/web.git", token: "ghs_1" });
  assert.equal(second.token, "ghs_2");
  const mints = seen.filter((request) => request.path.endsWith("/access_tokens"));
  assert.deepEqual(mints.map((request) => request.body), [
    { repositories: ["web"], permissions: { contents: "write" } },
    { repositories: ["web"], permissions: { contents: "write" } },
  ]);

  routes["DELETE /installation/token"] = () => ({ status: 204 });
  await repo.revoke("ghs_1");
  assert.equal(authOf(seen.at(-1)!), "Bearer ghs_1");
});

test("reads map GitHub's shapes into domain answers", async () => {
  const { repo } = setup();
  routes["GET /repos/acme/web/collaborators/maya/permission"] = () => ({ status: 200, json: { permission: "write", role_name: "maintain" } });
  routes["GET /repos/acme/web/collaborators/drive-by/permission"] = () => ({ status: 404 });
  assert.equal(await repo.permission("maya"), "maintain");
  assert.equal(await repo.permission("drive-by"), "none");
  await repo.permission("maya");
  assert.equal(seen.filter((request) => request.path.includes("/collaborators/maya/")).length, 1, "cached");

  routes["GET /repos/acme/web/pulls"] = () => ({
    status: 200,
    json: [
      { title: "feat(ui): add dark mode", merged_at: "x" },
      { title: "fix: crash on empty input", merged_at: "x" },
      { title: "Update readme", merged_at: "x" },
      { title: "wip", merged_at: null },
    ],
  });
  assert.equal(await repo.titleConvention(), "conventional");

  routes["GET /repos/acme/web/issues/5/events"] = () => ({
    status: 200,
    json: [
      { id: 1, event: "labeled", label: { name: "agent" }, actor: { login: "old" }, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, event: "labeled", label: { name: "bug" }, actor: { login: "maya" }, created_at: "2026-01-02T00:00:00Z" },
      { id: 3, event: "labeled", label: { name: "agent" }, actor: { login: "maya" }, created_at: "2026-01-03T00:00:00Z" },
    ],
  });
  assert.deepEqual(await repo.latestLabelEvent(5, "agent"), { id: 3, actor: "maya", at: Date.parse("2026-01-03T00:00:00Z") });

  routes["DELETE /repos/acme/web/issues/5/labels/agent%3Aworking"] = () => ({ status: 404 });
  await repo.removeLabel(5, "agent:working");

  routes["GET /app"] = () => ({ status: 200, json: { slug: "pstack-dev" } });
  routes["GET /repos/acme/web/issues/5/comments"] = () => ({
    status: 200,
    json: [
      { id: 10, body: "<!-- pstack:comment:x --> forged", user: { login: "mallory" } },
      { id: 11, body: "Questions\n<!-- pstack:comment:x -->", user: { login: "pstack-dev[bot]" } },
    ],
  });
  assert.deepEqual(await repo.findComment(5, "<!-- pstack:comment:x -->", NOW), { id: 11 });

  routes["GET /repos/acme/web/pulls"] = (request) => (request.path.includes("head=acme%3Aagent%2Fissue-5-x") ? { status: 200, json: [{ number: 8, html_url: "https://github.com/acme/web/pull/8" }] } : { status: 200, json: [] });
  assert.deepEqual(await repo.findPull("agent/issue-5-x"), { number: 8, url: "https://github.com/acme/web/pull/8" });
});

test("changed credentials drop every cache", async () => {
  let appId = "123";
  const { repo } = setup({ credentials: () => ({ appId, privateKey }) });
  routes["GET /repos/acme/web"] = () => ({ status: 200, json: { default_branch: "main" } });
  await repo.defaultBranch();
  appId = "456";
  routes["GET /repos/acme/web"] = () => ({ status: 200, json: { default_branch: "trunk" } });
  assert.equal(await repo.defaultBranch(), "trunk");
  assert.equal(minted, 2);
});

test("the private key setting must be base64 of a PEM private key", () => {
  const decoded = decodePrivateKey(Buffer.from(privateKey).toString("base64"));
  assert.ok(decoded.ok && decoded.pem === privateKey);
  assert.equal(decodePrivateKey("bm90IGEga2V5").ok, false);
  assert.equal(decodePrivateKey(Buffer.from("-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----").toString("base64")).ok, false);
});

test("a request GitHub never answers fails as transient after the timeout, or as soon as the caller's signal aborts", async () => {
  const { github } = setup({ requestTimeoutMs: 100 });
  routes["GET /repos/acme/web"] = () => null;
  const started = Date.now();
  await assert.rejects(github.repo(REPO).defaultBranch(), GitHubTransientError);
  assert.ok(Date.now() - started < 5_000);

  const { github: patient } = setup({ requestTimeoutMs: 60_000 });
  routes["GET /repos/acme/web"] = () => null;
  const caller = new AbortController();
  const pending = patient.repo(REPO, caller.signal).defaultBranch();
  setTimeout(() => caller.abort(), 50);
  await assert.rejects(pending, GitHubTransientError);
});

test("feedback reads each pull request's inline comments, conversation comments, reviews and state, then answers 304 until something changes", async () => {
  const { repo } = setup();
  const user = (login: string) => ({ login });
  let inline = [{ id: 11, body: "Rename this.", user: user("maya"), path: "src/a.ts", line: 4, diff_hunk: "@@ -1 +1 @@", pull_request_review_id: 21, created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-17T10:00:00Z" }];
  const etagged = (json: unknown[], tag: string) => (request: Seen) => (request.headers["if-none-match"] === tag ? { status: 304 } : { status: 200, json, headers: { etag: tag } });
  routes["GET /repos/acme/web/pulls/7/comments"] = (request) => {
    const since = new URL(request.path, "http://x").searchParams.get("since");
    const json = inline.filter((comment) => !since || comment.updated_at >= since);
    return etagged(json, `"c${json.length}"`)(request);
  };
  routes["GET /repos/acme/web/issues/7/comments"] = etagged([{ id: 12, body: "@pstack-test also add a test", user: user("maya"), created_at: "2026-10-17T10:01:00Z", updated_at: "2026-10-17T10:01:00Z" }], '"i1"');
  routes["GET /repos/acme/web/pulls/7/reviews"] = etagged([{ id: 21, body: "A few things.", user: user("maya"), state: "CHANGES_REQUESTED", submitted_at: "2026-10-17T10:00:00Z" }, { id: 22, body: "", user: user("maya"), state: "PENDING" }], '"r1"');
  routes["GET /repos/acme/web/pulls/7"] = (request) => (request.headers["if-none-match"] === '"p1"' ? { status: 304 } : { status: 200, json: { state: "open", merged: false }, headers: { etag: '"p1"' } });
  routes["GET /app"] = () => ({ status: 200, json: { slug: "pstack-dev" } });
  routes["GET /repos/acme/web/pulls/7/reviews/21/comments"] = () => ({ status: 200, json: inline.slice(0, 1) });

  const first = await pullOf(repo, null);
  assert.equal(first.state, "open");
  assert.deepEqual(
    first.items.map((item) => [item.kind, item.id, item.reviewState]),
    [["review-comment", 11, "CHANGES_REQUESTED"], ["pr-comment", 12, null], ["review", 21, "CHANGES_REQUESTED"]],
  );
  assert.deepEqual(first.items[0], { kind: "review-comment", id: 11, pr: 7, author: "maya", body: "Rename this.", path: "src/a.ts", line: 4, diffHunk: "@@ -1 +1 @@", inReplyTo: null, reviewId: 21, createdAt: Date.parse("2026-10-17T10:00:00Z"), postedAt: Date.parse("2026-10-17T10:00:00Z"), reviewState: "CHANGES_REQUESTED" });

  seen = [];
  inline = [...inline, { ...inline[0]!, id: 13, body: "And this.", created_at: "2026-10-17T10:05:00Z", updated_at: "2026-10-17T10:05:00Z" }];
  const second = await pullOf(repo, first.next);
  assert.match(seen.find((request) => request.path.startsWith("/repos/acme/web/pulls/7/comments"))!.path, /since=2026-10-17T09%3A50%3A00\.000Z/);
  assert.deepEqual(second.items.map((item) => item.id), [11, 13, 12], "items inside the overlap repeat; callers dedupe");
  assert.equal(second.items[1]!.reviewState, "CHANGES_REQUESTED", "a review answered 304 keeps its known state");
  assert.equal(second.state, "open", "a pull request answered 304 keeps its known state");

  seen = [];
  const third = await pullOf(repo, second.next);
  assert.deepEqual(third.items.map((item) => item.id), [11, 13]);
  assert.deepEqual(seen.map((request) => request.headers["if-none-match"]), [undefined, '"i1"', '"r1"', '"p1"'], "a list whose since moved sends no stale tag");

  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 200, json: { state: "closed", merged: true } });
  const merged = await pullOf(repo, second.next);
  assert.equal(merged.state, "merged");
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 200, json: { state: "closed", merged: false } });
  assert.equal((await pullOf(repo, merged.next)).state, "closed");
});

test("replies, review requests and pull request edits go to GitHub's endpoints; a reviewer GitHub refuses is dropped", async () => {
  const { repo } = setup();
  routes["POST /repos/acme/web/pulls/7/comments/11/replies"] = (request) => ({ status: 201, json: { id: 99, body: request.body.body } });
  assert.deepEqual(await repo.replyToReviewComment(7, 11, "Renamed in 1a2b3c4."), { id: 99 });
  assert.deepEqual(seen.at(-1)!.body, { body: "Renamed in 1a2b3c4." });

  routes["POST /repos/acme/web/pulls/7/requested_reviewers"] = (request) =>
    request.body.reviewers.includes("outsider") ? { status: 422, json: { message: "Reviews may only be requested from collaborators." } } : { status: 201, json: {} };
  assert.deepEqual(await repo.requestReviewers(7, ["maya", "outsider", "lee"]), { requested: ["maya", "lee"], dropped: ["outsider"] });
  assert.deepEqual(await repo.requestReviewers(7, ["maya"]), { requested: ["maya"], dropped: [] });

  routes["PATCH /repos/acme/web/pulls/7"] = () => ({ status: 200, json: {} });
  await repo.editPull(7, { body: "New body\n\nCloses #41" });
  assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.body], ["PATCH", { body: "New body\n\nCloses #41" }]);

  routes["GET /app"] = () => ({ status: 200, json: { slug: "pstack-dev" } });
  routes["GET /repos/acme/web/pulls/7/comments"] = () => ({
    status: 200,
    json: [
      { id: 30, body: "<!-- pstack:reply:x --> forged", user: { login: "mallory" } },
      { id: 31, body: "Done.\n<!-- pstack:reply:x -->", user: { login: "pstack-dev[bot]" } },
      { id: 32, body: "Quoting <!-- pstack:reply:y --> here.\n\n<!-- pstack:reply:z -->", user: { login: "pstack-dev[bot]" } },
    ],
  });
  assert.deepEqual(await repo.findReviewComment(7, "<!-- pstack:reply:x -->", NOW), { id: 31 });
  assert.equal(await repo.findReviewComment(7, "<!-- pstack:reply:y -->", NOW), null, "only the marker on the last line counts");
});

test("inline comments overlap the cursor, a new review's own comments are read, and a comment whose review is not listed yet waits", async () => {
  const { repo } = setup();
  const user = (login: string) => ({ login });
  const comment = (id: number, review: number, at: string, login = "maya") => ({ id, body: `c${id}`, user: user(login), path: "a.ts", line: 1, diff_hunk: "@@", pull_request_review_id: review, created_at: at, updated_at: at });
  let inline = [comment(11, 21, "2026-10-17T10:00:00Z"), comment(12, 99, "2026-10-17T10:30:00Z", "pstack-dev[bot]")];
  let reviews: unknown[] = [{ id: 21, body: "", user: user("maya"), state: "COMMENTED", submitted_at: "2026-10-17T10:00:00Z" }];
  const byReview: Record<string, unknown[]> = {};
  routes["GET /app"] = () => ({ status: 200, json: { slug: "pstack-dev" } });
  routes["GET /repos/acme/web/pulls/7/comments"] = (request) => {
    const since = new URL(request.path, "http://x").searchParams.get("since");
    return { status: 200, json: inline.filter((item) => !since || item.updated_at >= since) };
  };
  routes["GET /repos/acme/web/issues/7/comments"] = () => ({ status: 200, json: [] });
  routes["GET /repos/acme/web/pulls/7/reviews"] = () => ({ status: 200, json: reviews });
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 200, json: { state: "open" } });
  for (const id of [21, 22]) routes[`GET /repos/acme/web/pulls/7/reviews/${id}/comments`] = () => ({ status: 200, json: byReview[id] ?? [] });

  const first = await pullOf(repo, null);
  assert.deepEqual(first.items.filter((item) => item.kind === "review-comment").map((item) => item.id), [11], "the comment of review 99, not listed yet, waits");

  const drafted = comment(13, 22, "2026-10-17T09:00:00Z", "lee");
  inline = [...inline, drafted];
  byReview[22] = [drafted];
  reviews = [...reviews, { id: 22, body: "", user: user("lee"), state: "CHANGES_REQUESTED", submitted_at: "2026-10-17T11:00:00Z" }, { id: 99, body: "", user: user("pstack-dev[bot]"), state: "COMMENTED", submitted_at: "2026-10-17T10:30:00Z" }];
  seen = [];
  const second = await pullOf(repo, first.next);
  assert.match(seen.find((request) => request.path.startsWith("/repos/acme/web/pulls/7/comments?"))!.path, /since=2026-10-17T10%3A20%3A00\.000Z/, "ten minutes before the newest comment seen");
  const comments = second.items.filter((item) => item.kind === "review-comment");
  assert.deepEqual(comments.map((item) => [item.id, item.reviewState]), [[12, "COMMENTED"], [13, "CHANGES_REQUESTED"]], "the overlap re-reads the waiting comment, and review 22's drafted comment arrives through the review");
  assert.equal(comments[1]!.postedAt, Date.parse("2026-10-17T11:00:00Z"), "a review's comments count from its submission");
  assert.ok(!seen.some((request) => request.path.includes("/reviews/99/comments")), "the App's own review is not read");
});

test("a job's activity reads its issue's comments from when the job started, then from the cursor", async () => {
  const { repo } = setup();
  const comments = [
    { id: 1, body: "@pstack-test stop", user: { login: "maya" }, created_at: "2026-10-17T09:00:00Z", updated_at: "2026-10-17T09:00:00Z" },
    { id: 2, body: "@pstack-test stop", user: { login: "lee" }, created_at: "2026-10-17T11:00:00Z", updated_at: "2026-10-17T11:00:00Z" },
  ];
  routes["GET /repos/acme/web/issues/41/comments"] = (request) => {
    const since = new URL(request.path, "http://x").searchParams.get("since");
    return { status: 200, json: comments.filter((comment) => !since || comment.updated_at >= since) };
  };
  const first = await repo.activity({ issue: 41, since: Date.parse("2026-10-17T10:00:00Z"), pr: null }, null);
  assert.deepEqual(first.issueComments, [{ id: 2, author: "lee", body: "@pstack-test stop", createdAt: Date.parse("2026-10-17T11:00:00Z") }]);
  assert.equal(first.pull, null, "no pull request yet, nothing else is read");
  assert.equal(seen.filter((request) => request.path.includes("/pulls/")).length, 0);
  await repo.activity({ issue: 41, since: 0, pr: null }, first.next);
  assert.match(seen.at(-1)!.path, /since=2026-10-17T11%3A00%3A00Z/);
});

const HEAD = "a".repeat(40) as import("./job.ts").Sha;
const BASE = "b".repeat(40) as import("./job.ts").Sha;
const NEXT_HEAD = "c".repeat(40) as import("./job.ts").Sha;
const NEXT_BASE = "d".repeat(40) as import("./job.ts").Sha;

function autonomySetup(options: Partial<GitHubOptions> = {}) {
  const result = setup(options);
  const grants: Record<string, string> = { contents: "write", issues: "write", pull_requests: "write", checks: "read", statuses: "read" };
  routes["GET /repos/acme/web/installation"] = () => ({ status: 200, json: { id: 77, permissions: grants, suspended_at: null } });
  routes["GET /repos/acme/web"] = () => ({ status: 200, json: { id: 1234, default_branch: "main", archived: false } });
  routes["GET /repos/acme/web/git/ref/heads/main"] = () => ({ status: 200, json: { object: { sha: BASE } } });
  const pull = {
    number: 7, node_id: "PR_7", html_url: "https://github.example/acme/web/pull/7", state: "open", draft: true,
    merged_at: null as string | null, mergeable: true as boolean | null, mergeable_state: "clean",
    head: { ref: "agent/issue-5-test", sha: HEAD, repo: { full_name: "acme/web" } },
    base: { ref: "main", sha: BASE, repo: { full_name: "acme/web" } },
  };
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 200, json: pull });
  for (const sha of [HEAD, NEXT_HEAD]) {
    routes[`GET /repos/acme/web/commits/${sha}/check-suites`] = () => ({ status: 200, json: { total_count: 0, check_suites: [] } });
    routes[`GET /repos/acme/web/commits/${sha}/statuses`] = () => ({ status: 200, json: [] });
  }
  routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: false, commit: { sha: pull.base.sha } } });
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [] });
  routes["POST /graphql"] = (request) => {
    pull.draft = request.body.query.includes("convertPullRequestToDraft");
    const mutation = pull.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    return { status: 200, json: { data: { [mutation]: { pullRequest: { id: "PR_7", isDraft: pull.draft } } } } };
  };
  return { ...result, grants, pull };
}

const target = () => ({ pr: 7, head: HEAD, base: BASE });
const suite = (id: number, app = 1, head = HEAD) => ({ id, head_sha: head, app: { id: app, slug: `app-${app}` }, status: "completed", conclusion: "success" });
const run = (id: number, app = 1, conclusion = "success", extra = {}) => ({ id, app: { id: app }, name: "build", head_sha: HEAD, status: "completed", conclusion, html_url: null, ...extra });
const status = (id: number, state: string, created_at = "2026-10-17T10:00:00Z") => ({ id, context: "build", state, target_url: null, created_at });

test("capabilities read effective installation grants and refresh repository/default-head/grants without broad scopes", async () => {
  const { repo, grants, clock } = autonomySetup();
  const first = await repo.capabilities({ fresh: false });
  assert.deepEqual(first, { repositoryId: 1234, archived: false, defaultBranch: "main", defaultHead: BASE, observedAt: NOW,
    permissions: { contents: "write", issues: "write", pullRequests: "write", workflows: "none", checks: "read", statuses: "read" } });
  grants.workflows = "write";
  assert.equal((await repo.capabilities({ fresh: false })).permissions.workflows, "none");
  routes["GET /repos/acme/web/git/ref/heads/main"] = () => ({ status: 200, json: { object: { sha: NEXT_BASE } } });
  clock.now++;
  const fresh = await repo.capabilities({ fresh: true });
  assert.equal(fresh.permissions.workflows, "write");
  assert.equal(fresh.defaultHead, NEXT_BASE);
  assert.equal(fresh.observedAt, NOW + 1);
  assert.equal(seen.filter((request) => request.path.endsWith("/installation")).length, 2);
  assert.ok(!seen.some((request) => request.path.includes("/protection")));
});

test("fresh capability inspection distinguishes missing/rejected/suspended setup from transient faults", async () => {
  const { repo } = autonomySetup();
  for (const code of [401, 404]) {
    routes["GET /repos/acme/web/installation"] = () => ({ status: code });
    await assert.rejects(repo.capabilities({ fresh: true }), GitHubSetupError);
  }
  routes["GET /repos/acme/web/installation"] = () => ({ status: 503 });
  await assert.rejects(repo.capabilities({ fresh: true }), GitHubTransientError);
  routes["GET /repos/acme/web/installation"] = () => ({ status: 200, json: { id: 77, permissions: {}, suspended_at: new Date(NOW).toISOString() } });
  await assert.rejects(repo.capabilities({ fresh: true }), GitHubSetupError);
});

test("workflow push tokens require existing grants and request only contents plus workflows for one repository", async () => {
  const { repo, grants } = autonomySetup();
  await repo.pushCredentials({ workflows: false });
  await assert.rejects(repo.pushCredentials({ workflows: true }), (error) => error instanceof GitHubPermanentError && error.code === "missing-capability");
  assert.equal(seen.filter((request) => request.body?.permissions?.workflows).length, 0);
  grants.workflows = "write";
  const credentials = await repo.pushCredentials({ workflows: true });
  assert.equal(credentials.remoteUrl, "https://github.example/acme/web.git");
  assert.deepEqual(seen.filter((request) => request.body?.permissions?.workflows).map((request) => request.body), [
    { repositories: ["web"], permissions: { contents: "write", workflows: "write" } },
  ]);
  assert.ok(!seen.some((request) => request.method === "DELETE"), "the transport never revokes credentials owned by its caller");
});

test("permission denial invalidates capability cache and preserves a typed denial", async () => {
  const { repo, grants } = autonomySetup();
  await repo.capabilities({ fresh: false });
  grants.issues = "read";
  routes["POST /repos/acme/web/issues/5/comments"] = () => ({ status: 403, json: { message: "Resource not accessible by integration" } });
  await assert.rejects(repo.comment(5, "test"), (error) => error instanceof GitHubPermanentError && error.code === "denied");
  assert.equal((await repo.capabilities({ fresh: false })).permissions.issues, "read");
});

test("snapshot observes known empty policy without an administration request and reads fresh without ETags", async () => {
  const { repo, pull } = autonomySetup();
  const snapshot = await repo.reviewSnapshot(7);
  assert.deepEqual(snapshot, { ...target(), url: pull.html_url, state: "open", draft: true, headRepository: REPO,
    headBranch: pull.head.ref, baseBranch: "main", mergeability: "clean", observedAt: NOW, complete: true, checks: [],
    required: { kind: "known", checks: [], blockers: [] } });
  await repo.reviewSnapshot(7);
  assert.equal(seen.filter((request) => request.path === "/repos/acme/web/pulls/7").length, 4);
  assert.ok(!seen.some((request) => request.path.includes("/protection") || request.headers["if-none-match"]));
});

test("snapshot paginates suites, runs, statuses and active rules and preserves newest attempts and App identities", async () => {
  const { repo } = autonomySetup();
  routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = (request) => request.path.includes("page=2")
    ? { status: 200, json: { total_count: 2, check_suites: [suite(12, 2)] } }
    : { status: 200, json: { total_count: 2, check_suites: [suite(11)] }, headers: { link: `<${base}/repos/acme/web/commits/${HEAD}/check-suites?page=2>; rel="next"` } };
  routes["GET /repos/acme/web/check-suites/11/check-runs"] = (request) => request.path.includes("page=2")
    ? { status: 200, json: { total_count: 2, check_runs: [run(20, 1, "success", { status: "queued", conclusion: null })] } }
    : { status: 200, json: { total_count: 2, check_runs: [run(10)] }, headers: { link: `<${base}/repos/acme/web/check-suites/11/check-runs?page=2>; rel="next"` } };
  routes["GET /repos/acme/web/check-suites/12/check-runs"] = () => ({ status: 200, json: { total_count: 1, check_runs: [run(30, 2, "failure")] } });
  routes[`GET /repos/acme/web/commits/${HEAD}/statuses`] = (request) => request.path.includes("page=2")
    ? { status: 200, json: [status(99, "failure", "2026-10-17T09:00:00Z")] }
    : { status: 200, json: [status(100, "success")], headers: { link: `<${base}/repos/acme/web/commits/${HEAD}/statuses?page=2>; rel="next"` } };
  routes["GET /repos/acme/web/rules/branches/main"] = (request) => request.path.includes("page=2")
    ? { status: 200, json: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 2 }], strict_required_status_checks_policy: false } }] }
    : { status: 200, json: [{ type: "pull_request", parameters: { required_review_thread_resolution: false, required_approving_review_count: 2 } }], headers: { link: `<${base}/repos/acme/web/rules/branches/main?page=2>; rel="next"` } };
  const snapshot = (await repo.reviewSnapshot(7))!;
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.checks.map((check) => [check.id, check.name, check.source, check.appId, check.state, check.head]), [
    ["check-run:20", "build", "check-run", 1, "pending", HEAD], ["check-run:30", "build", "check-run", 2, "failure", HEAD],
    ["status:100", "build", "status", null, "success", HEAD],
  ]);
  assert.deepEqual(snapshot.required, { kind: "known", checks: [{ name: "build", source: "either", appId: 2, accepted: ["success", "neutral", "skipped"] }], blockers: [] });
  assert.ok(seen.some((request) => request.path.includes("filter=all")));
});

test("snapshots select newest App/name attempts across suites and retain pending suites and distinct Apps", async () => {
  for (const pending of [false, true]) {
    const { repo } = autonomySetup();
    routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = (request) => request.path.includes("page=2")
      ? { status: 200, json: { total_count: 4, check_suites: [suite(11), suite(14, 2)] } }
      : { status: 200, json: { total_count: 4, check_suites: [suite(12), { ...suite(13), status: "queued", conclusion: null }] },
        headers: { link: `<${base}/repos/acme/web/commits/${HEAD}/check-suites?page=2>; rel="next"` } };
    routes["GET /repos/acme/web/check-suites/11/check-runs"] = () => ({ status: 200, json: { total_count: 1, check_runs: [run(10, 1, "failure")] } });
    routes["GET /repos/acme/web/check-suites/12/check-runs"] = () => ({ status: 200, json: { total_count: 1,
      check_runs: [run(20, 1, "success", pending ? { status: "queued", conclusion: null } : {})] } });
    routes["GET /repos/acme/web/check-suites/13/check-runs"] = () => ({ status: 200, json: { total_count: 0, check_runs: [] } });
    routes["GET /repos/acme/web/check-suites/14/check-runs"] = () => ({ status: 200, json: { total_count: 1, check_runs: [run(30, 2, "failure")] } });
    const snapshot = (await repo.reviewSnapshot(7))!;
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.checks.filter((check) => check.id.startsWith("check-run:")).map((check) => [check.id, check.appId, check.state]),
      [["check-run:20", 1, pending ? "pending" : "success"], ["check-run:30", 2, "failure"]]);
    assert.deepEqual(snapshot.checks.filter((check) => check.id.startsWith("check-suite:")).map((check) => check.state), ["pending"]);
  }
});

test("zero-run successful suites cannot supply required check evidence under the App name", async () => {
  for (const conclusion of ["success", "neutral", "skipped"]) {
    const { repo } = autonomySetup();
    routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = () => ({ status: 200, json: { total_count: 1,
      check_suites: [{ ...suite(11), conclusion }] } });
    routes["GET /repos/acme/web/check-suites/11/check-runs"] = () => ({ status: 200, json: { total_count: 0, check_runs: [] } });
    routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [{ type: "required_status_checks", parameters: {
      required_status_checks: [{ context: "app-1", integration_id: 1 }], strict_required_status_checks_policy: false,
    } }] });
    const snapshot = (await repo.reviewSnapshot(7))!;
    assert.deepEqual(snapshot.checks, []);
    assert.deepEqual(snapshot.required.checks, [{ name: "app-1", source: "either", appId: 1, accepted: ["success", "neutral", "skipped"] }]);
  }
});

test("zero-run failing and unknown suites retain conservative aggregate signals", async () => {
  for (const conclusion of ["failure", "cancelled", "future_conclusion"]) {
    const { repo } = autonomySetup();
    routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = () => ({ status: 200, json: { total_count: 1,
      check_suites: [{ ...suite(11), conclusion }] } });
    routes["GET /repos/acme/web/check-suites/11/check-runs"] = () => ({ status: 200, json: { total_count: 0, check_runs: [] } });
    assert.deepEqual((await repo.reviewSnapshot(7))!.checks.map((check) => [check.id, check.state]),
      [["check-suite:11", conclusion === "future_conclusion" ? "unknown" : conclusion]]);
  }
});

test("classic branch checks preserve App bindings while reviewer approvals do not block review readiness", async () => {
  const { repo } = autonomySetup();
  routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: true, commit: { sha: BASE } } });
  routes["GET /repos/acme/web/branches/main/protection"] = () => ({ status: 200, json: {
    required_status_checks: { strict: true, contexts: ["build", "lint"], checks: [{ context: "build", app_id: 14 }, { context: "lint", app_id: -1 }] },
    required_pull_request_reviews: { required_approving_review_count: 3, require_code_owner_reviews: true },
  } });
  const snapshot = (await repo.reviewSnapshot(7))!;
  assert.deepEqual(snapshot.required, { kind: "known", checks: [
    { name: "build", source: "either", appId: 14, accepted: ["success", "neutral", "skipped"] },
    { name: "lint", source: "either", appId: null, accepted: ["success", "neutral", "skipped"] },
  ], blockers: [] });
});

test("policy denial, masked classic 404 and unsupported rules never become known-empty", async () => {
  const { repo } = autonomySetup();
  for (const code of [403, 404]) {
    routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: code });
    assert.equal((await repo.reviewSnapshot(7))!.required.kind, "unavailable");
  }
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [] });
  routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: true, commit: { sha: BASE } } });
  assert.equal((await repo.reviewSnapshot(7))!.required.kind, "unavailable");
  routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: false, commit: { sha: BASE } } });
  for (const type of ["workflows", "required_deployments", "future_rule"]) {
    routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [{ type }] });
    assert.equal((await repo.reviewSnapshot(7))!.required.kind, "unavailable");
  }
});

test("rate-limited or malformed policy reads fail truthfully instead of returning empty policy", async () => {
  const { repo } = autonomySetup();
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 403, headers: { "retry-after": "30" } });
  await assert.rejects(repo.reviewSnapshot(7), (error) => error instanceof GitHubTransientError && error.notBefore === NOW + 30_000);
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: {} });
  await assert.rejects(repo.reviewSnapshot(7), GitHubTransientError);
});

test("unavailable rules preserve observed checks and blockers regardless of unsupported rule order", async () => {
  for (const unsupportedFirst of [false, true]) {
    const { repo, pull } = autonomySetup();
    pull.mergeable_state = "behind";
    const required = { type: "required_status_checks", parameters: {
      required_status_checks: [{ context: "build", integration_id: 2 }], strict_required_status_checks_policy: true,
    } };
    const unsupported = { type: "workflows" };
    routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200,
      json: unsupportedFirst ? [unsupported, required] : [required, unsupported] });
    const policy = (await repo.reviewSnapshot(7))!.required;
    assert.equal(policy.kind, "unavailable");
    assert.deepEqual(policy.checks, [{ name: "build", source: "either", appId: 2, accepted: ["success", "neutral", "skipped"] }]);
    assert.deepEqual(policy.blockers, ["base branch must be incorporated into the head"]);
  }
});

test("policy denial after an observed rules page or before classic protection retains known constraints", async () => {
  for (const denyClassic of [false, true]) {
    const { repo, pull } = autonomySetup();
    pull.mergeable_state = "behind";
    routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: denyClassic, commit: { sha: BASE } } });
    routes["GET /repos/acme/web/rules/branches/main"] = (request) => request.path.includes("page=2")
      ? { status: 403 }
      : { status: 200, json: [{ type: "required_status_checks", parameters: {
        required_status_checks: [{ context: "build", integration_id: 2 }], strict_required_status_checks_policy: true,
      } }], ...(denyClassic ? {} : { headers: { link: `<${base}/repos/acme/web/rules/branches/main?page=2>; rel="next"` } }) };
    routes["GET /repos/acme/web/branches/main/protection"] = () => ({ status: 404 });
    const policy = (await repo.reviewSnapshot(7))!.required;
    assert.equal(policy.kind, "unavailable");
    assert.deepEqual(policy.checks, [{ name: "build", source: "either", appId: 2, accepted: ["success", "neutral", "skipped"] }]);
    assert.deepEqual(policy.blockers, ["base branch must be incorporated into the head"]);
  }
});

test("unavailable classic policy retains bound checks, unbound contexts and the strict base blocker", async () => {
  for (const unsupported of [false, true]) {
    const { repo, pull } = autonomySetup();
    pull.mergeable_state = "behind";
    routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: true, commit: { sha: BASE } } });
    routes["GET /repos/acme/web/branches/main/protection"] = () => ({ status: 200, json: {
      required_status_checks: { strict: true, contexts: ["build", "lint"], checks: [{ context: "build", app_id: 14 }] },
      required_conversation_resolution: { enabled: unsupported },
    } });
    const policy = (await repo.reviewSnapshot(7))!.required;
    assert.equal(policy.kind, "unavailable");
    assert.deepEqual(policy.checks, [
      { name: "build", source: "either", appId: 14, accepted: ["success", "neutral", "skipped"] },
      { name: "lint", source: "either", appId: null, accepted: ["success", "neutral", "skipped"] },
    ]);
    assert.deepEqual(policy.blockers, ["base branch must be incorporated into the head"]);
  }
});

test("a head or base race invalidates the snapshot and preserves the actual observed identity", async () => {
  for (const field of ["head", "base"] as const) {
    const { repo, pull } = autonomySetup();
    let reads = 0;
    routes["GET /repos/acme/web/pulls/7"] = () => {
      if (++reads === 2) pull[field].sha = field === "head" ? NEXT_HEAD : NEXT_BASE;
      return { status: 200, json: pull };
    };
    const snapshot = (await repo.reviewSnapshot(7))!;
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot[field], field === "head" ? NEXT_HEAD : NEXT_BASE);
  }
});

test("truncated check pages and mismatched check heads cannot produce a complete snapshot", async () => {
  const { repo } = autonomySetup();
  routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = () => ({ status: 200, json: { total_count: 2, check_suites: [suite(11)] } });
  routes["GET /repos/acme/web/check-suites/11/check-runs"] = () => ({ status: 200, json: { total_count: 1, check_runs: [run(10, 1, "success", { head_sha: NEXT_HEAD })] } });
  assert.equal((await repo.reviewSnapshot(7))!.complete, false);
});

test("only confirmed missing PRs return null; permission masking and read faults remain errors", async () => {
  const { repo, grants } = autonomySetup();
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 404 });
  assert.equal(await repo.reviewSnapshot(7), null);
  delete grants.pull_requests;
  await assert.rejects(repo.reviewSnapshot(7), (error) => error instanceof GitHubPermanentError && error.code === "missing-capability");
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 502 });
  await assert.rejects(repo.reviewSnapshot(7), GitHubTransientError);
});

test("guarded draft conversion uses GraphQL node IDs and observes the requested result", async () => {
  const { repo } = autonomySetup();
  const ready = await repo.setDraft({ expected: target(), draft: false });
  assert.equal(ready.kind, "observed");
  assert.ok(!ready.snapshot.draft);
  const draft = await repo.setDraft({ expected: target(), draft: true });
  assert.ok(draft.kind !== "missing" && draft.snapshot.draft);
  const mutations = seen.filter((request) => request.path === "/graphql");
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0]!.body.variables, { input: { pullRequestId: "PR_7" } });
  assert.match(mutations[0]!.body.query, /markPullRequestReadyForReview/);
  assert.match(mutations[1]!.body.query, /convertPullRequestToDraft/);
});

test("draft conversion detects stale head/base before mutation, including the ID-resolution race", async () => {
  for (const raceAt of [1, 3]) {
    for (const field of ["head", "base"] as const) {
      const { repo, pull } = autonomySetup();
      let reads = 0;
      routes["GET /repos/acme/web/pulls/7"] = () => {
        if (++reads === raceAt) pull[field].sha = field === "head" ? NEXT_HEAD : NEXT_BASE;
        return { status: 200, json: pull };
      };
      assert.equal((await repo.setDraft({ expected: target(), draft: false })).kind, "stale");
      assert.ok(!seen.some((request) => request.path === "/graphql"));
    }
  }
});

test("post-mutation head/base races return stale and never claim current readiness", async () => {
  for (const field of ["head", "base"] as const) {
    const { repo, pull } = autonomySetup();
    routes["POST /graphql"] = () => {
      pull.draft = false;
      pull[field].sha = field === "head" ? NEXT_HEAD : NEXT_BASE;
      return { status: 200, json: { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_7", isDraft: false } } } } };
    };
    assert.equal((await repo.setDraft({ expected: target(), draft: false })).kind, "stale");
  }
});

test("closed and missing PR conversion are observed without mutations", async () => {
  const { repo, pull } = autonomySetup();
  pull.state = "closed";
  assert.equal((await repo.setDraft({ expected: target(), draft: false })).kind, "closed");
  routes["GET /repos/acme/web/pulls/7"] = () => ({ status: 404 });
  assert.equal((await repo.setDraft({ expected: target(), draft: false })).kind, "missing");
  assert.ok(!seen.some((request) => request.path === "/graphql"));
});

test("GraphQL authorization failures are permanent and a lost mutation response is probed before retry", async () => {
  const { repo, pull } = autonomySetup({ requestTimeoutMs: 40 });
  routes["POST /graphql"] = () => ({ status: 200, json: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } });
  await assert.rejects(repo.setDraft({ expected: target(), draft: false }), (error) => error instanceof GitHubPermanentError && error.code === "denied");
  routes["POST /graphql"] = () => { pull.draft = false; return null; };
  const result = await repo.setDraft({ expected: target(), draft: false });
  assert.equal(result.kind, "observed");
  assert.ok(!result.snapshot.draft);
  assert.equal(seen.filter((request) => request.path === "/graphql").length, 2);
});

test("HTTP 200 GraphQL throttling and service errors remain uncertain with cooldowns", async () => {
  const cases: { type?: string; message: string; headers?: Record<string, string>; retryAt: number | null }[] = [
    { type: "RATE_LIMITED", message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 120) }, retryAt: NOW + 120_000 },
    { type: "RATE_LIMITED", message: "API rate limit exceeded", headers: { "retry-after": "30" }, retryAt: NOW + 30_000 },
    { type: "RATE_LIMITED", message: "API rate limit exceeded", retryAt: NOW + 60_000 },
    { type: "INTERNAL", message: "Something went wrong while executing your query", retryAt: null },
    { type: "SERVICE_UNAVAILABLE", message: "Service unavailable", headers: { "retry-after": "45" }, retryAt: NOW + 45_000 },
    { message: "We couldn't respond to your request in time", retryAt: null },
    { message: "You have exceeded a secondary rate limit", headers: { "retry-after": "90" }, retryAt: NOW + 90_000 },
  ];
  for (const { type, message, headers, retryAt } of cases) {
    const { repo } = autonomySetup();
    routes["POST /graphql"] = () => ({ status: 200, json: { data: null, errors: [{ type, message }] }, headers });
    await assert.rejects(repo.setDraft({ expected: target(), draft: false }),
      (error) => error instanceof GitHubTransientError && error.uncertain && error.notBefore === retryAt);
    assert.equal(seen.filter((request) => request.path === "/graphql").length, 1);
  }
});

test("GraphQL denial and invalid input remain permanent even with cooldown headers", async () => {
  for (const type of ["FORBIDDEN", "INSUFFICIENT_SCOPES", "UNPROCESSABLE"]) {
    const { repo } = autonomySetup();
    routes["POST /graphql"] = () => ({ status: 200, json: { errors: [{ type, message: "Request rejected" }] }, headers: { "retry-after": "30" } });
    await assert.rejects(repo.setDraft({ expected: target(), draft: false }),
      (error) => error instanceof GitHubPermanentError && error.code === (type === "UNPROCESSABLE" ? "invalid" : "denied"));
  }
});

test("a service fault after draft conversion probes the result without replaying the mutation", async () => {
  const { repo, pull } = autonomySetup();
  routes["POST /graphql"] = () => {
    pull.draft = false;
    return { status: 200, json: { data: null, errors: [{ type: "INTERNAL", message: "Service failure" }] } };
  };
  const result = await repo.setDraft({ expected: target(), draft: false });
  assert.ok(result.kind === "observed" && !result.snapshot.draft);
  assert.equal(seen.filter((request) => request.path === "/graphql").length, 1);
});

test("a failed mutation probe preserves uncertainty and the longest observed cooldown", async () => {
  for (const probeDelay of [null, "180"]) {
    const { repo, pull } = autonomySetup();
    let pullReads = 0;
    routes["GET /repos/acme/web/pulls/7"] = () => ++pullReads <= 3
      ? { status: 200, json: pull }
      : { status: 503, ...(probeDelay ? { headers: { "retry-after": probeDelay } } : {}) };
    routes["POST /graphql"] = () => ({ status: 200, json: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      headers: { "retry-after": "120" } });
    await assert.rejects(repo.setDraft({ expected: target(), draft: false }),
      (error) => error instanceof GitHubTransientError && error.uncertain && error.notBefore === NOW + (probeDelay ? 180_000 : 120_000));
    assert.equal(seen.filter((request) => request.path === "/graphql").length, 1);
  }
});

function statusSetup(options: Partial<GitHubOptions> = {}) {
  const result = autonomySetup(options);
  routes["GET /app"] = () => ({ status: 200, json: { slug: "pstack-dev" } });
  const comments = new Map<number, ReturnType<typeof markedComment>>();
  let next = 10;
  routes["GET /repos/acme/web/issues/5/comments"] = () => ({ status: 200, json: [...comments.values()] });
  routes["POST /repos/acme/web/issues/5/comments"] = (request) => {
    const comment = markedComment(next++, request.body.body);
    comments.set(comment.id, comment);
    return { status: 201, json: comment };
  };
  function route(id: number) {
    routes[`GET /repos/acme/web/issues/comments/${id}`] = () => comments.has(id) ? { status: 200, json: comments.get(id) } : { status: 404 };
    routes[`PATCH /repos/acme/web/issues/comments/${id}`] = (request) => {
      const comment = comments.get(id);
      if (!comment) return { status: 404 };
      comment.body = request.body.body;
      return { status: 200, json: comment };
    };
    routes[`DELETE /repos/acme/web/issues/comments/${id}`] = () => { comments.delete(id); return { status: 204 }; };
  }
  for (let id = 1; id < 30; id++) route(id);
  return { ...result, comments };
}
const STATUS_MARKER = "<!-- pstack:issue-status:acme/web:5 -->";
function markedComment(id: number, body = `Old status\n${STATUS_MARKER}`) {
  return { id, created_at: new Date(NOW + id).toISOString(), body, user: { login: "pstack-dev[bot]", type: "Bot" }, performed_via_github_app: { id: 123 }, issue_url: `${base}/repos/acme/web/issues/5` };
}
const statusInput = (revision = 1) => ({ issue: 5, marker: STATUS_MARKER, revision, body: `Status revision ${revision}.` });

test("status upsert creates once, updates the same App-owned comment repeatedly and recreates deleted comments", async () => {
  const { repo, comments } = statusSetup();
  assert.deepEqual(await repo.upsertIssueStatus(statusInput()), { commentId: 10 });
  await repo.upsertIssueStatus(statusInput());
  assert.equal(seen.filter((request) => request.method === "POST" && request.path.endsWith("/comments")).length, 1);
  assert.equal(seen.filter((request) => request.method === "PATCH").length, 0);
  await repo.upsertIssueStatus(statusInput(2));
  assert.match(comments.get(10)!.body, /Status revision 2\./);
  assert.match(comments.get(10)!.body, /status-revision:2/);
  comments.delete(10);
  assert.deepEqual(await repo.upsertIssueStatus(statusInput(3)), { commentId: 11 });
});

test("status reconciliation paginates without cutoff, keeps oldest owned comment and removes only rechecked duplicates", async () => {
  const { repo, comments } = statusSetup();
  comments.set(1, markedComment(1));
  comments.set(2, markedComment(2));
  comments.set(3, { ...markedComment(3), performed_via_github_app: { id: 456 } });
  comments.set(4, { ...markedComment(4), body: `Quoted\n${STATUS_MARKER}\nAdditional text` });
  comments.set(5, { ...markedComment(5), issue_url: `${base}/repos/acme/web/issues/6` });
  routes["GET /repos/acme/web/issues/5/comments"] = (request) => request.path.includes("page=2")
    ? { status: 200, json: [...comments.values()].filter((comment) => comment.id !== 1) }
    : { status: 200, json: [comments.get(1)], headers: { link: `<${base}/repos/acme/web/issues/5/comments?page=2>; rel="next"` } };
  assert.deepEqual(await repo.upsertIssueStatus(statusInput()), { commentId: 1 });
  assert.deepEqual([...comments.keys()], [1, 3, 4, 5]);
  assert.ok(seen.filter((request) => request.path.includes("/issues/5/comments")).every((request) => !request.path.includes("since=")));
});

test("lost create response is probed and converges without a second create", async () => {
  const { repo, comments } = statusSetup({ requestTimeoutMs: 40 });
  routes["POST /repos/acme/web/issues/5/comments"] = (request) => { comments.set(10, markedComment(10, request.body.body)); return null; };
  assert.deepEqual(await repo.upsertIssueStatus(statusInput()), { commentId: 10 });
  assert.equal(seen.filter((request) => request.method === "POST" && request.path.endsWith("/comments")).length, 1);
  assert.equal(comments.size, 1);
});

test("unobserved create timeout stays uncertain and read denial cannot trigger duplicate creation", async () => {
  const { repo } = statusSetup({ requestTimeoutMs: 40 });
  routes["POST /repos/acme/web/issues/5/comments"] = () => null;
  await assert.rejects(repo.upsertIssueStatus(statusInput()), (error) => error instanceof GitHubTransientError && error.uncertain);
  routes["GET /repos/acme/web/issues/5/comments"] = () => ({ status: 403 });
  await assert.rejects(repo.upsertIssueStatus(statusInput()), GitHubPermanentError);
  assert.equal(seen.filter((request) => request.method === "POST" && request.path.endsWith("/comments")).length, 1);
});

test("a duplicate whose ownership changes is preserved and a missing keeper is recreated", async () => {
  const { repo, comments } = statusSetup();
  comments.set(1, markedComment(1));
  comments.set(2, markedComment(2));
  routes["GET /repos/acme/web/issues/comments/2"] = () => {
    comments.get(2)!.performed_via_github_app.id = 456;
    return { status: 200, json: comments.get(2) };
  };
  await repo.upsertIssueStatus(statusInput());
  assert.equal(comments.has(2), true);
  routes["GET /repos/acme/web/issues/comments/1"] = () => { comments.delete(1); return { status: 404 }; };
  assert.deepEqual(await repo.upsertIssueStatus(statusInput(2)), { commentId: 10 });
});

test("lost edit response is probed and lost duplicate deletion converges on the next upsert", async () => {
  const { repo, comments } = statusSetup({ requestTimeoutMs: 40 });
  comments.set(1, markedComment(1));
  comments.set(2, markedComment(2));
  routes["PATCH /repos/acme/web/issues/comments/1"] = (request) => { comments.get(1)!.body = request.body.body; return null; };
  routes["DELETE /repos/acme/web/issues/comments/2"] = () => { comments.delete(2); return null; };
  await assert.rejects(repo.upsertIssueStatus(statusInput()), GitHubTransientError);
  assert.deepEqual(await repo.upsertIssueStatus(statusInput()), { commentId: 1 });
  assert.equal(comments.size, 1);
});

test("pagination cannot disclose installation credentials to a foreign origin", async () => {
  const { repo } = autonomySetup();
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [], headers: { link: '<https://foreign.invalid/rules>; rel="next"' } });
  await assert.rejects(repo.reviewSnapshot(7), GitHubPermanentError);
});

test("old-style classic contexts without App identity stay unavailable", async () => {
  const { repo } = autonomySetup();
  routes["GET /repos/acme/web/branches/main"] = () => ({ status: 200, json: { protected: true, commit: { sha: BASE } } });
  routes["GET /repos/acme/web/branches/main/protection"] = () => ({ status: 200, json: { required_status_checks: { strict: false, contexts: ["build"] } } });
  assert.equal((await repo.reviewSnapshot(7))!.required.kind, "unavailable");
});

test("unknown mergeability, conflict, failed statuses and unsupported conclusions remain explicit", async () => {
  const { repo, pull } = autonomySetup();
  pull.mergeable = null;
  assert.equal((await repo.reviewSnapshot(7))!.mergeability, "unknown");
  pull.mergeable = false;
  routes[`GET /repos/acme/web/commits/${HEAD}/statuses`] = () => ({ status: 200, json: [status(100, "error")] });
  const conflict = (await repo.reviewSnapshot(7))!;
  assert.equal(conflict.mergeability, "conflicting");
  assert.equal(conflict.checks[0]?.state, "failure");
  routes[`GET /repos/acme/web/commits/${HEAD}/check-suites`] = () => ({ status: 200, json: { total_count: 1, check_suites: [suite(11)] } });
  routes["GET /repos/acme/web/check-suites/11/check-runs"] = () => ({ status: 200, json: { total_count: 1, check_runs: [run(10, 1, "future_conclusion")] } });
  assert.equal((await repo.reviewSnapshot(7))!.checks[0]?.state, "unknown");
});

test("strict up-to-date policy reports a concrete base blocker", async () => {
  const { repo, pull } = autonomySetup();
  pull.mergeable_state = "behind";
  routes["GET /repos/acme/web/rules/branches/main"] = () => ({ status: 200, json: [{ type: "required_status_checks", parameters: {
    required_status_checks: [{ context: "build" }], strict_required_status_checks_policy: true,
  } }] });
  const required = (await repo.reviewSnapshot(7))!.required;
  assert.ok(required.kind === "known");
  assert.deepEqual(required.blockers, ["base branch must be incorporated into the head"]);
});

test("status reconciliation chooses creation time before comment ID and ignores user-owned lookalikes", async () => {
  const { repo, comments } = statusSetup();
  comments.set(1, { ...markedComment(1), created_at: new Date(NOW + 10_000).toISOString() });
  comments.set(2, markedComment(2));
  comments.set(3, { ...markedComment(3), user: { login: "pstack-dev[bot]", type: "User" } });
  assert.deepEqual(await repo.upsertIssueStatus(statusInput()), { commentId: 2 });
  assert.deepEqual([...comments.keys()], [2, 3]);
});

test("cancellation reaches fresh capability minting and every snapshot pagination request", async () => {
  const controller = new AbortController();
  const { github } = autonomySetup({ requestTimeoutMs: 5000 });
  const repo = github.repo(REPO, controller.signal);
  routes["POST /app/installations/77/access_tokens"] = () => { controller.abort(); return null; };
  await assert.rejects(repo.capabilities({ fresh: true }), GitHubTransientError);
  assert.ok(!seen.some((request) => request.path === "/repos/acme/web"));

  const nextController = new AbortController();
  const next = autonomySetup({ requestTimeoutMs: 5000 });
  routes[`GET /repos/acme/web/commits/${HEAD}/statuses`] = (request) => request.path.includes("page=2")
    ? (nextController.abort(), null)
    : { status: 200, json: [status(100, "success")], headers: { link: `<${base}/repos/acme/web/commits/${HEAD}/statuses?page=2>; rel="next"` } };
  await assert.rejects(next.github.repo(REPO, nextController.signal).reviewSnapshot(7), GitHubTransientError);
  assert.ok(!seen.some((request) => request.path.includes("/rules/branches/")));
});

test("read and mutation timeouts distinguish uncertainty and honor HTTP-date retry delays", async () => {
  const { repo } = autonomySetup({ requestTimeoutMs: 40 });
  routes["POST /repos/acme/web/issues/5/comments"] = () => null;
  await assert.rejects(repo.comment(5, "test"), (error) => error instanceof GitHubTransientError && error.uncertain);
  routes["GET /repos/acme/web/pulls/7"] = () => null;
  await assert.rejects(repo.reviewSnapshot(7), (error) => error instanceof GitHubTransientError && !error.uncertain);
  routes["POST /repos/acme/web/issues/5/comments"] = () => ({ status: 503, headers: { "retry-after": new Date(NOW + 60_000).toUTCString() } });
  await assert.rejects(repo.comment(5, "test"), (error) => error instanceof GitHubTransientError && error.uncertain && error.notBefore === NOW + 60_000);
});

test("an unobserved draft timeout is uncertain and is not replayed inside the call", async () => {
  const { repo } = autonomySetup({ requestTimeoutMs: 40 });
  routes["POST /graphql"] = () => null;
  await assert.rejects(repo.setDraft({ expected: target(), draft: false }), (error) => error instanceof GitHubTransientError && error.uncertain);
  assert.equal(seen.filter((request) => request.path === "/graphql").length, 1);
});
