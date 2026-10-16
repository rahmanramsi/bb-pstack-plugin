export const meta = {
  name: "pstack-panel",
  description:
    "Run one prompt across a diverse-model panel, then optionally hand every answer to a judge or synthesizer",
  phases: [
    { title: "Panel", detail: "One worker per seat, each on its own model" },
    { title: "Judge", detail: "Optional cross-judge or synthesizer over every answer" },
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

function options(label, phase, model, schema) {
  const opts = Object.assign({ label: label, phase: phase }, selection(model));
  if (schema) opts.schema = schema;
  return opts;
}

if (!args || !Array.isArray(args.seats) || args.seats.length === 0) {
  throw new Error("args.seats must be a non-empty array");
}
args.seats.forEach((seat, index) => {
  if (!seat || typeof seat !== "object") {
    throw new Error("args.seats[" + index + "] must be an object");
  }
  if (typeof (seat.prompt || args.prompt) !== "string") {
    throw new Error(
      "args.seats[" + index + "] needs a prompt (seat.prompt or args.prompt)",
    );
  }
  selection(seat.model);
});
if (args.judge) selection(args.judge.model);

const labels = args.seats.map(
  (seat, index) => seat.label || "Seat " + String.fromCharCode(65 + index),
);

phase("Panel");
const answers = await parallel(
  args.seats.map((seat, index) => () =>
    agent(
      seat.prompt || args.prompt,
      options(labels[index], "Panel", seat.model, args.schema),
    ),
  ),
);

const results = [];
const dropped = [];
answers.forEach((answer, index) => {
  const seat = args.seats[index];
  const model = seat.model || "inherit-parent";
  if (answer === null) {
    dropped.push({ label: labels[index], model: model });
  } else {
    results.push({ label: labels[index], model: model, output: answer });
  }
});
if (dropped.length > 0) {
  log(
    "dropped seats: " +
      dropped.map((seat) => seat.label + " (" + seat.model + ")").join(", "),
  );
}

let judge = null;
if (args.judge && results.length > 0) {
  phase("Judge");
  const exhibits = results
    .map(
      (result) =>
        "## " +
        result.label +
        " (" +
        result.model +
        ")\n\n" +
        (typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output, null, 2)),
    )
    .join("\n\n");
  judge = await agent(
    args.judge.prompt + "\n\n# Panel answers\n\n" + exhibits,
    options(
      args.judge.label || "Judge",
      "Judge",
      args.judge.model,
      args.judge.schema,
    ),
  );
}

return { results: results, dropped: dropped, judge: judge };
