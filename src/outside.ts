// Outside Main: the open threads that are not under this Main. Old work,
// threads started by hand, runs started by other tools: bb lists them, but
// the tree, which follows parent links down from Main, never reaches them.
//
// Everything here is read from the thread list alone, without a thread's
// events, so the section costs nothing however many threads it lists.

import { type ThreadFacts, isBusy } from "./state.ts";

/** What a line outside Main is doing, from the thread list's own fields. */
export type OutsideState = "running" | "asking" | "resting";

export interface OutsideLine {
  thread: ThreadFacts;
  /** How many open threads are under it; they go with it when it is moved. */
  under: number;
  state: OutsideState;
  /** When it last did anything, as bb records it. */
  lastAt: number;
}

export interface Outside {
  /** Newest activity first. */
  lines: OutsideLine[];
  /** Open threads with no parent that a plugin started: counted, not listed. */
  byPlugins: number;
  /** The Mains chosen for other projects: counted, not listed, so that none is moved under this one. */
  otherMains: number;
}

export const NO_OUTSIDE: Outside = { lines: [], byPlugins: 0, otherMains: 0 };

/** Open and visible: what bb itself would show in its sidebar. */
const open = (thread: ThreadFacts): boolean => thread.archivedAt === null && thread.visibility !== "hidden";

/**
 * The open threads not under `mainId`: no parent, not Main or a thread above
 * it, not archived or hidden. One started by a plugin (`originPluginId`) is
 * only counted, and so is another project's Main. A thread with threads
 * under it is one line, counting them.
 */
