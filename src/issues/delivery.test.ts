import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store.ts";
import { createStatusDelivery, desiredLabels, STATUS_AUDIT_MS, STATUS_CONCURRENCY, TERMINAL_STATUS_AUDIT_MS } from "./delivery.ts";
import { createGitHub, GitHubTransientError } from "./github.ts";
import { enter, initialControl, LABEL, type EffectOutcome, type JobId, type RepoName, type Sha } from "./job.ts";
import { openIssueStore } from "./store.ts";
import { COMMENT_MAX, statusBody, statusComment, statusMarker } from "./text.ts";

const REPO = "acme/web" as RepoName;
const SHA = "1".repeat(40) as Sha;
const HOUR = 60 * 60_000;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

async function fixture(t: TestContext) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  let store = openIssueStore(db, () => {});
  const clock = { now: Date.parse("2026-10-18T12:00:00Z") };
  const requests: { method: string; path: string; body: unknown; at: number }[] = [];
  const comments = new Map<number, { id: number; body: string; issue_url: string; created_at: string; updated_at: string; user: { login: string; type: string }; performed_via_github_app: { id: number } }>();
  const failures = { labels: 0, status: 0, statusFault: 0, retrySeconds: 600 };
  let next = 1;
  let base = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body: unknown = raw ? JSON.parse(raw) : null;
    const path = new URL(request.url!, base).pathname;
    const method = request.method!;
    requests.push({ method, path, body, at: clock.now });
    const send = (code: number, value: unknown) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (path === "/repos/acme/web/installation") return send(200, { id: 1 });
    if (path === "/app/installations/1/access_tokens") return send(201, { token: "test-token", expires_at: new Date(clock.now + STATUS_AUDIT_MS).toISOString() });
    if (path === "/app") return send(200, { slug: "test" });
    if (method === "POST" && path.endsWith("/labels") && failures.labels-- > 0) {
      response.setHeader("retry-after", String(failures.retrySeconds));
      return send(429, { message: "slow down" });
    }
    if (body && typeof body === "object" && "body" in body && typeof body.body === "string" && body.body.length > COMMENT_MAX) return send(422, { message: "body is too long (maximum is 65536 characters)" });
    if (path.includes("/issues/") && path.endsWith("/comments")) {
      if (failures.statusFault-- > 0) return send(502, { message: "bad gateway" });
      if (failures.status-- > 0) {
        response.setHeader("retry-after", String(failures.retrySeconds));
        return send(429, { message: "status cooldown" });
      }
      const issueUrl = `${base}${path.slice(0, -9)}`;
      if (method === "GET") return send(200, [...comments.values()].filter((comment) => comment.issue_url === issueUrl));
      assert.ok(body && typeof body === "object" && "body" in body && typeof body.body === "string");
      const comment = { id: next++, body: body.body, issue_url: issueUrl, created_at: new Date(clock.now).toISOString(), updated_at: new Date(clock.now).toISOString(), user: { login: "test[bot]", type: "Bot" }, performed_via_github_app: { id: 1 } };
      comments.set(comment.id, comment);
      return send(201, comment);
    }
    const id = Number(path.split("/").at(-1));
    if (path.includes("/issues/comments/")) {
      if (method === "PATCH") {
        assert.ok(body && typeof body === "object" && "body" in body && typeof body.body === "string");
        comments.get(id)!.body = body.body;
      }
      return send(comments.has(id) ? 200 : 404, comments.get(id) ?? { message: "missing" });
    }
    if (path.includes("/labels")) return send(200, []);
    send(404, { message: `${method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const github = () => createGitHub({ credentials: () => ({ appId: "1", privateKey }), apiUrl: base, clock: () => clock.now });
  let nextJob = 1;
  const insert = (issue = 41) => store.insert({ id: `job-${issue}-${nextJob++}` as JobId, repo: REPO, issue, trigger: { eventId: nextJob, actor: "maya", at: clock.now }, snapshot: { title: "Fix footer", body: "Footer overlaps", url: `https://github.test/issues/${issue}`, author: "maya" }, projectId: "project", hostId: "host", baseBranch: "main", state: "queued", error: null }, clock.now)!;
  const build = (run?: () => Promise<void>) => {
    const transport = github();
    const currentStore = store;
    return createStatusDelivery({ store: currentStore, github: transport, clock: () => clock.now, runEffect: async (job, effect): Promise<EffectOutcome> => {
      if (run) await run();
      try {
        const repo = transport.repo(job.repo);
        if (effect.op === "labels") {
          if (effect.add.length) await repo.addLabels(job.issue, effect.add);
          for (const label of effect.remove) await repo.removeLabel(job.issue, label);
        } else if (effect.op === "reply") await repo.comment(job.pr!.number, effect.body);
        return { kind: "done", patch: {} };
      } catch (error) {
        if (error instanceof GitHubTransientError) return { kind: "retry", error: error.message, notBefore: error.notBefore };
        throw error;
      }
    } });
  };
  const status = () => [...comments.values()].filter((comment) => comment.body.includes("pstack:issue-status"));
  return { db, clock, requests, comments, failures, insert, build, status, get store() { return store; }, restart() { store = openIssueStore(db, () => {}); }, labelPosts: () => requests.filter((request) => request.method === "POST" && request.path.endsWith("/labels")), statusReads: () => requests.filter((request) => request.method === "GET" && request.path.endsWith("/comments")) };
}

test("one eligible label attempt retains Retry-After across revisions, audits, restart and overlap", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  h.failures.labels = 10;
  await h.build()();
  assert.equal(h.labelPosts().length, 1);
  assert.equal(h.store.delivery(REPO, 41).pending, true);
  job = h.store.write(job.id, job.version, { report: { outcome: "changes", headSha: SHA, acceptedAt: h.clock.now, pr: { title: "fix", body: "fix" }, summary: "Fixed footer.", verification: ["footer tests passed"] } }, h.clock.now)!;
  h.restart();
  const first = h.build();
  const second = h.build();
  for (let minute = 1; minute < 10; minute++) { h.clock.now += 60_000; await Promise.all([first(), second()]); }
  assert.equal(h.labelPosts().length, 1);
  h.clock.now += 60_000;
  await Promise.all([first(), second()]);
  assert.equal(h.labelPosts().length, 2);
  assert.equal(h.store.get(job.id)!.control.disposition, null);
});

