// What state a thread is in, derived from what bb knows about it and from
// cow's own note on it when the user has parked it.

import { type Ask, messagedSince } from "./asks/ask.ts";
import { type Replies, unreadReply } from "./attention.ts";
import { type BriefMark, briefWaits, briefWaitText } from "./briefs/review.ts";
import { type Due, dueShort, parkDue, pickUpText } from "./park.ts";
import { type Refusal, refusalSummary, undismissed } from "./refusal.ts";
import { keepHolds } from "./keep.ts";
import type { KeepNote, ParkRecord, WaitNote } from "./shared.ts";
import { firstLine, formatAge } from "./text.ts";
import { waitDue, waitDueText, waitHolds, waitNext, waitText } from "./waiting.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every limit the derivation uses, in one place. */
export const LIMITS = {
  /** A running thread with no event for this long reads as stuck. */
  runningQuietMs: 2 * HOUR,
  /**
   * A thread bb says is at rest, whose newest turn event read so far is a
   * start, is still settling: its end has not been read yet. After this long
   * with no event it is taken to be at rest all the same.
   */
  settlingMs: MINUTE,
  /**
   * A question, permission request or ask waiting on the user this long
   * reads as stuck. A reply never does: it is at rest, and reading it is
   * the person's to do when they choose.
   */
  waitingOnUserMs: 7 * DAY,
  /** An archived line is listed for this long, with its reason, then leaves the page. */
  archivedListedMs: 2 * DAY,
  /** A line to settle reads warm once it has waited this long since it finished... */
  settleWarmMs: 3 * DAY,
  /** ...and red after this long. Age never puts it in the queue. */
  settleOldMs: 7 * DAY,
  /** Parked work with no pick-up date asks this often whether it is still wanted. */
  parkCheckMs: 28 * DAY,
} as const;

/**
 * The states a line can show. `waiting` is said, by the agent or the person:
 * its next move belongs to someone else. `blocked` is detected: bb refused
 * the agent a permission without asking the user.
 */
export type LineState =
  | "wants"
  | "blocked"
  | "running"
  | "waiting"
  | "stuck"
  | "parked"
  /** Kept by the person with z: around on purpose, asking for nothing. */
  | "kept"
  | "failed"
  /** A project with nothing to say: not running, nothing waiting on the person. It may carry an unseen reply as a mark. */
  | "idle"
  | "done";

export const STATE_LABEL: Record<LineState, string> = {
  wants: "wants you",
  blocked: "blocked on a permission",
  running: "running",
  waiting: "waiting",
  stuck: "stuck",
  parked: "parked",
  kept: "kept",
  failed: "failed",
  idle: "idle",
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
  /** The plugin that started it, such as an automation; absent or null for one a person or an agent started. */
  originPluginId?: string | null;
  /** "fork" for a thread forked from another. */
  originKind?: string | null;
  /** bb leaves a hidden thread out of its sidebar. */
  visibility?: "visible" | "hidden";
  /** Its section in bb's sidebar. */
  sectionId?: string | null;
  /** When it tells its parent about its turns: bb's default is "auto". */
  parentNotifications?: "auto" | "off" | "stuck";
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
  /** When its newest turn started, as far as its events have been read. */
  startedAt?: number | null;
  /** The question or permission request it is waiting on the user for, if any. */
  ask: { kind: "question" | "permission"; text: string; at: number } | null;
  /** What bb refused without asking, and nothing has resolved since. */
  refusals: readonly Refusal[];
  /** Its recent finished turns, and whether the person started them. */
  replies?: Replies;
}

/**
 * What decides whether a finished turn's reply is the person's to read. The
 * rule is the same for every thread: see `unreadReply`.
 */
