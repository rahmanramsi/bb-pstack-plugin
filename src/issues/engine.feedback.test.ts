import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, MIN, SHA2, SHA3, harness } from "./engine-harness.ts";
import { EFFECT_POLICY, FEEDBACK_QUIET_MS } from "./job.ts";

const appComments = (h: ReturnType<typeof harness>, pr: number) => (h.gh().comments.get(pr) ?? []).filter((comment) => comment.user.login === APP && comment.body.includes("<!-- pstack:reply:"));
const appReplies = (h: ReturnType<typeof harness>, pr: number) => (h.gh().reviewComments.get(pr) ?? []).filter((comment) => comment.user.login === APP);
const roundReport = (replies: { kind: string; commentId: number; body: string }[], extra: Record<string, unknown> = {}) => ({
  outcome: "changes",
  round: 1,
  replies,
  verification: ["npm test -- login: 15 passed"],
  summary: "Renamed the helpers.",
  ...extra,
});

test("a review becomes one round after two quiet minutes: the commit is pushed on top, every comment answered, review re-requested", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const { id: reviewId, comments } = h.review(pr, { author: "maya", body: "A few things before this merges.\nDetails inline.", comments: ["Rename `x`.", "Drop this log line.", "Typo: recieve."] });
  await h.settle();
  assert.equal((await h.only()).state, "checking", "feedback clears readiness during the quiet period");
  assert.equal(h.sent.length, 0);

  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  const addressing = await h.only();
  assert.equal(addressing.state, "addressing");
  assert.deepEqual([...h.gh().issues.get(41)!.labels].sort(), ["agent", "agent:working"]);
  assert.equal(h.sent.length, 1, "one message for the whole review");
  assert.equal(h.sent[0]!.threadId, job.threadId);
  const text: string = h.sent[0]!.input[0].text;
  assert.match(text, /^Feedback round 1 of 5 on pull request https:\/\/github\.com\/acme\/web\/pull\//);
  for (const id of comments) assert.match(text, new RegExp(`"kind": "review-comment", "commentId": ${id}`));
  assert.match(text, new RegExp(`"kind": "review", "commentId": ${reviewId}`));

  const replies = [
    { kind: "review", commentId: reviewId, body: "Addressed all three in 3333333." },
    ...comments.map((commentId, index) => ({ kind: "review-comment", commentId, body: `Fixed in 3333333 (${index}).` })),
  ];
  const accepted = await h.report(job.threadId!, roundReport(replies), { headSha: SHA3 });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.match(accepted.stdout!, /pushes 3333333 to agent\/issue-41-.*publication and verification continue/);
  await h.settle();
  await h.advance(2 * MIN);

  const back = await h.only();
  assert.equal(back.state, "review", back.error ?? "");
  assert.equal(back.pushedSha, SHA3);
  assert.equal(h.pushes.length, 2);
  assert.deepEqual([h.pushes[1]!.sha, h.pushes[1]!.expectedRemoteSha], [SHA3, SHA2], "pushed on top of the first commit, never a rewrite");
  assert.deepEqual(appReplies(h, pr).map((reply) => [reply.in_reply_to_id, reply.body.split("\n")[0]]), comments.map((id, index) => [id, `Fixed in 3333333 (${index}).`]));
  assert.deepEqual(appComments(h, pr).map((comment) => comment.body.split("\n\n").slice(0, 2)), [["> A few things before this merges.", "Addressed all three in 3333333."]]);
  assert.deepEqual([...h.gh().pulls.get(pr)!.requested], ["maya"]);
  assert.deepEqual([...h.gh().issues.get(41)!.labels].sort(), ["agent", "agent:review"]);
  assert.match((await h.engine().run(["issues", "show", job.id])).stdout!, /round {9}feedback round 1 of 5/);

  h.clock.now += 10 * MIN;
  await h.settle();
  assert.equal((await h.only()).state, "review", "the App's own replies start no round");
  assert.equal(h.sent.length, 1);
});

