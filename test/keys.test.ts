import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY_MAP, KeyReader } from "../src/keys.ts";

const read = (key: string, shift = false) => new KeyReader().read(key, shift, 5000);

test("h and l, and the left and right arrows, fold and unfold", () => {
  assert.deepEqual(read("h"), { kind: "fold", key: "h" });
  assert.deepEqual(read("ArrowLeft"), { kind: "fold", key: "h" });
  assert.deepEqual(read("l"), { kind: "fold", key: "l" });
  assert.deepEqual(read("ArrowRight"), { kind: "fold", key: "l" });
});

test("Space marks a reply seen; J and K move a not-started item", () => {
  assert.deepEqual(read(" "), { kind: "seen" });
  assert.deepEqual(read("J", true), { kind: "reorder", by: 1 });
  assert.deepEqual(read("K", true), { kind: "reorder", by: -1 });
  // The lower-case letters still move the cursor.
  assert.deepEqual(read("j"), { kind: "move", by: 1 });
  assert.deepEqual(read("k"), { kind: "move", by: -1 });
});

test("the keys that were there keep their meaning", () => {
  assert.deepEqual(read("f"), { kind: "hints" });
  assert.deepEqual(read("x"), { kind: "verb", verb: "stop" });
  assert.deepEqual(read("3"), { kind: "ask-number", number: 3 });
  assert.equal(read("z"), null);
  const reader = new KeyReader();
  assert.equal(reader.read("g", false, 5000), null);
  assert.deepEqual(reader.read("g", false, 5100), { kind: "top" });
});

test("the key map lists every new key", () => {
  const keys = KEY_MAP.map((entry) => entry.keys);
  for (const key of ["h l", "Space", "J K"]) assert.ok(keys.includes(key), key);
});
