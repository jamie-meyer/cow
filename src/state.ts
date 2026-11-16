// What state a thread is in, derived only from what bb knows about it.

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
} as const;

/**
 * The states a line can show. Nothing produces `parked` or `waiting` yet:
 * both need the agent or the user to say so, which this page cannot do today.
 */
export type LineState =
  | "wants"
  | "running"
  | "waiting"
  | "stuck"
  | "parked"
  | "failed"
  | "done";

export const STATE_LABEL: Record<LineState, string> = {
  wants: "wants you",
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
  /** The question or approval it is waiting on the user for, if any. */
  ask: { text: string; at: number } | null;
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
}

const BUSY = new Set(["active", "starting", "stopping", "pending"]);

function isBusy(thread: ThreadFacts): boolean {
  return BUSY.has(thread.status);
}

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
 * A finished reply is the user's to read only on a thread with no parent,
 * such as Main. A thread that has a parent reported to that parent, and is
 * the parent's to deal with.
 */
function hasUnreadReply(thread: ThreadFacts): boolean {
  if (thread.parentThreadId !== null || isBusy(thread)) return false;
  return thread.lastReadAt === null || thread.lastReadAt < thread.latestAttentionAt;
}

export function derive(
  thread: ThreadFacts,
  activity: Activity | undefined,
  now: number,
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
    };
  }

  if (thread.status === "error" || (!isBusy(thread) && activity?.turn?.failed)) {
    return {
      state: "failed",
      since: settled,
      doing: said || "its last turn failed",
      next: "open it: retry or stop",
      waitingOnYou: true,
    };
  }

  const asked = thread.hasPendingInteraction;
  if (asked || hasUnreadReply(thread)) {
    const ask = asked ? (activity?.ask ?? null) : null;
    const since = ask?.at ?? settled;
    const doing = asked ? ask?.text || said || "it asked you something" : said || "finished";
    if (now - since > LIMITS.waitingOnUserMs) {
      return {
        state: "stuck",
        since,
        doing,
        next: `it has waited ${formatAge(now - since)} on you`,
        waitingOnYou: true,
      };
    }
    return {
      state: "wants",
      since,
      doing,
      next: asked ? "answer it in its chat" : "read its reply",
      waitingOnYou: true,
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
        next: "open it: nudge or stop",
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
