// Letter hints: one label per target on screen, typed to activate it.

/** Home row first, so the first hints are under the fingers. */
export const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

/**
 * Labels for `count` targets, most important target first. As many as
 * possible are a single letter; the rest are two letters that start with a
 * letter no single-letter label uses. No label is a prefix of another, so a
 * hint fires on its last letter. Two letters reach the alphabet's size
 * squared; targets beyond that get no label.
 */
export function hintLabels(count: number, alphabet: string = HINT_ALPHABET): string[] {
  if (count <= 0) return [];
  const letters = [...alphabet];
  const size = letters.length;
  if (size < 2) throw new Error("the hint alphabet needs at least two letters");
  const wanted = Math.min(count, size * size);
  // With `pairs` letters kept as first letters of pairs, there is room for
  // (size - pairs) single labels and pairs * size double ones.
  let pairs = 0;
  while (size - pairs + pairs * size < wanted) pairs += 1;
  const singles = letters.slice(0, size - pairs);
  const labels = singles.slice(0, wanted);
  for (const first of letters.slice(size - pairs)) {
    for (const second of letters) {
      if (labels.length === wanted) return labels;
      labels.push(first + second);
    }
  }
  return labels;
}

export type HintMatch =
  | { kind: "hit"; index: number }
  | { kind: "partial" }
  | { kind: "miss" };

/** What the letters typed so far select among `labels`. */
export function matchHint(labels: readonly string[], typed: string): HintMatch {
  const index = labels.indexOf(typed);
  if (index >= 0) return { kind: "hit", index };
  return labels.some((label) => label.startsWith(typed)) ? { kind: "partial" } : { kind: "miss" };
}
