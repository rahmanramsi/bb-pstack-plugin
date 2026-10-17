import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi, PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { CHECKOUT_PROOF_CHANNEL, CHECKOUT_RENDERER, ConsentForm, ProofSignal } from "./checkout-form.ts";
import { CLONE_BACKOFF_MS, DISMISS_COOLDOWN_MS, createCheckouts, decide, parseCheckouts, pressured, recordDecisions } from "./checkouts.ts";
import { hostId, type Board, type HostRow, type Need } from "./placement.ts";

const HOME = hostId.parse("host_home");
const BOX = hostId.parse("host_box");
const VPS = hostId.parse("host_vps");

function book(text: string) {
  const parsed = parseCheckouts(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  return parsed.book;
}

test("checkout rules reject anything but <project|*> allow|deny <host|*>", () => {
  assert.ok(parseCheckouts("# comment\n\n* deny *\np1 allow host_box").ok);
  for (const text of ["p1 allow", "p1 maybe host_box", "p1 allow host_box extra", "allow"]) {
    assert.equal(parseCheckouts(text).ok, false, text);
  }
});

test("the most specific rule wins and deny beats allow at equal specificity", () => {
  const rules = book("* allow *\np1 deny *\np1 allow host_box\n* deny host_vps");
  assert.equal(decide(rules, "p2", BOX), "allow");
  assert.equal(decide(rules, "p1", HOME), "deny");
  assert.equal(decide(rules, "p1", BOX), "allow");
  assert.equal(decide(rules, "p1", VPS), "deny");
  assert.equal(decide(book("p1 allow *\n* deny host_box"), "p1", BOX), "deny");
  assert.equal(decide(book("p1 allow host_box\np1 deny host_box"), "p1", BOX), "deny");
  assert.equal(decide(book("p1 allow host_box"), "p2", BOX), null);
  assert.equal(decide(book(""), "p1", BOX), null);
});

test("recorded decisions replace that pair's line and keep everything else", () => {
  const text = recordDecisions("# mine\n* deny host_vps\np1 allow host_box\n", "p1", new Map([[BOX, "deny"], [HOME, "allow"]]));
  assert.match(text, /^# mine\n\* deny host_vps\n/);
  const rules = book(text);
  assert.equal(decide(rules, "p1", BOX), "deny");
  assert.equal(decide(rules, "p1", HOME), "allow");
  assert.equal(decide(rules, "p1", VPS), "deny");
  assert.equal(rules.rules.length, 3);
});

const row = (id: typeof HOME, overrides: Partial<HostRow> = {}): HostRow => ({ id, name: id, running: 0, held: 0, limit: 4, free: 4, blocker: null, onlyNeedsCheckout: false, ...overrides });
const need: Need = { projectId: "p1", home: { kind: "worktree", hostId: HOME, baseBranch: null }, away: { kind: "worktree", baseBranch: null, pin: null }, affinity: "spread", model: null };

test("pressure needs a full home and a machine that lacks only a checkout", () => {
  const board = (homeFree: number): Board => ({
    hosts: [row(HOME, { free: homeFree, running: 4 - homeFree }), row(BOX, { blocker: "no checkout of this project", onlyNeedsCheckout: true }), row(VPS, { blocker: "disconnected" })],
    global: { running: 4, limit: null }, next: null,
  });
  assert.deepEqual(pressured(board(0), need), [{ id: BOX, name: BOX }]);
  assert.deepEqual(pressured(board(1), need), []);
  assert.deepEqual(pressured(board(0), { ...need, away: null }), []);
});

function fake(options: { setting?: string; sources?: string[]; addFailures?: number; addCreatesSource?: boolean } = {}) {
  let setting = options.setting ?? "";
  let now = 1_000_000;
  const sources = new Set(options.sources ?? [HOME]);
  const adds: unknown[] = [];
  const sleeps: number[] = [];
  const gets: number[] = [];
  const forms: { request: PluginInteractionRequest; answer: (result: PluginInteractionResult) => Promise<void> }[] = [];
  const published: unknown[] = [];
  const kv = new Map<string, unknown>();
  let failures = options.addFailures ?? 0;
  const bb = {
    sdk: {
      hosts: { list: async () => [HOME, BOX, VPS].map((id) => ({ id, name: `${id} name`, status: id === VPS ? "disconnected" : "connected", lifecycle: { phase: "active" } })) },
      projects: {
        get: async () => { gets.push(now); return { name: "Project One", sources: [...sources].map((id) => ({ hostId: id })) }; },
        sources: {
          add: async (args: { hostId: string }) => {
            adds.push(args);
            if (failures > 0) {
              failures--;
              if (options.addCreatesSource) sources.add(args.hostId);
              throw new Error("clone timed out");
            }
            sources.add(args.hostId);
            return {};
          },
        },
      },
    },
    ui: {
      requestInput: (request: PluginInteractionRequest) => new Promise<PluginInteractionResult>((resolve) => {
        forms.push({ request, answer: async (result) => { resolve(result); await settle(); } });
      }),
    },
    realtime: { publish: (channel: string, payload: unknown) => { published.push({ channel, payload }); } },
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } } },
    log: { warn() {}, info() {} },
  } as unknown as BbPluginApi;
  const checkouts = createCheckouts(bb, { get: async () => setting, set: async (text) => { setting = text; } }, {
    clock: () => now, sleep: async (ms) => { sleeps.push(ms); },
  });
  const proofFor = (formId: string) => {
    assert.equal(checkouts.publishProof(formId), true);
    const signal = ProofSignal.parse((published.at(-1) as { payload: unknown }).payload);
    assert.equal((published.at(-1) as { channel: string }).channel, CHECKOUT_PROOF_CHANNEL);
    return signal.proof;
  };
  return { checkouts, forms, adds, sleeps, gets, kv, proofFor, setting: () => setting, advance: (ms: number) => { now += ms; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const BOX_ROW = [{ id: BOX, name: "Box" }];

test("placement pressure opens one form per project in the requesting thread", async () => {
  const h = fake();
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  h.checkouts.notice("thr_b", "p1", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 1);
  const { request } = h.forms[0];
  assert.equal(request.threadId, "thr_a");
  assert.equal(request.rendererId, CHECKOUT_RENDERER);
  const form = ConsentForm.parse(request.payload);
  assert.deepEqual([form.projectId, form.projectName, form.hosts], ["p1", "Project One", BOX_ROW]);
  h.checkouts.notice("thr_c", "p2", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 2);
});

test("a dismissed form stays closed for 24 hours", async () => {
  const h = fake();
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  await h.forms[0].answer({ outcome: "cancelled", reason: "user" });
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 1);
  h.advance(DISMISS_COOLDOWN_MS);
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 2);
});

