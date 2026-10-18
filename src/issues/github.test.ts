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
