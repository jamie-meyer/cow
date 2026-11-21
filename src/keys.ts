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
  /** `h` folds a group or goes to its head; `l` unfolds it or steps into it. */
  | { kind: "fold"; key: "h" | "l" }
  /** Mark the line's reply as seen. */
  | { kind: "seen" }
  /** Move a not-started item up or down its list. */
  | { kind: "reorder"; by: 1 | -1 }
  /** Narrow the page to the lines that match what is typed. */
  | { kind: "filter" }
  /** Inside an open brief: run its check again. On a line: show the capabilities its thread holds. */
  | { kind: "recheck" }
  /** Open the capabilities sheet. */
  | { kind: "caps" }
  /** Close what is open over the page. */
  | { kind: "close" }
  /** Mark the line as a project, or take the mark off. */
  | { kind: "project" }
  /** Say the line waits on someone other than the person, or clear that. */
  | { kind: "wait" }
  /** Scroll the chat in the pane: a few lines, or half of what shows. */
  | { kind: "chat-scroll"; by: 1 | -1; half: boolean }
  /** Scroll the chat in the pane to its newest message. */
  | { kind: "chat-end" }
  | { kind: "help" }
  | { kind: "choose-main" }
  /** Bring the selected thread from Outside Main under Main. */
  | { kind: "bring" }
  /** The actions other plugins offer for the selected thread. */
  | { kind: "more" }
  /** Hide or show the context card in this window. */
  | { kind: "card" }
  /** Say what a worker under Archived or To settle came to, or change it. */
  | { kind: "outcome" }
  /** Open the ledger sheet. */
  | { kind: "ledger" }
  /** Open the workspaces sheet. */
  | { kind: "workspaces" }
  /** Bring the selected clone thread's work back to its sources. */
  | { kind: "bring-back" };

