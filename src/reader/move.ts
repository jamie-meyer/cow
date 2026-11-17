// The reader's movement, in the manner of vim: which keys mean what, with a
// count before them, and where the cursor lands. Pure. Lines are 0-based
// here; the reader shows them 1-based.

export type Motion =
  | { kind: "lines"; by: number }
  | { kind: "half"; by: 1 | -1 }
  | { kind: "page"; by: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" }
  /** `<n>G`: to line n, 1-based. */
  | { kind: "goto"; line: number }
  | { kind: "block"; by: 1 | -1 };

export type ReaderKey =
  | { kind: "motion"; motion: Motion }
  | { kind: "search" }
  | { kind: "match"; by: 1 | -1 }
  | { kind: "hints" }
  | { kind: "raw" }
  | { kind: "split" }
  | { kind: "copy"; withLine: boolean }
  | { kind: "panel" }
  | { kind: "close" }
  /** A digit or a first `g`: more keys are needed. */
  | { kind: "pending" }
  | { kind: "none" };

/** How long after `g` a second `g` still means "top". */
const CHORD_MS = 800;
const MAX_COUNT = 9_999_999;

/** Turns keys into what the reader does, remembering a count and a pending `g`. */
export class ReaderKeys {
  private count = "";
  private pendingG = 0;

  /** The count typed so far, for the status line. */
  get typed(): string {
    return this.count + (this.pendingG > 0 ? "g" : "");
  }

  reset(): void {
    this.count = "";
    this.pendingG = 0;
  }

  read(key: string, ctrl: boolean, now: number): ReaderKey {
    if (!ctrl && /^[0-9]$/.test(key) && (key !== "0" || this.count !== "")) {
      this.pendingG = 0;
      if (Number(this.count + key) <= MAX_COUNT) this.count += key;
      return { kind: "pending" };
    }
    const chord = !ctrl && key === "g" && this.pendingG > 0 && now - this.pendingG < CHORD_MS;
    if (!ctrl && key === "g" && !chord) {
      this.pendingG = now;
      return { kind: "pending" };
    }
    const n = this.count === "" ? null : Number(this.count);
    this.reset();
    const times = n ?? 1;
    if (ctrl) {
      switch (key) {
        case "d":
          return { kind: "motion", motion: { kind: "half", by: 1 } };
        case "u":
          return { kind: "motion", motion: { kind: "half", by: -1 } };
        case "f":
          return { kind: "motion", motion: { kind: "page", by: 1 } };
        case "b":
          return { kind: "motion", motion: { kind: "page", by: -1 } };
        default:
          return { kind: "none" };
      }
    }
    switch (key) {
      case "j":
      case "ArrowDown":
      case "Enter":
        return { kind: "motion", motion: { kind: "lines", by: times } };
      case "k":
      case "ArrowUp":
        return { kind: "motion", motion: { kind: "lines", by: -times } };
      case "g":
        return { kind: "motion", motion: n === null ? { kind: "top" } : { kind: "goto", line: n } };
      case "G":
        return { kind: "motion", motion: n === null ? { kind: "bottom" } : { kind: "goto", line: n } };
      case "}":
        return { kind: "motion", motion: { kind: "block", by: 1 } };
      case "{":
        return { kind: "motion", motion: { kind: "block", by: -1 } };
      case " ":
        return { kind: "motion", motion: { kind: "page", by: 1 } };
      case "/":
        return { kind: "search" };
      case "n":
        return { kind: "match", by: 1 };
      case "N":
        return { kind: "match", by: -1 };
      case "f":
        return { kind: "hints" };
      case "r":
        return { kind: "raw" };
      case "u":
        return { kind: "split" };
      case "y":
        return { kind: "copy", withLine: false };
      case "Y":
        return { kind: "copy", withLine: true };
      case "o":
        return { kind: "panel" };
      case "q":
      case "Escape":
        return { kind: "close" };
      default:
        return { kind: "none" };
    }
  }
}

const clamp = (value: number, total: number): number => Math.max(0, Math.min(Math.max(0, total - 1), value));

/**
 * The line a block motion lands on: `}` goes to the next blank line below a
 * line that is not blank, `{` to the one above; the last or first line when
 * there is none. `blank[i]` says whether line i is blank.
 */
export function blockTarget(blank: readonly boolean[], cursor: number, by: 1 | -1): number {
  const total = blank.length;
  let at = cursor + by;
  // Leave the run of blank lines the cursor is in or beside.
  while (at >= 0 && at < total && blank[at]) at += by;
  while (at >= 0 && at < total && !blank[at]) at += by;
  return clamp(at, total);
}

/**
 * Where a motion puts the cursor. `total` is how many lines there are,
 * `page` how many fit in the window, `blank` which lines are blank (for
 * block motions; without it they move a page).
 */
export function moveCursor(cursor: number, motion: Motion, total: number, page: number, blank?: readonly boolean[]): number {
  const span = Math.max(1, page);
  switch (motion.kind) {
    case "lines":
      return clamp(cursor + motion.by, total);
    case "half":
      return clamp(cursor + motion.by * Math.max(1, Math.floor(span / 2)), total);
    case "page":
      // Two lines stay in view from the page before, as in vim.
      return clamp(cursor + motion.by * Math.max(1, span - 2), total);
    case "top":
      return 0;
    case "bottom":
      return clamp(total - 1, total);
    case "goto":
      return clamp(motion.line - 1, total);
    case "block":
      return blank && blank.length === total ? blockTarget(blank, cursor, motion.by) : clamp(cursor + motion.by * Math.max(1, Math.floor(span / 2)), total);
  }
}

/**
 * How far to scroll so the line at `top`..`top + height` is in a window
 * that shows `viewTop`..`viewTop + viewHeight`, keeping `margin` clear above
 * and below where there is room. 0 when it is in view already.
 */
export function scrollToShow(top: number, height: number, viewTop: number, viewHeight: number, margin: number): number {
  const keep = Math.max(0, Math.min(margin, (viewHeight - height) / 2));
  if (top < viewTop + keep) return top - keep - viewTop;
  if (top + height > viewTop + viewHeight - keep) return top + height + keep - (viewTop + viewHeight);
  return 0;
}
