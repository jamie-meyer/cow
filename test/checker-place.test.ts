// Where a checker starts, which failures point at another provider, and what
// a check run again keeps when it fails.

import assert from "node:assert/strict";
import { test } from "node:test";
import { providerCouldFix, startCouldFix, startFailedText, turnFailedText } from "../src/briefs/provider.ts";
import { briefWaitText, briefWaits, dateText, earlierDisputesText, failedRecheckText, foundText, reviewText } from "../src/briefs/review.ts";
import { briefView } from "../src/briefs/service.ts";
import { NOW } from "./fixtures.ts";
import { world } from "./memory.ts";

/** Seven claims the agent says it checked. */
const RAW = {
  summary: "Did it.",
  claims: Array.from({ length: 7 }, (_, n) => ({ text: `Claim ${n + 1} holds`, label: "checked", evidence: [{ description: "the note", text: `note ${n + 1}` }] })),
  judgementCalls: [],
  notDone: [],
};
const ids = RAW.claims.map((_, n) => `c${n + 1}`);
/** Two supported, five it cannot tell: the check from real use. */
const twoAndFive = JSON.stringify({
  claims: ids.map((id, n) => ({ id, shows: `About ${id}.`, verdict: n < 2 ? "supported" : "cannot-tell", needs: n < 2 ? null : "more" })),
});
const allSupported = JSON.stringify({ claims: ids.map((id) => ({ id, shows: `About ${id}.`, verdict: "supported", needs: null })) });
const HINT = /To check it on another provider/;

test("a checker starts in a personal workspace, whatever became of the thread's environment", async () => {
  const w = world();
  w.env.id = null;
  const record = await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  assert.deepEqual(w.started.map((start) => start.place), [{ type: "personal" }]);
  assert.equal(record.check?.runs[0]?.status, "running");
});

test("when bb will not make a personal workspace, the thread's own environment is used if it is there", async () => {
  const w = world();
  w.refuse.set("personal", "HTTP 400: personal workspaces are turned off");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  assert.deepEqual(w.started.map((start) => start.place), [{ type: "reuse", projectId: "proj_1", environmentId: "env_1" }]);
});

