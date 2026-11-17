import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { CONFIRM_WORD, backOut, confirmAsk, draftAnswer, emptyAskDraft, markOption, nextAsk, writeAnswer, writeWord } from "../src/asks/card.ts";
import type { Brief } from "../src/briefs/brief.ts";
import { type Check, review } from "../src/briefs/review.ts";
import { checkLine, moveStop, sheetItems } from "../src/briefs/sheet.ts";
import { NOW } from "./fixtures.ts";

const ask = (overrides: Partial<Ask> = {}): Ask => ({
  id: "ask_1",
  threadId: "t",
  askedBy: "t",
  projectId: "p",
  question: "Which colour?",
  options: [
    { label: "red", detail: null },
    { label: "blue", detail: "the colder one" },
  ],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: null,
  createdAt: NOW,
  status: "open",
  answer: null,
  deliveredAt: null,
  withdrawnAt: null,
  ...overrides,
});

test("a digit only marks an option; the same digit again unmarks it", () => {
  const a = ask();
  const marked = markOption(emptyAskDraft, a, 2);
  assert.equal(marked.option, 2);
  assert.equal(markOption(marked, a, 2).option, null);
  assert.equal(markOption(marked, a, 1).option, 1);
  assert.equal(markOption(emptyAskDraft, a, 3), emptyAskDraft);
  assert.equal(markOption(emptyAskDraft, a, 0), emptyAskDraft);
  // Once the answer is being confirmed, digits change nothing.
  const staged = { ...marked, stage: "restate" as const };
  assert.equal(markOption(staged, a, 1), staged);
});

test("the answer is the option, your words, or both; without either Enter says what is missing", () => {
  const a = ask();
  assert.deepEqual(draftAnswer(markOption(emptyAskDraft, a, 2), a), { ok: true, text: "blue (option 2)", option: 2, words: null });
  assert.deepEqual(draftAnswer(writeAnswer(emptyAskDraft, "  green "), a), { ok: true, text: "green", option: null, words: "green" });
  assert.deepEqual(draftAnswer(writeAnswer(markOption(emptyAskDraft, a, 1), "a dark one"), a), { ok: true, text: "red (option 1): a dark one", option: 1, words: "a dark one" });
  assert.deepEqual(draftAnswer(emptyAskDraft, a), { ok: false, why: "choose an option, or type your answer, first" });
  assert.deepEqual(draftAnswer(emptyAskDraft, ask({ optionsOnly: true })), { ok: false, why: "choose an option first" });
  assert.deepEqual(draftAnswer(emptyAskDraft, ask({ options: [] })), { ok: false, why: "type your answer first" });
  const strict = draftAnswer(writeAnswer(emptyAskDraft, "green"), ask({ optionsOnly: true }));
  assert.equal(strict.ok, false);
});

test("a low-risk answer is sent on Enter, and never without an answer", () => {
  const a = ask({ risk: "low" });
  assert.deepEqual(confirmAsk(emptyAskDraft, a), { kind: "incomplete", why: "choose an option, or type your answer, first" });
  assert.deepEqual(confirmAsk(markOption(emptyAskDraft, a, 1), a), { kind: "send", option: 1, text: null, said: "red (option 1)" });
  assert.equal(confirmAsk(markOption(emptyAskDraft, ask(), 1), ask()).kind, "send");
});

test("a medium-risk answer is restated and needs a second Enter", () => {
  const a = ask({ risk: "medium" });
  const first = confirmAsk(markOption(emptyAskDraft, a, 2), a);
  assert.equal(first.kind, "stage");
  if (first.kind !== "stage") return;
  assert.equal(first.draft.stage, "restate");
  assert.deepEqual(confirmAsk(first.draft, a), { kind: "send", option: 2, text: null, said: "blue (option 2)" });
  // Escape goes back to the choices, and the next Enter restates again.
  const back = backOut(first.draft);
  assert.equal(back?.stage, "choose");
  assert.equal(back?.option, 2);
  assert.equal(confirmAsk(back!, a).kind, "stage");
  assert.equal(backOut(back!), null);
  // Nothing to restate without an answer.
  assert.equal(confirmAsk(emptyAskDraft, a).kind, "incomplete");
});

