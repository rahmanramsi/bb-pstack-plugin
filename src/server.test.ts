import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ISSUES_CHANNEL } from "./contract.ts";
import { openIssueStore, type NewJob } from "./issues/store.ts";
import type { JobId, RepoName } from "./issues/job.ts";
import { openChecklistStore } from "./checklist-store.ts";

const thread = (id: string) => ({ id, originPluginId: "pstack" });

test("pstack delegates receive checklist nudges while run workers do not", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  type IdleHandler = (payload: { thread: ReturnType<typeof thread>; lastAssistantText: string }) => unknown;
  const idle: IdleHandler[] = [];
  const sends: string[] = [];
  let cli: PluginCliRegistration | null = null;
  const bb = {
    pluginId: "pstack",
    settings: { define: () => ({ get: async () => ({ models: "" }), onChange() {} }) },
    storage: { database: () => db, migrate: (_db: unknown, migrations: string[]) => migrations.forEach((sql) => db.exec(sql)) },
    sdk: { threads: { list: async () => [], send: async ({ threadId }: { threadId: string }) => sends.push(threadId) } },
    realtime: { publish() {} },
    rpc: { register() {} },
    cli: { register: (value: PluginCliRegistration) => { cli = value; } },
    agents: { registerTool() {}, configure() {}, contributeInstructions() {} },
    events: { on: (event: string, handler: IdleHandler) => { if (event === "thread.idle") idle.push(handler); } },
    background: { service() {} },
    hosts: { experimental_client: () => ({}) },
    experimental_hooks: { on() {} },
    log: { error() {}, warn() {} },
  } as unknown as BbPluginApi;
  await plugin(bb);
  assert.ok(cli);
  const store = openChecklistStore(db);
  for (const id of ["thr_delegate", "thr_worker"]) {
    store.createChecklist(id, "feature", [{ section: "playbook", text: "Verify the change.", afterPr: false, skipPolicy: "agent" }], 0);
  }
  db.prepare("INSERT INTO attempts (run_id, job_key, ordinal, state, thread_id, issued_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("psr_run", "seat-a", 1, "attached", "thr_worker", 0);
  const nudge = idle.at(-1)!;
  await nudge({ thread: thread("thr_delegate"), lastAssistantText: "done" });
  await nudge({ thread: thread("thr_worker"), lastAssistantText: "done" });
  assert.deepEqual(sends, ["thr_delegate"]);
  assert.equal(store.checklist("thr_delegate")?.nudgedAtRevision, 0);
  assert.equal(store.checklist("thr_worker")?.nudgedAtRevision, null);
});

test("a thread pstack launched, such as an issue worker, gets no checklist nudge when it goes idle", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pstack",
    sdk: {
      threads: { list: async () => [], send: async () => ({}) as never, get: async () => { throw Object.assign(new Error("missing"), { status: 404 }); } },
    },
  });
  await plugin(bb);
  const worker = "thr_worker";
  const begun = await harness.runCli(["checklist", "begin", "feature"], { threadId: worker, cwd: "/tmp" });
  assert.equal(begun.exitCode, 0, begun.stderr);

  const store = openIssueStore(bb.storage.database(), () => {});
  const job = store.insert(
    {
      id: "psi_00000000-0000-0000-0000-000000000001" as JobId,
      repo: "acme/web" as RepoName,
      issue: 41,
      trigger: { eventId: 1, actor: "maya", at: 1 },
      snapshot: { title: "Submit button hides", body: "", url: "https://github.com/acme/web/issues/41", author: "maya" },
      projectId: "prj_web",
      hostId: "host_worker",
      baseBranch: "main",
      state: "queued",
      error: null,
    },
    1,
  )!;
  store.write(job.id, job.version, { phase: { state: "stopped" }, threadId: worker }, 2);

  await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: worker, originPluginId: "pstack" }), lastAssistantText: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.sdk.callsTo("threads.send"), []);

  const person = "thr_person";
  await harness.runCli(["checklist", "begin", "feature"], { threadId: person, cwd: "/tmp" });
  await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: person, originPluginId: null }), lastAssistantText: null });
  assert.equal(harness.sdk.callsTo("threads.send").length, 1, "a thread a person started is nudged");
  await harness.dispose();
});

