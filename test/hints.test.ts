import assert from "node:assert/strict";
import { test } from "node:test";
import { HINT_ALPHABET, hintLabels, matchHint } from "../src/hints.ts";

const SIZE = HINT_ALPHABET.length;

/** No label may be the start of another, or the longer one could never be typed. */
function prefixFree(labels: readonly string[]): boolean {
  return labels.every((a) => labels.every((b) => a === b || !b.startsWith(a)));
}

test("no targets, no labels", () => {
  assert.deepEqual(hintLabels(0), []);
});

test("as many targets as there are letters get one letter each, home row first", () => {
  assert.deepEqual(hintLabels(3), ["a", "s", "d"]);
  assert.deepEqual(hintLabels(SIZE), [...HINT_ALPHABET]);
});

test("more targets keep single letters for the first ones and add pairs for the rest", () => {
  for (const count of [SIZE + 1, 40, 80, 300, SIZE * SIZE]) {
    const labels = hintLabels(count);
    assert.equal(labels.length, count);
    assert.equal(new Set(labels).size, count);
    assert.ok(prefixFree(labels), `${count} labels are prefix-free`);
    assert.ok(labels.every((l) => l.length <= 2 && [...l].every((c) => HINT_ALPHABET.includes(c))));
    // Singles come first, so the first targets are the cheapest to reach.
    const firstPair = labels.findIndex((label) => label.length === 2);
    assert.ok(labels.slice(firstPair).every((label) => label.length === 2));
  }
  // One more than the alphabet costs a single letter: 25 singles, then pairs.
  const labels = hintLabels(SIZE + 1);
  assert.equal(labels.filter((label) => label.length === 1).length, SIZE - 1);
  assert.equal(labels[SIZE - 1], "ma");
  assert.equal(hintLabels(40).filter((label) => label.length === 1).length, SIZE - 1);
});

test("targets beyond what two letters reach get no label", () => {
  assert.equal(hintLabels(SIZE * SIZE + 50).length, SIZE * SIZE);
});

test("typing narrows, hits, or misses", () => {
  const labels = hintLabels(30);
  assert.deepEqual(matchHint(labels, "a"), { kind: "hit", index: 0 });
  assert.deepEqual(matchHint(labels, "m"), { kind: "partial" });
  assert.deepEqual(matchHint(labels, "ms"), { kind: "hit", index: 26 });
  assert.deepEqual(matchHint(labels, "mm"), { kind: "miss" });
  assert.deepEqual(matchHint(hintLabels(3), "f"), { kind: "miss" });
});

test("a custom alphabet is honoured", () => {
  assert.deepEqual(hintLabels(2, "ab"), ["a", "b"]);
  assert.deepEqual(hintLabels(3, "ab"), ["a", "ba", "bb"]);
  assert.deepEqual(hintLabels(4, "ab"), ["aa", "ab", "ba", "bb"]);
  assert.throws(() => hintLabels(2, "a"));
});