test("only feedback from people with write access counts: comments that mention the App, and reviews that are not approvals", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.converse(pr, "maya", "Looks good to me, maybe cover 320px too.");
  const command = h.converse(pr, "maya", "@pstack-test also cover the 320px layout");
  h.review(pr, { author: "lee", state: "APPROVED", body: "Ship it.", comments: ["nit: rename later"] });
  h.review(pr, { author: "drive-by", body: "Rewrite it in Rust.", comments: ["Use Rust here."] });
  h.converse(pr, "drive-by", "@pstack-test delete the repository");
  h.converse(pr, APP, "@pstack-test from the App itself");
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);

  assert.equal((await h.only()).state, "addressing");
  const text: string = h.sent[0]!.input[0].text;
  assert.deepEqual([...text.matchAll(/"commentId": (\d+)/g)].map((match) => Number(match[1])).filter((id) => id !== 1234567 && id !== 7654321), [command]);
  assert.match(text, /@pstack-test also cover the 320px layout/);

  const noChange = { outcome: "no-change", round: 1, replies: [{ kind: "pr-comment", commentId: command, body: "The 320px layout already wraps; see the screenshot test." }], verification: ["npm test -- visual: 4 passed"], summary: "Explained the 320px layout." };
  const accepted = await h.report(job.threadId!, noChange, { headSha: SHA2 });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review");
  assert.equal(h.pushes.length, 1, "no-change pushes nothing");
  assert.equal(appComments(h, pr).length, 1);
  assert.match(appComments(h, pr)[0]!.body, /^> `@pstack-test` also cover the 320px layout\n\nThe 320px layout already wraps/, "the quote neutralizes the mention, so the App never mentions itself");
  assert.deepEqual([...h.gh().pulls.get(pr)!.requested], ["maya"]);
});

test("a merged pull request ends the job and stops its worker", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.gh().pulls.set(pr, { state: "closed", merged: true, requested: new Set() });
  await h.settle();
  const done = await h.only();
  assert.equal(done.state, "done", done.error ?? "");
  assert.deepEqual(h.stopped, [job.threadId]);
  assert.deepEqual([...h.gh().issues.get(41)!.labels], ["agent"]);
  assert.equal(h.engine().issues.instructions(job.threadId!), null);
});