export function outsideMain(
  threads: readonly ThreadFacts[],
  mainId: string,
  otherMains: ReadonlySet<string> = new Set(),
  /** Threads listed in another section (an automation's runs): neither listed nor counted here. */
  elsewhere: ReadonlySet<string> = new Set(),
): Outside {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  // Main and what is above it are where the tree starts, not outside it.
  const above = new Set<string>();
  for (let id: string | null = mainId; id !== null && !above.has(id); id = byId.get(id)?.parentThreadId ?? null) above.add(id);

  const children = new Map<string, ThreadFacts[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  const openUnder = (id: string): number => {
    const seen = new Set([id]);
    const pending = [id];
    let count = 0;
    while (pending.length > 0) {
      for (const child of children.get(pending.pop()!) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        pending.push(child.id);
        if (open(child)) count += 1;
      }
    }
    return count;
  };

  const found: Outside = { lines: [], byPlugins: 0, otherMains: 0 };
  for (const thread of threads) {
    if (thread.parentThreadId !== null || above.has(thread.id) || !open(thread) || elsewhere.has(thread.id)) continue;
    if (thread.originPluginId) {
      found.byPlugins += 1;
      continue;
    }
    if (otherMains.has(thread.id)) {
      found.otherMains += 1;
      continue;
    }
    found.lines.push({
      thread,
      under: openUnder(thread.id),
      state: isBusy(thread) ? "running" : thread.hasPendingInteraction ? "asking" : "resting",
      lastAt: Math.max(thread.latestAttentionAt, thread.createdAt),
    });
  }
  found.lines.sort((a, b) => b.lastAt - a.lastAt || a.thread.id.localeCompare(b.thread.id));
  return found;
}

/** What an outside line's state reads as. */
export const OUTSIDE_STATE_TEXT: Record<OutsideState, string> = {
  running: "running",
  asking: "wants an answer",
  resting: "at rest",
};

/** The words after the count: what is not listed, if anything. */
export function notListedText(outside: Outside): string {
  const parts: string[] = [];
  if (outside.byPlugins > 0) parts.push(`${outside.byPlugins} started by plugins`);
  if (outside.otherMains > 0) parts.push(`${outside.otherMains} ${outside.otherMains === 1 ? "is another project's Main" : "are other projects' Mains"}`);
  return parts.length === 0 ? "" : `${parts.join(", ")}, not listed`;
}

// ---- bringing one under Main ---------------------------------------------

export type ParentNotifications = "auto" | "off" | "stuck";

/**
 * What moving a thread under Main changes, recorded before the move so that
 * undo puts back exactly what was there: its parent, its sidebar section,
 * and when it tells its parent about its turns.
 */
export interface MoveRecord {
  threadId: string;
  title: string;
  parentThreadId: string | null;
  sectionId: string | null;
  parentNotifications: ParentNotifications;
}

/** The update bb is asked for, and the one that takes it back. */
export interface ThreadUpdate {
  threadId: string;
  parentThreadId?: string | null;
  sectionId?: string | null;
  parentNotifications?: ParentNotifications;
}

/** bb's default for a thread it has no setting for. */
const DEFAULT_NOTIFICATIONS: ParentNotifications = "auto";

export function moveRecord(thread: ThreadFacts): MoveRecord {
  return {
    threadId: thread.id,
    title: thread.title,
    parentThreadId: thread.parentThreadId,
    sectionId: thread.sectionId ?? null,
    parentNotifications: thread.parentNotifications ?? DEFAULT_NOTIFICATIONS,
  };
}

/**
 * The move: under Main, telling Main only when it is stuck. With "auto" it
 * would start a turn of Main's each time it finished one of its own.
 */
export function moveUpdate(threadId: string, mainId: string): ThreadUpdate {
  return { threadId, parentThreadId: mainId, parentNotifications: "stuck" };
}

/**
 * Taking it back, in order. bb gives a thread whose parent is cleared the
 * old parent's sidebar section, so the section is set after the parent, on
 * its own.
 */
export function undoUpdates(record: MoveRecord): ThreadUpdate[] {
  return [
    { threadId: record.threadId, parentThreadId: record.parentThreadId, parentNotifications: record.parentNotifications },
    { threadId: record.threadId, sectionId: record.sectionId },
  ];
}

/** What the confirmation says will happen. */
export function moveText(line: OutsideLine, mainTitle: string): string {
  const under = line.under === 0 ? "" : ` with the ${line.under === 1 ? "thread" : `${line.under} threads`} under it`;
  return (
    `bring “${line.thread.title}”${under} under Main (“${mainTitle}”)? ` +
    "bb tells Main with a short notice, so Main starts a turn. Its notifications to Main are set to “stuck”: it tells Main only when it is stuck, not each time it finishes a turn. u takes it back"
  );
}

/** bb's refusal of a move, in plain words. */
export function moveRefusal(cause: unknown): string {
  const text = (cause instanceof Error ? `${cause.message} ${(cause as { code?: unknown }).code ?? ""}` : String(cause)).toLowerCase();
  if (text.includes("too_deep") || text.includes("too deep") || text.includes("depth")) {
    return "bb refused: the tree would be more than 4 levels deep. Main is too far down, or the thread has threads under it that add their depth";
  }
  // bb 0.49 answers an archived or deleted parent with "parent_thread_invalid".
  if (text.includes("parent_thread_invalid") || text.includes("parent thread is invalid") || text.includes("archived") || text.includes("deleted")) {
    return "bb refused: Main cannot take a thread under it, as it is archived or deleted";
  }
  if (text.includes("cycle") || text.includes("loop") || text.includes("own ancestor") || text.includes("descendant")) {
    return "bb refused: Main is under that thread, so it cannot go under Main";
  }
  return `bb refused: ${cause instanceof Error ? cause.message : String(cause)}`;
}

// ---- archiving one ---------------------------------------------------------

/** The refusal for the Main a command resolves to: the thread the person chose. */
export const MAIN_ARCHIVE_REFUSAL = "Main cannot be archived from here";
/** Another project's Main: Outside Main only counts it, and nothing here archives it. */
export const OTHER_MAIN_REFUSAL = "it is the Main chosen for another project";
/** Archiving it would archive Main with it. */
export const ABOVE_MAIN_REFUSAL = "a Main is under it";
/** A thread outside Main archived by an agent that is neither Main nor that thread. */
export const OUTSIDE_REFUSAL = "it is outside Main, and a thread archives only itself and what is under it: outside Main, Main archives it";

/** Where a thread named to `bb cow archive` stands, and whether its caller may archive it there. */
export interface ArchivePlace {
  /** It has no parent and is no Main, or above one: it is listed under Outside Main. */
  outside: boolean;
  /** Why the caller may not archive it here, before the rules every line has; null when it may. */
  why: string | null;
}

/**
 * Who may archive which thread, by where it is. `mains` is project id to
 * the Main chosen for it; `callerId` the thread that ran the command, or
 * null for the person; `ownProjectId` the project whose Main the command
 * resolves to (the caller's, or the current one for the person). A thread
 * under a parent is left to the rules every line has.
 */
export function archivePlace(
  threads: readonly ThreadFacts[],
  mains: Readonly<Record<string, string>>,
  callerId: string | null,
  ownProjectId: string | null,
  targetId: string,
): ArchivePlace {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const target = byId.get(targetId);
  if (!target) return { outside: false, why: null };
  const mainOf = Object.entries(mains).find(([, id]) => id === targetId)?.[0];
  if (mainOf !== undefined) {
    return { outside: false, why: ownProjectId === null || mainOf === ownProjectId ? MAIN_ARCHIVE_REFUSAL : OTHER_MAIN_REFUSAL };
  }
  // bb archives what is under a thread with it: one above a Main would take that Main.
  for (const mainId of Object.values(mains)) {
    const seen = new Set<string>();
    for (let id = byId.get(mainId)?.parentThreadId ?? null; id !== null && !seen.has(id); id = byId.get(id)?.parentThreadId ?? null) {
      seen.add(id);
      if (id === targetId) return { outside: false, why: ABOVE_MAIN_REFUSAL };
    }
  }
  if (target.parentThreadId !== null) return { outside: false, why: null };
  // Nothing else owns a thread outside Main: the person archives it, Main does, or the thread itself.
  if (callerId === null || callerId === targetId) return { outside: true, why: null };
  const caller = byId.get(callerId);
  const callerIsMain = caller !== undefined && mains[caller.projectId] === callerId;
  return { outside: true, why: callerIsMain ? null : OUTSIDE_REFUSAL };
}

/** Why `e` on a line of Outside Main is refused, or null when it archives. `asks`: its open asks. */
export function outsideArchiveBlocked(line: OutsideLine, asks: number): string | null {
  if (line.under > 0) return "threads under it are still open";
  if (asks > 0) return "it has an open ask: answer it, or have it withdrawn";
  if (line.state === "running") return ARCHIVE_RUNNING;
  if (line.state === "asking") return ARCHIVE_ASKING;
  return null;
}

/** A thread whose turn is running is not archived: its turn ends first. */
export const ARCHIVE_RUNNING = "its turn is still running";
/** Nor one bb is asking a question or a permission of. */
export const ARCHIVE_ASKING = "bb is asking it a question";