/** The key map as the legend shows it: grouped by what the person is doing. */
export const KEY_GROUPS: readonly { title: string; keys: readonly { keys: string; does: string }[] }[] = [
  {
    title: "Moving around",
    keys: [
      { keys: "j k", does: "next, previous line (arrows work too); the heading, Main, is the line above the first" },
      { keys: "gg G", does: "the heading, the last line" },
      { keys: "h l", does: "fold, unfold a group, or the To settle, Kept, Automations and Outside Main sections on their headings, or an automation's runs on its row; on a member, h goes to its group's head or its section's heading, and on a run to its automation (left, right arrows too)" },
      { keys: "Tab", does: "next entry in the queue of what waits on you (Shift+Tab previous)" },
      { keys: "1 to 9", does: "jump to that entry in the queue" },
      { keys: "/", does: "filter: type to narrow the page to matching lines; Ctrl+n, Ctrl+p or arrows move, Enter keeps the line, shown and unfolded so j reaches what is under it, Esc cancels" },
      { keys: "f", does: "letter hints on every line, action, link and button in view, the chat's included; again for a menu it opened. A hint on a file opens it in the reader, and one on a link to a thread opens that thread in the pane" },
    ],
  },
  {
    title: "Reading a thread and talking to it",
    keys: [
      { keys: "Enter", does: "open the line's chat beside the overview, or switch the pane to it; it never types into the chat. On an automation's row, its latest run's chat, or for a script what its last run printed, in the reader" },
      { keys: "m", does: "open Main's chat the same way" },
      { keys: "; '", does: "scroll the open chat down, up a few lines, from the overview; : and \" by half a page; \\ goes to its newest message" },
      { keys: "i", does: "type in the chat that is open, wherever the cursor is: the only key that does; with no chat open, say something to Main" },
      { keys: "I", does: "say something to the selected thread" },
      { keys: "Esc", does: "leave the chat, then close it; after following a link to a thread in the chat, it first goes back to the chat you came from, as many times as you followed one; cancel a prompt" },
      { keys: "Cmd+[ Cmd+]", does: "bb's back and forward: walk the chats opened on this page, closing the pane included. The page's address names the open chat, so a reload reopens it; a chat reopened that way marks no reply seen until you open it with Enter" },
    ],
  },
  {
    title: "Dealing with what waits on you",
    keys: [
      { keys: "a", does: "answer the line's ask or question, grant or deny its permission request, or deal with a permission bb refused: digits choose, Enter confirms; an ask with more at stake is shown back first, or needs a word typed. A request or a refusal can be saved as a capability from its card. On a thread's request for a capability (its line says press a to allow or refuse), 1 allows it: the steps open at once and end in a confirmation; 2, then Enter, refuses it" },
      { keys: "b", does: "open the line's brief over the page: disputes first. In it: j k move, l or Enter opens a claim's evidence, h closes it, a answers a judgement call, c runs the check again (y confirms), q or Esc closes" },
      { keys: "Space", does: "mark a reply as seen: the line stops waiting on you, and stays where it is, dimmed, until the page is reloaded; on a line to settle, or a project or Main marked with the unread dot, it is no longer unread; on a line whose request was decided outside cow, acknowledge that" },
      { keys: "w", does: "say the line is waiting on someone else: who or what, then a reminder (19 Nov, +3d, +2w) or nothing. On a waiting line, w clears it (y confirms); when its reminder comes, a keeps it waiting or takes it back" },
    ],
  },
  {
    title: "Setting work aside, ending it, taking it back",
    keys: [
      { keys: "p", does: "park it: a reason, then 19 Nov, +3d, +2w, a condition, or nothing" },
      { keys: "r", does: "resume a parked line: back into the tree" },
      { keys: "e", does: "archive a done, idle, waiting, kept or failed line, or a line in Outside Main at rest with nothing open under it: a reason or nothing, then Enter. On a finished worker (done, waiting or kept; not a project, Main or an automation's run) it first asks what it came to: 1 done, 2 partial, 3 redone, 4 dropped, or Enter to leave it unsaid. On an automation's row, delete the automation (y confirms): its past runs stay, and u cannot bring it back" },
      { keys: "z", does: "keep a line that is not running: it goes to Kept, asks for nothing and reminds you of nothing, until it starts a turn. A few words or nothing, then Enter. On a kept line, z takes it off Kept" },
      { keys: "x", does: "stop a running turn (y confirms); on parked work that came back, drop it, with a reason; on a not-started item, remove it" },
      { keys: "A", does: "on a line in Outside Main, bring that thread under Main (y confirms): Main gets a short notice from bb and starts a turn, and the thread's notifications to Main are set to stuck, so it does not wake Main each time it finishes a turn" },
      { keys: "u", does: "undo the last park, resume, archive, dismissal, mark as seen, project mark, wait, keep or move under Main (y confirms). A sent message, an answer, a decision and a stopped turn cannot be undone" },
      { keys: "P", does: "mark a line as a project, or unmark it: a project is never done; when quiet it reads idle and stays in the tree" },
      { keys: "J K", does: "move a not-started item down, up its list" },
    ],
  },
  {
    title: "What finished work came to",
    keys: [
      { keys: "o", does: "on a line under Archived or To settle, say what the worker came to, or change it: 1 done (the work was used as it came back), 2 partial (some of it was used, or it needed a second worker), 3 redone (it was wrong, and you or another thread redid it), 4 dropped (it was not used); any other key cancels. Signed as yours: no thread can overwrite it" },
      { keys: "L", does: "the ledger over the page: for the last 14 days, by model, by dispatching thread and by label (the kind of job, then by model within it), how many workers, each outcome, the median time to first report and steers before it, how many you judged, the tokens and list-price dollars and the dollars per done; then the latest rows, and this month's tokens and dollars under Main (workers, project threads, Main, cow's checker runs). Dollars are an estimate at list price, not a bill. It holds no titles, prompts or message text. b shows one grouping at a time, j k scroll, q or Esc closes" },
    ],
  },
  {
    title: "Capabilities and this page's key",
    keys: [
      { keys: "c", does: "show the capabilities the line's thread holds, and where each comes from: itself, a thread above it, or Main; c or Esc closes" },
      { keys: "C", does: "the capabilities sheet over the page: n makes one, x deletes (y confirms), u undoes a delete, Enter shows its history, Space acknowledges a new one, a decision made outside cow, or what an agent took out of your queue (on that, Enter opens the thread's chat), Tab shows the log, q or Esc closes. It also lists the keys enrolled to act as you, this page's among them: Enter approves a page that asks, x refuses or removes one" },
    ],
  },
  {
    title: "Reading a file",
    keys: [
      { keys: "(reader)", does: "a file opens over the page, read-only: j k move, Ctrl+d Ctrl+u half a page, Ctrl+f Ctrl+b a page, gg G and 12G, { } by block, / searches with n N, f hints its links, r raw Markdown, u splits a diff, y Y copy the path, o opens it in bb's panel, q or Esc goes back" },
    ],
  },
  {
    title: "Workspaces",
    keys: [
      { keys: "W", does: "the workspaces sheet over the page: each workspace folder cow knows, whether its cow.workspace.json is approved, and each repository with its last sync, whether it is dirty and which commands it has. j k move, s syncs the selected repository, S every approved workspace, Enter shows the selected one's last sync output in the reader (signed: output may hold secrets), or says it never ran; r opens its workspace's file when it has changed since you approved it; below them the held clones (bb removed them, cow kept them since work might be lost): Enter shows what their teardowns printed (signed), t runs the approved teardown again and removes the clone when nothing holds it any more, d asks to remove one for good, naming what would be lost, and y confirms (each signed); q or Esc closes" },
      { keys: "(workspace notice)", does: "a workspace file that is new or changed waits in the queue; a click or its hint opens it in the reader: the commands that would newly run first, then the change. There a approves exactly the content shown (refused if the file changed since), x dismisses it without approving until it changes again. Signed: no thread can approve" },
      { keys: "(held notice)", does: "a clone bb removed that cow held back (a teardown failed, or a repository without one held unsaved work) waits in the queue until you decide; a click or its hint opens W on it" },
      { keys: "B", does: "on a thread that runs in a copy-on-write workspace, bring its work back: names each repository with new commits and the approved back command it would run, then y runs them in the sources (signed); any other key cancels. This is the only way a back command runs" },
    ],
  },
  {
    title: "Other plugins",
    keys: [
      { keys: "v", does: "hide or show the context card in this window, which remembers it across a reload: what bb and other plugins know about the selected line's thread (its pull request, its changed files, and any section another plugin adds), at the bottom of the right column above the legend, or at the top of the chat pane for the open chat, folded there to its section titles when it is long. It is no stop for j and k; f hints its links, files and folded titles" },
      { keys: ".", does: "list what other plugins offer for the line's thread, such as a pull request's checks or a restack: a digit or letter runs one, in that plugin's own code and under its authority, not cow's; one with choices shows them next, and Esc goes back. A dimmed one is turned off by its plugin. Esc closes the list. The verb bar shows . more only when there is something to list" },
    ],
  },
  {
    title: "The page itself",
    keys: [
      { keys: "M", does: "choose a different Main for this window" },
      { keys: "Ctrl+Option+C", does: "from anywhere in bb (a thread's chat, another page, settings): open cow's page. On the page it does nothing, so the open chat and the selection stay. Ctrl+Alt+C off macOS; rebind it in bb's keyboard settings as \"🐄 cow: open cow's page\", which is in bb's command palette too" },
      { keys: "?", does: "this legend; ?, q or Esc closes it" },
    ],
  },
];