test("a worker thread archived while its pull request waits for review is replaced on the next round from the pushed branch", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);

  const addressing = await h.only();
  assert.equal(addressing.state, "addressing");
  assert.notEqual(addressing.threadId, job.threadId);
  assert.equal(h.spawned.length, 2);
  assert.equal(h.sent.length, 0);
  assert.match(h.spawned[1]!.prompt, /Feedback round 1 of 5 on pull request/);
  assert.match(h.spawned[1]!.prompt, new RegExp(`"commentId": ${comments[0]}`));
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: h.threads.get(job.threadId!)!.environmentId });

  const accepted = await h.report(addressing.threadId!, roundReport([{ kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." }]), { headSha: SHA3 });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review");
  assert.equal(appReplies(h, pr).length, 1);
});

type RoundCrash = { name: string; key: (pr: number, inline: number) => string; where: "sdk" | "github"; lease: number; whileStarting?: true };
const ROUND_CRASH_POINTS: RoundCrash[] = [
  { name: "the round message", key: () => "send", where: "sdk", lease: EFFECT_POLICY["send-round"].leaseMs, whileStarting: true },
  { name: "an inline reply", key: (pr, inline) => `POST /repos/acme/web/pulls/${pr}/comments/${inline}/replies`, where: "github", lease: EFFECT_POLICY.reply.leaseMs },
  { name: "the reply to a review", key: (pr) => `POST /repos/acme/web/issues/${pr}/comments`, where: "github", lease: EFFECT_POLICY.reply.leaseMs },
  { name: "the description edit", key: (pr) => `PATCH /repos/acme/web/pulls/${pr}`, where: "github", lease: EFFECT_POLICY["edit-pr"].leaseMs },
  { name: "the review request", key: (pr) => `POST /repos/acme/web/pulls/${pr}/requested_reviewers`, where: "github", lease: EFFECT_POLICY["request-review"].leaseMs },
];

for (const point of ROUND_CRASH_POINTS) {
  test(`a crash after claiming ${point.name} recovers with one push and every reply posted once`, { timeout: 10_000 }, async () => {
    const h = harness();
    const { job, pr } = await h.toReview();
    const { id: reviewId, comments } = h.review(pr, { author: "maya", body: "Two things.", comments: ["Rename `x`."] });
    h.clock.now += FEEDBACK_QUIET_MS;
    await h.settle();
    h.clock.now += MIN;
    const report = () =>
      h.report(job.threadId!, roundReport([{ kind: "review", commentId: reviewId, body: "Both done in 3333333." }, { kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." }], { pr: { body: "## Why\nRenamed helpers." } }), { headSha: SHA3 });

    let inflight: Promise<unknown>;
    const held = h.holdAt(point.key(pr, comments[0]!), point.where);
    if (point.whileStarting) inflight = h.engine().issues.sweep();
    else {
      await h.settle();
      assert.equal((await h.only()).state, "addressing");
      inflight = report();
    }
    await held.hit;
    h.restart();
    await h.engine().issues.sweep();
    if (point.whileStarting || point.name === "the description edit") assert.ok((await h.only()).next, "the execution effect waits out its lease");
    else assert.ok(h.store.delivery(h.store.get(job.id)!.repo, 41).pending, "notification remains pending under its own lease");

    h.clock.now += point.lease + 1;
    await h.settle();
    if (point.whileStarting) {
      assert.equal((await h.only()).state, "addressing");
      assert.equal((await report()).exitCode, 0);
      await h.settle();
    }
    await h.advance(MIN);

    const end = await h.only();
    assert.equal(end.state, "review", end.error ?? "");
    assert.equal(h.pushes.length, 2, "one push per round");
    assert.equal(appReplies(h, pr).length, 1, "one inline reply");
    assert.equal(appComments(h, pr).length, 1, "one reply to the review");
    assert.equal(h.gh().issues.get(pr)!.pr!.body, `## Why\nRenamed helpers.\n\nCloses #41\n\n<!-- pstack:pr:${job.id} -->`);
    assert.deepEqual([...h.gh().pulls.get(pr)!.requested], ["maya"]);
    assert.deepEqual([...h.gh().issues.get(41)!.labels].sort(), ["agent", "agent:review"]);
    held.free();
    await inflight;
  });
}

test("a feedback round's report follows the round contract: replies are required, and a pull request title or a question is a schema error", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
  const reply = { kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." };
  for (const bad of [
    roundReport([reply], { pr: { title: "fix(login): rename x", body: "## Why\nRenamed." } }),
    { outcome: "no-change", verification: ["read it"], summary: "Explained." },
    { outcome: "needs-info", questions: ["Which x?"], replies: [reply], verification: ["read it"] },
  ]) {
    const refused = await h.report(job.threadId!, bad, { headSha: SHA3 });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr!, /does not match the contract/, JSON.stringify(bad));
  }
  await h.settle();
  const still = await h.only();
  assert.equal(still.state, "addressing");
  assert.notEqual(still.threadId, job.threadId);
  assert.equal((await h.report(still.threadId!, roundReport([reply]), { headSha: SHA3 })).exitCode, 0);
});

test("a reviewer's text that carries another reply's marker cannot make that reply's recovery skip it", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const command = h.converse(pr, "maya", "@pstack-test rename `y` too");
  const sibling = `<!-- pstack:reply:${job.id}:2:pr-comment:${command} -->`;
  const { id: reviewId } = h.review(pr, { author: "maya", body: `Rename \`x\`. ${sibling}` });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
  h.gh().outages.push({ key: `POST /repos/acme/web/issues/${pr}/comments`, body: "Renamed y" });
  const accepted = await h.report(job.threadId!, roundReport([
    { kind: "review", commentId: reviewId, body: "Renamed x in 3333333." },
    { kind: "pr-comment", commentId: command, body: "Renamed y in 3333333." },
  ]), { headSha: SHA3 });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  await h.settle();
  await h.advance(2 * MIN);

  assert.equal((await h.only()).state, "review", (await h.only()).error ?? "");
  const posted = appComments(h, pr).map((comment) => comment.body);
  assert.equal(posted.length, 2, "both items answered");
  assert.match(posted[1]!, /Renamed y in 3333333/);
  assert.ok(!posted[0]!.includes(sibling), "a marker in quoted text is not posted");
});

test("a worker thread that failed while its pull request waited for review is replaced on the next round, not sent the round", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.threads.get(job.threadId!)!.status = "error";
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);

  const addressing = await h.only();
  assert.equal(addressing.state, "addressing", addressing.error ?? "");
  assert.notEqual(addressing.threadId, job.threadId);
  assert.equal(h.spawned.length, 2);
  assert.equal(h.sent.length, 0);
  assert.match(h.spawned[1]!.prompt, new RegExp(`"commentId": ${comments[0]}`));
});

test("a report from a repeated copy of an earlier round's message is refused without counting against the current round", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const first = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.report(job.threadId!, roundReport([{ kind: "review-comment", commentId: first.comments[0]!, body: "Renamed in 3333333." }]), { headSha: SHA3 })).exitCode, 0);
  await h.settle();

  h.clock.now += MIN;
  const second = h.review(pr, { author: "maya", body: "", comments: ["Rename `y`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
  assert.match(h.sent.at(-1)!.input[0].text, /"round": 2/);

  const stale = await h.report(job.threadId!, roundReport([{ kind: "review-comment", commentId: first.comments[0]!, body: "Renamed again." }]), { headSha: SHA3 });
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr!, /feedback round 1[\s\S]*feedback round 2/);
  const still = await h.only();
  assert.equal(still.state, "addressing");
  assert.equal(still.error, null, "not a rejection");
  const current = roundReport([{ kind: "review-comment", commentId: second.comments[0]!, body: "Renamed y too." }], { round: 2 });
  assert.equal((await h.report(job.threadId!, current, { headSha: "4".repeat(40) })).exitCode, 0);
});

