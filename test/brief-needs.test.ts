// A finished job shows only its exceptions: a check that could not run
// waits like a dispute, and a brief that waits opens on "Needs you".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief } from "../src/briefs/brief.ts";
import { turnFailedText } from "../src/briefs/provider.ts";
import {
  type Check,
  type ClaimVerdict,
  type Shown,
  briefNeedsYou,
  briefWaitText,
  briefWaits,
  failureReason,
  failureReasonOf,
  markOf,
  markText,
  needsYou,
  restText,
  review,
  reviewText,
} from "../src/briefs/review.ts";
import { briefView } from "../src/briefs/service.ts";
import { sheetItems } from "../src/briefs/sheet.ts";
import { NOW } from "./fixtures.ts";
import { world } from "./memory.ts";

const RAW = {
  summary: "Added a rate limit to the login endpoint.",
  claims: [
    { text: "The limit is 5 a minute", label: "checked", evidence: [{ description: "the rule", text: "rate = 5/min" }] },
    { text: "No other rule changed", label: "inferred", evidence: [{ description: "the diff", text: "+ rate = 5/min" }] },
  ],
  notDone: ["No load test was run"],
};
const answerAll = (verdict: string) =>
  JSON.stringify({ claims: ["c1", "c2"].map((id) => ({ id, shows: `About ${id}.`, verdict, needs: verdict === "cannot-tell" ? "a test run" : null })) });
const NOT_SIGNED_IN = { category: "unauthorized", detail: "Please sign in again.", httpStatus: null };

// ---- the waiting rule, through the service --------------------------------------

test("a check that could not run, with nothing earlier standing, waits on you, saying why, until you open it", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.checkers.set("chk_1", { state: "error", reply: null, tools: [], failure: NOT_SIGNED_IN });
  const view = briefView(await w.briefs.get("child"));
  assert.equal(view.mark.state, "failed");
  assert.equal(view.mark.failure, "the provider is not signed in");
  assert.ok(briefWaits(view.mark));
  assert.equal(briefWaitText(view.mark), "brief: the check could not run (the provider is not signed in)");
  assert.equal(markText(view.mark), "brief: the check could not run (the provider is not signed in)");
  // Opened, it stops waiting.
  await w.briefs.read("child", 1);
  assert.ok(!briefWaits(briefView(await w.briefs.get("child")).mark));
});

test("opened, then checked again and failed again: it waits again", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.checkers.set("chk_1", { state: "error", reply: null, tools: [] });
  await w.briefs.read("child", 1);
  assert.ok(!briefWaits(briefView(await w.briefs.get("child")).mark));
  await w.briefs.check({ caller: null, threadId: "child" });
  // While the new check runs, nothing new waits.
  assert.ok(!briefWaits(briefView(await w.briefs.get("child")).mark));
  w.checkers.set("chk_2", { state: "error", reply: null, tools: [], failure: NOT_SIGNED_IN });
  const again = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([again.state, again.read, briefWaits(again)], ["failed", false, true]);
});

test("a check run again that fails, over an earlier check of the same version that stands, does not wait", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", answerAll("supported"));
  const clean = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([clean.state, briefWaits(clean)], ["checked", false]);
  await w.briefs.check({ caller: null, threadId: "child" });
  w.checkers.set("chk_2", { state: "error", reply: null, tools: [], failure: NOT_SIGNED_IN });
  const view = briefView(await w.briefs.get("child"));
  assert.equal(view.record.failedRecheck?.errors.length, 1);
  assert.deepEqual([view.mark.state, view.mark.failure, briefWaits(view.mark)], ["checked", undefined, false]);
  assert.deepEqual(needsYou(view.review, view.mark, "child"), []);
});

test("a check still running does not wait, and a brief never checked because checking on submit is off waits on nothing new", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  const running = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([running.state, briefWaits(running)], ["running", false]);

  const off = world();
  off.settings.onSubmit = false;
  const view = briefView(await off.briefs.submit({ caller: "child", threadId: null, raw: RAW }));
  assert.deepEqual([view.mark.state, briefWaits(view.mark), briefNeedsYou(view.mark)], ["unchecked", false, false]);
  assert.deepEqual(off.started, []);
});

test("a new version whose check answers clean stops the wait", async () => {
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.checkers.set("chk_1", { state: "error", reply: null, tools: [] });
  assert.ok(briefWaits(briefView(await w.briefs.get("child")).mark));
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_2", answerAll("supported"));
  const latest = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([latest.version, latest.state, briefWaits(latest)], [2, "checked", false]);
});

