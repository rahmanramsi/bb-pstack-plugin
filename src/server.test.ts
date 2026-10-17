import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { openIssueStore } from "./issues/store.ts";
import type { JobId, RepoName } from "./issues/job.ts";
import plugin from "./server.ts";

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

  const store = openIssueStore(bb.storage.database());
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