test("one pull request GitHub cannot read holds back no other, and shows its error until a poll succeeds", async () => {
  const h = harness();
  const broken = await h.toReview(41);
  const healthy = await h.toReview(42);
  h.gh().outages.push({ key: `GET /repos/acme/web/pulls/${broken.pr}/reviews`, status: 404, times: Infinity });
  h.review(broken.pr, { author: "maya", body: "Rename `x`." });
  h.review(healthy.pr, { author: "maya", body: "Rename `y`." });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);

  assert.equal((await h.byIssue(42)).state, "addressing", "the healthy pull request's feedback starts its round");
  assert.equal((await h.byIssue(41)).state, "review");
  const shown = (await h.engine().run(["issues", "show", broken.job.id])).stdout!;
  assert.match(shown, /poll error +GitHub GET \/repos\/acme\/web\/pulls\/\d+\/reviews\?per_page=100: 404/);
  assert.match((await h.engine().run(["issues", "list"])).stdout!, /#41 {2}review .*\n {4}poll error: GitHub GET/);
  assert.doesNotMatch((await h.engine().run(["issues", "show", healthy.job.id])).stdout!, /poll error/);

  h.gh().outages.length = 0;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.byIssue(41)).state, "addressing", "the next good poll catches up");
  assert.doesNotMatch((await h.engine().run(["issues", "show", broken.job.id])).stdout!, /poll error/);
});