test("a failure is said in a few words: the cause, not where it ran or the way out", () => {
  const turn = turnFailedText({ provider: "claude-code", model: "m", failure: NOT_SIGNED_IN, threadId: "child" });
  assert.match(turn, /To check it on another provider/);
  assert.equal(failureReasonOf(turn), "the provider is not signed in");
  assert.equal(failureReasonOf(turnFailedText({ provider: null, model: null, failure: null, threadId: "child" })), "the checker's turn failed");
  assert.equal(failureReasonOf("the checker could not be started on nope, its default model: no such provider: nope. To check it on another provider: bb cow brief check child --provider <provider> --model <model>"), "the checker could not be started: no such provider: nope");
  assert.equal(
    failureReasonOf('the checker could not be started on x, model m: HTTP 400: Unknown provider "x". Registered provider ids: codex, claude-code, pi. To check it on another provider: bb cow brief check child --provider <provider> --model <model>'),
    'the checker could not be started: HTTP 400: Unknown provider "x"',
  );
  assert.equal(failureReasonOf("the checker could not be started: bb would not make it a personal workspace (on bb's primary machine: x). A checker runs only…"), "bb would not make the checker a workspace of its own");
  assert.equal(failureReasonOf("the checker used a tool: Read. It was told to use none, so its answer is discarded. What it did is in its thread: bb thread log chk"), "the checker used a tool: Read");
  assert.equal(failureReasonOf("the checker's answer is not valid JSON; and it could not be run again: bb is away"), "the checker gave no usable answer");
  assert.equal(failureReasonOf("the checker did not answer in time"), "the checker did not answer in time");
  assert.equal(failureReason(["the checker did not answer in time", "the checker did not answer in time", "the checker gave no answer"]), "the checker did not answer in time; the checker gave no usable answer");
});

// ---- "Needs you" ----------------------------------------------------------------------

const BRIEF: Brief = {
  summary: "Did the job.",
  claims: [
    { id: "c1", text: "Supported one", label: "checked", evidence: [] },
    { id: "c2", text: "Not established one", label: "checked", evidence: [] },
    { id: "c3", text: "Contradicted one", label: "inferred", evidence: [] },
    { id: "c4", text: "Supported two", label: "checked", evidence: [] },
  ],
  judgementCalls: [
    { text: "Keep the old endpoint?", askId: "ask_open" },
    { text: "Rename the flag?", askId: null },
  ],
  notDone: ["no load test", "no docs"],
};
const SHOWN: Shown = {
  task: { state: "read", chars: 100, clipped: false, hasSection: true, checks: ["The limit is 5.", "A test covers it.", "The README says so."], checksDropped: 0 },
  diff: { state: "none", why: "no checkout" },
  flagged: ["test/login.test.ts", "tsconfig.json"],
  at: NOW,
};
const verdict = (id: string, v: ClaimVerdict["verdict"], needs: string | null = null): ClaimVerdict => ({ id, shows: `About ${id}.`, verdict: v, needs });
const done = (claims: ClaimVerdict[], tasks: ClaimVerdict[] = [], unaccounted: string[] = []): Check => ({
  model: "m",
  startedAt: NOW,
  runs: [{ status: "done", verdicts: claims, tasks, unaccounted, threadId: "chk", startedAt: NOW, finishedAt: NOW }],
});
const DISPUTED = done(
  [verdict("c1", "supported"), verdict("c2", "cannot-tell", "the test output"), verdict("c3", "not-supported"), verdict("c4", "supported")],
  [verdict("t1", "supported"), verdict("t2", "cannot-tell", "the test run"), verdict("t3", "not-supported")],
  ["notes.txt"],
);
const FAILED: Check = {
  model: "m",
  startedAt: NOW,
  runs: [{ status: "failed", error: turnFailedText({ provider: "claude-code", model: "m", failure: NOT_SIGNED_IN, threadId: "child" }), threadId: "chk", startedAt: NOW, finishedAt: NOW }],
};
const open = (askId: string) => askId === "ask_open";

