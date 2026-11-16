// A refused permission: an agent tried to do something that needs the user's
// permission, on a turn the user did not start. bb asks only a person, so it
// refused by itself, told the agent no, and raised no request. This finds
// those refusals in a thread's event log and words what cow can do about one.
//
// How a refusal looks, established against bb 0.49 with the Claude Code
// provider:
// - the command or file change failed, and its `approvalStatus` is null (a
//   denial by the user has `approvalStatus: "denied"` and is not a refusal);
// - the prompt it ran under was not sent by the user;
// - its error is one of the texts bb refuses with, listed in REFUSED_WITH.
// bb marks a refusal in no other way, so the texts are what tells it from a
// command that simply failed.

import { firstLine } from "./text.ts";

/** What bb, or the provider on bb's behalf, says when it refuses without asking. */
const REFUSED_WITH: readonly RegExp[] = [
  /^bb's workspace sandbox allows work inside the current workspace only/,
  /^Path is outside allowed working directories/,
];

/** At most this many refusals are kept for one thread; the oldest go first. */
export const MAX_REFUSALS = 20;

export interface Refusal {
  /** The agent's tool call. */
  id: string;
  kind: "command" | "file_change";
  /** The command, or the file's path. */
  what: string;
  /** For a command: where it would have run, when bb says. */
  cwd: string | null;
  /** For a file change: add, modify, delete, as bb names it, and the diff. */
  change: string | null;
  diff: string | null;
  /** What bb told the agent. */
  why: string;
  /** When it was refused, and where in the thread's event log. */
  at: number;
  seq: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface LogEvent {
  seq: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}

function toLogEvent(raw: unknown): LogEvent | null {
  const r = record(raw);
  if (!r || typeof r.seq !== "number" || typeof r.type !== "string") return null;
  return {
    seq: r.seq,
    at: typeof r.createdAt === "number" ? r.createdAt : 0,
    type: r.type,
    data: record(r.data) ?? {},
  };
}

const wasRefused = (why: string): boolean => REFUSED_WITH.some((pattern) => pattern.test(why.trim()));

/** The same action: the same command, or a change to the same file. */
const sameAction = (a: Pick<Refusal, "kind" | "what">, b: Pick<Refusal, "kind" | "what">): boolean =>
  a.kind === b.kind && a.what === b.what;

/** The actions an item is about, and how it ended. */
function itemActions(
  item: Record<string, unknown>,
): { status: string; why: string; actions: Pick<Refusal, "kind" | "what" | "cwd" | "change" | "diff">[] } | null {
  const status = text(item.status);
  if (item.type === "commandExecution" && typeof item.command === "string" && item.command !== "") {
    return {
      status,
      why: text(item.aggregatedOutput),
      actions: [{ kind: "command", what: item.command, cwd: text(item.cwd) || null, change: null, diff: null }],
    };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const actions = [];
    for (const raw of item.changes) {
      const change = record(raw);
      if (!change || typeof change.path !== "string" || change.path === "") continue;
      actions.push({
        kind: "file_change" as const,
        what: change.path,
        cwd: null,
        change: text(change.kind) || null,
        diff: text(change.diff) || null,
      });
    }
    return { status, why: text(item.error), actions };
  }
  return null;
}

/**
 * The refusals in a thread's events that are still unresolved, oldest first.
 * The events may come in any order and need only be the recent ones: the
 * kinds read are `client/turn/requested`, `turn/started` and `item/completed`.
 *
 * A refusal is unresolved while all of this holds:
 * - it happened in the thread's latest turn (a newer turn means whoever
 *   runs the thread has moved it on);
 * - the user has not sent the thread a message since (then they know, or
 *   have just asked again);
 * - the same command has not run, and the same file has not been changed,
 *   successfully since.
 * An action refused before the oldest event given cannot be seen, and one
 * whose prompt is not among the events is left out rather than guessed at.
 */
export function findRefusals(events: readonly unknown[]): Refusal[] {
  const log = events
    .map(toLogEvent)
    .filter((event): event is LogEvent => event !== null)
    .sort((a, b) => a.seq - b.seq);
  let open: Refusal[] = [];
  /** Who sent the prompt the agent is working under; null before the first one seen. */
  let initiator: string | null = null;
  for (const event of log) {
    if (event.type === "turn/started") {
      open = [];
    } else if (event.type === "client/turn/requested") {
      initiator = text(event.data.initiator) || null;
      if (initiator === "user") open = [];
    } else if (event.type === "item/completed") {
      const item = record(event.data.item);
      const found = item && itemActions(item);
      if (!item || !found) continue;
      if (found.status === "completed") {
        open = open.filter((refusal) => !found.actions.some((action) => sameAction(action, refusal)));
      } else if (
        found.status === "failed" &&
        item.approvalStatus == null &&
        initiator !== null &&
        initiator !== "user" &&
        wasRefused(found.why)
      ) {
        for (const action of found.actions) {
          // Refused again: one entry, at its newest refusal.
          open = open.filter((refusal) => !sameAction(action, refusal));
          open.push({ ...action, id: text(item.id), why: found.why.trim(), at: event.at, seq: event.seq });
        }
      }
    }
  }
  return open.slice(-MAX_REFUSALS);
}

/** The refusals the user has not dismissed. */
export function undismissed(refusals: readonly Refusal[], dismissedThroughSeq: number | null | undefined): Refusal[] {
  if (dismissedThroughSeq == null) return [...refusals];
  return refusals.filter((refusal) => refusal.seq > dismissedThroughSeq);
}

/** One refusal in a few words: "run: echo cow", "change /tmp/a.txt". */
export function refusalShort(refusal: Refusal): string {
  return refusal.kind === "command" ? `run: ${firstLine(refusal.what) || "a command"}` : `change ${refusal.what}`;
}

/** What a blocked thread's line says: the first refusal, and how many more. */
export function refusalSummary(refusals: readonly Refusal[]): string {
  const first = refusals[0];
  if (!first) return "";
  const more = refusals.length - 1;
  return `bb refused to ${refusalShort(first)}${more > 0 ? ` (and ${more} more)` : ""}`;
}

function listed(refusals: readonly Refusal[]): string {
  return refusals.map((refusal) => (refusal.kind === "command" ? refusal.what : `change the file ${refusal.what}`)).join("\n");
}

/**
 * The message that asks the thread to try again. Sent as the user, it starts
 * a turn the user started, so this time bb raises a permission request.
 */
export function askAgainMessage(refusals: readonly Refusal[]): string {
  const onlyCommands = refusals.every((refusal) => refusal.kind === "command");
  const what =
    refusals.length === 1
      ? onlyCommands
        ? "Run exactly this command again"
        : "Make exactly this file change again"
      : onlyCommands
        ? "Run exactly these commands again"
        : "Do exactly these again";
  return (
    "bb refused this without asking me, because the turn was not started by a person. " +
    "I am asking now, so bb will show me a permission request. " +
    `${what}, the same way as before:\n\n${listed(refusals)}`
  );
}

/** The message that tells the thread the permission is not coming. */
export function carryOnMessage(refusals: readonly Refusal[]): string {
  const it = refusals.length === 1 ? "this" : "these";
  return (
    `bb refused ${it} because it needs my permission, and I will not grant it. ` +
    `Do not try ${refusals.length === 1 ? "it" : "them"} again. ` +
    `Carry on another way if you can; if you cannot, stop and report what is blocked:\n\n${listed(refusals)}`
  );
}

// ---- the card's choices -------------------------------------------------

export type BlockedAction = "ask_again" | "carry_on" | "dismiss";

export const BLOCKED_OPTIONS: readonly { action: BlockedAction; label: string; detail: string }[] = [
  {
    action: "ask_again",
    label: "Ask again as me",
    detail: "sends the message below as you; bb then asks you for permission",
  },
  {
    action: "carry_on",
    label: "Tell it to carry on without it",
    detail: "sends the message below as you; nothing is granted",
  },
  { action: "dismiss", label: "Dismiss", detail: "clears this from the page; the thread is told nothing; u undoes it" },
];

/** What the user has done on the card so far. */
export interface BlockedDraft {
  /** 1-based option, or null before any digit. */
  chosen: number | null;
  /** The message each sending option would send, as edited. */
  messages: Record<"ask_again" | "carry_on", string>;
}

export function emptyBlockedDraft(refusals: readonly Refusal[]): BlockedDraft {
  return {
    chosen: null,
    messages: { ask_again: askAgainMessage(refusals), carry_on: carryOnMessage(refusals) },
  };
}

export function chosenBlocked(draft: BlockedDraft): BlockedAction | null {
  return draft.chosen === null ? null : (BLOCKED_OPTIONS[draft.chosen - 1]?.action ?? null);
}

/** A digit marks an option and never sends. */
export function chooseBlocked(draft: BlockedDraft, number: number): BlockedDraft {
  return BLOCKED_OPTIONS[number - 1] ? { ...draft, chosen: number } : draft;
}

/** Edit the message of the chosen option. */
export function writeBlocked(draft: BlockedDraft, value: string): BlockedDraft {
  const action = chosenBlocked(draft);
  if (action === null || action === "dismiss") return draft;
  return { ...draft, messages: { ...draft.messages, [action]: value } };
}

export type BlockedConfirmed =
  | { kind: "incomplete"; why: string }
  | { kind: "send"; action: "ask_again" | "carry_on"; text: string }
  | { kind: "dismiss" };

/** Enter: nothing without a choice; a message has to say something. */
export function confirmBlocked(draft: BlockedDraft): BlockedConfirmed {
  const action = chosenBlocked(draft);
  if (action === null) return { kind: "incomplete", why: "choose an option first" };
  if (action === "dismiss") return { kind: "dismiss" };
  const message = draft.messages[action].trim();
  if (message === "") return { kind: "incomplete", why: "the message is empty: type what to tell it" };
  return { kind: "send", action, text: message };
}
