import assert from "node:assert/strict";
import { test } from "node:test";
import { HINT_ALPHABET, hintLabels, matchHint } from "../src/hints.ts";

test("no targets, no labels", () => {
  assert.deepEqual(hintLabels(0), []);
});

test("up to nine targets get one home-row letter each", () => {
  assert.deepEqual(hintLabels(3), ["a", "s", "d"]);
  assert.deepEqual(hintLabels(9), [...HINT_ALPHABET]);
});

test("more targets get labels of one shared length, all different", () => {
  for (const count of [10, 40, 81, 82, 300]) {
    const labels = hintLabels(count);
    assert.equal(labels.length, count);
    assert.equal(new Set(labels).size, count);
    assert.equal(new Set(labels.map((l) => l.length)).size, 1);
    assert.ok(labels.every((l) => [...l].every((c) => HINT_ALPHABET.includes(c))));
  }
  assert.equal(hintLabels(10)[0], "aa");
  assert.equal(hintLabels(10)[9], "sa");
  assert.equal(hintLabels(82)[0].length, 3);
});

test("typing narrows, hits, or misses", () => {
  const labels = hintLabels(12);
  assert.deepEqual(matchHint(labels, "a"), { kind: "partial" });
  assert.deepEqual(matchHint(labels, "as"), { kind: "hit", index: 1 });
  assert.deepEqual(matchHint(labels, "l"), { kind: "miss" });
  assert.deepEqual(matchHint(hintLabels(3), "d"), { kind: "hit", index: 2 });
});

test("a custom alphabet is honoured", () => {
  assert.deepEqual(hintLabels(4, "ab"), ["aa", "ab", "ba", "bb"]);
  assert.throws(() => hintLabels(2, "a"));
});
