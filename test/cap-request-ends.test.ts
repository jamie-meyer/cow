// A request for a capability that ends without one: each way it can end, and
// what the thread it was for is told. Ordinary asks read as before.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ask, CAPABILITY_OPTIONS, answerMessage, answered, askText, closedInChat, draftAsk, endedUngranted, granted, ungrantedLine, unmadeGrant, withdrawn } from "../src/asks/ask.ts";
import { emptyAskDraft, markChat, noGrantWarning, writeAnswer } from "../src/asks/card.ts";
import type { AskInput } from "../src/asks/service.ts";
import { NOW } from "./fixtures.ts";
import { memoryKv, world } from "./memory.ts";

const QUESTION = "May I run “npm run check”?";
const AGAIN = "`bb cow caps` shows what you hold; `bb cow cap request` asks again.";
const capability = { kind: "command", rule: "npm run check" } as const;

const request = (overrides: Partial<AskInput> = {}): AskInput => ({
  caller: "child",
  threadId: null,
  question: QUESTION,
  options: [...CAPABILITY_OPTIONS],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: "to run the checks",
  capability,
  ...overrides,
});
const ordinary = (overrides: Partial<AskInput> = {}): AskInput => ({ ...request(overrides), question: "Which colour?", options: ["red", "blue"], context: null, capability: null, ...overrides });

const made = (cap: Ask["capability"] = capability): Ask => {
  const result = draftAsk({ threadId: "child", askedBy: "child", projectId: "proj_1", question: QUESTION, options: [...CAPABILITY_OPTIONS], optionsOnly: false, risk: null, proofs: [], context: null, capability: cap }, "ask_1", NOW, null);
  assert.ok(result.ok);
  return result.value;
};
const head = `Answer to your question (ask_1):\n\n> ${QUESTION}\n\n`;

test("a request answered in words: the words go, and cow says in its own voice that nothing was granted", () => {
  const done = answered(made(), { option: null, text: "done" }, NOW);
  assert.ok(done.ok);
  assert.equal(
    answerMessage(done.value),
    `${head}done\n\nFrom cow, not the user: No capability was granted from ask_1: the user answered in words, and words grant nothing. ${AGAIN}`,
  );
  assert.equal(granted(done.value), false);
  assert.equal(endedUngranted(done.value), true);
});

test("a refusal says no, and says it in the same words as the rest", () => {
  const done = answered(made(), { option: 2, text: null }, NOW);
  assert.ok(done.ok);
  assert.equal(answerMessage(done.value), `${head}refuse it (option 2)\n\nFrom cow, not the user: No capability was granted from ask_1: the user refused it. ${AGAIN}`);
  const noted = answered(made(), { option: 2, text: "narrow it to the one script" }, NOW);
  assert.ok(noted.ok);
  assert.equal(answerMessage(noted.value), `${head}refuse it (option 2): narrow it to the one script\n\nFrom cow, not the user: No capability was granted from ask_1: the user refused it. ${AGAIN}`);
});

test("a grant names the capability made, and carries no note that nothing was granted", () => {
  const said = "granted as the capability “checks”: npm run check for “child” only";
  const done = answered(made(), { option: 1, text: said }, NOW);
  assert.ok(done.ok);
  assert.equal(answerMessage(done.value), `${head}allow it (option 1): ${said}`);
  assert.equal(granted(done.value), true);
  assert.equal(endedUngranted(done.value), false);
  assert.doesNotMatch(askText(done.value, NOW, () => "now"), /no capability was granted/);
});

test("option 1 is refused on a request until a capability in force was made from it; other answers and ordinary asks are not touched", () => {
  const ask = made();
  assert.match(unmadeGrant(ask, 1, []) ?? "", /no capability has been made from ask_1/);
  assert.match(unmadeGrant(ask, 1, [{ askId: "ask_other", deletedAt: null }]) ?? "", /no capability/);
  assert.match(unmadeGrant(ask, 1, [{ askId: "ask_1", deletedAt: NOW }]) ?? "", /no capability/);
  assert.equal(unmadeGrant(ask, 1, [{ askId: "ask_1", deletedAt: null }]), null);
  assert.equal(unmadeGrant(ask, 2, []), null);
  assert.equal(unmadeGrant(ask, null, []), null);
  assert.equal(unmadeGrant(made(null), 1, []), null);
});

test("an ordinary ask answered in words, or with an option, reads exactly as before", () => {
  const words = answered(made(null), { option: null, text: "done" }, NOW);
  assert.ok(words.ok);
  assert.equal(answerMessage(words.value), `${head}done`);
  const option = answered(made(null), { option: 2, text: null }, NOW);
  assert.ok(option.ok);
  assert.equal(answerMessage(option.value), `${head}refuse it (option 2)`);
  assert.equal(endedUngranted(words.value), false);
  assert.equal(ungrantedLine(words.value, "child"), "");
});

test("the thread closing its request in chat is told by the command's own output; one above it is told to pass it on", () => {
  const closed = closedInChat(made(), { by: "thread", closedBy: "child", answer: "done" }, NOW);
  assert.ok(closed.ok);
  assert.equal(closed.value.closed?.notify, undefined, "the thread closed it: nothing is sent");
  assert.equal(ungrantedLine(closed.value, "child"), `\nNo capability was granted from ask_1: it was closed as answered in chat, and words in chat grant nothing. ${AGAIN}`);
  assert.equal(
    ungrantedLine(closed.value, "main"),
    "\nNo capability was granted to child from ask_1: it was closed as answered in chat, and words in chat grant nothing. cow does not tell it so: tell it, if it waits for one. `bb cow caps --thread child` shows what it holds; `bb cow cap request --thread child` asks again.",
  );
  // An ordinary chat close is the record it always was.
  const plain = closedInChat(made(null), { by: "thread", closedBy: "child", answer: "done" }, NOW);
  assert.ok(plain.ok);
  assert.deepEqual(plain.value.closed, { by: "thread", closedBy: "child", answer: "done", at: NOW });
  assert.equal(ungrantedLine(plain.value, "child"), "");
});

