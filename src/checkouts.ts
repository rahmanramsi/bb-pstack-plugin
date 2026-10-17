import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { CHECKOUT_PROOF_CHANNEL, CHECKOUT_RENDERER, ConsentAnswer, type ConsentForm, Verdict } from "./checkout-form.ts";
import { hostId, type Board, type HostId, type Need } from "./placement.ts";

/** One `checkouts` line. A null side is `*`. */
export interface Rule {
  project: string | null;
  host: HostId | null;
  verdict: Verdict;
}
export interface ConsentBook {
  rules: readonly Rule[];
}
export type ParsedCheckouts = { ok: true; book: ConsentBook } | { ok: false; errors: string[] };

const meaningful = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");

export function parseCheckouts(text: string): ParsedCheckouts {
  const rules: Rule[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!meaningful(line)) return;
    const [project, verdict, host, ...rest] = line.trim().split(/\s+/);
    const parsed = Verdict.safeParse(verdict);
    if (!parsed.success || !host || rest.length > 0) {
      errors.push(`line ${index + 1}: expected "<projectId|*> allow|deny <hostId|*>", got "${line.trim()}"`);
      return;
    }
    rules.push({ project: project === "*" ? null : project, host: host === "*" ? null : hostId.parse(host), verdict: parsed.data });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, book: { rules } };
}

/** The most specific matching rule wins; at equal specificity deny beats allow. Null means nobody has decided. */
export function decide(book: ConsentBook, projectId: string, host: HostId): Verdict | null {
  let best = -1;
  let verdict: Verdict | null = null;
  for (const rule of book.rules) {
    if ((rule.project !== null && rule.project !== projectId) || (rule.host !== null && rule.host !== host)) continue;
    const specificity = (rule.project === null ? 0 : 1) + (rule.host === null ? 0 : 1);
    if (specificity > best) [best, verdict] = [specificity, rule.verdict];
    else if (specificity === best && rule.verdict === "deny") verdict = "deny";
  }
  return verdict;
}