test("Needs you lists each item worst first: the flag, contradicted claims, task checks not shown, what is not established, then judgement calls", () => {
  const seen = review(BRIEF, DISPUTED, SHOWN);
  const needs = needsYou(seen, markOf(1, seen), "child", open);
  assert.deepEqual(
    needs.map((need) => [need.kind, need.item]),
    [
      ["flag", "flag"],
      ["contradicted", "claim:c3"],
      ["not-shown", "task:t3"],
      ["not-established", "claim:c2"],
      ["cannot-tell", "task:t2"],
      ["call", "call:0"],
      ["call", "call:1"],
    ],
  );
  const text = needs.map((need) => need.text);
  assert.equal(text[0], "changed what decides whether its checks pass: 2 files (test/login.test.ts, tsconfig.json)");
  assert.equal(text[1], "contradicted: “Contradicted one”");
  assert.equal(text[2], "task check not shown: “The README says so.”");
  assert.equal(text[3], "not established: “Not established one”; would settle it: the test output");
  assert.equal(text[4], "task check not established: “A test covers it.”; would settle it: the test run");
  assert.equal(text[5], "judgement call, open as an ask: “Keep the old endpoint?”");
  assert.equal(text[6], "judgement call, not raised as an ask: “Rename the flag?”");
  // Each names what acts on it: the ask is answered with a, the rest by opening the thread to reply.
  assert.deepEqual(needs[5]?.key, { keys: "a", does: "answers it" });
  assert.equal(needs[5]?.command, null);
  assert.deepEqual(needs[1]?.key, { keys: "q ⏎", does: "opens the thread to reply" });
  assert.equal(needs[1]?.command, "bb thread tell child");
  // An ask no longer open says so and offers nothing.
  const closed = needsYou(seen, markOf(1, seen), "child", () => false)[5];
  assert.deepEqual([closed?.text, closed?.key, closed?.command], ["judgement call, its ask is answered or withdrawn: “Keep the old endpoint?”", null, null]);
});

test("a check that could not run comes first, with why and the way out", () => {
  const seen = review(BRIEF, FAILED, SHOWN);
  const needs = needsYou(seen, markOf(1, seen), "child", open);
  assert.deepEqual(needs.map((need) => need.kind), ["failed", "flag", "call", "call"]);
  assert.equal(
    needs[0]?.text,
    "the check could not run (the provider is not signed in): nothing in the brief has been looked at but by its author. Check it again, or on another provider: bb cow brief check child --provider <provider> --model <model>",
  );
  assert.deepEqual(needs[0]?.key, { keys: "c", does: "checks it again" });
  assert.equal(needs[0]?.command, "bb cow brief check child");
  // A failure another provider would not get past does not suggest one.
  const timeout = review(BRIEF, { ...FAILED, runs: [{ ...FAILED.runs[0]!, status: "failed", error: "the checker did not answer in time" }] }, null);
  assert.equal(needsYou(timeout, markOf(1, timeout), "child")[0]?.text, "the check could not run (the checker did not answer in time): nothing in the brief has been looked at but by its author. Check it again");
});

test("an earlier check run again unread is a line of its own", () => {
  const clean = review({ ...BRIEF, judgementCalls: [] }, done(["c1", "c2", "c3", "c4"].map((id) => verdict(id, "supported"))), null);
  const mark = markOf(1, clean, 0, false, 2, true, 1, 0);
  assert.ok(briefWaits(mark));
  assert.deepEqual(needsYou(clean, mark, "child").map((need) => [need.kind, need.text]), [["earlier", "an earlier check of this version contradicted 1 claim and could not confirm 1 claim, and the check was run again before you had read them"]]);
});

test("a brief that does not wait has no block, and its sheet and text are as they were", () => {
  const clean = review({ ...BRIEF, judgementCalls: [] }, done(["c1", "c2", "c3", "c4"].map((id) => verdict(id, "supported"))), null);
  const mark = markOf(1, clean);
  assert.ok(!briefNeedsYou(mark));
  assert.deepEqual(needsYou(clean, mark, "child"), []);
  const head = { threadId: "child", version: 1, summary: "Did the job." };
  assert.equal(reviewText(head, clean, mark), reviewText(head, clean));
  assert.doesNotMatch(reviewText(head, clean, mark), /Needs you/);
  assert.ok(!sheetItems(clean, [], null).some((item) => item.kind === "rest"));
  // Read, a brief that has something keeps its block: it is what the brief is about, not whether it waits.
  const seen = review(BRIEF, DISPUTED, SHOWN);
  assert.ok(needsYou(seen, markOf(1, seen, 0, true), "child").length > 0);
});

test("the rest is counted in one line", () => {
  assert.equal(restText(review(BRIEF, DISPUTED, SHOWN)), "the rest: 2 claims supported, 1 task check shown, 1 changed file no claim accounts for, 2 not done; what the checker was shown and the summary");
  assert.equal(restText(review(BRIEF, FAILED, SHOWN)), "the rest: 4 claims with no verdict, 3 task checks with no verdict, 2 not done; what the checker was shown and the summary");
  const seven = { ...BRIEF, claims: Array.from({ length: 7 }, (_, i) => ({ id: `c${i + 1}`, text: `claim ${i + 1}`, label: "checked" as const, evidence: [] })) };
  assert.equal(restText(review(seven, done(seven.claims.map((claim) => verdict(claim.id, "supported"))), null)), "the rest: 7 claims supported, 2 not done; what the checker was shown and the summary");
});

