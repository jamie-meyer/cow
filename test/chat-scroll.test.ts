import assert from "node:assert/strict";
import { test } from "node:test";
import { AT_END_PX, CHAT_STEP_PX, LEAVE_PX, outputBelow, stepTarget } from "../src/chatScroll.ts";
import { KeyReader } from "../src/keys.ts";

test("a step stays inside the chat, and a step up from the newest message is big enough to leave it", () => {
  assert.equal(stepTarget(500, CHAT_STEP_PX, 1000), 566);
  assert.equal(stepTarget(500, -CHAT_STEP_PX, 1000), 434);
  assert.equal(stepTarget(980, CHAT_STEP_PX, 1000), 1000);
  assert.equal(stepTarget(20, -CHAT_STEP_PX, 1000), 0);
  // From the end, or within a few pixels of it, a small step up still clears bb's pin.
  assert.equal(stepTarget(1000, -10, 1000), 1000 - LEAVE_PX);
  assert.equal(stepTarget(1000 - AT_END_PX, -10, 1000), 1000 - AT_END_PX - LEAVE_PX);
  assert.equal(stepTarget(1000, -CHAT_STEP_PX, 1000), 934);
  // Away from the end a small step is a small step, and down is never enlarged.
  assert.equal(stepTarget(900, -10, 1000), 890);
  assert.equal(stepTarget(1000, 10, 1000), 1000);
  assert.equal(stepTarget(0, -CHAT_STEP_PX, 0), 0);
});

test("new output is below when the chat has grown since the person left its end", () => {
  assert.equal(outputBelow(null, 5000), false);
  assert.equal(outputBelow(2000, 2000), false);
  assert.equal(outputBelow(2000, 2003), false);
  assert.equal(outputBelow(2000, 2100), true);
});

test("; ' : \" and \\ are the chat's scroll keys, and P marks a project", () => {
  const keys = new KeyReader();
  assert.deepEqual(keys.read(";", false, 0), { kind: "chat-scroll", by: 1, half: false });
  assert.deepEqual(keys.read("'", false, 0), { kind: "chat-scroll", by: -1, half: false });
  assert.deepEqual(keys.read(":", true, 0), { kind: "chat-scroll", by: 1, half: true });
  assert.deepEqual(keys.read('"', true, 0), { kind: "chat-scroll", by: -1, half: true });
  assert.deepEqual(keys.read("\\", false, 0), { kind: "chat-end" });
  assert.deepEqual(keys.read("P", true, 0), { kind: "project" });
  // The keys they sit beside are unchanged.
  assert.deepEqual(keys.read("j", false, 0), { kind: "move", by: 1 });
  assert.deepEqual(keys.read("p", false, 0), { kind: "verb", verb: "park" });
});