test("a form cancelled by a thread stop is not a dismissal", async () => {
  const h = fake();
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  await h.forms[0].answer({ outcome: "cancelled", reason: "thread-stopped" });
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 2);
});

test("a deny answered from anywhere is recorded and clones nothing", async () => {
  const h = fake();
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  await h.forms[0].answer({ outcome: "submitted", value: { decisions: { [BOX]: "deny" }, proof: null } });
  assert.equal(decide(book(h.setting()), "p1", BOX), "deny");
  assert.deepEqual(h.adds, []);
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.forms.length, 1);
});

test("an allow without the app's proof records nothing and clones nothing", async () => {
  for (const proof of [null, "guessed"]) {
    const h = fake();
    h.checkouts.notice("thr_a", "p1", BOX_ROW);
    await settle();
    const value = { decisions: { [BOX]: "allow" }, proof };
    const description = await h.forms[0].request.describeSubmission!(value);
    assert.match(description.detail ?? "", /ignored/);
    await h.forms[0].answer({ outcome: "submitted", value });
    assert.equal(decide(book(h.setting()), "p1", BOX), null);
    assert.deepEqual(h.adds, []);
  }
});

test("an allow with the app's proof is recorded and clones in the background", async () => {
  const h = fake({ setting: "# kept" });
  h.checkouts.notice("thr_a", "p1", [...BOX_ROW, { id: VPS, name: "Vps" }]);
  await settle();
  const form = ConsentForm.parse(h.forms[0].request.payload);
  await h.forms[0].answer({ outcome: "submitted", value: { decisions: { [BOX]: "allow", [VPS]: "deny" }, proof: h.proofFor(form.formId) } });
  assert.match(h.setting(), /^# kept\n/);
  assert.equal(decide(book(h.setting()), "p1", BOX), "allow");
  assert.equal(decide(book(h.setting()), "p1", VPS), "deny");
  assert.deepEqual(h.adds, [{ projectId: "p1", type: "clone", hostId: BOX }]);
  assert.equal(h.checkouts.publishProof(form.formId), false);
});

test("allowed machines clone once per project and machine however often pressure repeats", async () => {
  const h = fake({ setting: "p1 allow host_box" });
  for (let i = 0; i < 3; i++) h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.deepEqual(h.adds, [{ projectId: "p1", type: "clone", hostId: BOX }]);
  assert.equal(h.forms.length, 0);
});

test("a failed clone re-reads sources and retries with back-off", async () => {
  const h = fake({ setting: "p1 allow host_box", addFailures: 2 });
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.adds.length, 3);
  assert.deepEqual(h.sleeps, CLONE_BACKOFF_MS.slice(0, 2));
  assert.equal(h.gets.length, 3);
});

test("a clone that errored but created the source is not cloned again", async () => {
  const h = fake({ setting: "p1 allow host_box", addFailures: 1, addCreatesSource: true });
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.adds.length, 1);
  assert.equal(h.gets.length, 2);
});

test("a clone gives up after its back-off runs out", async () => {
  const h = fake({ setting: "p1 allow host_box", addFailures: 99 });
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.adds.length, CLONE_BACKOFF_MS.length + 1);
  h.checkouts.notice("thr_a", "p1", BOX_ROW);
  await settle();
  assert.equal(h.adds.length, CLONE_BACKOFF_MS.length + 1);
});

test("asking lists connected machines with no checkout and no rule, past any cooldown", async () => {
  const h = fake({ setting: "p1 deny host_vps" });
  h.kv.set("checkout-dismissed:p1", 1_000_000);
  const result = await h.checkouts.ask("thr_a", "p1");
  assert.deepEqual(result, { kind: "opened", hosts: [{ id: BOX, name: `${BOX} name` }] });
  assert.equal((await h.checkouts.ask("thr_b", "p1")).kind, "already-open");
  await h.forms[0].answer({ outcome: "submitted", value: { decisions: { [BOX]: "deny" }, proof: null } });
  assert.deepEqual(await h.checkouts.ask("thr_a", "p1"), { kind: "nothing-to-ask" });
});
