import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ask, answerMessage, answerText, answered, asksByThread, draftAsk, mayAskFor, openAsks, parseOption, storagePath, withdrawn } from "../src/asks/ask.ts";
import { MAX_OPEN_PER_THREAD } from "../src/asks/service.ts";
import { Refusal } from "../src/kv.ts";
import { MINUTE, NOW } from "./fixtures.ts";
import { memoryKv, world } from "./memory.ts";

const draft = (overrides: Partial<Parameters<typeof draftAsk>[0]> = {}) => ({
  threadId: "child",
  askedBy: "child",
  projectId: "proj_1",
  question: "Which colour?",
  options: ["red", "blue::the colder one"],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: null,
  ...overrides,
});
const made = (overrides: Partial<Parameters<typeof draftAsk>[0]> = {}, id = "ask_1", now = NOW): Ask => {
  const result = draftAsk(draft(overrides), id, now, "/storage/child");
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.value;
};
const refused = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (cause: unknown) => cause instanceof Refusal && cause.code === code, `expected a refusal with code ${code}`);
};

test("an option is a label, or a label and what it means", () => {
  assert.deepEqual(parseOption("red"), { ok: true, value: { label: "red", detail: null } });
  assert.deepEqual(parseOption(" ship  now :: skips the review "), { ok: true, value: { label: "ship now", detail: "skips the review" } });
  assert.equal(parseOption("::only a detail").ok, false);
  assert.equal(parseOption("x".repeat(121)).ok, false);
});

test("a proof path is kept relative to the thread's storage, and may not leave it", () => {
  assert.deepEqual(storagePath("shots/a.png", "/storage/child"), { ok: true, value: "shots/a.png" });
  assert.deepEqual(storagePath("/storage/child/shots/a.png", "/storage/child/"), { ok: true, value: "shots/a.png" });
  assert.deepEqual(storagePath("./a.png", null), { ok: true, value: "a.png" });
  assert.equal(storagePath("/etc/passwd", "/storage/child").ok, false);
  assert.equal(storagePath("/storage/children/a.png", "/storage/child").ok, false);
  assert.equal(storagePath("../other/a.png", "/storage/child").ok, false);
  assert.equal(storagePath("/storage/child", "/storage/child").ok, false);
  assert.equal(storagePath("/abs/a.png", null).ok, false);
});

test("a drafted ask is open and carries what was asked", () => {
  const ask = made({ risk: "high", proofs: ["/storage/child/plan.txt", "plan.txt"], context: "  the deploy is tonight " });
  assert.equal(ask.status, "open");
  assert.deepEqual(ask.options, [
    { label: "red", detail: null },
    { label: "blue", detail: "the colder one" },
  ]);
  assert.deepEqual(ask.proofs, ["plan.txt"]);
  assert.equal(ask.context, "the deploy is tonight");
  assert.equal(ask.risk, "high");
});

