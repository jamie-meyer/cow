// What state a thread is in, derived from what bb knows about it and from
// cow's own note on it when the user has parked it.

import type { Ask } from "./asks/ask.ts";
import { type Replies, unreadReply } from "./attention.ts";
import { type BriefMark, briefWaits, briefWaitText } from "./briefs/review.ts";
import { type Due, dueShort, parkDue, pickUpText } from "./park.ts";
import { type Refusal, refusalSummary, undismissed } from "./refusal.ts";
import type { ParkRecord } from "./shared.ts";
import { firstLine, formatAge } from "./text.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every limit the derivation uses, in one place. */
export const LIMITS = {
  /** A running thread with no event for this long reads as stuck. */
  runningQuietMs: 2 * HOUR,
  /** A question or unread reply waiting on the user this long reads as stuck. */
  waitingOnUserMs: 7 * DAY,
  /** Done lines are listed for this long, then only counted. */
  doneListedMs: 2 * DAY,
  /** Parked work with no pick-up date asks this often whether it is still wanted. */
  parkCheckMs: 28 * DAY,
} as const;

/**
 * The states a line can show. Nothing produces `waiting` yet: it needs the
 * agent to say what it waits on. `blocked` is detected: bb refused the agent
 * a permission without asking the user.
 */
export type LineState =
  | "wants"
  | "blocked"
  | "running"
  | "waiting"
  | "stuck"
  | "parked"
  | "failed"
  | "done";

export const STATE_LABEL: Record<LineState, string> = {
  wants: "wants you",
  blocked: "blocked on a permission",
  running: "running",
  waiting: "waiting",
  stuck: "stuck",
  parked: "parked",
  failed: "failed",
  done: "done",
};

/** The fields of a bb thread this page reads. Times are epoch milliseconds. */
export interface ThreadFacts {
  id: string;
  projectId: string;
  title: string;
  parentThreadId: string | null;
  /** bb's execution status: active, starting, stopping, pending, idle, error. */
  status: string;
  hasPendingInteraction: boolean;
  archivedAt: number | null;
  lastReadAt: number | null;
  latestAttentionAt: number;
  createdAt: number;
}

/** What a thread's event log adds to its facts. Loaded lazily, so optional. */
export interface Activity {
  /** When the newest event arrived. */
  lastEventAt: number | null;
  /** The newest turn boundary. */
  turn: { phase: "started" | "completed"; at: number; failed: boolean } | null;
  /** The agent's latest step, as short text. */
  latestStep: string;
  /** The agent's latest message. */
  output: string;
  /** The question or permission request it is waiting on the user for, if any. */
  ask: { kind: "question" | "permission"; text: string; at: number } | null;
  /** What bb refused without asking, and nothing has resolved since. */
  refusals: readonly Refusal[];
  /** Its recent finished turns, and whether the person started them. */
  replies?: Replies;
}

/** What decides whether a finished turn's reply is the person's to read. */
export interface Attention {
  /** The thread has threads under it: the person talks to it directly. */
  head: boolean;
  /** cow's record of the turn the person last saw, as a place in the event log. */
  seenSeq: number | null;
}

/** What the thread has put in front of the person with `bb cow`: its open asks and its latest brief. */
export interface Raised {
  /** Its open asks, oldest first. */
  asks: readonly Ask[];
  /** What its latest brief came to, or null when it has submitted none. */
  brief: BriefMark | null;
}

export interface Derived {
  state: LineState;
  /** When it entered this state; for stuck, when it went quiet. */
  since: number;
  /** What it is doing or waiting on. */
  doing: string;
  /** What moves it next. */
  next: string;
  /**
   * The user is the one who has to move it: it asked something, it failed, or
   * it is a thread of the user's own with a reply they have not read. Decides
   * queue membership, and stays true when a wait has gone on long enough for
   * the state to read as stuck.
   */
  waitingOnYou: boolean;
  /** For an archived thread: the reason the user gave, if any. */
  archivedWhy?: string;
  /** Set when the user parked it: the note, and why it is back if it is. */
  park?: { record: ParkRecord; due: Due | null };
  /** Set when bb refused it a permission without asking: what was refused, oldest first. */
  blocked?: { refusals: readonly Refusal[] };
  /**
   * Set when it waits on the person with a reply that cow tracks itself (a
   * thread with a parent): where that reply is in the event log, which is
   * what "seen" records.
   */
  reply?: { seq: number };
  /** Set when it has open asks, whatever state the line shows: oldest first. */
  asks?: readonly Ask[];
  /** Set when it has submitted a brief, whatever state the line shows. */
  brief?: BriefMark;
  /** Set when the line waits on the person because of its brief: disputes or judgement calls not yet read. */
  briefWaits?: true;
}

