import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { openIssueStore } from "./issues/store.ts";
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
    sdk: { system: { config: async () => ({ primaryHostId: "host_server" }) as never } },
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