test("a withdrawn request: the command's output says nothing was granted", () => {
  const gone = withdrawn(made(), NOW);
  assert.ok(gone.ok);
  assert.equal(ungrantedLine(gone.value, "child"), `\nNo capability was granted from ask_1: the request was withdrawn. ${AGAIN}`);
  const plain = withdrawn(made(null), NOW);
  assert.ok(plain.ok);
  assert.equal(ungrantedLine(plain.value, "child"), "");
});

test("bb cow asks --all never reads an ungranted request as granted", () => {
  const words = answered(made(), { option: null, text: "done" }, NOW);
  assert.ok(words.ok);
  assert.match(askText(words.value, NOW, () => "now"), /answered on cow's page: done \(not delivered yet\)\n {2}no capability was granted from it$/);
  const closed = closedInChat(made(), { by: "person", closedBy: null, answer: null }, NOW);
  assert.ok(closed.ok);
  assert.match(askText(closed.value, NOW, () => "now"), /no capability was granted from it$/);
  const plain = answered(made(null), { option: null, text: "done" }, NOW);
  assert.ok(plain.ok);
  assert.doesNotMatch(askText(plain.value, NOW, () => "now"), /capability/);
});

test("through the service: words, a refusal, a thread's close and a withdrawal each end the request with nothing sent but what is owed", async () => {
  const { asks, sent } = world();
  const words = await asks.ask(request());
  await asks.answer(words.id, { option: null, text: "done" });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /\n\ndone\n\nFrom cow, not the user: No capability was granted from ask_t\d+: the user answered in words, and words grant nothing\. /);
  const refuse = await asks.ask(request());
  await asks.answer(refuse.id, { option: 2, text: null });
  assert.match(sent[1]!.text, /From cow, not the user: No capability was granted from ask_t\d+: the user refused it\. /);
  const byThread = await asks.ask(request());
  await asks.close(byThread.id, { caller: "child", answer: "done" });
  const gone = await asks.ask(request());
  await asks.withdraw("child", gone.id);
  assert.equal(sent.length, 2, "a close by the thread, and a withdrawal, send nothing: the command's output says it");
  assert.equal(await asks.redeliver(), 0);
});

test("the person closing a request as answered in chat: its thread is sent cow's note that nothing was granted, once", async () => {
  const kv = memoryKv();
  const { asks, sent } = world(kv);
  const ask = await asks.ask(request());
  const closed = await asks.close(ask.id, { person: true });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closed?.notify, true);
  assert.notEqual(closed.deliveredAt, null);
  assert.deepEqual(sent, [
    {
      threadId: "child",
      text: `From cow, not the user: the user closed your request for a capability (${ask.id}) on cow's page, as answered in chat:\n\n> ${QUESTION}\n\nNo capability was granted from ${ask.id}: it was closed as answered in chat, and words in chat grant nothing. ${AGAIN}`,
    },
  ]);
  assert.equal(await world(kv).asks.redeliver(), 0, "sent once");
});

test("a note that could not be sent leaves the close standing and is sent on the next load", async () => {
  const kv = memoryKv();
  const first = world(kv);
  const ask = await first.asks.ask(request());
  first.failSend.on = true;
  const closed = await first.asks.close(ask.id, { person: true });
  assert.equal(closed.status, "closed");
  assert.equal(closed.deliveredAt, null);
  assert.deepEqual(first.sent, []);
  const later = world(kv);
  assert.equal(await later.asks.redeliver(), 1);
  assert.match(later.sent[0]?.text ?? "", /No capability was granted/);
  assert.equal(await later.asks.redeliver(), 0);
});

test("the person closing an ordinary ask sends nothing, as before", async () => {
  const { asks, sent } = world();
  const ask = await asks.ask(ordinary());
  const closed = await asks.close(ask.id, { person: true });
  assert.deepEqual(closed.closed, { by: "person", closedBy: null, answer: null, at: closed.closed!.at });
  assert.equal(closed.deliveredAt, null);
  assert.deepEqual(sent, []);
});

test("the card says words grant nothing as soon as they are typed, or chat is marked; never on an ordinary ask", () => {
  const ask = made();
  assert.equal(noGrantWarning(emptyAskDraft, ask, "Checks"), null);
  assert.equal(noGrantWarning(writeAnswer(emptyAskDraft, "   "), ask, "Checks"), null);
  assert.equal(
    noGrantWarning(writeAnswer(emptyAskDraft, "narrow it to this one file"), ask, "Checks"),
    "Words grant nothing: they are sent to “Checks” with a line from cow that no capability was granted. 1 is what grants; your words can still say what to ask for instead.",
  );
  assert.equal(noGrantWarning(markChat(emptyAskDraft), ask, "Checks"), "Closing it grants nothing: “Checks” is told that no capability was granted. 1 is what grants.");
  assert.equal(noGrantWarning(writeAnswer(emptyAskDraft, "done"), made(null), "Checks"), null);
  assert.equal(noGrantWarning(markChat(emptyAskDraft), made(null), "Checks"), null);
});