const BUSY = new Set(["active", "starting", "stopping", "pending"]);

/**
 * When the thread last came to rest. bb moves `latestAttentionAt` only for
 * threads without a parent, so for the rest the event log's last finished
 * turn is the only evidence.
 */
function settledAt(thread: ThreadFacts, activity: Activity | undefined): number {
  const finished = activity?.turn?.phase === "completed" ? activity.turn.at : 0;
  return Math.max(thread.latestAttentionAt, finished);
}

/**
 * bb's own record of an unread reply, kept only for a thread with no parent,
 * such as Main. For a thread with a parent cow keeps its own: see
 * `unreadReply`.
 */
function hasUnreadReply(thread: ThreadFacts): boolean {
  if (thread.parentThreadId !== null || isBusy(thread)) return false;
  return thread.lastReadAt === null || thread.lastReadAt < thread.latestAttentionAt;
}

/** Whether a turn is in progress, whatever state the line shows. */
export function isBusy(thread: ThreadFacts): boolean {
  return BUSY.has(thread.status);
}

/**
 * When the user's part began: for parked work that has come back, when it
 * came back; otherwise when the line entered its state.
 */
export function waitingSince(derived: Derived): number {
  return derived.park?.due?.at ?? derived.since;
}

/** One question in a line: the oldest ask, and how many more there are. */
export function asksText(asks: readonly Ask[]): string {
  const first = asks[0];
  if (!first) return "";
  return `asks you: ${first.question.replace(/\s+/g, " ")}${asks.length > 1 ? ` (and ${asks.length - 1} more)` : ""}`;
}

/**
 * What a line shows. Where several things wait on the person at once, the
 * line shows the first of: a failure; a question or permission request of
 * bb's own, which holds a running turn; an open ask; a permission bb refused;
 * a brief with disputes or judgement calls; a reply addressed to them.
 */
export function derive(
  thread: ThreadFacts,
  activity: Activity | undefined,
  now: number,
  park?: ParkRecord | null,
  /** Why the user archived it; shown only while it is archived. */
  archivedWhy?: string | null,
  /** The user dismissed its refused permissions up to this place in its event log. */
  dismissedThroughSeq?: number | null,
  /** Whether its replies are the person's, and which they have seen. Without it, a thread with a parent reports to that parent. */
  attention?: Attention | null,
  /** Its open asks and its latest brief. */
  raised?: Raised | null,
): Derived {
  const asks = thread.archivedAt === null ? (raised?.asks ?? []) : [];
  const derived = deriveLine(thread, activity, now, park, archivedWhy, dismissedThroughSeq, attention, asks, raised?.brief ?? null);
  return { ...derived, ...(asks.length > 0 ? { asks } : {}), ...(raised?.brief ? { brief: raised.brief } : {}) };
}