/** Writes one exact `<project> <verdict> <host>` line per decision, replacing any earlier exact line for that pair. */
export function recordDecisions(text: string, projectId: string, decisions: ReadonlyMap<HostId, Verdict>): string {
  const kept = text.split(/\r?\n/).filter((line) => {
    if (!meaningful(line)) return true;
    const [project, , host] = line.trim().split(/\s+/);
    return !(project === projectId && decisions.has(host as HostId));
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return [...kept, ...[...decisions].map(([host, verdict]) => `${projectId} ${verdict} ${host}`)].join("\n");
}

/** Hosts a clone would open up: home is full and the host is eligible except for its missing checkout. */
export function pressured(board: Board, need: Need): { id: HostId; name: string }[] {
  if (need.projectId === null || need.away === null) return [];
  const home = board.hosts.find((row) => row.id === need.home.hostId);
  if (!home || home.limit === null || home.free > 0) return [];
  return board.hosts.filter((row) => row.onlyNeedsCheckout).map(({ id, name }) => ({ id, name }));
}

export const NO_REMOTE = "no git remote to clone from";
export const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const CLONE_BACKOFF_MS = [5_000, 30_000, 120_000];
const CLONE_QUIET_MS = 60 * 60 * 1000;
const dismissedKey = (projectId: string) => `checkout-dismissed:${projectId}`;

export type AskResult =
  | { kind: "opened"; hosts: { id: HostId; name: string }[] }
  | { kind: "already-open"; threadId: string }
  | { kind: "cooling-down"; until: number }
  | { kind: "nothing-to-ask" };

export interface Checkouts {
  /** Placement pressure. Clones allowed hosts and asks about undecided ones; never waits for either. */
  notice(threadId: string, projectId: string, hosts: readonly { id: HostId; name: string }[]): void;
  /** Opens the form for every connected host with no checkout and no rule, ignoring the dismissal cooldown. */
  ask(threadId: string, projectId: string): Promise<AskResult>;
  /** Publishes a pending form's proof to the bb app. False when no such form is open. */
  publishProof(formId: string): boolean;
  verdict(projectId: string, host: HostId): Promise<Verdict | null>;
  /** The URL a clone would use. Null when neither the project nor its default checkout has a remote. */
  remote(projectId: string): Promise<string | null>;
}

export interface CheckoutSetting {
  get(): Promise<string>;
  set(text: string): Promise<void>;
}

export function createCheckouts(bb: BbPluginApi, setting: CheckoutSetting, deps: {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Checkouts {
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const open = new Map<string, { threadId: string; formId: string; proof: string }>();
  const cloning = new Map<string, Promise<void>>();
  const gaveUp = new Map<string, number>();
  let writes: Promise<unknown> = Promise.resolve();
  const warn = (what: string, error: unknown) => bb.log.warn(`pstack checkouts: ${what}: ${error instanceof Error ? error.message : String(error)}`);

  async function book(): Promise<ConsentBook> {
    const parsed = parseCheckouts(await setting.get());
    if (!parsed.ok) throw new Error(`the checkouts setting is invalid: ${parsed.errors.join("; ")}`);
    return parsed.book;
  }

  function record(projectId: string, decisions: ReadonlyMap<HostId, Verdict>): Promise<void> {
    const next = writes.then(async () => {
      const text = await setting.get();
      const parsed = parseCheckouts(text);
      if (!parsed.ok) throw new Error(`the checkouts setting is invalid: ${parsed.errors.join("; ")}`);
      await setting.set(recordDecisions(text, projectId, decisions));
    });
    writes = next.catch(() => {});
    return next;
  }

  // bb clones the project's git remote, which can be null, so fall back to the origin of the default checkout.
  async function remoteOf(project: { gitRemoteUrl: string | null; sources: readonly { hostId: string; path: string; isDefault: boolean }[] }): Promise<string | null> {
    if (project.gitRemoteUrl) return project.gitRemoteUrl;
    const source = project.sources.find((candidate) => candidate.isDefault);
    if (!source) return null;
    const { repos } = await bb.sdk.hosts.experimental_discoverRepos({ hostId: source.hostId });
    return repos.find((repo) => repo.path === source.path)?.originUrl ?? null;
  }

  function clone(projectId: string, host: HostId): void {
    const key = `${projectId} ${host}`;
    if (cloning.has(key) || clock() - (gaveUp.get(key) ?? -Infinity) < CLONE_QUIET_MS) return;
    const run = (async () => {
      for (let attempt = 0; attempt <= CLONE_BACKOFF_MS.length; attempt++) {
        if (attempt > 0) await sleep(CLONE_BACKOFF_MS[attempt - 1]);
        try {
          const project = await bb.sdk.projects.get({ projectId });
          if (project.sources.some((source) => source.hostId === host)) return;
          if (decide(await book(), projectId, host) !== "allow") return;
          const remoteUrl = await remoteOf(project);
          if (remoteUrl === null) {
            bb.log.warn(`pstack checkouts: not cloning ${projectId} onto ${host}: ${NO_REMOTE}; the project has no git remote and its default checkout has no origin`);
            return;
          }
          await bb.sdk.projects.sources.add({ projectId, type: "clone", hostId: host, remoteUrl });
          bb.log.info(`pstack checkouts: cloned ${projectId} onto ${host}`);
          return;
        } catch (error) { warn(`clone of ${projectId} onto ${host}, attempt ${attempt + 1}`, error); }
      }
      gaveUp.set(key, clock());
    })().finally(() => { cloning.delete(key); });
    cloning.set(key, run);
  }

  function settle(form: ConsentForm, proof: string, value: unknown): { decisions: Map<HostId, Verdict>; ignored: HostId[] } {
    const parsed = ConsentAnswer.safeParse(value);
    const decisions = new Map<HostId, Verdict>();
    const ignored: HostId[] = [];
    if (!parsed.success) return { decisions, ignored };
    const trusted = parsed.data.proof === proof;
    for (const host of form.hosts) {
      const verdict = parsed.data.decisions[host.id];
      if (verdict === "allow" && !trusted) ignored.push(hostId.parse(host.id));
      else if (verdict) decisions.set(hostId.parse(host.id), verdict);
    }
    return { decisions, ignored };
  }

  async function finish(form: ConsentForm, proof: string, result: PluginInteractionResult): Promise<void> {
    let dismissed = result.outcome === "cancelled" && (result.reason === "user" || result.reason === "timeout");
    if (result.outcome === "submitted") {
      const { decisions, ignored } = settle(form, proof, result.value);
      if (ignored.length > 0) bb.log.warn(`pstack checkouts: ignored allow for ${ignored.join(", ")}; it was not answered from the bb app`);
      if (decisions.size > 0) await record(form.projectId, decisions);
      for (const [host, verdict] of decisions) if (verdict === "allow") clone(form.projectId, host);
      dismissed = decisions.size < form.hosts.length;
    }
    if (dismissed) await bb.storage.kv.set(dismissedKey(form.projectId), clock());
  }

  async function openForm(threadId: string, projectId: string, hosts: readonly { id: HostId; name: string }[], respectCooldown: boolean): Promise<AskResult> {
    const current = open.get(projectId);
    if (current) return { kind: "already-open", threadId: current.threadId };
    if (hosts.length === 0) return { kind: "nothing-to-ask" };
    const formId = randomUUID();
    const proof = randomUUID();
    // Claimed before any await so a concurrent notice for this project sees the open form.
    open.set(projectId, { threadId, formId, proof });
    let form: ConsentForm;
    try {
      if (respectCooldown) {
        const dismissedAt = await bb.storage.kv.get<number>(dismissedKey(projectId));
        if (dismissedAt !== undefined && clock() - dismissedAt < DISMISS_COOLDOWN_MS) {
          open.delete(projectId);
          return { kind: "cooling-down", until: dismissedAt + DISMISS_COOLDOWN_MS };
        }
      }
      const projectName = await bb.sdk.projects.get({ projectId }).then((project) => project.name, () => projectId);
      form = { formId, projectId, projectName, hosts: [...hosts] };
    } catch (error) {
      open.delete(projectId);
      throw error;
    }
    void bb.ui.requestInput({
      threadId, rendererId: CHECKOUT_RENDERER, title: "Checkout consent", payload: form,
      presentation: { label: { pending: "Waiting for checkout consent", completed: "Recorded checkout consent" } },
      describeSubmission: (value) => {
        const { decisions, ignored } = settle(form, proof, value);
        const name = (id: string) => form.hosts.find((host) => host.id === id)?.name ?? id;
        const lines = [...decisions].map(([host, verdict]) => `- ${name(host)}: ${verdict === "allow" ? "clone allowed" : "clone denied"}`);
        for (const host of ignored) lines.push(`- ${name(host)}: allow ignored, it was not answered from the bb app`);
        return { title: `Checkout consent for ${form.projectName}`, detail: lines.join("\n") || "No machine was decided." };
      },
    }).then((result) => finish(form, proof, result))
      .catch((error) => warn(`checkout form for ${projectId}`, error))
      .finally(() => { if (open.get(projectId)?.formId === formId) open.delete(projectId); });
    return { kind: "opened", hosts: [...hosts] };
  }

  return {
    notice(threadId, projectId, hosts) {
      void (async () => {
        const rules = await book();
        const undecided = hosts.filter((host) => {
          const verdict = decide(rules, projectId, host.id);
          if (verdict === "allow") clone(projectId, host.id);
          return verdict === null;
        });
        if (undecided.length > 0) await openForm(threadId, projectId, undecided, true);
      })().catch((error) => warn(`placement pressure for ${projectId}`, error));
    },
    async ask(threadId, projectId) {
      const [hosts, project, rules] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.projects.get({ projectId }), book()]);
      const checkedOut = new Set(project.sources.map((source) => source.hostId));
      const undecided = hosts
        .filter((host) => host.status === "connected" && host.lifecycle.phase === "active" && !checkedOut.has(host.id))
        .map((host) => ({ id: hostId.parse(host.id), name: host.name }))
        .filter((host) => decide(rules, projectId, host.id) === null);
      return openForm(threadId, projectId, undecided, false);
    },
    publishProof(formId) {
      const form = [...open.values()].find((entry) => entry.formId === formId);
      if (!form) return false;
      bb.realtime.publish(CHECKOUT_PROOF_CHANNEL, { formId, proof: form.proof });
      return true;
    },
    async verdict(projectId, host) { return decide(await book(), projectId, host); },
    async remote(projectId) { return remoteOf(await bb.sdk.projects.get({ projectId })); },
  };
}