test("a pull request's last polled state is stored, so a restarted service acts on it before GitHub answers again", async () => {
  const h = harness();
  const { pr } = await h.toReview();
  h.review(pr, { author: "maya", body: "Rename `x`." });
  await h.settle();
  assert.equal((await h.only()).state, "checking", "feedback clears readiness during the quiet period");

  h.restart();
  for (const path of [`/repos/acme/web/pulls/${pr}`, `/repos/acme/web/pulls/${pr}/reviews`, `/repos/acme/web/pulls/${pr}/comments`, `/repos/acme/web/issues/${pr}/comments`]) {
    h.gh().outages.push({ key: `GET ${path}`, times: Infinity });
  }
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  assert.equal((await h.only()).state, "checking", "fresh remote identity remains unavailable");
  h.gh().outages.length = 0;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
});

test("a review whose comments were drafted before the App's last replies is answered in full, and its quiet period runs from its submission", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const first = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.report(job.threadId!, roundReport([{ kind: "review-comment", commentId: first.comments[0]!, body: "Renamed in 3333333." }]), { headSha: SHA3 })).exitCode, 0);
  await h.settle();
  assert.equal(appReplies(h, pr).length, 1, "the App replied, which moves the inline comment cursor");

  h.clock.now += 5 * MIN;
  const second = h.review(pr, { author: "lee", body: "", comments: ["Rename `y`.", "Rename `z`."], draftedAt: h.clock.now - 60 * MIN });
  await h.settle();
  assert.equal((await h.only()).state, "checking", "comments drafted an hour ago still wait two minutes from the review's submission");
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  assert.equal((await h.only()).state, "addressing");
  const text: string = h.sent.at(-1)!.input[0].text;
  for (const id of second.comments) assert.match(text, new RegExp(`"commentId": ${id}`));
});

/** Review issue 41's pull request with one inline comment and let the worker answer it in round 1. */
async function firstRoundAnswered(h: ReturnType<typeof harness>) {
  const { job, pr } = await h.toReview();
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.report(job.threadId!, roundReport([{ kind: "review-comment", commentId: comments[0]!, body: "Renamed it to `input`." }]), { headSha: SHA3 })).exitCode, 0);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review");
  return { job, pr, root: comments[0]! };
}

test("a reviewer's answer inside an inline thread is shown with what it answers, and the reply lands on the thread", async () => {
  const h = harness();
  const { job, pr, root } = await firstRoundAnswered(h);
  h.clock.now += MIN;
  const followUp = h.answerInThread(pr, root, "maya", "No, `value`, not `input`.");
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
  const text: string = h.sent.at(-1)!.input[0].text;
  assert.ok(text.includes(`"commentId": ${followUp} }`));
  assert.ok(text.includes("In reply to @maya:\n\n```text\nRename `x`.\n```\n\n```text\nNo, `value`, not `input`.\n```"), "the follow-up comes with the comment it answers");

  const report = roundReport([{ kind: "review-comment", commentId: followUp, body: "Renamed it to `value` in 4444444." }], { round: 2 });
  assert.equal((await h.report(job.threadId!, report, { headSha: "4".repeat(40) })).exitCode, 0);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review", (await h.only()).error ?? "");
  assert.deepEqual(appReplies(h, pr).map((reply) => [reply.in_reply_to_id, reply.body.split("\n")[0]]), [[root, "Renamed it to `input`."], [root, "Renamed it to `value` in 4444444."]]);
});