export interface Attention {
  /**
   * It is a project: Main, a thread that has or has had threads under it, or
   * one marked as a project. A project that is not archived is never done.
   */
  project?: boolean;
  /** It is Main: its replies go by cow's rule and record, not by bb's own unread record, though it has no parent. */
  main?: boolean;
  /** cow's record of the turn the person last saw, as a place in the event log. */
  seenSeq: number | null;
}

/** What the thread has put in front of the person with `bb cow`: its open asks and its latest brief. */
export interface Raised {
  /** Its open asks, oldest first. */
  asks: readonly Ask[];
  /** What its latest brief came to, or null when it has submitted none. */
  brief: BriefMark | null;
  /** When cow delivered the person's answers to its other asks: messages of theirs that answer nothing else. */
  delivered?: readonly number[];
  /** Decisions on its permission requests that cow did not make and the person has not acknowledged, oldest first. */
  outside?: readonly OutsideFlag[];
}

/** A decision on a permission request that was made somewhere other than cow. */
export interface OutsideFlag {
  id: string;
  /** "approved outside cow: run: echo x". */
  text: string;
  at: number;
}

/** Where a decision cow did not make may have been made: all cow can say about it. */
export const OUTSIDE_WHERE = "in bb's own view, or by another thread";

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
  /** The open asks the person has sent the thread a message since: perhaps answered in chat already. */
  asksMessaged?: readonly string[];
  /** Set when it has submitted a brief, whatever state the line shows. */
  brief?: BriefMark;
  /** Set when the line waits on the person because of its brief: disputes or judgement calls not yet read. */
  briefWaits?: true;
  /** Set when decisions on its requests were made outside cow and are not acknowledged, whatever state the line shows. */
  outside?: readonly OutsideFlag[];
  /** Set when the line reads waiting on someone else: the note, and whether its reminder has arrived. */
  wait?: { note: WaitNote; due: boolean };
  /** Set when the person keeps it on the Kept shelf. */
  keep?: { note: KeepNote };
  /**
   * Set on a done or idle line whose newest reply the person has not seen:
   * where that reply is in the event log, which is what "seen" records. It
   * does not put the line in the queue: a done line is listed first to
   * settle, and an idle one carries a small unread mark.
   */
  unseen?: { seq: number };
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
 * bb's own record of an unread reply, kept only for a thread with no parent.
 * It decides for one that cow does not read by its own rule: an automation's
 * run, say. Main and the threads under it go by `unreadReply`.
 */
function hasUnreadReply(thread: ThreadFacts, ours: boolean): boolean {
  if (ours || thread.parentThreadId !== null || isBusy(thread)) return false;
  return thread.lastReadAt === null || thread.lastReadAt < thread.latestAttentionAt;
}

/** Whether a turn is in progress, whatever state the line shows. */
export function isBusy(thread: ThreadFacts): boolean {
  return BUSY.has(thread.status);
}

/**
 * Whether a thread that bb says is at rest has, as far as its events have
 * been read, not ended its turn: the newest turn event known is a start. The
 * end is on its way, so the line keeps reading as running until it is read,
 * instead of reading done for a moment and then something else.
 */
export function isSettling(thread: ThreadFacts, activity: Activity | undefined, now: number): boolean {
  if (isBusy(thread) || thread.status === "error" || activity?.turn?.phase !== "started") return false;
  return now - Math.max(activity.lastEventAt ?? 0, activity.turn.at) <= LIMITS.settlingMs;
}

/** Whether a state is one of rest: nothing runs and nothing waits. */
export function atRest(state: LineState): boolean {
  return state === "done" || state === "idle";
}

/** Whether a state is one of a line set aside by the person, off the tree: parked or kept. */
export function setAside(state: LineState): boolean {
  return state === "parked" || state === "kept";
}

/**
 * When the user's part began: for parked work that has come back, when it
 * came back; otherwise when the line entered its state.
 */
export function waitingSince(derived: Derived): number {
  if (derived.wait?.due && derived.wait.note.remindAt !== null) return derived.wait.note.remindAt;
  return derived.park?.due?.at ?? derived.since;
}