test("a high-risk answer needs the word typed", () => {
  const a = ask({ risk: "high" });
  const first = confirmAsk(writeAnswer(emptyAskDraft, "do it"), a);
  assert.equal(first.kind, "stage");
  if (first.kind !== "stage") return;
  assert.equal(first.draft.stage, "word");
  assert.deepEqual(confirmAsk(first.draft, a), { kind: "incomplete", why: `type the word ${CONFIRM_WORD} to send a high-risk answer` });
  assert.equal(confirmAsk(writeWord(first.draft, "yes"), a).kind, "incomplete");
  assert.deepEqual(confirmAsk(writeWord(first.draft, " SEND "), a), { kind: "send", option: null, text: "do it", said: "do it" });
  assert.equal(backOut(writeWord(first.draft, "se"))?.word, "");
});

test("after one ask comes the next, oldest first, wrapping round", () => {
  const asks = [ask({ id: "a" }), ask({ id: "b" }), ask({ id: "c" })];
  assert.equal(nextAsk(asks, "a")?.id, "b");
  assert.equal(nextAsk(asks, "c")?.id, "a");
  assert.equal(nextAsk([asks[0]!], "a"), null);
  // The current one may have gone already: withdrawn, or answered elsewhere.
  assert.equal(nextAsk(asks, "gone")?.id, "a");
  assert.equal(nextAsk([], "gone"), null);
});

const BRIEF: Brief = {
  summary: "Did the job.",
  claims: ["c1", "c2", "c3", "c4"].map((id) => ({ id, text: `${id} holds`, label: "checked" as const, evidence: [] })),
  judgementCalls: [
    { text: "Ship it?", askId: "ask_1" },
    { text: "Tell the users?", askId: "ask_gone" },
    { text: "Rename it?", askId: null },
  ],
  notDone: [],
};
const run = (verdicts: string[], id = "chk") => ({
  status: "done" as const,
  threadId: id,
  startedAt: NOW,
  finishedAt: NOW,
  verdicts: verdicts.map((verdict, index) => ({ id: `c${index + 1}`, shows: "x", verdict: verdict as "supported", needs: verdict === "cannot-tell" ? "more" : null })),
});
const check = (...runs: Check["runs"]): Check => ({ model: "small", startedAt: NOW, runs });

test("the sheet stops at disputes first, then judgement calls, then the other claims", () => {
  const items = sheetItems(review(BRIEF, check(run(["supported", "cannot-tell", "supported", "not-supported"]))), [ask()]);
  assert.deepEqual(items.map((item) => `${item.kind}:${item.id}`), [
    "dispute:claim:c4",
    "dispute:claim:c2",
    "call:call:0",
    "call:call:1",
    "call:call:2",
    "claim:claim:c1",
    "claim:claim:c3",
  ]);
  // Only a judgement call whose ask is still open can be answered in place.
  const calls = items.filter((item) => item.kind === "call");
  assert.deepEqual(calls.map((item) => (item.kind === "call" ? item.ask?.id ?? null : null)), ["ask_1", null, null]);
  assert.equal(moveStop(items, null, 1), "claim:c4");
  assert.equal(moveStop(items, "claim:c4", 1), "claim:c2");
  assert.equal(moveStop(items, "claim:c4", -1), "claim:c4");
  assert.equal(moveStop(items, "claim:c3", 1), "claim:c3");
  assert.equal(moveStop(items, "gone", -1), "claim:c4");
  assert.equal(moveStop([], null, 1), null);
});

test("the heading says what kind of check it was, and never calls a failed one a check", () => {
  const one = checkLine(review(BRIEF, check(run(["supported", "supported", "supported", "supported"]))));
  assert.equal(one.tone, "checked");
  assert.equal(one.text, "Audited by 1 run of small. It read only the evidence attached here.");
  const two = checkLine(review(BRIEF, check(run(["supported", "supported", "supported", "supported"]), run(["supported", "not-supported", "supported", "supported"], "b"))));
  assert.match(two.text, /^Audited by 2 runs of small; the runs disagreed on 1 claim\./);
  const agreed = checkLine(review(BRIEF, check(run(["supported", "supported", "supported", "supported"]), run(["supported", "supported", "supported", "supported"], "b"))));
  assert.match(agreed.text, /the runs agreed on every claim/);
  const failed = checkLine(review(BRIEF, check({ status: "failed", error: "prose", threadId: "c", startedAt: NOW, finishedAt: NOW })));
  assert.equal(failed.tone, "failed");
  assert.match(failed.text, /^Check failed/);
  assert.doesNotMatch(failed.text, /Audited/);
  assert.equal(checkLine(review(BRIEF, null)).tone, "none");
  assert.equal(checkLine(review(BRIEF, check({ status: "running", threadId: "c", startedAt: NOW, finishedAt: null }))).tone, "running");
  assert.match(checkLine(review(BRIEF, { ...check(run(["supported", "supported", "supported", "supported"])), model: null })).text, /bb's default model/);
});