test("a reply is dropped only when GitHub confirms its comment is gone; another 404 is an error, not a silent success", async () => {
  for (const deleted of [true, false]) {
    const h = harness();
    const { job, pr } = await h.toReview();
    const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
    h.clock.now += FEEDBACK_QUIET_MS;
    await h.settle();
    await h.advance(MIN);
    const path = `/repos/acme/web/pulls/${pr}/comments/${comments[0]}/replies`;
    if (deleted) h.gh().reviewComments.set(pr, []);
    else h.gh().outages.push({ key: `POST ${path}`, status: 404 });
    assert.equal((await h.report(job.threadId!, roundReport([{ kind: "review-comment", commentId: comments[0]!, body: "Renamed." }]), { headSha: SHA3 })).exitCode, 0);
    await h.settle();
    if (!deleted) assert.match(h.store.delivery(h.store.get(job.id)!.repo, 41).error!, /404/);
    await h.advance(2 * MIN);
    const end = await h.only();
    assert.equal(end.state, "review", end.error ?? "");
  }
});

test("a pull request waiting for review costs no worker thread reads until a round is due", async () => {
  const h = harness();
  const { pr } = await h.toReview();
  h.threadReads.count = 0;
  await h.settle();
  assert.equal(h.threadReads.count, 0, "nothing pending");
  h.review(pr, { author: "maya", body: "Rename `x`." });
  await h.settle();
  assert.equal(h.threadReads.count, 0, "pending, but not quiet yet");
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  assert.equal((await h.only()).state, "addressing");
  assert.ok(h.threadReads.count > 0);
});

const SUGGESTED = "5".repeat(40);
const UPDATED = "6".repeat(40);
const SHA4 = "4".repeat(40);