test("new desired labels supersede failed labels and delivered audits do not rewrite labels", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  h.failures.labels = 1;
  await h.build()();
  job = h.store.write(job.id, job.version, { phase: { state: "review" }, threadId: "thread", pushedSha: SHA, pr: { number: 5, url: "https://github.test/pull/5" }, control: { ...job.control, readiness: { pr: 5, head: SHA, base: SHA } } }, h.clock.now)!;
  await h.build()();
  assert.equal(h.labelPosts().length, 1);
  h.clock.now += 600_000;
  await h.build()();
  assert.deepEqual(h.labelPosts().map((request) => request.body), [{ labels: [LABEL.working] }, { labels: [LABEL.review] }]);
  h.clock.now += STATUS_AUDIT_MS;
  await h.build()();
  assert.equal(h.labelPosts().length, 2);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});

test("terminal audits stay quiet while independent decoration and newer outcome deliver immediately", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, pr: { number: 42, url: "https://github.test/pull/42" }, control: { ...job.control, disposition: "no-change" } }, h.clock.now)!;
  await h.build()();
  const reads = h.statusReads().length;
  h.store.decorate(job, { op: "reply", target: { kind: "pr-comment", id: 1 }, key: "independent", body: "Feedback delivered." });
  h.clock.now += 1;
  await h.build()();
  assert.equal(h.statusReads().length, reads);
  assert.ok([...h.comments.values()].some((comment) => comment.body === "Feedback delivered."));
  job = h.store.write(job.id, job.version, { control: { ...job.control, disposition: "closed" } }, h.clock.now)!;
  await h.build()();
  assert.ok([...h.comments.values()].some((comment) => comment.body.includes("Closed without merging")));
  const marked = [...h.comments.values()].find((comment) => comment.body.includes("pstack:issue-status"))!;
  h.comments.delete(marked.id);
  await h.build()();
  assert.equal(h.status().length, 0);
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 0);
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 1);
  const repaired = h.status()[0]!;
  repaired.body = "edited externally\n<!-- pstack:issue-status:acme/web:41 -->";
  h.clock.now += TERMINAL_STATUS_AUDIT_MS;
  await h.build()();
  assert.ok(repaired.body.includes("Closed without merging"));
});

