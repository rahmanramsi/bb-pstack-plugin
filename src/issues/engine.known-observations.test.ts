import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./engine-harness.ts";

test("known pending feedback clears readiness before the next scheduled PR observation", async () => {
  const h = harness();
  const { pr } = await h.toReview();
  h.review(pr, { body: "Correct the footer spacing." });
  await h.settle();
  assert.equal((await h.only()).outcome, null);
  assert.equal((await h.only()).state, "checking");
  assert.equal(h.gh().issues.get(pr)!.pr!.draft, true);
  assert.equal(h.sent.length, 0);
});
