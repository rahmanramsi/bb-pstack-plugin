import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseChoice, type EffectiveRole } from "./models.ts";

export type CatalogModel = { model: string; levels: readonly string[] };

export type ProviderCatalog =
  | { state: "unavailable" }
  | { state: "error"; detail: string }
  | { state: "ok"; models: readonly CatalogModel[] };

export type Catalog = ReadonlyMap<string, ProviderCatalog>;

export type Check = {
  ok: boolean;
  subject: string;
  detail: string;
};

type Verdict = { ok: boolean; detail: string };

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function checkTuple(value: string, catalog: Catalog): Verdict {
  const choice = parseChoice(value);
  if (!choice) return { ok: false, detail: "not a provider/model/level tuple" };
  if (choice.kind === "inherit-parent") {
    return { ok: true, detail: "runs on the parent thread's model" };
  }
  const provider = catalog.get(choice.provider);
  if (!provider) {
    return { ok: false, detail: `provider "${choice.provider}" is not installed` };
  }
  switch (provider.state) {
    case "unavailable":
      return { ok: false, detail: `provider "${choice.provider}" is unavailable` };
    case "error":
      return { ok: false, detail: `could not load ${choice.provider} models: ${provider.detail}` };
    case "ok": {
      const model = provider.models.find((entry) => entry.model === choice.model);
      if (!model) {
        return {
          ok: false,
          detail: `${choice.provider} has no model "${choice.model}" (has ${listOrNone(provider.models.map((m) => m.model))})`,
        };
      }
      if (!model.levels.includes(choice.reasoningLevel)) {
        return {
          ok: false,
          detail: `${choice.model} does not support "${choice.reasoningLevel}" (supports ${listOrNone(model.levels)})`,
        };
      }
      return { ok: true, detail: "available" };
    }
  }
}

/**
 * Why a host with `catalog` cannot run `tuple`, or null when it can. Throws when the provider's models failed to load,
 * which says nothing about the tuple.
 */
export function workerProblem(tuple: string, catalog: Catalog): string | null {
  const check = checkTuple(tuple, catalog);
  if (check.ok) return null;
  if (catalog.get(tuple.split("/")[0]!)?.state === "error") throw new Error(`${tuple}: ${check.detail}`);
  return `${tuple}: ${check.detail}`;
}

export function checkRoles(roles: readonly EffectiveRole[], catalog: Catalog): Check[] {
  return roles.flatMap((role) =>
    role.models.map((value) => ({
      ...checkTuple(value, catalog),
      subject: `${role.role}: ${value}`,
    })),
  );
}

export function providerIds(roles: readonly EffectiveRole[]): string[] {
  const ids = new Set<string>();
  for (const role of roles) {
    for (const value of role.models) {
      const choice = parseChoice(value);
      if (choice?.kind === "tuple") ids.add(choice.provider);
    }
  }
  return [...ids].sort();
}

export function failedChecks(checks: readonly Check[]): Check[] {
  return checks.filter((check) => !check.ok);
}

export function renderChecks(checks: readonly Check[]): string {
  return checks
    .map((check) => {
      const mark = check.ok ? "ok  " : "FAIL";
      return `${mark}  ${check.subject}  (${check.detail.replace(/\s+/g, " ").trim()})`;
    })
    .join("\n");
}

/** Where to read a catalog: the host of an environment, a host, or the server's own host. */
export type CatalogRouting = NonNullable<Parameters<BbPluginApi["sdk"]["providers"]["list"]>[0]>;

export async function loadCatalog(bb: BbPluginApi, route: string | CatalogRouting | undefined, ids: readonly string[]): Promise<Catalog> {
  const routing = typeof route === "string" ? { environmentId: route } : route ?? {};
  const providers = await bb.sdk.providers.list(routing);
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, ProviderCatalog] | null> => {
      const info = providers.find((provider) => provider.id === id);
      if (!info) return null;
      if (!info.available) return [id, { state: "unavailable" }];
      try {
        const result = await bb.sdk.providers.models({ ...routing, providerId: id });
        if (result.modelLoadError) return [id, { state: "error", detail: result.modelLoadError.detail ?? result.modelLoadError.code }];
        return [id, {
          state: "ok",
          models: result.models.map((entry) => ({ model: entry.model, levels: entry.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) })),
        }];
      } catch (error) {
        return [id, { state: "error", detail: error instanceof Error ? error.message : String(error) }];
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}
