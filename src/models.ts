export const INHERIT_PARENT = "inherit-parent";

export type ModelChoice =
  | { kind: "inherit-parent" }
  | { kind: "tuple"; provider: string; model: string; reasoningLevel: string };

type RoleSpec = {
  label: string;
  panel: boolean;
  defaults: readonly string[];
  /** An unconfigured role with a fallback uses that role's effective models. */
  fallback?: string;
};

const CODE = "codex/gpt-6.1-sol/xhigh";
const JUDGMENT = "claude-code/claude-opus-5-5/xhigh";

export const ROLES: readonly RoleSpec[] = [
  { label: "feature, refactoring", panel: false, defaults: [CODE] },
  { label: "bug-fix", panel: false, defaults: [CODE] },
  { label: "perf-issue", panel: false, defaults: [CODE] },
  { label: "hillclimb", panel: false, defaults: [CODE] },
  { label: "judgment and prose", panel: false, defaults: [JUDGMENT] },
  { label: "hardest tasks", panel: false, defaults: [JUDGMENT] },
  { label: "how explorer", panel: false, defaults: [CODE] },
  { label: "how explainer", panel: false, defaults: [JUDGMENT] },
  { label: "why investigators", panel: false, defaults: [CODE] },
  { label: "why synthesizer", panel: false, defaults: [JUDGMENT] },
  { label: "reflect tooling", panel: false, defaults: [CODE] },
  {
    label: "reflect judgment, divergent, synthesizer",
    panel: false,
    defaults: [JUDGMENT],
  },
  { label: "arena runners", panel: true, defaults: [JUDGMENT, CODE] },
  { label: "arena cross-judge pool", panel: true, defaults: [JUDGMENT, CODE] },
  { label: "swarm workers", panel: false, defaults: [CODE] },
  { label: "architect runners", panel: true, defaults: [JUDGMENT, CODE] },
  { label: "interrogate reviewers", panel: true, defaults: [JUDGMENT, CODE] },
  { label: "issue worker", panel: false, defaults: [], fallback: "feature, refactoring" },
];

const ROLE_BY_LABEL = new Map(ROLES.map((role) => [role.label, role]));

export type ModelConfig = {
  budget: string | null;
  roles: Map<string, readonly ModelChoice[]>;
};

export type ParseResult =
  | { ok: true; config: ModelConfig }
  | { ok: false; errors: string[] };

export function parseChoice(raw: string): ModelChoice | null {
  const value = raw.trim();
  if (value === INHERIT_PARENT) return { kind: "inherit-parent" };
  const parts = value.split("/");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    return null;
  }
  const [provider, model, reasoningLevel] = parts as [string, string, string];
  return { kind: "tuple", provider, model, reasoningLevel };
}

export function formatChoice(choice: ModelChoice): string {
  return choice.kind === "inherit-parent"
    ? INHERIT_PARENT
    : `${choice.provider}/${choice.model}/${choice.reasoningLevel}`;
}

export function parseModelConfig(text: string): ParseResult {
  const errors: string[] = [];
  const roles = new Map<string, readonly ModelChoice[]>();
  let budget: string | null = null;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const where = `line ${index + 1}`;
    if (line === "") return;
    if (line.startsWith("#")) {
      const match = /^#\s*budget\s*:(.*)$/.exec(line);
      if (!match) return;
      const value = match[1]!.trim();
      if (value === "") errors.push(`${where}: budget line has no value`);
      else if (budget !== null) errors.push(`${where}: budget appears twice`);
      else budget = value;
      return;
    }
    const colon = line.lastIndexOf(":");
    if (colon <= 0) {
      errors.push(`${where}: expected "<role>: <value>"`);
      return;
    }
    const label = line.slice(0, colon).trim();
    const role = ROLE_BY_LABEL.get(label);
    if (!role) {
      errors.push(`${where}: unknown role "${label}"`);
      return;
    }
    if (roles.has(label)) {
      errors.push(`${where}: role "${label}" appears twice`);
      return;
    }
    const rawValues = line.slice(colon + 1).split(",").map((v) => v.trim());
    if (!role.panel && rawValues.length !== 1) {
      errors.push(`${where}: role "${label}" takes one model, not a list`);
      return;
    }
    const choices: ModelChoice[] = [];
    for (const raw of rawValues) {
      const choice = parseChoice(raw);
      if (!choice) {
        errors.push(
          `${where}: "${raw}" is not "provider/model/level" or "${INHERIT_PARENT}"`,
        );
        return;
      }
      choices.push(choice);
    }
    roles.set(label, choices);
  });

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, config: { budget, roles } };
}

export type EffectiveRole = {
  role: string;
  panel: boolean;
  source: "configured" | "default";
  models: string[];
};

export function effectiveRoles(config: ModelConfig): EffectiveRole[] {
  const modelsOf = (role: RoleSpec): string[] => {
    const configured = config.roles.get(role.label);
    if (configured) return configured.map(formatChoice);
    const fallback = role.fallback ? ROLE_BY_LABEL.get(role.fallback) : undefined;
    return fallback ? modelsOf(fallback) : [...role.defaults];
  };
  return ROLES.map((role) => ({
    role: role.label,
    panel: role.panel,
    source: config.roles.has(role.label) ? "configured" : "default",
    models: modelsOf(role),
  }));
}

export function renderTable(config: ModelConfig): string {
  const rows = effectiveRoles(config);
  const width = Math.max(...rows.map((row) => row.role.length));
  const lines = rows.map(
    (row) =>
      `${row.role.padEnd(width)}  ${row.models.join(", ")}${row.source === "default" ? "  (default)" : ""}`,
  );
  const header = `budget: ${config.budget ?? "not set (skill defaults, xhigh)"}`;
  return [header, "", ...lines].join("\n");
}

export function findRole(label: string): string | null {
  const wanted = label.trim().toLowerCase();
  const role = ROLES.find((candidate) => candidate.label === wanted);
  return role ? role.label : null;
}
