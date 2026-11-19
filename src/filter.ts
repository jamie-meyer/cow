// Narrowing the page to the lines that match what the user types, in the
// manner of a fuzzy finder.
//
// The matches keep the tree's order: ranking them would pull a line away
// from its group. A line matches when every word typed is found in it: in
// its name loosely (the word's letters in order, with anything between), or
// in what it is doing exactly. Case never matters.

import type { Overview } from "./tree.ts";

/** Whether the letters of `word` appear in `text` in order. Both lower case. */
function inOrder(word: string, text: string): boolean {
  let at = 0;
  for (const letter of word) {
    at = text.indexOf(letter, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** Whether a row named `name`, doing `doing`, matches `query`. An empty query matches everything. */
export function matches(query: string, name: string, doing = ""): boolean {
  const title = name.toLowerCase();
  const rest = doing.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => inOrder(word, title) || rest.includes(word));
}

export interface Filtered {
  /** The rows that match, in page order: the tree, Parked, To settle, Kept, Automations, Outside Main, then Archived. The cursor moves among these. */
  matches: string[];
  /** The tree rows to draw: the matches, and the heads of the groups they are in, for context; and the automations whose runs match. */
  keep: ReadonlySet<string>;
}

/**
 * The rows of the page that match `query`. Folds are not consulted: a match
 * inside a folded group is found, and its heads are kept so that it is
 * drawn where it belongs.
 */
export function filterOverview(overview: Overview, query: string): Filtered {
  const found: string[] = [];
  const keep = new Set<string>();
  /** The heads above the current row, by depth. */
  const heads: string[] = [];
  for (const row of overview.rows) {
    heads.length = row.depth;
    const hit =
      row.kind === "line"
        ? matches(query, row.line.thread.title, row.line.derived.doing)
        : matches(query, row.item.title);
    if (hit) {
      found.push(row.id);
      keep.add(row.id);
      for (const head of heads) keep.add(head);
    }
    heads[row.depth] = row.id;
  }
  // A folded section is searched too: what matches in it is drawn while the filter is open.
  for (const line of [...overview.parked, ...overview.asideAsks, ...overview.settle, ...overview.kept]) {
    if (matches(query, line.thread.title, line.derived.doing)) found.push(line.thread.id);
  }
  // The automations, each by its name, and their runs; a run's automation is drawn with it, for context.
  for (const group of overview.automations.groups) {
    if (matches(query, group.automation.name)) found.push(group.id);
    for (const line of group.runs) {
      if (!matches(query, line.thread.title, line.derived.doing)) continue;
      found.push(line.thread.id);
      keep.add(group.id);
    }
  }
  // Outside Main, folded or not, then Archived last, as on the page.
  for (const line of overview.outside.lines) {
    if (matches(query, line.thread.title)) found.push(line.thread.id);
  }
  for (const line of overview.archived) {
    if (matches(query, line.thread.title, line.derived.doing)) found.push(line.thread.id);
  }
  return { matches: found, keep };
}