test("an unusable GitHub App private key shows as the repository's poll error", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pstack",
    settings: { githubAppId: "123", githubPrivateKey: Buffer.from("not a key").toString("base64"), issueRepos: "acme/web project=prj_web host=host_worker" },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_server" }) as never },
      projects: { defaultExecutionOptions: async () => null },
      providers: {
        list: async () => [{ id: "codex", available: true }] as never,
        models: async () => ({ models: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] }) as never,
      },
    },
  });
  await plugin(bb);
  const service = harness.runService("pstack-issues");
  const listed = async () => (await harness.runCli(["issues", "list"], { cwd: "/tmp" })).stdout;
  while (!(await listed()).includes("poll error")) await new Promise((resolve) => setTimeout(resolve, 5));
  service.controller.abort();
  await service.done;
  assert.match(await listed(), /poll error: githubPrivateKey is not a base64-encoded PEM private key/);
  await harness.dispose();
});

const ISSUE_SETUP = {
  githubAppId: "123",
  githubPrivateKey: Buffer.from("not a key").toString("base64"),
  issueRepos: "acme/web project=prj_web host=host_worker\nacme/api project=prj_api host=host_worker",
};

function queuedJob(id: string, issue: number, eventId: number): NewJob {
  return {
    id: id as JobId,
    repo: "acme/web" as RepoName,
    issue,
    trigger: { eventId, actor: "maya", at: 1 },
    snapshot: { title: `Issue ${issue}`, body: "", url: `https://github.com/acme/web/issues/${issue}`, author: "maya" },
    projectId: "prj_web",
    hostId: "host_worker",
    baseBranch: "main",
    state: "queued",
    error: null,
  };
}

test("the app's issue board retains CLI jobs when the GitHub catalog fails, and a worker thread's board holds its job", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "pstack", settings: ISSUE_SETUP });
  await plugin(bb);
  const store = openIssueStore(bb.storage.database(), () => {});
  const working = store.insert(queuedJob("psi_00000000-0000-0000-0000-000000000001", 41, 1), 1)!;
  store.write(working.id, working.version, { phase: { state: "working" }, threadId: "thr_worker" }, 2);
  const ended = store.insert(queuedJob("psi_00000000-0000-0000-0000-000000000002", 42, 2), 3)!;
  store.write(ended.id, ended.version, { phase: { state: "stopped" } }, 4);
  const listed = async (...flags: string[]) => JSON.parse((await harness.runCli(["issues", "list", "--json", ...flags], { cwd: "/tmp" })).stdout);

  const open = await harness.callRpc("pstackIssueBoard", { all: false });
  assert.deepEqual((open as { jobs: unknown[] }).jobs, (await listed()).jobs);
  assert.deepEqual((open as { issues: unknown[] }).issues, []);
  assert.ok((open as { repos: { error: string | null }[] }).repos.every((repo) => repo.error?.includes("private key")));
  assert.deepEqual((open as { repos: { repo: string }[] }).repos.map((repo) => repo.repo), ["acme/web", "acme/api"]);
  assert.deepEqual((await harness.callRpc("pstackIssueBoard", { all: true }) as { jobs: unknown[] }).jobs, (await listed("--all")).jobs);
  const worker = (await harness.callRpc("pstackIssueBoard", { threadId: "thr_worker" })) as { jobs: { id: string; title: string }[] };
  assert.deepEqual(worker.jobs.map((job) => [job.id, job.title]), [[working.id, "Issue 41"]]);
  assert.deepEqual(await harness.callRpc("pstackIssueBoard", { threadId: "thr_person" }), { repos: [], jobs: [] });
  await harness.dispose();
});

