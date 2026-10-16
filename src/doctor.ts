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
