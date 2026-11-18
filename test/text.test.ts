import assert from "node:assert/strict";
import { test } from "node:test";
import { describeItem, firstLine, formatAge } from "../src/text.ts";

test("firstLine skips blank and rule lines and strips markdown", () => {
  assert.equal(firstLine("\n\n---\n## **Done**: `x` works\nmore"), "Done: x works");
  assert.equal(firstLine("- first bullet"), "first bullet");
  // Underscores inside a word are part of it; at its edges they are emphasis.
  assert.equal(firstLine("asked thr_x about snake_case_name"), "asked thr_x about snake_case_name");
  assert.equal(firstLine("_quiet_ and __loud__ words"), "quiet and loud words");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine(null), "");
  assert.equal(firstLine("x".repeat(400)).length, 160);
});

test("describeItem names the latest step", () => {
  assert.equal(describeItem({ type: "commandExecution", command: "npm test\n# then" }), "$ npm test");
  assert.equal(describeItem({ type: "toolCall", tool: "Read" }), "using Read");
  assert.equal(describeItem({ type: "toolCall", server: "tracker", tool: "save" }), "tracker: save");
  assert.equal(describeItem({ type: "agentMessage", text: "Half way.\nMore." }), "Half way.");
  assert.equal(describeItem({ type: "reasoning" }), "thinking");
  assert.equal(describeItem({ type: "somethingNew" }), "");
  assert.equal(describeItem(null), "");
});

test("formatAge is compact", () => {
  const minute = 60_000;
  assert.equal(formatAge(0), "1m");
  assert.equal(formatAge(59 * minute), "59m");
  assert.equal(formatAge(60 * minute), "1h");
  assert.equal(formatAge(47 * 60 * minute), "47h");
  assert.equal(formatAge(48 * 60 * minute), "2d");
  assert.equal(formatAge(27 * 24 * 60 * minute), "27d");
  assert.equal(formatAge(28 * 24 * 60 * minute), "4w");
});