test("the issue board uses the GitHub plugin catalog across mapped and unmapped repositories", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "pstack", settings: ISSUE_SETUP });
  const items = [
    { repo: "acme/web", number: 41, kind: "issue", title: "Fix navigation", url: "https://github.com/acme/web/issues/41", state: "open", author: "maya", body: "", labels: [], assignees: [], updatedAt: "2026-10-18T00:00:00Z" },
    { repo: "acme/extra", number: 7, kind: "issue", title: "Update docs", url: "https://github.com/acme/extra/issues/7", state: "closed", author: "maya", body: "", labels: ["docs"], assignees: [], updatedAt: "2026-10-17T00:00:00Z" },
  ];
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }) => {
    assert.equal(pluginId, "github");
    assert.equal(method, "listItems");
    assert.deepEqual(input, { kind: "issue" });
    return { items };
  });
  await plugin(bb);
  const board = await harness.callRpc("pstackIssueBoard", { all: false }) as { issues: { repo: string; issue: number; startError: string | null }[]; repos: { repo: string }[]; jobs: unknown[] };
  assert.deepEqual(board.issues.map(({ repo, issue }) => [repo, issue]), [["acme/web", 41], ["acme/extra", 7]]);
  assert.equal(board.issues[0]!.startError, null);
  assert.match(board.issues[1]!.startError!, /issueRepos/);
  assert.ok(board.repos.some(({ repo }) => repo === "acme/extra"));
  assert.deepEqual(board.jobs, []);
  await assert.rejects(harness.callRpc("pstackStartIssue", { repo: "acme/extra", issue: 7 }), /not configured/);
  await assert.rejects(harness.callRpc("pstackStartIssue", { repo: "acme/web", issue: -1 }));
  await harness.dispose();
});

test("stopping an issue job from the app moves it to stopping once, and signals the issue channel", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "pstack" });
  await plugin(bb);
  const store = openIssueStore(bb.storage.database(), () => {});
  const job = store.insert(queuedJob("psi_00000000-0000-0000-0000-000000000003", 43, 3), 1)!;
  store.write(job.id, job.version, { phase: { state: "working" }, threadId: "thr_worker" }, 2);

  assert.deepEqual(await harness.callRpc("pstackStopIssueJob", { id: job.id }), { stopped: true });
  assert.equal(store.get(job.id)!.phase.state, "stopping");
  assert.deepEqual(await harness.callRpc("pstackStopIssueJob", { id: job.id }), { stopped: false });
  await assert.rejects(harness.callRpc("pstackStopIssueJob", { id: "psi_not-an-id" }));

  while (!harness.realtimeSignals.some((signal) => signal.channel === ISSUES_CHANNEL)) await new Promise((resolve) => setTimeout(resolve, 20));
  const signal = harness.realtimeSignals.find((candidate) => candidate.channel === ISSUES_CHANNEL)!;
  assert.ok(Number.isInteger((signal.payload as { revision: unknown }).revision));
  assert.deepEqual(Object.keys(signal.payload as object), ["revision"]);
  await harness.dispose();
});

for (const child of [{ status: "pending", retry: false, label: "a pending" }, { status: "error", retry: true, label: "an errored" }] as const) {
  test(`a delegate waiting on ${child.label} child${child.retry ? " with a scheduled retry" : ""} gets no checklist nudge`, async (t) => {
    const db = new Database(":memory:");
    t.after(() => db.close());
    type IdleHandler = (payload: { thread: ReturnType<typeof thread>; lastAssistantText: string }) => unknown;
    const idle: IdleHandler[] = [];
    const sends: string[] = [];
    const bb = {
      pluginId: "pstack",
      settings: { define: () => ({ get: async () => ({ models: "" }), onChange() {} }) },
      storage: { database: () => db, migrate: (_db: unknown, migrations: string[]) => migrations.forEach((sql) => db.exec(sql)) },
      sdk: {
        threads: {
          list: async ({ parentThreadId }: { parentThreadId?: string }) => (parentThreadId === "thr_delegate" ? [{ id: "thr_child", status: child.status }] : []),
          queuedMessages: { list: async ({ threadId }: { threadId: string }) => (child.retry && threadId === "thr_child" ? [{ payload: { kind: "retry" }, sendAt: 1 }] : []) },
          send: async ({ threadId }: { threadId: string }) => sends.push(threadId),
        },
      },
      realtime: { publish() {} },
      rpc: { register() {} },
      cli: { register() {} },
      agents: { registerTool() {}, configure() {}, contributeInstructions() {} },
      events: { on: (event: string, handler: IdleHandler) => { if (event === "thread.idle") idle.push(handler); } },
      background: { service() {} },
      hosts: { experimental_client: () => ({}) },
      experimental_hooks: { on() {} },
      log: { error() {}, warn() {} },
    } as unknown as BbPluginApi;
    await plugin(bb);
    openChecklistStore(db).createChecklist("thr_delegate", "feature", [{ section: "playbook", text: "Verify the change.", afterPr: false, skipPolicy: "agent" }], 0);
    await idle.at(-1)!({ thread: thread("thr_delegate"), lastAssistantText: "done" });
    assert.deepEqual(sends, []);
  });
}
