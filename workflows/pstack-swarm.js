export const meta = {
  name: "pstack-swarm",
  description:
    "Run one swarm worker per slice with a shared brief, optionally verify each report, and return every report",
  phases: [
    { title: "Work", detail: "One worker per slice" },
    { title: "Verify", detail: "Optional independent check of each report" },
  ],
};

function selection(model) {
  if (model === undefined || model === null || model === "inherit-parent") {
    return {};
  }
  const parts = String(model).split("/");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw new Error(
      'model "' + model + '" is not "provider/model/level" or "inherit-parent"',
    );
  }
  return { provider: parts[0], model: parts[1], reasoningLevel: parts[2] };
}

const report = {
  type: "object",
  required: ["slice", "status", "summary", "evidence", "issues"],
  additionalProperties: false,
  properties: {
    slice: { type: "string" },
    status: { enum: ["PASS", "ISSUES", "BLOCKED"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
  },
};

const verdict = {
  type: "object",
  required: ["slice", "confirmed", "notes"],
  additionalProperties: false,
  properties: {
    slice: { type: "string" },
    confirmed: { type: "boolean" },
    notes: { type: "string" },
  },
};

if (!args || typeof args.brief !== "string" || args.brief.trim() === "") {
  throw new Error("args.brief must be a non-empty string");
}
if (!Array.isArray(args.slices) || args.slices.length === 0) {
  throw new Error("args.slices must be a non-empty array");
}
selection(args.model);
if (args.verify) selection(args.verify.model);

const slices = args.slices.map((slice) =>
  typeof slice === "string" ? { name: slice, brief: "" } : slice,
);
slices.forEach((slice, index) => {
  if (!slice || typeof slice.name !== "string" || slice.name === "") {
    throw new Error("args.slices[" + index + "] needs a name");
  }
});

const workerContract =
  "\n\nReturn your report through the result tool: `slice` is your slice name verbatim, " +
  "`status` is PASS, ISSUES, or BLOCKED, `summary` is two or three sentences, " +
  "`evidence` lists the commands you ran and what they printed (or file:line you read), " +
  "and `issues` lists each problem in one sentence (empty when PASS).";

const stages = [
  (slice) =>
    agent(
      args.brief +
        "\n\n# Your slice\n\n" +
        slice.name +
        (slice.brief ? "\n\n" + slice.brief : "") +
        workerContract,
      Object.assign(
        { label: "work:" + slice.name, phase: "Work", schema: report },
        selection(slice.model || args.model),
      ),
    ),
];
if (args.verify) {
  stages.push((workerReport, slice) =>
    agent(
      args.verify.prompt +
        "\n\n# Report to verify\n\n" +
        JSON.stringify(workerReport, null, 2) +
        "\n\nRe-run or re-read the evidence yourself. Do not trust the report. " +
        "Return `slice` verbatim, `confirmed` true only when the evidence holds, and `notes`.",
      Object.assign(
        { label: "verify:" + slice.name, phase: "Verify", schema: verdict },
        selection(args.verify.model),
      ),
    )
      .then((check) => Object.assign({}, workerReport, { verification: check }))
      .catch(() => Object.assign({}, workerReport, { verification: null })),
  );
}

const outcomes = await pipeline(slices, ...stages);

const reports = outcomes.filter(Boolean);
const missing = slices
  .filter((slice, index) => outcomes[index] === null)
  .map((slice) => slice.name);
if (missing.length > 0) log("dropped slices: " + missing.join(", "));

return { reports: reports, missing: missing };