/** Every entry of the key map, in the legend's order. */
export const KEY_MAP: readonly { keys: string; does: string }[] = KEY_GROUPS.flatMap((group) => group.keys);

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
      case "h":
      case "ArrowLeft":
        return { kind: "fold", key: "h" };
      case "l":
      case "ArrowRight":
        return { kind: "fold", key: "l" };
      case " ":
        return { kind: "seen" };
      case "/":
        return { kind: "filter" };
      case "J":
        return { kind: "reorder", by: 1 };
      case "K":
        return { kind: "reorder", by: -1 };
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
      case "z":
        return { kind: "verb", verb: "keep" };
      case "b":
        return { kind: "verb", verb: "brief" };
      case "c":
        return { kind: "recheck" };
      case "C":
        return { kind: "caps" };
      case "q":
        return { kind: "close" };
      case "P":
        return { kind: "project" };
      case "A":
        return { kind: "bring" };
      case ".":
        return { kind: "more" };
      case "v":
        return { kind: "card" };
      case "o":
        return { kind: "outcome" };
      case "L":
        return { kind: "ledger" };
      case "W":
        return { kind: "workspaces" };
      case "B":
        return { kind: "bring-back" };
      case "w":
        return { kind: "wait" };
      case ";":
        return { kind: "chat-scroll", by: 1, half: false };
      case "'":
        return { kind: "chat-scroll", by: -1, half: false };
      case ":":
        return { kind: "chat-scroll", by: 1, half: true };
      case '"':
        return { kind: "chat-scroll", by: -1, half: true };
      case "\\":
        return { kind: "chat-end" };
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
function hostPopups(): HTMLElement[] {
  const open: HTMLElement[] = [];
  for (const popup of document.querySelectorAll<HTMLElement>(POPUPS)) {
    // A floating wrapper says nothing itself; what it holds says whether it
    // is open. A menu that is closing stays in the page until it has faded.
    const held = popup.firstElementChild instanceof HTMLElement ? popup.firstElementChild.dataset.state : undefined;
    if ((popup.dataset.state ?? held) === "closed") continue;
    if (popup.closest('[data-cow-root], [inert], [aria-hidden="true"]')) continue;
    // A tooltip floats the same way a menu does, and takes no keys.
    if (popup.querySelector('[role="tooltip"]') && !popup.querySelector('[role="menu"], [role="listbox"], [role="dialog"]')) continue;
    if (popup.checkVisibility()) open.push(popup);
  }
  return open;
}
const hostPopupOpen = (): boolean => hostPopups().length > 0;