test("a draft is refused with something to act on", () => {
  const bad = (overrides: Parameters<typeof draft>[0]) => {
    const result = draftAsk(draft(overrides), "ask_1", NOW, "/storage/child");
    assert.equal(result.ok, false);
    return result.ok ? "" : result.error;
  };
  assert.match(bad({ question: "   " }), /--question is empty/);
  assert.match(bad({ question: "x".repeat(601) }), /over 600/);
  assert.match(bad({ options: ["a", "a"] }), /both "a"/);
  assert.match(bad({ options: ["a"], optionsOnly: true }), /at least two/);
  assert.match(bad({ options: Array.from({ length: 10 }, (_, n) => `o${n}`) }), /at most 9/);
  assert.match(bad({ proofs: ["/tmp/x.png"] }), /--proof: .*not in the thread's storage/);
});

test("a thread asks for itself or for a thread under it", () => {
  assert.equal(mayAskFor("child", "child", ["main"]), true);
  assert.equal(mayAskFor("main", "grandchild", ["child", "main"]), true);
  assert.equal(mayAskFor("grandchild", "child", ["main"]), false);
  assert.equal(mayAskFor("other", "child", ["main"]), false);
});

test("answering takes an option, words, or an option with a note", () => {
  const ask = made();
  const byOption = answered(ask, { option: 2, text: null }, NOW + 1);
  assert.ok(byOption.ok);
  assert.equal(byOption.value.status, "answered");
  assert.equal(answerText(byOption.value), "blue (option 2)");
  const inWords = answered(ask, { option: null, text: " green, actually " }, NOW);
  assert.ok(inWords.ok);
  assert.equal(answerText(inWords.value), "green, actually");
  const both = answered(ask, { option: 1, text: "but a dark one" }, NOW);
  assert.ok(both.ok);
  assert.equal(answerText(both.value), "red (option 1): but a dark one");
});

test("an answer that does not fit the question is refused", () => {
  const ask = made();
  assert.equal(answered(ask, { option: 3, text: null }, NOW).ok, false);
  assert.equal(answered(ask, { option: 0, text: null }, NOW).ok, false);
  assert.equal(answered(ask, { option: null, text: "  " }, NOW).ok, false);
  const strict = made({ optionsOnly: true });
  assert.equal(answered(strict, { option: null, text: "green" }, NOW).ok, false);
  assert.equal(answered(strict, { option: 1, text: null }, NOW).ok, true);
  const open = made({ options: [] });
  assert.equal(answered(open, { option: 1, text: null }, NOW).ok, false);
});

test("an ask is answered or withdrawn once", () => {
  const done = answered(made(), { option: 1, text: null }, NOW);
  assert.ok(done.ok);
  assert.equal(answered(done.value, { option: 2, text: null }, NOW).ok, false);
  assert.equal(withdrawn(done.value, NOW).ok, false);
  const gone = withdrawn(made(), NOW + 5);
  assert.ok(gone.ok);
  assert.equal(gone.value.withdrawnAt, NOW + 5);
  assert.equal(answered(gone.value, { option: 1, text: null }, NOW).ok, false);
  assert.equal(withdrawn(gone.value, NOW).ok, false);
});

test("the message to the thread quotes the question and gives the answer", () => {
  const done = answered(made({ question: "Which colour?\nIt is for the logo." }), { option: 2, text: null }, NOW);
  assert.ok(done.ok);
  assert.equal(answerMessage(done.value), "Answer to your question (ask_1):\n\n> Which colour?\n> It is for the logo.\n\nblue (option 2)");
});

test("open asks are listed oldest first, and grouped by thread", () => {
  const a = made({}, "ask_a", NOW + 2);
  const b = made({ threadId: "main" }, "ask_b", NOW + 1);
  const c = made({ question: "And size?" }, "ask_c", NOW + 3);
  const closed = withdrawn(made({}, "ask_d", NOW), NOW);
  assert.ok(closed.ok);
  const all = [a, b, c, closed.value];
  assert.deepEqual(openAsks(all).map((ask) => ask.id), ["ask_b", "ask_a", "ask_c"]);
  assert.deepEqual(openAsks(all, "child").map((ask) => ask.id), ["ask_a", "ask_c"]);
  const grouped = asksByThread(all);
  assert.deepEqual([...grouped.keys()].sort(), ["child", "main"]);
  assert.deepEqual(grouped.get("child")?.map((ask) => ask.id), ["ask_a", "ask_c"]);
});

const input = (overrides: object = {}) => ({
  caller: "child" as string | null,
  threadId: null as string | null,
  question: "Which colour?",
  options: ["red", "blue"],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: null,
  ...overrides,
});

test("a thread asks for itself, a thread above asks for it, and no other thread does", async () => {
  const { asks } = world();
  const own = await asks.ask(input());
  assert.equal(own.threadId, "child");
  assert.equal(own.askedBy, "child");
  const forGrandchild = await asks.ask(input({ caller: "main", threadId: "grandchild" }));
  assert.equal(forGrandchild.threadId, "grandchild");
  assert.equal(forGrandchild.askedBy, "main");
  await refused(asks.ask(input({ caller: "other", threadId: "child", question: "Mine?" })), "not_your_thread");
  await refused(asks.ask(input({ caller: "grandchild", threadId: "child", question: "Up?" })), "not_your_thread");
  await refused(asks.ask(input({ caller: null })), "no_thread");
  await refused(asks.ask(input({ caller: "child", threadId: "nowhere" })), "thread_not_found");
  assert.equal((await asks.list()).length, 2);
});

test("several asks stay open on one thread and each is answered separately", async () => {
  const { asks, sent, clock } = world();
  const first = await asks.ask(input());
  clock.now += MINUTE;
  const second = await asks.ask(input({ question: "And what size?", options: [] }));
  assert.deepEqual((await asks.list({ threadId: "child" })).map((ask) => ask.id), [first.id, second.id]);

  const done = await asks.answer(second.id, { option: null, text: "large" });
  assert.equal(done.status, "answered");
  assert.equal(done.deliveredAt, clock.now);
  assert.deepEqual(sent, [{ threadId: "child", text: `Answer to your question (${second.id}):\n\n> And what size?\n\nlarge` }]);
  assert.deepEqual((await asks.list()).map((ask) => ask.id), [first.id]);
  assert.deepEqual((await asks.list({ all: true })).map((ask) => ask.status), ["open", "answered"]);

  await refused(asks.answer(second.id, { option: null, text: "small" }), "cannot_answer");
  await refused(asks.answer(first.id, { option: 7, text: null }), "cannot_answer");
  await refused(asks.answer("ask_nope", { option: 1, text: null }), "ask_not_found");
  assert.equal(sent.length, 1);
});

test("the same question is not asked twice, and a thread cannot flood the user", async () => {
  const { asks } = world();
  const first = await asks.ask(input());
  await refused(asks.ask(input()), "already_asked");
  await asks.withdraw("child", first.id);
  await asks.ask(input());
  for (let n = 1; n < MAX_OPEN_PER_THREAD; n += 1) await asks.ask(input({ question: `Question ${n}?` }));
  await refused(asks.ask(input({ question: "One more?" })), "too_many_asks");
});

test("the asking thread withdraws; an unrelated thread cannot", async () => {
  const { asks, sent } = world();
  const ask = await asks.ask(input());
  await refused(asks.withdraw("other", ask.id), "not_your_thread");
  const gone = await asks.withdraw("child", ask.id);
  assert.equal(gone.status, "withdrawn");
  assert.deepEqual(await asks.list(), []);
  await refused(asks.answer(ask.id, { option: 1, text: null }), "cannot_answer");
  await refused(asks.withdraw("child", ask.id), "cannot_withdraw");
  assert.deepEqual(sent, []);
});

test("asks survive the services being made again, as on a reload", async () => {
  const kv = memoryKv();
  const before = world(kv);
  const ask = await before.asks.ask(input({ risk: "medium" }));
  const after = world(kv);
  assert.deepEqual(await after.asks.list(), [ask]);
  await after.asks.answer(ask.id, { option: 1, text: null });
  assert.equal((await world(kv).asks.get(ask.id)).status, "answered");
});

test("an answer that could not be delivered is kept and sent later, once", async () => {
  const kv = memoryKv();
  const first = world(kv);
  const ask = await first.asks.ask(input());
  first.failSend.on = true;
  await refused(first.asks.answer(ask.id, { option: 2, text: null }), "not_delivered");
  const kept = await first.asks.get(ask.id);
  assert.equal(kept.status, "answered");
  assert.equal(kept.deliveredAt, null);

  const later = world(kv);
  assert.equal(await later.asks.redeliver(), 1);
  assert.equal(later.sent.length, 1);
  assert.match(later.sent[0]?.text ?? "", /blue \(option 2\)/);
  assert.equal(await later.asks.redeliver(), 0);
  assert.equal(later.sent.length, 1);
});

test("a stored ask that is not an ask is ignored, not trusted", async () => {
  const kv = memoryKv();
  await kv.set("ask:ask_bad", { id: "ask_bad", status: "answered" });
  const { asks } = world(kv);
  assert.deepEqual(await asks.list({ all: true }), []);
  await refused(asks.get("ask_bad"), "ask_not_found");
});
