// The reader's view of what is drawn: the rows the cursor moves over, read
// from the page after bb's components have drawn a file, and where each row
// and each search match is on screen. bb's source and diff viewers draw
// their lines inside an open shadow root; Markdown is drawn in the page.

import type { Match } from "./search.ts";

/** One line the cursor can rest on: one element, or the two halves of a split diff's line. */
export interface Row {
  els: HTMLElement[];
  text: string;
}

/** Blocks of drawn Markdown that are a row each, when nothing inside them is one. */
const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, tr, pre, blockquote, hr, img, .sh__line";

function shadowLines(container: HTMLElement): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const host of container.querySelectorAll<HTMLElement>("diffs-container")) {
    const root = host.shadowRoot;
    if (!root) continue;
    for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
      if (!line.closest("[data-gutter]")) lines.push(line);
    }
  }
  return lines;
}

/** Whether a split diff is drawn: its lines come in pairs, side by side. */
function isSplit(container: HTMLElement): boolean {
  for (const host of container.querySelectorAll<HTMLElement>("diffs-container")) {
    if (host.shadowRoot?.querySelector('[data-diff-type="split"]')) return true;
  }
  return false;
}

/** Everything the cursor can rest on inside `container`, top to bottom. */
export function collectRows(container: HTMLElement): Row[] {
  const own = [...container.querySelectorAll<HTMLElement>("[data-cow-rd-line]")];
  if (own.length > 0) return own.map((el) => ({ els: [el], text: el.textContent ?? "" }));
  const lines = shadowLines(container);
  if (lines.length > 0) {
    if (!isSplit(container)) return lines.map((el) => ({ els: [el], text: el.textContent ?? "" }));
    // Lines drawn at the same height are one row.
    const byTop = new Map<number, HTMLElement[]>();
    for (const el of lines) {
      const top = Math.round(el.getBoundingClientRect().top);
      const group = byTop.get(top);
      if (group) group.push(el);
      else byTop.set(top, [el]);
    }
    return [...byTop.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, els]) => {
        els.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return { els, text: els.map((el) => el.textContent ?? "").join("\t") };
      });
  }
  const blocks = [...container.querySelectorAll<HTMLElement>(BLOCKS)].filter((el) => el.querySelector(BLOCKS) === null && el.closest("[data-cow-rd-layer]") === null);
  return blocks.map((el) => ({ els: [el], text: el.textContent ?? "" }));
}

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where a row is, relative to `origin`'s top left corner. Null when it is not drawn. */
export function rowBox(row: Row, origin: DOMRect): Box | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of row.els) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (top === Infinity) return null;
  return { top: top - origin.top, left: 0, width: origin.width, height: bottom - top };
}

/** The text nodes of an element, in order, with the offset each starts at. */
function textNodes(el: HTMLElement): { node: Text; at: number }[] {
  const nodes: { node: Text; at: number }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, at });
    at += (node as Text).data.length;
  }
  return nodes;
}

/** Where a match is drawn, relative to `origin`: one box for each line it wraps onto. */
export function matchBoxes(row: Row, match: Match, origin: DOMRect): Box[] {
  // A row of two halves joins their texts with one character between.
  let offset = 0;
  for (const el of row.els) {
    const length = (el.textContent ?? "").length;
    if (match.start >= offset && match.end <= offset + length) {
      const nodes = textNodes(el);
      const find = (target: number, end: boolean) => {
        for (const entry of nodes) {
          const last = entry.at + entry.node.data.length;
          if (target < last || (end && target === last)) return { node: entry.node, offset: target - entry.at };
        }
        return null;
      };
      const from = find(match.start - offset, false);
      const to = find(match.end - offset, true);
      if (!from || !to) return [];
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return [...range.getClientRects()].map((rect) => ({ top: rect.top - origin.top, left: rect.left - origin.left, width: rect.width, height: rect.height }));
    }
    offset += length + 1;
  }
  return [];
}

/** The line number bb's viewer gives a row, when it gives one. */
export function rowLineNumber(row: Row): number | null {
  for (const el of [...row.els].reverse()) {
    const value = Number(el.dataset.line);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}