test("with nowhere to start, the failure says so and suggests no other provider", async () => {
  const gone = world();
  gone.refuse.set("personal", "HTTP 400: personal workspaces are turned off");
  gone.refuse.set("reuse", "HTTP 409: Environment unavailable.");
  const record = await gone.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  const [error] = briefView(record).review.failures;
  assert.equal(
    error,
    "the checker could not be started: the thread's environment is gone, and there is nowhere else to start a check (bb would not make a personal workspace for it: HTTP 400: personal workspaces are turned off; and in the thread's own environment: HTTP 409: Environment unavailable)",
  );
  assert.doesNotMatch(error ?? "", HINT);

  const none = world();
  none.env.id = null;
  none.refuse.set("personal", "bb has no personal project to make a personal workspace in");
  const alone = briefView(await none.briefs.submit({ caller: "child", threadId: null, raw: RAW })).review.failures[0] ?? "";
  assert.match(alone, /^the checker could not be started: the thread's environment is gone, and there is nowhere else to start a check \(bb would not make a personal workspace for it: bb has no personal project to make a personal workspace in\)$/);
});

test("a refusal another provider could get past is said with the way to it, and not tried elsewhere", async () => {
  const w = world();
  Object.assign(w.own, { provider: "nope", model: null });
  w.refuse.set("personal", 'HTTP 400: Unknown provider "nope".');
  const record = await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  assert.equal(w.started.length, 0);
  assert.equal(
    briefView(record).review.failures[0],
    'the checker could not be started on nope, its default model: HTTP 400: Unknown provider "nope". To check it on another provider: bb cow brief check child --provider <provider> --model <model>',
  );
});

test("the hint to try another provider comes only with failures another provider could fix", () => {
  for (const cause of ['HTTP 400: Unknown provider "x"', "no such model", "HTTP 401: Unauthorized", "Please sign in again", "billing problem", "rate limit reached", "usage limit", "HTTP 429"]) {
    assert.equal(startCouldFix(cause), true, cause);
  }
  for (const cause of ["HTTP 409: Environment unavailable.", "HTTP 500: internal error", "ECONNREFUSED", "the worktree is gone"]) {
    assert.equal(startCouldFix(cause), false, cause);
  }
  assert.doesNotMatch(startFailedText({ provider: "claude-code", model: "m", cause: "HTTP 409: Environment unavailable.", threadId: "t" }), HINT);
  assert.equal(startFailedText({ provider: "claude-code", model: "m", cause: "HTTP 409: Environment unavailable.", threadId: "t" }), "the checker could not be started on claude-code, model m: HTTP 409: Environment unavailable.");

  const fails = (category: string | null, httpStatus: number | null = null) => ({ category, detail: null, httpStatus });
  for (const failure of [fails("unauthorized"), fails("billing"), fails("rate-limit"), fails("budget-exceeded"), fails("overloaded"), fails("context-window-exceeded"), fails("bad-request", 404), fails(null, 401), fails("unknown", 429)]) {
    assert.equal(providerCouldFix(failure), true, JSON.stringify(failure));
    assert.match(turnFailedText({ provider: "p", model: null, failure, threadId: "t" }), HINT);
  }
  for (const failure of [null, fails("connection-failed"), fails("stream-disconnected"), fails("sandbox"), fails("policy"), fails("bad-request", 400), fails("something-new")]) {
    assert.equal(providerCouldFix(failure), false, JSON.stringify(failure));
    assert.doesNotMatch(turnFailedText({ provider: "p", model: null, failure, threadId: "t" }), HINT);
  }
});

test("a rerun that fails keeps the check that answered, and records the attempt beside it", async () => {
  const w = world();
  const submitted = await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.clock.now = NOW + 60_000;
  w.reply("chk_1", twoAndFive);
  const first = await w.briefs.get("child");
  const checkedAt = NOW + 60_000;
  await w.briefs.read("child", submitted.version);

  w.clock.now = NOW + 86_400_000;
  w.settings.model = "no-such-model";
  const running = await w.briefs.check({ caller: "main", threadId: "child" });
  assert.equal(briefView(running).review.state, "running");
  w.checkers.set("chk_2", { state: "error", reply: null, tools: [], failure: { category: "bad-request", detail: "no model", httpStatus: 404 } });
  w.clock.now = NOW + 86_460_000;
  await w.briefs.checkerStopped("chk_2");

  const kept = await w.briefs.get("child");
  // The earlier check is the current one again, verdicts and all, still read, still the version's first check.
  assert.deepEqual(kept.check, first.check);
  assert.deepEqual([kept.readAt !== null, kept.earlierChecks, kept.earlierDisputes, kept.replaced], [true, 0, 0, null]);
  assert.deepEqual(kept.failedRecheck, {
    startedAt: NOW + 86_400_000,
    finishedAt: NOW + 86_460_000,
    provider: null,
    model: "no-such-model",
    errors: [turnFailedText({ provider: null, model: "no-such-model", failure: { category: "bad-request", detail: "no model", httpStatus: 404 }, threadId: "child" })],
  });
  const view = briefView(kept);
  assert.equal(view.review.state, "checked");
  const said = failedRecheckText(kept.failedRecheck!, view.review.checkedAt);
  assert.equal(
    said,
    `checked again on ${dateText(NOW + 86_400_000)}: that attempt failed (${kept.failedRecheck!.errors[0]}); the check below is from ${dateText(checkedAt)}`,
  );
  const text = reviewText({ threadId: "child", version: 1, summary: "s", failedRecheck: kept.failedRecheck }, view.review);
  assert.match(text, /^Brief v1 from child\n {2}s\n\nChecked again on \d{4}-\d\d-\d\d \d\d:\d\d UTC: that attempt failed \(/);
  assert.match(text, /\nChecked by bb's default provider and model: 1 run\.\n/);
  assert.doesNotMatch(text, /NOTE:/);
});

test("a rerun that cannot start at all keeps the earlier check too", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", twoAndFive);
  const first = await w.briefs.get("child");
  w.refuse.set("personal", "HTTP 400: personal workspaces are turned off");
  w.refuse.set("reuse", "HTTP 409: Environment unavailable.");
  const after = await w.briefs.check({ caller: "main", threadId: "child" });
  assert.deepEqual(after.check, first.check);
  assert.match(after.failedRecheck?.errors[0] ?? "", /^the checker could not be started: the thread's environment is gone, and there is nowhere else to start a check/);
});

test("a rerun that answers replaces the earlier check, and takes the failed attempt with it", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", twoAndFive);
  await w.briefs.get("child");
  await w.briefs.check({ caller: "main", threadId: "child" });
  w.checkers.set("chk_2", { state: "error", reply: null, tools: [] });
  assert.notEqual((await w.briefs.get("child")).failedRecheck, null);
  await w.briefs.check({ caller: "main", threadId: "child" });
  w.reply("chk_3", allSupported);
  const replaced = await w.briefs.get("child");
  assert.deepEqual([briefView(replaced).mark.notEstablished, replaced.failedRecheck, replaced.replaced, replaced.earlierChecks], [0, null, null, 1]);
  // The earlier check had five it could not confirm and nobody had read it: today's note, in the words of what it counted.
  assert.deepEqual([replaced.earlierDisputes, replaced.earlierContradicted], [5, 0]);
  const mark = briefView(replaced).mark;
  assert.equal(briefWaits(mark), true);
  const text = reviewText({ threadId: "child", version: 1, summary: "s", earlierDisputes: replaced.earlierDisputes, earlierContradicted: replaced.earlierContradicted }, briefView(replaced).review);
  assert.match(text, /\n {2}NOTE: an earlier check of this version could not confirm 5 claims, and the check was run again before you had read them\. This check replaced that one\.\n/);
  assert.equal(briefWaitText(mark), "brief: an earlier check, run again unread, could not confirm 5 claims");
});

test("the note says what it counted: contradicted, could not confirm, or both", () => {
  assert.equal(foundText(5, 0), "could not confirm 5 claims");
  assert.equal(foundText(1, 1), "contradicted 1 claim");
  assert.equal(foundText(3, 1), "contradicted 1 claim and could not confirm 2 claims");
  // A record from before the split was kept.
  assert.equal(foundText(5, null), "contradicted or could not confirm 5 claims");
  assert.equal(earlierDisputesText(1, 0), "an earlier check of this version could not confirm 1 claim, and the check was run again before you had read it");
  assert.equal(earlierDisputesText(0, 0), "");
  assert.equal(dateText(Date.UTC(2026, 10, 19, 14, 3, 30)), "2026-11-19 14:03 UTC");
});
