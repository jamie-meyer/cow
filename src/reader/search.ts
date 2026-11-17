// Searching what the reader shows, line by line. Pure: the reader gives the
// lines as text and draws the matches it gets back.

export interface Match {
  /** 0-based line. */
  line: number;
  /** Character offsets in that line: start inclusive, end exclusive. */
  start: number;
  end: number;
}

/** The most matches kept; a search that finds more says so. */
export const MAX_MATCHES = 2000;

/**
 * Every place `query` occurs in `lines`, in order. As in vim with smartcase:
 * case is ignored unless the query has a capital letter in it.
 */
export function findMatches(lines: readonly string[], query: string, max: number = MAX_MATCHES): { matches: Match[]; more: boolean } {
  const matches: Match[] = [];
  if (query === "") return { matches, more: false };
  const exact = query !== query.toLowerCase();
  const needle = exact ? query : query.toLowerCase();
  for (let line = 0; line < lines.length; line += 1) {
    const text = exact ? lines[line]! : lines[line]!.toLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      if (matches.length >= max) return { matches, more: true };
      matches.push({ line, start: at, end: at + needle.length });
    }
  }
  return { matches, more: false };
}

/**
 * The match to go to from the cursor's line: with `by` 1 the first on a
 * later line, with -1 the last on an earlier one, wrapping round the end.
 * `from` is the match the cursor is on now, when it is on one. Null when
 * there are no matches.
 */
export function stepMatch(matches: readonly Match[], cursorLine: number, by: 1 | -1, from: number | null = null): { index: number; wrapped: boolean } | null {
  if (matches.length === 0) return null;
  if (from !== null && matches[from]?.line === cursorLine) {
    const next = from + by;
    if (next >= 0 && next < matches.length) return { index: next, wrapped: false };
    return { index: by > 0 ? 0 : matches.length - 1, wrapped: true };
  }
  if (by > 0) {
    const index = matches.findIndex((match) => match.line > cursorLine);
    return index >= 0 ? { index, wrapped: false } : { index: 0, wrapped: true };
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index]!.line < cursorLine) return { index, wrapped: false };
  }
  return { index: matches.length - 1, wrapped: true };
}

/** Where a search that has just been typed lands: the first match at or after the cursor's line, else the first. */
export function firstMatch(matches: readonly Match[], cursorLine: number): number | null {
  if (matches.length === 0) return null;
  const index = matches.findIndex((match) => match.line >= cursorLine);
  return index >= 0 ? index : 0;
}