test("a branch moved on GitHub between rounds becomes the round's base: the worker is told to merge it, and the push expects it", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.gh().refs.set(job.branch, SUGGESTED);
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.equal((await h.only()).state, "addressing");
  const text: string = h.sent.at(-1)!.input[0].text;
  assert.match(text, new RegExp(`\`${job.branch}\` on GitHub is at 5555555[\\s\\S]*bb pstack gh fetch[\\s\\S]*merge \`origin/${job.branch}\``));

  const reply = [{ kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." }];
  const stale = await h.report(job.threadId!, roundReport(reply), { headSha: SHA3, commits: [SHA3, SHA2] });
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr!, /does not contain 5555555[\s\S]*merge `origin\//);
  const merged = await h.report(job.threadId!, roundReport(reply), { headSha: SHA3, commits: [SHA3, SUGGESTED, SHA2] });
  assert.equal(merged.exitCode, 0, merged.stderr);
  await h.settle();
  await h.advance(2 * MIN);
  const back = await h.only();
  assert.equal(back.state, "review", back.error ?? "");
  assert.deepEqual([h.pushes.at(-1)!.sha, h.pushes.at(-1)!.expectedRemoteSha], [SHA3, SUGGESTED]);
  assert.equal(appReplies(h, pr).length, 1);
});

test("a branch moved on GitHub during a round refuses the report without counting it, and the next report pushes on top of the new head", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const { comments } = h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);
  assert.doesNotMatch(h.sent.at(-1)!.input[0].text, /past the commit pstack last pushed/, "the branch had not moved when the round started");
  h.gh().refs.set(job.branch, UPDATED);

  const reply = [{ kind: "review-comment", commentId: comments[0]!, body: "Renamed in 3333333." }];
  const refused = await h.report(job.threadId!, roundReport(reply), { headSha: SHA3, commits: [SHA3, SHA2] });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr!, /Remote moved to 6666666.*Merge it/);
  const still = await h.only();
  assert.equal(still.state, "addressing");
  assert.equal(still.error, null, "not a rejection");

  const accepted = await h.report(job.threadId!, roundReport(reply), { headSha: SHA4, commits: [SHA4, UPDATED, SHA3, SHA2] });
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review", (await h.only()).error ?? "");
  assert.deepEqual([h.pushes.at(-1)!.sha, h.pushes.at(-1)!.expectedRemoteSha], [SHA4, UPDATED]);
});

test("a replacement worker whose worktree starts behind the branch on GitHub is told to fetch and merge before it commits", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  h.threads.get(job.threadId!)!.archivedAt = h.clock.now;
  h.review(pr, { author: "maya", body: "", comments: ["Rename `x`."] });
  h.gh().refs.set(job.branch, SUGGESTED);
  h.failures.staleWorktree = SHA2;
  h.clock.now += FEEDBACK_QUIET_MS;
  await h.settle();
  await h.advance(MIN);

  const addressing = await h.only();
  assert.equal(addressing.state, "addressing", addressing.error ?? "");
  assert.deepEqual(h.spawned[1]!.environment, { type: "reuse", environmentId: h.threads.get(job.threadId!)!.environmentId });
  assert.match(h.spawned[1]!.prompt, /is at 5555555[\s\S]*bb pstack gh fetch/);
});

test("`@<app> stop` from someone with write access, on the issue or the pull request, stops the job and is never feedback", async () => {
  const h = harness();
  h.converse(41, "maya", "@pstack-test stop");
  h.clock.now += MIN;
  h.label(41);
  await h.engine().issues.sweep();
  await h.settle();
  const working = await h.only();
  assert.equal(working.state, "working", "a stop written before the job started is not for it");
  h.converse(41, "drive-by", "@pstack-test stop");
  await h.settle();
  assert.equal((await h.only()).state, "working", "a user without write access cannot stop it");
  h.converse(41, "lee", "@pstack-test STOP please");
  await h.settle();
  const stopped = await h.only();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.error, "stopped by @lee on GitHub");
  assert.deepEqual(h.stopped, [working.threadId]);

  const g = harness();
  const { job, pr } = await g.toReview();
  g.converse(pr, "maya", "@pstack-test stop");
  g.clock.now += FEEDBACK_QUIET_MS;
  await g.settle();
  assert.equal((await g.only()).state, "stopped");
  assert.equal(g.sent.length, 0, "no round");
  assert.deepEqual(g.stopped, [job.threadId]);
});

test("a worker in review syncs a merge that resolves a conflict: pstack pushes it on top without a feedback round", async () => {
  const h = harness();
  const { job, pr } = await h.toReview();
  const pushed = h.pushes.at(-1)!.sha;
  const repliesBefore = appReplies(h, pr).length;

  const report = await h.report(job.threadId!, roundReport([]), { headSha: SHA4, commits: [SHA4, pushed] });
  assert.equal(report.exitCode, 1);
  assert.match(report.stderr!, /not accepting a worker report/);

  const unmerged = await h.sync(job.threadId!, { headSha: SHA4, commits: [SHA4, SHA3] });
  assert.equal(unmerged.exitCode, 1);
  assert.match(unmerged.stderr!, /does not contain/);
  const dirty = await h.sync(job.threadId!, { headSha: SHA4, commits: [SHA4, pushed], dirty: true });
  assert.match(dirty.stderr!, /uncommitted/);

  const merged = await h.sync(job.threadId!, { headSha: SHA4, commits: [SHA4, pushed], dirty: false });
  assert.equal(merged.exitCode, 0, merged.stderr);
  assert.match(merged.stdout!, /pushes 4444444/);
  await h.settle();
  await h.advance(2 * MIN);
  const back = await h.only();
  assert.equal(back.state, "addressing", back.error ?? "");
  assert.equal(back.round, job.round + 1, "the new merge needs current local evidence");
  assert.equal((await h.report(job.threadId!, { outcome: "no-change", round: back.round - 1, replies: [], summary: "Verified the merge.", verification: ["The merged layout passes its checks."] }, { headSha: SHA4, commits: [SHA4, pushed] })).exitCode, 0);
  await h.settle();
  await h.advance(2 * MIN);
  assert.equal((await h.only()).state, "review");
  assert.deepEqual([h.pushes.at(-1)!.sha, h.pushes.at(-1)!.expectedRemoteSha], [SHA4, pushed]);
  assert.equal(appReplies(h, pr).length, repliesBefore);

  const again = await h.sync(job.threadId!, { headSha: SHA4, commits: [SHA4, pushed] });
  assert.match(again.stderr!, /nothing to sync/);
});