test("the sheet's stops for a brief that waits: what needs you, then one stop for the rest, which unfolds", () => {
  const seen = review(BRIEF, DISPUTED, SHOWN);
  const folded = sheetItems(seen, [], { open: false });
  assert.deepEqual(folded.map((item) => item.id), ["flag", "claim:c3", "claim:c2", "task:t3", "task:t2", "call:0", "call:1", "rest"]);
  const rest = folded.at(-1);
  assert.deepEqual(rest, { kind: "rest", id: "rest", text: restText(seen), open: false });
  const unfolded = sheetItems(seen, [], { open: true });
  assert.deepEqual(unfolded.map((item) => item.id), ["flag", "claim:c3", "claim:c2", "task:t3", "task:t2", "call:0", "call:1", "rest", "claim:c1", "claim:c4", "task:t1"]);
  // A failed check has no disputes to show: the judgement calls, then the rest.
  assert.deepEqual(sheetItems(review(BRIEF, FAILED, null), [], { open: false }).map((item) => item.id), ["call:0", "call:1", "rest"]);
});

test("brief show's text: the block first, then the detail, then the rest under a heading that counts it", () => {
  const seen = review(BRIEF, DISPUTED, SHOWN);
  const text = reviewText({ threadId: "child", version: 2, summary: "Did the job." }, seen, markOf(2, seen), open);
  const lines = text.split("\n");
  assert.equal(lines[0], "Brief v2 from child");
  // The summary is part of the rest.
  assert.notEqual(lines[1], "  Did the job.");
  const at = (pattern: string) => lines.findIndex((line) => line.startsWith(pattern));
  assert.ok(at("Needs you (7)") > 0);
  assert.equal(lines[at("Needs you (7)") + 1], "  - changed what decides whether its checks pass: 2 files (test/login.test.ts, tsconfig.json)  → bb thread tell child");
  assert.equal(lines[at("Needs you (7)") + 6], "  - judgement call, open as an ask: “Keep the old endpoint?”");
  assert.ok(at("Needs you") < at("Disputes (5)") && at("Disputes (5)") < at("Judgement calls for you (2)"));
  assert.ok(at("Judgement calls for you") < at("The rest: 2 claims supported") && at("The rest:") < at("The agent's summary") && at("The agent's summary") < at("Other claims (2)"));
  assert.ok(at("Other claims") < at("Left undone (2)"));

  const failed = review(BRIEF, FAILED, null);
  const failedText = reviewText({ threadId: "child", version: 1, summary: "s" }, failed, markOf(1, failed), open);
  assert.match(failedText, /CHECK FAILED[^\n]*\n {2}failed run: [^\n]*\n\nNeeds you \(3\)\n {2}- the check could not run \(the provider is not signed in\): [^\n]*  → bb cow brief check child\n/);
  // No empty sections under the block: a failed check has no disputes to detail.
  assert.doesNotMatch(failedText, /Disputes \(0\)/);
  assert.match(failedText, /\n\nJudgement calls for you \(2\)\n/);
});

test("--json keeps every field it had, and adds whether it waits, what needs you and the rest", async () => {
  const { attentionCommands } = await import("../src/raised-cli.ts");
  const w = world();
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.checkers.set("chk_1", { state: "error", reply: null, tools: [], failure: NOT_SIGNED_IN });
  const commands = attentionCommands({ asks: w.asks, briefs: w.briefs } as never) as unknown as Record<string, { run: (input: unknown, ctx: unknown) => Promise<unknown> }>;
  const out = (await commands["brief show"]!.run({ positionals: { thread: "child" }, options: { json: true, wait: false } }, { signal: undefined })) as unknown;
  const json = JSON.parse((out as { stdout: string }).stdout) as Record<string, unknown>;
  for (const key of ["threadId", "version", "submittedAt", "summary", "check", "failedRecheck", "mark", "disputes", "judgementCalls", "claims", "notDone", "tasks", "flagged", "unaccounted", "shown"]) assert.ok(key in json, key);
  assert.equal(json.waits, true);
  assert.equal((json.mark as { failure?: string }).failure, "the provider is not signed in");
  assert.deepEqual((json.needsYou as { kind: string }[]).map((need) => need.kind), ["failed"]);
  assert.match(String(json.rest), /^the rest: 2 claims with no verdict, 1 not done/);
});
