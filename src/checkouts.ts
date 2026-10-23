import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostId, type Board, type HostId, type Need } from "./placement.ts";

export const Verdict = z.enum(["allow", "deny"]);
export type Verdict = z.infer<typeof Verdict>;

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

/** The most specific matching rule wins; at equal specificity deny beats allow. With no matching rule, cloning is allowed. */
export function decide(book: ConsentBook, projectId: string, host: HostId): Verdict {
  let best = -1;
  let verdict: Verdict = "allow";
  for (const rule of book.rules) {
    if ((rule.project !== null && rule.project !== projectId) || (rule.host !== null && rule.host !== host)) continue;
    const specificity = (rule.project === null ? 0 : 1) + (rule.host === null ? 0 : 1);
    if (specificity > best) [best, verdict] = [specificity, rule.verdict];
    else if (specificity === best && rule.verdict === "deny") verdict = "deny";
  }
  return verdict;
}

/** Hosts a clone would open up: home is full and the host is eligible except for its missing checkout. */
export function pressured(board: Board, need: Need): { id: HostId; name: string }[] {
  if (need.projectId === null || need.away === null) return [];
  const home = board.hosts.find((row) => row.id === need.home.hostId);
  if (!home || home.limit === null || home.free > 0) return [];
  return board.hosts.filter((row) => row.onlyNeedsCheckout).map(({ id, name }) => ({ id, name }));
}

export const NO_REMOTE = "no git remote to clone from";
export const CLONE_BACKOFF_MS = [5_000, 30_000, 120_000];
const CLONE_QUIET_MS = 60 * 60 * 1000;

export interface Checkouts {
  /** Clones the project onto each host no rule denies, in the background. At most one clone per project and host runs. */
  clone(projectId: string, hosts: readonly HostId[]): void;
  /** Clones the project onto every connected host with no checkout that no rule denies, and returns those hosts. */
  cloneEverywhere(projectId: string): Promise<{ id: HostId; name: string }[]>;
  verdict(projectId: string, host: HostId): Promise<Verdict>;
  /** The URL a clone would use. Null when neither the project nor its default checkout has a remote. */
  remote(projectId: string): Promise<string | null>;
}

/**
 * Clones `remoteUrl` onto `host` through the pstack GitHub App and returns the checkout's path, or null when the App
 * cannot reach the repository (not GitHub, not configured, not installed), in which case bb clones it itself.
 */
export type AppClone = (host: HostId, remoteUrl: string, projectName: string) => Promise<string | null>;

export function createCheckouts(bb: BbPluginApi, setting: () => Promise<string>, deps: {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  appClone?: AppClone;
} = {}): Checkouts {
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cloning = new Map<string, Promise<void>>();
  const gaveUp = new Map<string, number>();
  const warn = (what: string, error: unknown) => bb.log.warn(`pstack checkouts: ${what}: ${error instanceof Error ? error.message : String(error)}`);

  async function book(): Promise<ConsentBook> {
    const parsed = parseCheckouts(await setting());
    if (!parsed.ok) throw new Error(`the checkouts setting is invalid: ${parsed.errors.join("; ")}`);
    return parsed.book;
  }

  // bb clones the project's git remote, which can be null, so fall back to the origin of the default checkout.
  async function remoteOf(project: { gitRemoteUrl: string | null; sources: readonly { hostId: string; path: string; isDefault: boolean }[] }): Promise<string | null> {
    if (project.gitRemoteUrl) return project.gitRemoteUrl;
    const source = project.sources.find((candidate) => candidate.isDefault);
    if (!source) return null;
    const { repos } = await bb.sdk.hosts.experimental_discoverRepos({ hostId: source.hostId });
    return repos.find((repo) => repo.path === source.path)?.originUrl ?? null;
  }

  function cloneOne(projectId: string, host: HostId): void {
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
          // bb's own clone runs plain git on the host, which holds no GitHub credentials, so a private repository
          // goes through the App first.
          const path = deps.appClone ? await deps.appClone(host, remoteUrl, project.name) : null;
          await bb.sdk.projects.sources.add(path === null
            ? { projectId, type: "clone", hostId: host, remoteUrl }
            : { projectId, type: "local_path", hostId: host, path });
          bb.log.info(`pstack checkouts: cloned ${projectId} onto ${host}${path === null ? "" : ` at ${path} through the GitHub App`}`);
          return;
        } catch (error) { warn(`clone of ${projectId} onto ${host}, attempt ${attempt + 1}`, error); }
      }
      gaveUp.set(key, clock());
    })().finally(() => { cloning.delete(key); });
    cloning.set(key, run);
  }

  return {
    clone(projectId, hosts) {
      for (const host of hosts) cloneOne(projectId, host);
    },
    async cloneEverywhere(projectId) {
      const [hosts, project, rules] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.projects.get({ projectId }), book()]);
      const checkedOut = new Set(project.sources.map((source) => source.hostId));
      const targets = hosts
        .filter((host) => host.status === "connected" && host.lifecycle.phase === "active" && !checkedOut.has(host.id))
        .map((host) => ({ id: hostId.parse(host.id), name: host.name }))
        .filter((host) => decide(rules, projectId, host.id) === "allow");
      for (const host of targets) cloneOne(projectId, host.id);
      return targets;
    },
    async verdict(projectId, host) { return decide(await book(), projectId, host); },
    async remote(projectId) { return remoteOf(await bb.sdk.projects.get({ projectId })); },
  };
}
