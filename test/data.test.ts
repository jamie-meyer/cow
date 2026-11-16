import assert from "node:assert/strict";
import { test } from "node:test";
import { toAsk, toFacts } from "../src/data.ts";

test("toFacts reads a thread and falls back where bb left fields empty", () => {
  const facts = toFacts({
    id: "thr_1",
    projectId: "proj_1",
    title: null,
    titleFallback: "  first words of the prompt ",
    status: "active",
    parentThreadId: "thr_0",
    hasPendingInteraction: true,
    archivedAt: null,
    lastReadAt: null,
    latestAttentionAt: 20,
    createdAt: 10,
    updatedAt: 30,
  });
  assert.deepEqual(facts, {
    id: "thr_1",
    projectId: "proj_1",
    title: "first words of the prompt",
    parentThreadId: "thr_0",
    status: "active",
    hasPendingInteraction: true,
    archivedAt: null,
    lastReadAt: null,
    latestAttentionAt: 20,
    createdAt: 10,
  });
});

test("toFacts rejects junk and deleted threads", () => {
  assert.equal(toFacts(null), null);
  assert.equal(toFacts({ id: 7 }), null);
  assert.equal(toFacts({ id: "thr_1", projectId: "proj_1", deletedAt: 5 }), null);
  assert.equal(toFacts({ id: "thr_1", projectId: "proj_1" })?.title, "thr_1");
});

test("toAsk picks the oldest pending interaction and reads its question", () => {
  const ask = toAsk([
    { status: "resolved", createdAt: 1, payload: { questions: [{ prompt: "Old?" }] } },
    { status: "pending", createdAt: 9, payload: { title: "Approve the deploy" } },
    { status: "pending", createdAt: 5, payload: { questions: [{ prompt: "Which colour?\nred or blue" }] } },
  ]);
  assert.deepEqual(ask, { kind: "question", text: "Which colour?", at: 5 });
  assert.deepEqual(toAsk([{ status: "pending", createdAt: 3, payload: {} }]), {
    kind: "question",
    text: "it is waiting for your input",
    at: 3,
  });
  assert.deepEqual(
    toAsk([
      {
        status: "pending",
        createdAt: 4,
        payload: { kind: "approval", subject: { kind: "command", command: "echo cow\necho moo" } },
      },
    ]),
    { kind: "permission", text: "permission to run: echo cow", at: 4 },
  );
  assert.equal(toAsk([]), null);
  assert.equal(toAsk(["junk", null]), null);
});
