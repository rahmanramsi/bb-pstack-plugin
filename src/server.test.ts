import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";
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