export interface KeyOwner {
  /** A key pressed while the cursor is in the overview. */
  onKey(key: string, shift: boolean): void;
  /** Escape pressed inside the embedded chat: give the cursor back. */
  onLeaveChat(): void;
  /** Hint mode is on: every key is a hint letter, wherever focus is. */
  capturing?(): boolean;
  /**
   * A key pressed with Ctrl alone, outside any field. True when the page
   * took it; otherwise it is left to bb like every other modified key.
   */
  onCtrl?(key: string): boolean;
}

/**
 * Listen for keys in the capture phase on `window`, so the page hears them
 * before bb does wherever focus has drifted.
 *
 * - Modified keys are bb's, except Ctrl with a letter while the reader is
 *   open: its page and half-page keys.
 * - Typing in any field works normally.
 * - Inside the embedded chat every key is the chat's, except Escape, which
 *   returns to the overview, and `f` when focus is on something that is not
 *   a field.
 * - Anywhere else the overview owns every plain key and lets none through,
 *   so a digit can never answer a question in the embedded chat by accident.
 * - While a menu or dialog of bb's is open the keyboard is its own, except
 *   `f`, which puts hints on what it offers.
 * - In hint mode every key is a hint letter, wherever focus is.
 */
export function attachKeys(owner: KeyOwner): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const typing = target !== null && isEditable(target);
      if (!typing && !hostPopupOpen() && owner.onCtrl?.(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!owner.capturing?.()) {
      const inPage = target?.closest("[data-cow-root]") != null;
      const typing = target !== null && isEditable(target);
      if (!inPage && hostPopupOpen()) {
        if (event.key !== "f" || typing) return;
      } else {
        const inChat = target?.closest("[data-cow-chat]") != null;
        // Focus left on one of the chat's buttons, by a menu that closed, say,
        // is not typing: f still asks for hints.
        if (inChat && !(event.key === "f" && !typing)) {
          if (event.key === "Escape" && !hostPopupOpen()) {
            event.preventDefault();
            event.stopPropagation();
            owner.onLeaveChat();
          }
          return;
        }
        // Fields of ours handle their own keys; fields of bb's are bb's.
        if (typing) return;
      }
    }
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
  /** Where to draw the label, in the window. */
  left: number;
  top: number;
}

/** What in another plugin's badge takes a hint: a link, and nothing else. */
const BADGE_LINK = "a[href], [role=link]";

/** Anything a click or a caret can use, by element type and by role. */
const CLICKABLE = [
  "a[href]",
  "button",
  "summary",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable=false])",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=option]",
  "[role=tab]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[role=textbox]",
  "[role=treeitem]",
  "[aria-haspopup]",
  "[aria-expanded]",
  "[tabindex]:not([tabindex^='-'])",
].join(", ");

function isOff(element: HTMLElement): boolean {
  return (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true" ||
    // Not aria-hidden: bb hides the page from screen readers while one of its
    // menus is open, and for as long as the menu takes to fade once closed.
    // What can be clicked is decided by what a click would reach.
    element.closest("[inert]") !== null
  );
}

