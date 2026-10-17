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
type Route = (request: Seen) => { status: number; json?: unknown; headers?: Record<string, string> };

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
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

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
