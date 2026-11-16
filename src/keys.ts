// Keyboard rules: which keys the page owns, what each one means, and which
// elements on screen can take a hint.

import type { Verb } from "./verbs.ts";

/** What a key asks for in normal mode. */
export type Command =
  | { kind: "move"; by: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "hints" }
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "main-chat" }
  | { kind: "say"; to: "main" | "line" }
  | { kind: "ask"; by: 1 | -1 }
  | { kind: "ask-number"; number: number }
  | { kind: "verb"; verb: Verb }
  | { kind: "undo" }
  | { kind: "help" }
  | { kind: "choose-main" };

/** The key map, in the order the legend lists it. */
export const KEY_MAP: readonly { keys: string; does: string }[] = [
  { keys: "j k", does: "next, previous line (arrows work too)" },
  { keys: "gg G", does: "first, last line" },
  { keys: "f", does: "letter hints on every line and action in view" },
  { keys: "Enter", does: "open the line's chat beside the overview; again to type in it" },
  { keys: "Esc", does: "leave the chat, then close it; cancel a prompt" },
  { keys: "m", does: "open Main's chat the same way" },
  { keys: "i", does: "say something to Main" },
  { keys: "I", does: "say something to the selected thread" },
  { keys: "a", does: "answer the line's question: digits choose, Enter sends" },
  { keys: "p", does: "park it: a reason, then 19 Nov, +3d, +2w, a condition, or nothing" },
  { keys: "r", does: "resume a parked line: back into the tree" },
  { keys: "x", does: "stop a running turn; on parked work that came back, drop it (y confirms)" },
  { keys: "e", does: "archive a done or failed line (y confirms)" },
  { keys: "u", does: "undo the last park, resume or archive (y confirms)" },
  { keys: "Tab", does: "next ask in the queue (Shift+Tab previous)" },
  { keys: "1 to 9", does: "jump to that ask" },
  { keys: "M", does: "choose a different Main" },
  { keys: "?", does: "this legend" },
];

/** How long after `g` a second `g` still means "top". */
const CHORD_MS = 800;

/** Turns keys into commands, remembering a pending `g`. */
export class KeyReader {
  private pendingG = 0;

  read(key: string, shift: boolean, now: number): Command | null {
    const chord = key === "g" && now - this.pendingG < CHORD_MS;
    this.pendingG = key === "g" && !chord ? now : 0;
    switch (key) {
      case "j":
      case "ArrowDown":
        return { kind: "move", by: 1 };
      case "k":
      case "ArrowUp":
        return { kind: "move", by: -1 };
      case "g":
        return chord ? { kind: "top" } : null;
      case "G":
        return { kind: "bottom" };
      case "f":
        return { kind: "hints" };
      case "Enter":
        return { kind: "open" };
      case "Escape":
        return { kind: "back" };
      case "m":
        return { kind: "main-chat" };
      case "M":
        return { kind: "choose-main" };
      case "i":
        return { kind: "say", to: "main" };
      case "I":
        return { kind: "say", to: "line" };
      case "a":
        return { kind: "verb", verb: "answer" };
      case "p":
        return { kind: "verb", verb: "park" };
      case "r":
        return { kind: "verb", verb: "resume" };
      case "x":
        return { kind: "verb", verb: "stop" };
      case "e":
        return { kind: "verb", verb: "archive" };
      case "u":
        return { kind: "undo" };
      case "Tab":
        return { kind: "ask", by: shift ? -1 : 1 };
      case "?":
        return { kind: "help" };
      default:
        return /^[1-9]$/.test(key) ? { kind: "ask-number", number: Number(key) } : null;
    }
  }
}

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock"]);
const NAMED_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
]);

function isEditable(el: Element): boolean {
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  );
}

const POPUPS =
  '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/**
 * A menu or dialog of bb's is open, so the keyboard belongs to it. bb keeps
 * closed drawers in the page, so being present is not being open.
 */
function hostPopupOpen(): boolean {
  for (const popup of document.querySelectorAll<HTMLElement>(POPUPS)) {
    if (popup.dataset.state === "closed") continue;
    if (popup.closest('[data-cow-root], [inert], [aria-hidden="true"]')) continue;
    if (popup.checkVisibility()) return true;
  }
  return false;
}

export interface KeyOwner {
  /** A key pressed while the cursor is in the overview. */
  onKey(key: string, shift: boolean): void;
  /** Escape pressed inside the embedded chat: give the cursor back. */
  onLeaveChat(): void;
}

/**
 * Listen for keys in the capture phase on `window`, so the page hears them
 * before bb does wherever focus has drifted.
 *
 * - Modified keys are bb's.
 * - Typing in any field works normally.
 * - Inside the embedded chat every key is the chat's, except Escape, which
 *   returns to the overview.
 * - Anywhere else the overview owns every plain key and lets none through,
 *   so a digit can never answer a question in the embedded chat by accident.
 */
export function attachKeys(owner: KeyOwner): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (MODIFIER_KEYS.has(event.key)) return;
    const target = event.target instanceof Element ? event.target : null;
    const inPage = target?.closest("[data-cow-root]") != null;
    if (!inPage && hostPopupOpen()) return;
    const inChat = target?.closest("[data-cow-chat]") != null;
    if (inChat) {
      if (event.key === "Escape" && !hostPopupOpen()) {
        event.preventDefault();
        event.stopPropagation();
        owner.onLeaveChat();
      }
      return;
    }
    // Fields of ours handle their own keys; fields of bb's are bb's.
    if (target && isEditable(target)) return;
    if (event.key.length !== 1 && !NAMED_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    owner.onKey(event.key, event.shiftKey);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}

export interface HintTarget {
  element: HTMLElement;
  /** Where to draw the label, relative to the page root. */
  left: number;
  top: number;
}

/**
 * Every element marked `data-cow-hint` that is actually visible in `root`,
 * lines first so that they get the shortest hints.
 */
export function collectHintTargets(root: HTMLElement): HintTarget[] {
  const frame = root.getBoundingClientRect();
  const lines: HintTarget[] = [];
  const others: HintTarget[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-cow-hint]")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const clip = (element.closest("[data-cow-scroll]") ?? root).getBoundingClientRect();
    if (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) continue;
    (element.dataset.cowLine === undefined ? others : lines).push({
      element,
      left: Math.max(0, rect.left - frame.left - 3),
      top: rect.top - frame.top + Math.max(0, (rect.height - 15) / 2),
    });
  }
  return [...lines, ...others];
}