/**
 * Whether a click at the element's middle would reach it: on screen, not
 * clipped away, not covered. A button that is drawn only while the mouse is
 * over its row (the chat's copy and message actions) is transparent until
 * then and still takes the click, so it counts.
 */
function reachable(element: HTMLElement, rect: DOMRect): boolean {
  if (rect.width < 2 || rect.height < 2 || !element.checkVisibility({ checkVisibilityCSS: true })) return false;
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, window.innerWidth);
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  if (right - left < 2 || bottom - top < 2) return false;
  for (const [x, y] of [
    [(left + right) / 2, (top + bottom) / 2],
    [left + 2, top + 2],
  ] as const) {
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && (hit === element || element.contains(hit))) return true;
  }
  return false;
}

/**
 * Everything on the page a hint can use, most important first: cow's lines,
 * then cow's own actions, then every other clickable thing in view, which
 * is what bb draws in the embedded chat. cow's own keep their place in the
 * order whatever the chat shows, so their labels stay short and the same.
 *
 * While a menu or dialog of bb's is open outside the page, only what it
 * offers takes a hint: that is where the next click goes.
 */
export function collectHintTargets(page: HTMLElement): HintTarget[] {
  // A sheet open over the page covers it: only what is in the sheet can be used.
  // So does the menu of what other plugins offer, while it is open under its line.
  const root = page.querySelector<HTMLElement>("[data-cow-reader]") ?? page.querySelector<HTMLElement>("[data-cow-sheet]") ?? page.querySelector<HTMLElement>("[data-cow-more]") ?? page;
  const popups = hostPopups();
  const lines: HintTarget[] = [];
  const own: HintTarget[] = [];
  const others: HintTarget[] = [];
  const taken = new Set<string>();
  const add = (into: HintTarget[], element: HTMLElement, rect: DOMRect) => {
    const left = Math.max(0, rect.left - 3);
    const top = Math.max(0, rect.top + Math.max(0, (Math.min(rect.height, 28) - 15) / 2));
    // Two targets drawn on the same spot are one thing to the eye: the outer one stands for both.
    const spot = `${Math.round(left / 4)}:${Math.round(top / 4)}`;
    if (taken.has(spot)) return;
    taken.add(spot);
    into.push({ element, left, top });
  };
  if (popups.length === 0) {
    for (const element of root.querySelectorAll<HTMLElement>("[data-cow-hint]")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const clip = (element.closest("[data-cow-scroll]") ?? root).getBoundingClientRect();
      if (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) continue;
      const isLine = element.dataset.cowLine !== undefined || element.dataset.cowTodo !== undefined || element.dataset.cowBriefItem !== undefined;
      add(isLine ? lines : own, element, rect);
    }
  }
  for (const scope of popups.length > 0 ? popups : [root]) {
    for (const element of scope.querySelectorAll<HTMLElement>(CLICKABLE)) {
      // Inside one of cow's own targets it is that target. A badge another plugin draws on a line is
      // not a control: only a link in one is a target of its own.
      const inBadge = element.closest("[data-cow-badges]") !== null;
      if (inBadge ? !element.matches(BADGE_LINK) : element.closest("[data-cow-hint]") !== null) continue;
      if (isOff(element)) continue;
      const rect = element.getBoundingClientRect();
      if (reachable(element, rect)) add(others, element, rect);
    }
  }
  return [...lines, ...own, ...others];
}

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

/** Whether activating the element means putting the caret in it. */
export function takesCaret(element: HTMLElement): boolean {
  if (element.isContentEditable || element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
  return element.tagName === "INPUT" && TEXT_INPUTS.has((element.getAttribute("type") ?? "").toLowerCase());
}

/**
 * Use a hint's target as a click of the mouse would: the press, the release
 * and the click, in the middle of the element. Menus that open on the press
 * open, links follow their href, and a field takes the caret. Nothing but a
 * field is given focus, so the keyboard stays with the overview and the next
 * key is still cow's.
 */
export function activate(element: HTMLElement): void {
  if (takesCaret(element)) {
    element.focus();
    return;
  }
  const rect = element.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
  element.dispatchEvent(new PointerEvent("pointerup", pointer));
  element.dispatchEvent(new MouseEvent("mouseup", at));
  element.click();
}
