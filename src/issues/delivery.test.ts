import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../store.ts";
import { createStatusDelivery, STATUS_AUDIT_MS, STATUS_CONCURRENCY } from "./delivery.ts";
import { createGitHub, GitHubTransientError } from "./github.ts";
import { initialControl, LABEL, type EffectOutcome, type JobId, type RepoName, type Sha } from "./job.ts";
import { openIssueStore } from "./store.ts";
import { statusBody } from "./text.ts";

const REPO = "acme/web" as RepoName;
const SHA = "1".repeat(40) as Sha;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

async function fixture(t: TestContext) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  let store = openIssueStore(db, () => {});
  const clock = { now: Date.parse("2026-10-18T12:00:00Z") };
  const requests: { method: string; path: string; body: unknown; at: number }[] = [];
  const comments = new Map<number, { id: number; body: string; issue_url: string; created_at: string; updated_at: string; user: { login: string; type: string }; performed_via_github_app: { id: number } }>();
  const failures = { labels: 0, status: 0, retrySeconds: 600 };
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
    if (path.includes("/issues/") && path.endsWith("/comments")) {
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
  const insert = (issue = 41) => store.insert({ id: `job-${issue}` as JobId, repo: REPO, issue, trigger: { eventId: issue, actor: "maya", at: clock.now }, snapshot: { title: "Fix footer", body: "Footer overlaps", url: `https://github.test/issues/${issue}`, author: "maya" }, projectId: "project", hostId: "host", baseBranch: "main", state: "queued", error: null }, clock.now)!;
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
  return { db, clock, requests, comments, failures, insert, build, get store() { return store; }, restart() { store = openIssueStore(db, () => {}); }, labelPosts: () => requests.filter((request) => request.method === "POST" && request.path.endsWith("/labels")), statusReads: () => requests.filter((request) => request.method === "GET" && request.path.endsWith("/comments")) };
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
  assert.equal([...h.comments.values()].filter((comment) => comment.body.includes("pstack:issue-status")).length, 0);
  h.clock.now += STATUS_AUDIT_MS;
  await h.build()();
  assert.equal([...h.comments.values()].filter((comment) => comment.body.includes("pstack:issue-status")).length, 1);
  const repaired = [...h.comments.values()].find((comment) => comment.body.includes("pstack:issue-status"))!;
  repaired.body = "edited externally\n<!-- pstack:issue-status:acme/web:41 -->";
  h.clock.now += STATUS_AUDIT_MS;
  await h.build()();
  assert.ok(repaired.body.includes("Closed without merging"));
});

test("unrelated decoration never bypasses a future comment cooldown even after restart", async (t) => {
  const h = await fixture(t);
  let job = h.insert();
  h.failures.status = 1;
  await h.build()();
  const reads = h.statusReads().length;
  job = h.store.write(job.id, job.version, { phase: { state: "done" }, pr: { number: 42, url: "https://github.test/pull/42" } }, h.clock.now)!;
  h.store.decorate(job, { op: "reply", target: { kind: "pr-comment", id: 1 }, key: "separate", body: "Independent reply." });
  h.restart();
  h.clock.now += 60_000;
  await h.build()();
  assert.equal(h.statusReads().length, reads);
  assert.ok([...h.comments.values()].some((comment) => comment.body === "Independent reply."));
  h.clock.now += 9 * 60_000;
  await h.build()();
  assert.ok([...h.comments.values()].some((comment) => comment.body.includes("Outcome unknown")));
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