/** What a line says when the person has messaged the thread since it asked. */
export const MESSAGED_SINCE = "you have messaged this thread since it asked";

/** One question in a line: the oldest ask, and how many more there are. `messaged` when the person has written to the thread since it was asked. */
export function asksText(asks: readonly Ask[], messaged = false): string {
  const first = asks[0];
  if (!first) return "";
  // An ask for a capability says so: it is a grant the thread wants, not a question about the work.
  const lead = first.capability ? "" : "asks you: ";
  return `${lead}${first.question.replace(/\s+/g, " ")}${asks.length > 1 ? ` (and ${asks.length - 1} more)` : ""}${messaged ? ` · ${MESSAGED_SINCE}` : ""}`;
}

/**
 * What a line shows. Where several things wait on the person at once, the
 * line shows the first of: a failure; a question or permission request of
 * bb's own, which holds a running turn; an open ask; a decision made outside
 * cow; a permission bb refused; a brief with disputes or judgement calls.
 * Then, with nothing of those: a running turn; waiting on someone else; a
 * reply addressed to them; idle or done.
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
  /** Its note that it waits on someone other than the person, if any. */
  wait?: WaitNote | null,
  /** The person's note that they keep it around, if any. */
  keep?: KeepNote | null,
): Derived {
  const asks = thread.archivedAt === null ? (raised?.asks ?? []) : [];
  const spokeAt = activity?.replies?.personSpokeAt ?? null;
  const messaged = asks.filter((ask) => messagedSince(ask, spokeAt, raised?.delivered)).map((ask) => ask.id);
  const outside = thread.archivedAt === null ? (raised?.outside ?? []) : [];
  const holding = wait && waitHolds(wait, activity?.startedAt) ? wait : null;
  // Kept until it starts a new turn; a turn in progress is one.
  const kept = keep && keepHolds(keep, activity?.startedAt) && !isBusy(thread) ? keep : null;
  const derived = deriveLine(thread, activity, now, park, archivedWhy, dismissedThroughSeq, attention, asks, raised?.brief ?? null, messaged, outside, holding, kept);
  return {
    ...derived,
    ...(outside.length > 0 ? { outside } : {}),
    ...(asks.length > 0 ? { asks } : {}),
    ...(messaged.length > 0 ? { asksMessaged: messaged } : {}),
    ...(raised?.brief ? { brief: raised.brief } : {}),
  };
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
  /** The ids of the asks the person has messaged the thread since. */
  messaged: readonly string[],
  outside: readonly OutsideFlag[],
  wait: WaitNote | null,
  keep: KeepNote | null,
): Derived {
  // The line shows its oldest ask: whether that one may be answered already is what it says.
  const firstMessaged = asks.length > 0 && messaged.includes(asks[0]!.id);
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
      doing: asking ? `${park.reason} · ${asksText(asks, firstMessaged)}` : park.reason,
      next: due ? dueShort(due, now) : asking ? "answer it: press a" : pickUpText(park, now, LIMITS.parkCheckMs),
      waitingOnYou: due !== null || asking,
      park: { record: park, due },
    };
  }

  // Keeping is the person's choice too, and quieter: nothing reminds them
  // of it. What truly needs them shows through, as on a parked line: its
  // open ask.
  if (keep) {
    const asking = asks.length > 0;
    return {
      state: "kept",
      since: keep.at,
      doing: asking ? `${keep.words ?? "kept"} · ${asksText(asks, firstMessaged)}` : (keep.words ?? (said || "kept")),
      next: asking ? "answer it: press a" : "",
      waitingOnYou: asking,
      keep: { note: keep },
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
  // Between bb saying a turn is over and its end being read, the line stays as it was.
  const busy = isBusy(thread) || isSettling(thread, activity, now);
  // Main and every thread under it: a reply is the person's, and waits on
  // them until they have seen it, only when it ends the newest finished turn
  // and they started that turn. A turn an agent or a notice of bb's started
  // (a worker's job, its report to the project above it) ends in a reply that
  // is not theirs: a worker is done, to settle; a project is idle, marked unread.
  const ours = attention != null && (thread.parentThreadId !== null || attention.main === true);
  const reply = !asked && ours && !busy ? unreadReply(activity?.replies, false, attention.seenSeq) : null;
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
      doing: asksText(asks, firstMessaged),
      next: stuck ? `it has waited ${formatAge(now - since)} on you: press a` : firstMessaged ? "answer it, or say it was answered in chat: press a" : "answer it: press a",
      waitingOnYou: true,
      ...(blocked ? { blocked: { refusals } } : {}),
    };
  }

  // A request of this thread's was approved or denied, and not through cow:
  // the person is shown it until they acknowledge it, whatever the thread
  // has gone on to do.
  if (!asked && outside.length > 0) {
    const first = outside[0]!;
    return {
      state: "wants",
      since: first.at,
      doing: `${first.text}${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ""} · ${OUTSIDE_WHERE}`,
      next: "acknowledge: Space",
      waitingOnYou: true,
      ...(blocked ? { blocked: { refusals } } : {}),
    };
  }

  // A finished job whose brief the checker disputed, or that leaves the
  // person a decision, is theirs to read before its reply is.
  if (!asked && !blocked && !busy && brief !== null && briefWaits(brief)) {
    return {
      state: "wants",
      since: Math.max(settled, brief.at),
      doing: briefWaitText(brief),
      next: "read it: press b",
      waitingOnYou: true,
      briefWaits: true,
    };
  }

  // Waiting on someone else gives way to everything above, and to a turn in
  // progress: a reply it ends with says it is waiting, so it is not the
  // person's to act on. With a reminder that has arrived, it is.
  if (wait && !asked && !blocked && !busy) {
    const due = waitDue(wait, now);
    return {
      state: "waiting",
      since: wait.at,
      doing: due ? waitDueText(wait, now) : waitText(wait, now),
      next: waitNext(wait, now, due),
      waitingOnYou: due,
      wait: { note: wait, due },
    };
  }

  if (asked || (!busy && hasUnreadReply(thread, ours)) || (reply && !blocked)) {
    const ask = asked ? (activity?.ask ?? null) : null;
    const since = ask?.at ?? reply?.at ?? settled;
    const doing = asked
      ? ask?.text || said || "it asked you something"
      : reply
        ? `replied to you: ${said || "it finished its turn"}`
        : said || "finished";
    const mine = reply ? { reply: { seq: reply.seq } } : {};
    // Only a question or a request reads stuck: a reply is at rest, and is read when the person chooses.
    if (asked && now - since > LIMITS.waitingOnUserMs) {
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

  if (busy) {
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

  // Its newest reply, if the person has not seen it: a mark, not a wait.
  const unseen = ours ? unreadReply(activity?.replies, true, attention.seenSeq) : null;
  const mark = unseen ? { unseen: { seq: unseen.seq } } : {};
  // A project is never done: with nothing to say it is idle, in its place,
  // for as long as it is quiet, with a small unread mark while it has one.
  if (attention?.project) return { state: "idle", since: settled, doing: said || "quiet", next: "", waitingOnYou: false, ...mark };
  // A finished thread with such a reply is listed first to settle, marked unread.
  return {
    state: "done",
    since: settled,
    doing: said || "finished",
    next: "",
    waitingOnYou: false,
    ...mark,
  };
}

/** How a line to settle reads by how long it has waited since it finished: plain, warm, then red. */
export type Heat = "plain" | "warm" | "old";

export function settleHeat(finishedAt: number, now: number): Heat {
  const age = now - finishedAt;
  if (age >= LIMITS.settleOldMs) return "old";
  return age >= LIMITS.settleWarmMs ? "warm" : "plain";
}