test("a delivered status adopts the daily audit when its job turns terminal without a new body", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const control = { ...job.control, disposition: "failure" as const, publicFailure: { kind: "execution" as const } };
  job = h.store.write(job.id, job.version, { phase: enter("sticking", [desiredLabels(job)]), control }, h.clock.now)!;
  await h.build()();
  const delivered = h.status()[0]!.body;
  assert.match(delivered, /Issue #41: Failed/);
  h.clock.now += 60_000;
  job = h.store.write(job.id, job.version, { phase: { state: "stuck" } }, h.clock.now)!;
  await h.build()();
  assert.equal(h.status()[0]!.body, delivered);
  h.comments.delete(h.status()[0]!.id);
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 0);
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 1);
});

test("an active job's status is audited hourly", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { phase: { state: "review" }, threadId: "thread", pushedSha: SHA, pr: { number: 5, url: "https://github.test/pull/5" } }, h.clock.now)!;
  await h.build()();
  h.comments.delete(h.status()[0]!.id);
  h.clock.now += HOUR - 1;
  await h.build()();
  assert.equal(h.status().length, 0);
  h.clock.now += 1;
  await h.build()();
  assert.equal(h.status().length, 1);
});

test("a status delivered after its job turns terminal uses the terminal audit interval", { timeout: 5_000 }, async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { phase: enter("sticking", [desiredLabels(job)]), control: { ...job.control, disposition: "failure", publicFailure: { kind: "execution" } } }, h.clock.now)!;
  let reached!: () => void;
  let release!: () => void;
  const hit = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (args[1]?.method === "POST" && String(args[0]).endsWith("/issues/41/comments")) {
      reached();
      await gate;
    }
    return response;
  };
  let deliver: ReturnType<typeof h.build>;
  try { deliver = h.build(); }
  finally { globalThis.fetch = originalFetch; }
  const pending = deliver();
  try {
    await hit;
    job = h.store.write(job.id, job.version, { phase: { state: "stuck" } }, h.clock.now)!;
  } finally {
    release();
    await pending;
  }
  assert.equal(h.status().length, 1);
  h.comments.delete(h.status()[0]!.id);
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 0, "the in-flight response cannot restore the hourly schedule");
  h.clock.now += 12 * HOUR;
  await h.build()();
  assert.equal(h.status().length, 1);
});

test("an ordinary comment fault leaves an unrelated decoration independent", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  await h.build()();
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, pr: { number: 42, url: "https://github.test/pull/42" } }, h.clock.now)!;
  h.store.decorate(job, { op: "reply", target: { kind: "pr-comment", id: 1 }, key: "separate", body: "Independent reply." });
  h.failures.statusFault = 1;
  h.clock.now += 60_000;
  await h.build()();
  assert.match(h.store.delivery(REPO, 41).error ?? "", /502/);
  assert.ok([...h.comments.values()].some((comment) => comment.body === "Independent reply."));
  h.clock.now += 60_000;
  await h.build()();
  assert.ok(h.status().some((comment) => comment.body.includes("Outcome unknown")));
});

test("a rate-limited status comment holds every decoration until its cooldown, across revisions and restart", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  h.failures.status = 1;
  await h.build()();
  assert.equal(h.labelPosts().length, 0);
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, pr: { number: 42, url: "https://github.test/pull/42" } }, h.clock.now)!;
  h.store.decorate(job, { op: "reply", target: { kind: "pr-comment", id: 1 }, key: "separate", body: "Held reply." });
  h.restart();
  const before = h.requests.length;
  for (let minute = 1; minute < 10; minute++) { h.clock.now += 60_000; await h.build()(); }
  assert.equal(h.requests.length, before);
  assert.equal(h.store.delivery(REPO, 41).pending, true);
  h.clock.now += 60_000;
  await h.build()();
  assert.ok(h.status().some((comment) => comment.body.includes("Outcome unknown")));
  assert.ok([...h.comments.values()].some((comment) => comment.body === "Held reply."));
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});

