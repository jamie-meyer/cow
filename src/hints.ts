// Letter hints: one label per target on screen, typed to activate it.

/** Home-row letters, so every hint is under the fingers. */
export const HINT_ALPHABET = "asdfghjkl";

/**
 * Labels for `count` targets, in target order. All labels have the same
 * length (the shortest that fits), so none is a prefix of another and a hint
 * fires on its last letter.
 */
export function hintLabels(count: number, alphabet: string = HINT_ALPHABET): string[] {
  if (count <= 0) return [];
  const letters = [...alphabet];
  if (letters.length < 2) throw new Error("the hint alphabet needs at least two letters");
  let length = 1;
  while (letters.length ** length < count) length += 1;
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let label = "";
    let rest = index;
    for (let position = 0; position < length; position += 1) {
      label = letters[rest % letters.length] + label;
      rest = Math.floor(rest / letters.length);
    }
    labels.push(label);
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
