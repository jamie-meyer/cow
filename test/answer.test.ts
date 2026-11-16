import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AskQuestion,
  choose,
  confirm,
  emptyDraft,
  oldestAsk,
  toAskDetail,
  writeText,
} from "../src/answer.ts";

const option = (value: string) => ({ label: value, value });
const interaction = (overrides: Record<string, unknown> = {}) => ({
  id: "int_1",
  status: "pending",
  createdAt: 100,
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "q1",
        prompt: "Which colour?",
        options: [option("red"), { ...option("blue"), description: "the calm one" }],
        allowFreeText: true,
        multiSelect: false,
      },
    ],
  },
  ...overrides,
});
const question = (overrides: Partial<AskQuestion> = {}): AskQuestion => ({
  id: "q1",
  prompt: "Which colour?",
  options: [
    { label: "red", value: "red", description: "" },
    { label: "blue", value: "blue", description: "" },
  ],
  allowFreeText: false,
  multiSelect: false,
  required: true,
  ...overrides,
});

test("reads a built-in question", () => {
  const ask = toAskDetail(interaction());
  assert.ok(ask?.kind === "questions");
  assert.equal(ask.id, "int_1");
  assert.deepEqual(ask.questions[0], {
    id: "q1",
    prompt: "Which colour?",
    options: [
      { label: "red", value: "red", description: "" },
      { label: "blue", value: "blue", description: "the calm one" },
    ],
    allowFreeText: true,
    multiSelect: false,
    required: true,
  });
});

test("only pending interactions count, and the oldest comes first", () => {
  assert.equal(toAskDetail(interaction({ status: "resolved" })), null);
  assert.equal(toAskDetail(null), null);
  const ask = oldestAsk([
    interaction({ id: "new", createdAt: 300 }),
    interaction({ id: "done", createdAt: 1, status: "resolved" }),
    interaction({ id: "old", createdAt: 200 }),
  ]);
  assert.equal(ask?.id, "old");
  assert.equal(oldestAsk([]), null);
});

test("kinds the page cannot answer are named, not guessed at", () => {
  const approval = toAskDetail(
    interaction({
      payload: { kind: "approval", reason: null, subject: { kind: "command", command: "rm -rf build" } },
    }),
  );
  assert.ok(approval?.kind === "other");
  assert.equal(approval.title, "rm -rf build");
  assert.match(approval.why, /permission request/);

  const plugin = toAskDetail(interaction({ payload: { kind: "plugin", title: "Pick a plan", data: {} } }));
  assert.ok(plugin?.kind === "other");
  assert.equal(plugin.title, "Pick a plan");

  const many = toAskDetail(
    interaction({
      payload: {
        kind: "user_question",
        questions: [{ id: "q", prompt: "?", options: Array.from({ length: 10 }, (_, i) => option(`o${i}`)) }],
      },
    }),
  );
  assert.ok(many?.kind === "other");
  assert.match(many.why, /more than 9 options/);

  const empty = toAskDetail(
    interaction({ payload: { kind: "user_question", questions: [{ id: "q", prompt: "?" }] } }),
  );
  assert.equal(empty?.kind, "other");
});

test("a digit chooses and never sends; another digit replaces the choice", () => {
  const questions = [question()];
  let draft = emptyDraft(questions);
  assert.equal(confirm(draft, questions).kind, "incomplete");
  draft = choose(draft, questions, 2);
  assert.deepEqual(draft.selected, [["blue"]]);
  draft = choose(draft, questions, 1);
  assert.deepEqual(draft.selected, [["red"]]);
  assert.equal(choose(draft, questions, 7), draft);
  assert.deepEqual(confirm(draft, questions), {
    kind: "send",
    answers: { q1: { selected: ["red"] } },
  });
});

test("a question that takes several toggles each digit", () => {
  const questions = [question({ multiSelect: true })];
  let draft = choose(choose(emptyDraft(questions), questions, 1), questions, 2);
  assert.deepEqual(draft.selected, [["red", "blue"]]);
  draft = choose(draft, questions, 1);
  assert.deepEqual(draft.selected, [["blue"]]);
});

test("text in your own words replaces a single choice, and the other way round", () => {
  const questions = [question({ allowFreeText: true })];
  let draft = choose(emptyDraft(questions), questions, 1);
  draft = writeText(draft, questions, " teal ");
  assert.deepEqual(draft.selected, [[]]);
  assert.deepEqual(confirm(draft, questions), {
    kind: "send",
    answers: { q1: { selected: [], freeText: "teal" } },
  });
  draft = choose(draft, questions, 2);
  assert.deepEqual(draft.freeText, [""]);
  assert.deepEqual(draft.selected, [["blue"]]);
  // A question that takes no text ignores it.
  const closed = [question()];
  assert.deepEqual(writeText(emptyDraft(closed), closed, "x").freeText, [""]);
});

test("several questions are answered one at a time, and sent together", () => {
  const questions = [question(), question({ id: "q2", options: [], allowFreeText: true, required: false })];
  let draft = emptyDraft(questions);
  assert.deepEqual(confirm(draft, questions), { kind: "incomplete", why: "choose an option first" });
  draft = choose(draft, questions, 2);
  const next = confirm(draft, questions);
  assert.ok(next.kind === "next");
  assert.equal(next.draft.step, 1);
  // The second question is optional.
  assert.deepEqual(confirm(next.draft, questions), {
    kind: "send",
    answers: { q1: { selected: ["blue"] }, q2: { selected: [] } },
  });
});
