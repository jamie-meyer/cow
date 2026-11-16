// The overview's shape: Main's descendants as indented lines, the recently
// done ones apart, and the queue of what is waiting on the user.

import {
  type Derived,
  type LineState,
  type ThreadFacts,
  isRecentDone,
} from "./state.ts";

export interface Line {
  thread: ThreadFacts;
  derived: Derived;
  /** 0 for Main's own children. */
  depth: number;
  /** 1-based place in the queue, or null when it is not waiting on the user. */
  queueNumber: number | null;
}

export interface Overview {
  /** Null when the Main thread is not among `threads`. */
  main: Line | null;
  /** Open work, each thread under its parent, in creation order. */
  lines: Line[];
  /** Finished within the listing window, newest first. */
  done: Line[];
  /** Every thread under Main that is not archived, listed or not. */
  unarchived: string[];
  /** Finished longer ago: counted, not listed. */
  olderDone: number;
  /** Main and the lines that are waiting on the user, oldest first. */
  queue: Line[];
  /** How many listed lines are in each state. */
  counts: Record<LineState, number>;
}

function emptyCounts(): Record<LineState, number> {
  return { wants: 0, running: 0, waiting: 0, stuck: 0, parked: 0, failed: 0, done: 0 };
}

/**
 * Lay out everything that descends from `mainId`.
 *
 * A line keeps its place when its state changes: order depends only on
 * parentage and creation time. A finished thread stays in the tree while any
 * thread under it is still open, so open work never loses its parent.
 */
export function buildOverview(
  threads: readonly ThreadFacts[],
  mainId: string,
  deriveThread: (thread: ThreadFacts) => Derived,
  now: number,
): Overview {
  const children = new Map<string, ThreadFacts[]>();
  let mainThread: ThreadFacts | null = null;
  for (const thread of threads) {
    if (thread.id === mainId) mainThread = thread;
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const overview: Overview = {
    main: null,
    lines: [],
    done: [],
    unarchived: [],
    olderDone: 0,
    queue: [],
    counts: emptyCounts(),
  };
  if (!mainThread) return overview;
  const mainLine: Line = {
    thread: mainThread,
    derived: deriveThread(mainThread),
    depth: 0,
    queueNumber: null,
  };
  overview.main = mainLine;

  const seen = new Set<string>([mainId]);
  /** Adds the subtree's lines; returns whether any of it is still open. */
  const walk = (thread: ThreadFacts, depth: number): boolean => {
    seen.add(thread.id);
    if (thread.archivedAt === null) overview.unarchived.push(thread.id);
    const line: Line = { thread, derived: deriveThread(thread), depth, queueNumber: null };
    const at = overview.lines.length;
    overview.lines.push(line);
    let open = line.derived.state !== "done";
    for (const child of children.get(thread.id) ?? []) {
      if (!seen.has(child.id) && walk(child, depth + 1)) open = true;
    }
    if (!open) {
      // Everything under it is finished too and has already filed itself, so
      // this drops only the thread's own line.
      overview.lines.length = at;
      if (isRecentDone(line.derived, now)) overview.done.push(line);
      else overview.olderDone += 1;
    }
    return open;
  };
  for (const child of children.get(mainId) ?? []) {
    if (!seen.has(child.id)) walk(child, 0);
  }

  overview.done.sort((a, b) => b.derived.since - a.derived.since);
  // Main has no line of its own, but its unread reply or question is still
  // the user's to deal with, so it takes a place in the queue.
  overview.queue = [mainLine, ...overview.lines]
    .filter((line) => line.derived.waitingOnYou)
    .sort((a, b) => a.derived.since - b.derived.since || a.thread.id.localeCompare(b.thread.id));
  overview.queue.forEach((line, index) => {
    line.queueNumber = index + 1;
  });
  for (const line of [...overview.lines, ...overview.done]) {
    overview.counts[line.derived.state] += 1;
  }
  return overview;
}

/** The ids the cursor can rest on, top to bottom. */
export function cursorOrder(overview: Overview): string[] {
  return [...overview.lines, ...overview.done].map((line) => line.thread.id);
}