function deriveLine(
  thread: ThreadFacts,
  activity: Activity | undefined,
  now: number,
  park: ParkRecord | null | undefined,
  archivedWhy: string | null | undefined,
  dismissedThroughSeq: number | null | undefined,
  attention: Attention | null | undefined,
  asks: readonly Ask[],
  brief: BriefMark | null,
): Derived {
  const said = firstLine(activity?.output);
  const settled = settledAt(thread, activity);

  if (thread.archivedAt !== null) {
    return {
      state: "done",
      since: thread.archivedAt,
      doing: said || "archived",
      next: "",
      waitingOnYou: false,
      ...(archivedWhy ? { archivedWhy } : {}),
    };
  }

  // Parking is the user's choice, so it hides whatever the agent is doing
  // until the thread is resumed.
  if (park) {
    const due = parkDue(park, now, LIMITS.parkCheckMs);
    // A question it asked before it was parked is still the person's to answer.
    const asking = asks.length > 0;
    return {
      state: "parked",
      since: park.at,
      doing: asking ? `${park.reason} · ${asksText(asks)}` : park.reason,
      next: due ? dueShort(due, now) : asking ? "answer it: press a" : pickUpText(park, now, LIMITS.parkCheckMs),
      waitingOnYou: due !== null || asking,
      park: { record: park, due },
    };
  }

  if (thread.status === "error" || (!isBusy(thread) && activity?.turn?.failed)) {
    return {
      state: "failed",
      since: settled,
      doing: said || "its last turn failed",
      next: "open it to retry, or archive it",
      waitingOnYou: true,
    };
  }

  const asked = thread.hasPendingInteraction;
  // A thread with a parent: a worker that finished a turn its parent started
  // reported to that parent and is done. One the person talks to replied to
  // them, and waits until they have seen it.
  const reply =
    !asked && attention && thread.parentThreadId !== null && !isBusy(thread)
      ? unreadReply(activity?.replies, attention.head, attention.seenSeq)
      : null;
  // A refused permission outranks a reply that is waiting to be read: the
  // reply keeps, and only the user can unblock the work.
  const refusals = undismissed(activity?.refusals ?? [], dismissedThroughSeq);
  const blocked = refusals.length > 0;

  // An open ask outranks everything but a failure and a request of bb's own
  // that holds a turn: it was put to the person on purpose, and it stays
  // until they answer, whatever the thread goes on to do.
  if (!asked && asks.length > 0) {
    const since = asks[0]!.createdAt;
    const stuck = now - since > LIMITS.waitingOnUserMs;
    return {
      state: stuck ? "stuck" : "wants",
      since,
      doing: asksText(asks),
      next: stuck ? `it has waited ${formatAge(now - since)} on you: press a` : "answer it: press a",
      waitingOnYou: true,
      ...(blocked ? { blocked: { refusals } } : {}),
    };
  }

  // A finished job whose brief the checker disputed, or that leaves the
  // person a decision, is theirs to read before its reply is.
  if (!asked && !blocked && !isBusy(thread) && brief !== null && briefWaits(brief)) {
    return {
      state: "wants",
      since: Math.max(settled, brief.at),
      doing: briefWaitText(brief),
      next: "read it: press b",
      waitingOnYou: true,
      briefWaits: true,
    };
  }

  if (asked || hasUnreadReply(thread) || (reply && !blocked)) {
    const ask = asked ? (activity?.ask ?? null) : null;
    const since = ask?.at ?? reply?.at ?? settled;
    const doing = asked
      ? ask?.text || said || "it asked you something"
      : reply
        ? `replied to you: ${said || "it finished its turn"}`
        : said || "finished";
    const mine = reply ? { reply: { seq: reply.seq } } : {};
    if (now - since > LIMITS.waitingOnUserMs) {
      return {
        state: "stuck",
        since,
        doing,
        next: `it has waited ${formatAge(now - since)} on you`,
        waitingOnYou: true,
        ...mine,
      };
    }
    return {
      state: "wants",
      since,
      doing,
      next: reply
        ? "read it: Enter, or Space once seen"
        : !asked
          ? "read its reply"
          : ask?.kind === "permission"
            ? "grant or deny: press a"
            : "answer it: press a",
      waitingOnYou: true,
      ...mine,
    };
  }

  // A refused permission outranks running and done: the work may go on, but
  // not the way the agent meant, and only the user can change that.
  if (blocked) {
    return {
      state: "blocked",
      since: refusals[0]!.at,
      doing: refusalSummary(refusals),
      next: "ask again: press a",
      waitingOnYou: true,
      blocked: { refusals },
    };
  }

  if (isBusy(thread)) {
    const startedAt =
      activity?.turn?.phase === "started" ? activity.turn.at : thread.latestAttentionAt;
    const lastEventAt = Math.max(activity?.lastEventAt ?? 0, startedAt);
    const step = activity?.latestStep || said;
    if (now - lastEventAt > LIMITS.runningQuietMs) {
      return {
        state: "stuck",
        since: lastEventAt,
        doing: `no event for ${formatAge(now - lastEventAt)}${step ? ` · last: ${step}` : ""}`,
        next: "nudge it, or stop it: press x",
        waitingOnYou: false,
      };
    }
    return {
      state: "running",
      since: startedAt,
      doing: step || (thread.status === "pending" ? "queued to start" : "working"),
      next: "finishes its turn",
      waitingOnYou: false,
    };
  }

  return { state: "done", since: settled, doing: said || "finished", next: "", waitingOnYou: false };
}

/** Whether a done line is recent enough to list rather than only count. */
export function isRecentDone(derived: Derived, now: number): boolean {
  return derived.state === "done" && now - derived.since <= LIMITS.doneListedMs;
}