test("a rate-limited decoration stops later decorations and the comment until its cooldown", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { pr: { number: 42, url: "https://github.test/pull/42" } }, h.clock.now)!;
  h.store.decorate(job, { op: "reply", target: { kind: "pr-comment", id: 1 }, key: "later", body: "Later reply." });
  h.failures.labels = 1;
  await h.build()();
  assert.equal(h.labelPosts().length, 1);
  assert.ok(![...h.comments.values()].some((comment) => comment.body === "Later reply."));
  job = h.store.write(job.id, job.version, { phase: { state: "done" } }, h.clock.now)!;
  h.restart();
  const before = h.requests.length;
  for (let minute = 1; minute < 10; minute++) { h.clock.now += 60_000; await h.build()(); }
  assert.equal(h.requests.length, before);
  h.clock.now += 60_000;
  await h.build()();
  assert.ok([...h.comments.values()].some((comment) => comment.body === "Later reply."));
  assert.ok(h.status().some((comment) => comment.body.includes("Outcome unknown")));
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});

test("delivery bounds concurrent issues", async (t) => {
  const h = await fixture(t);
  for (let issue = 1; issue <= 12; issue++) h.insert(issue);
  let active = 0;
  let maximum = 0;
  const deliver = h.build(async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; });
  await Promise.all([deliver(), h.build(async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; })()]);
  assert.equal(h.labelPosts().length, 12);
  assert.ok(maximum > 1);
  assert.ok(maximum <= STATUS_CONCURRENCY, String(maximum));
});

test("claims enforce due time and live ownership and stale settlements preserve newer work", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const old = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(old, h.clock.now), true);
  const key = old.decorations[0]!.effect.key;
  assert.equal(h.store.claimDecoration(old, key, h.clock.now), 0);
  assert.equal(h.store.claimDecoration(old, key, h.clock.now), null);
  h.clock.now += 60_000;
  assert.equal(h.store.claimDecoration(old, key, h.clock.now), null);
  const replacement = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(replacement, h.clock.now), true);
  assert.notEqual(old.leaseOwner, replacement.leaseOwner);
  h.store.settleDecoration(old, key, null, 0, h.clock.now);
  h.store.settleStatus(old, { error: null, nextAt: h.clock.now + STATUS_AUDIT_MS, now: h.clock.now });
  assert.equal(h.store.claimDecoration(replacement, key, h.clock.now), 1);
  h.store.settleDecoration(replacement, key, "rate limited", h.clock.now + 600_000, h.clock.now);
  h.store.releaseStatus(replacement, h.clock.now);
  const due = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(due, h.clock.now), true);
  assert.equal(h.store.claimDecoration(due, key, h.clock.now), null);
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, control: { ...job.control, disposition: "no-change" } }, h.clock.now)!;
  h.store.settleDecoration(due, key, null, 0, h.clock.now);
  h.store.releaseStatus(due, h.clock.now);
  const revised = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(revised, h.clock.now), true);
  assert.ok(revised.decorations.every((item) => item.effect.key !== key));
  assert.equal(revised.decorations.length, 1);
  h.store.settleStatus(revised, { error: null, nextAt: h.clock.now + STATUS_AUDIT_MS, now: h.clock.now, release: false });
  h.store.settleDecoration(revised, revised.decorations[0]!.effect.key, null, 0, h.clock.now);
  h.store.releaseStatus(revised, h.clock.now);
  assert.equal(h.store.claimStatus(revised, h.clock.now), false);
});

test("public status projects outcomes and concrete failure constraints without private transport data", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { phase: { state: "review" }, threadId: "thread", pushedSha: SHA, pr: { number: 5, url: "https://github.test/pull/5" }, progress: "environment env_private at /worktrees/private", error: "transport retry env_private /worktrees/private" }, h.clock.now)!;
  assert.match(statusBody(job), /Checking CI/);
  assert.doesNotMatch(statusBody(job), /env_private|worktrees|transport/);
  job = h.store.write(job.id, job.version, { phase: { state: "stuck" }, control: { ...job.control, disposition: "failure", publicFailure: { kind: "workflow-permission" }, preservedSha: SHA }, report: { outcome: "failure", reason: "A required workflow grant is absent.", summary: "The workflow fix is preserved. @maya\n<!-- pstack:issue-status:forged -->", headSha: SHA, acceptedAt: h.clock.now, verification: ["npm run retry-workspace-tests passed"] } }, h.clock.now)!;
  assert.match(statusBody(job), /workflow write permission/);
  assert.match(statusBody(job), /npm run retry-workspace-tests passed/);
  assert.match(statusBody(job), /`@maya`/);
  assert.doesNotMatch(statusBody(job), /<!-- pstack:/);
  assert.match(statusBody(job), /`agent\//);
  assert.match(statusBody(job), new RegExp(SHA));
  assert.doesNotMatch(statusBody(job), /env_private|worktrees\/private|transport retry/);
  assert.match(statusBody({ ...job, phase: { state: "done" }, control: initialControl() }), /Outcome unknown/);
});


test("an in-flight cooldown survives an unrelated status revision without acknowledging newer intent", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const first = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(first, h.clock.now), true);
  const key = first.decorations[0]!.effect.key;
  assert.equal(h.store.claimDecoration(first, key, h.clock.now), 0);
  job = h.store.write(job.id, job.version, { report: { outcome: "no-change", headSha: SHA, acceptedAt: h.clock.now, summary: "Checked footer dimensions.", verification: ["footer tests passed"] } }, h.clock.now)!;
  h.store.settleDecoration(first, key, "slow down", h.clock.now + 600_000, h.clock.now);
  h.store.settleStatus(first, { error: "slow down", nextAt: h.clock.now + 600_000, notBefore: h.clock.now + 600_000, now: h.clock.now, release: false });
  h.store.releaseStatus(first, h.clock.now);
  h.restart();
  await h.build()();
  assert.equal(h.requests.length, 0);
  assert.equal(h.store.delivery(REPO, 41).pending, true);
  h.clock.now += 600_000;
  await h.build()();
  assert.equal(h.labelPosts().length, 1);
  assert.ok([...h.comments.values()].some((comment) => comment.body.includes("Checked footer dimensions.")));
});


test("new generations retain the live issue lease and old responses cannot acknowledge or erase their work", async (t) => {
  const h = await fixture(t);
  let oldJob = h.insert();
  oldJob = h.store.write(oldJob.id, oldJob.version, { phase: { state: "done" }, control: { ...oldJob.control, disposition: "no-change" } }, h.clock.now)!;
  const claimed = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(claimed, h.clock.now), true);
  const oldKey = claimed.decorations[0]!.effect.key;
  assert.equal(h.store.claimDecoration(claimed, oldKey, h.clock.now), 0);
  const latest = h.insert();
  assert.equal(latest.generation, 2);
  await h.build()();
  assert.equal(h.requests.length, 0);
  h.store.settleDecoration(claimed, oldKey, null, 0, h.clock.now);
  h.store.settleStatus(claimed, { error: "cooldown", nextAt: h.clock.now + 600_000, notBefore: h.clock.now + 600_000, now: h.clock.now });
  await h.build()();
  assert.equal(h.requests.length, 0);
  assert.equal(h.store.delivery(REPO, 41).pending, true);
  h.clock.now += 600_000;
  await h.build()();
  assert.deepEqual(h.labelPosts().map((request) => request.body), [{ labels: [LABEL.working] }]);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
  assert.equal([...h.comments.values()].filter((comment) => comment.body.includes("pstack:issue-status")).length, 1);
  assert.deepEqual(h.db.prepare("SELECT count(*) AS n FROM issue_status WHERE issue = 41").get(), { n: 1 });
});

test("oversized accepted changes deliver a bounded status that keeps the outcome, pull request, commit and branch", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const verification = ["v".repeat(70_000), ...Array.from({ length: 3_000 }, (_, index) => `check ${index} passed`)];
  const summary = "@a ".repeat(30_000);
  job = h.store.write(job.id, job.version, { phase: { state: "review" }, threadId: "thread", pushedSha: SHA, pr: { number: 5, url: "https://github.test/pull/5" }, control: { ...job.control, readiness: { pr: 5, head: SHA, base: SHA } }, report: { outcome: "changes", headSha: SHA, acceptedAt: h.clock.now, pr: { title: "fix", body: "fix" }, summary, verification } }, h.clock.now)!;
  await h.build()();
  const [comment] = h.status();
  assert.ok(comment, h.store.delivery(REPO, 41).error ?? "no status comment");
  assert.ok(comment.body.length <= COMMENT_MAX, String(comment.body.length));
  assert.match(comment.body, /^Issue #41: Ready for review/);
  assert.match(comment.body, /Pull request: https:\/\/github\.test\/pull\/5/);
  assert.match(comment.body, new RegExp(`Reported commit: ${SHA}`));
  assert.match(comment.body, /Branch: `agent\//);
  assert.match(comment.body, /Truncated to fit GitHub's comment limit/);
  assert.doesNotMatch(comment.body, /(^|[^`])@a\b/);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
  assert.deepEqual(h.store.get(job.id)!.report!.verification, verification);
  assert.equal(h.store.get(job.id)!.report!.summary, summary);
});

test("a huge failure reason and child progress cannot hide the failed outcome or the policy limitation", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const limitation = "Branch policy could not be inspected: rules are unavailable.";
  job = h.store.write(job.id, job.version, { phase: { state: "stuck" }, control: { ...job.control, disposition: "failure", publicFailure: { kind: "report", reason: "r".repeat(100_000) }, preservedSha: SHA, policyLimitation: limitation, childrenProgress: `**Sub-issues: 0 of 5000 closed**\n\n${Array.from({ length: 5_000 }, (_, index) => `- [ ] #${index + 100} ${"t".repeat(30)} (queued)`).join("\n")}` } }, h.clock.now)!;
  await h.build()();
  const [comment] = h.status();
  assert.ok(comment, h.store.delivery(REPO, 41).error ?? "no status comment");
  assert.ok(comment.body.length <= COMMENT_MAX, String(comment.body.length));
  assert.match(comment.body, /^Issue #41: Failed/);
  assert.ok(comment.body.includes(limitation));
  assert.match(comment.body, /Reason: r+/);
  assert.match(comment.body, new RegExp(`Preserved commit: ${SHA}`));
  assert.match(comment.body, /Branch: `agent\//);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});

test("a status body that fits alone still fits once the revision and identity markers are added", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const shell = statusBody(h.store.write(job.id, job.version, { phase: { state: "done" }, control: { ...job.control, disposition: "no-change" }, report: { outcome: "no-change", headSha: SHA, acceptedAt: h.clock.now, summary: "x", verification: [] } }, h.clock.now)!).length;
  job = h.store.get(job.id)!;
  job = h.store.write(job.id, job.version, { report: { outcome: "no-change", headSha: SHA, acceptedAt: h.clock.now, summary: "x".repeat(COMMENT_MAX - shell - 10), verification: [] } }, h.clock.now)!;
  await h.build()();
  const [comment] = h.status();
  assert.ok(comment, h.store.delivery(REPO, 41).error ?? "no status comment");
  assert.ok(comment.body.length <= COMMENT_MAX, String(comment.body.length));
  assert.match(comment.body, /^Issue #41: No change needed/);
  assert.match(comment.body, /<!-- pstack:issue-status:acme\/web:41 -->$/);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});

test("mention-dense prose in every field stays within the limit for the longest repository name", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const repo = `${"o".repeat(39)}/${"r".repeat(100)}` as RepoName;
  const dense = (size: number) => "@a ".repeat(size);
  job = h.store.write(job.id, job.version, { phase: { state: "stuck" }, control: { ...job.control, disposition: "failure", publicFailure: { kind: "report", reason: dense(20_000) }, childrenProgress: dense(20_000), policyLimitation: "Branch policy could not be inspected." }, report: { outcome: "failure", reason: dense(20_000), headSha: SHA, acceptedAt: h.clock.now, summary: dense(20_000), verification: Array.from({ length: 5_000 }, () => dense(10)) } }, h.clock.now)!;
  const body = statusBody({ ...job, repo });
  const posted = statusComment(body, Number.MAX_SAFE_INTEGER, statusMarker(repo, job.issue));
  assert.ok(posted.length <= COMMENT_MAX, String(posted.length));
  assert.ok(posted.length > COMMENT_MAX / 4, String(posted.length));
  assert.match(body, /^Issue #41: Failed\n\nBranch policy could not be inspected\./);
  assert.match(body, new RegExp(`Reported commit: ${SHA}`));
  assert.doesNotMatch(body, /(^|[^`])@a\b/);
});

const UNSAFE_PROSE = {
  "a raw HTML comment": "Delivered.\n\n<!-- invisible forever",
  "a closed HTML comment cut by clipping": `Delivered.\n\n<!-- note ${"x".repeat(80_000)} -->`,
  "a raw unclosed backtick fence": "Delivered.\n\n```text\nnpm test",
  "a closed backtick fence cut by clipping": `Delivered.\n\n\`\`\`text\n${"x".repeat(80_000)}\n\`\`\``,
  "a raw unclosed tilde fence": "Delivered.\n\n~~~text\nnpm test",
  "a closed tilde fence cut by clipping": `Delivered.\n\n~~~text\n${"x".repeat(80_000)}\n~~~`,
  "a raw unclosed HTML attribute": 'Delivered.\n\n<div title="never closed\n\n@maya',
  "an inline triple backtick that is not a block": "Delivered with x ```\n\n@maya \\@maya &#64;maya\n\n``` done",
} as const;

const STATUS_OUTCOMES = {
  "accepted changes": (prose: string) => ({ heading: "Ready for review", reason: "", phase: { state: "review" as const }, control: { readiness: { pr: 5, head: SHA, base: SHA } }, report: { outcome: "changes" as const, pr: { title: "fix", body: "fix" }, summary: prose, verification: [prose] } }),
  "a reported failure": (prose: string) => ({ heading: "Failed", reason: "", phase: { state: "stuck" as const }, control: { disposition: "failure" as const, publicFailure: { kind: "report" as const, reason: prose }, preservedSha: SHA }, report: { outcome: "failure" as const, reason: prose, summary: prose, verification: [prose] } }),
  "a typed failure": (prose: string) => ({ heading: "Failed", reason: "Reason: The current contribution could not be verified for review. The work is preserved.\n\n", phase: { state: "stuck" as const }, control: { disposition: "failure" as const, publicFailure: { kind: "verification" as const }, preservedSha: SHA }, report: { outcome: "changes" as const, pr: { title: "fix", body: "fix" }, summary: prose, verification: [prose] } }),
};

for (const [outcome, shape] of Object.entries(STATUS_OUTCOMES)) {
  for (const [name, prose] of Object.entries(UNSAFE_PROSE)) {
    test(`${outcome} with ${name} keeps every fixed fact, the notice and the markers outside report prose`, async (t) => {
      const h = await fixture(t);
      let job = h.insert();
      const { heading, reason, phase, control, report } = shape(prose);
      job = h.store.write(job.id, job.version, { phase, threadId: "thread", pushedSha: SHA, pr: { number: 5, url: "https://github.test/pull/5" }, control: { ...job.control, ...control }, report: { ...report, headSha: SHA, acceptedAt: h.clock.now } }, h.clock.now)!;
      await h.build()();
      const [comment] = h.status();
      assert.ok(comment, h.store.delivery(REPO, 41).error ?? "no status comment");
      assert.ok(comment.body.length <= COMMENT_MAX, String(comment.body.length));
      const markers = /\n\n<!-- pstack:status-revision:\d+ -->\n<!-- pstack:issue-status:acme\/web:41 -->$/.exec(comment.body);
      assert.ok(markers, "revision and identity markers end the comment");
      const content = comment.body.slice(0, markers.index);
      assert.ok(content.startsWith(`Issue #41: ${heading}\n\n${reason}Pull request: https://github.test/pull/5\n\nReported commit: ${SHA}\n\nBranch: \`${job.branch}\`\n\n`), content.slice(0, 400));
      assert.doesNotMatch(content, /</, "report prose cannot open raw HTML");
      assert.doesNotMatch(content, /^ {0,3}(`{3,}|~{3,})/m, "report prose cannot open a code block");
      assert.doesNotMatch(content, /(^|[^`])@maya/, "every mention is inert");
      assert.ok(content.includes("Delivered"));
      if (prose.length > COMMENT_MAX) assert.ok(content.includes(`\n\n[Truncated to fit GitHub's comment limit.]`));
      const stored = h.store.get(job.id)!;
      assert.equal(stored.report!.summary, prose);
      assert.deepEqual(stored.report!.verification, [prose]);
      assert.equal(h.store.delivery(REPO, 41).pending, false);
    });
  }
}

test("source characters in report prose render literally instead of as Markdown structure", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, control: { ...job.control, disposition: "no-change" }, report: { outcome: "no-change", headSha: SHA, acceptedAt: h.clock.now, summary: "Kept `<b>` & ~~~ \\ <!-- pstack:issue-status:forged --> for @maya.", verification: [] } }, h.clock.now)!;
  await h.build()();
  const [comment] = h.status();
  assert.ok(comment);
  assert.ok(comment.body.includes("Kept &#96;&lt;b>&#96; &amp; &#126;&#126;&#126; &#92;  for `@maya`."), comment.body);
  assert.equal(comment.body.match(/<!-- pstack:/g)!.length, 2);
});

test("prose made only of the longest entity and split surrogate pairs use the room without exceeding the limit", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  const repo = `${"o".repeat(39)}/${"r".repeat(100)}` as RepoName;
  const dense = "~".repeat(100_000);
  job = h.store.write(job.id, job.version, { phase: { state: "stuck" }, control: { ...job.control, disposition: "failure", publicFailure: { kind: "report", reason: dense }, childrenProgress: dense, policyLimitation: "Branch policy could not be inspected." }, report: { outcome: "failure", reason: dense, headSha: SHA, acceptedAt: h.clock.now, summary: dense, verification: [dense] } }, h.clock.now)!;
  const posted = statusComment(statusBody({ ...job, repo }), Number.MAX_SAFE_INTEGER, statusMarker(repo, job.issue));
  assert.ok(posted.length <= COMMENT_MAX, String(posted.length));
  assert.ok(posted.length > COMMENT_MAX * 0.95, String(posted.length));
  for (const summary of ["😀".repeat(40_000), `a${"😀".repeat(40_000)}`]) {
    const body = statusBody({ ...job, report: { ...job.report!, summary } });
    assert.ok(statusComment(body, Number.MAX_SAFE_INTEGER, statusMarker(job.repo, job.issue)).length <= COMMENT_MAX);
    assert.doesNotMatch(body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test("an old generation's rate-limited decoration still holds the issue after a new generation projects", async (t) => {
  const h = await fixture(t);
  const oldJob = h.insert();
  h.store.write(oldJob.id, oldJob.version, { phase: { state: "done" }, control: { ...oldJob.control, disposition: "no-change" } }, h.clock.now);
  const claimed = h.store.statuses(h.clock.now)[0]!;
  assert.equal(h.store.claimStatus(claimed, h.clock.now), true);
  const oldKey = claimed.decorations[0]!.effect.key;
  assert.equal(h.store.claimDecoration(claimed, oldKey, h.clock.now), 0);
  const latest = h.insert();
  assert.equal(latest.generation, 2);
  const projected = h.db.prepare("SELECT decorations_json FROM issue_status WHERE issue = 41").get();
  h.store.settleDecoration(claimed, oldKey, "slow down", h.clock.now + 600_000, h.clock.now, h.clock.now + 600_000);
  assert.deepEqual(h.db.prepare("SELECT decorations_json FROM issue_status WHERE issue = 41").get(), projected);
  h.store.releaseStatus(claimed, h.clock.now);
  h.restart();
  for (let minute = 1; minute < 10; minute++) { h.clock.now += 60_000; await h.build()(); }
  assert.equal(h.requests.length, 0);
  h.clock.now += 60_000;
  await h.build()();
  assert.deepEqual(h.labelPosts().map((request) => request.body), [{ labels: [LABEL.working] }]);
  assert.equal(h.store.delivery(REPO, 41).pending, false);
});
