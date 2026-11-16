// The overview's shape: Main's descendants as nested groups, the parked ones
// on their shelf, the finished ones apart, and the queue of what is waiting
// on the user.
//
// Any thread with threads under it is a group: its line is the head, and the
// lines under it are its members. Where a finished line goes:
// - a member that finished stays in its group for as long as the group is
//   open, listed for the usual two days and counted after that;
// - a line directly under Main that is finished, with everything under it
//   finished too, goes to Done as one line, however many threads it holds;
// - an archived line always leaves its place: the user put it away. It is
//   listed under Done with its reason.
// A line with a note of what is next, or with work listed as not started,
// is not finished, whatever its last turn says.

import type { TodoItem } from "./shared.ts";
import { type Derived, LIMITS, type LineState, type ThreadFacts, waitingSince } from "./state.ts";

export type Rollup = Record<LineState, number>;

export interface Line {
  thread: ThreadFacts;
  derived: Derived;
  /** 0 for Main's own children. */
  depth: number;
  /** The line it is listed under; null for Main's own children and outside the tree. */
  parentId: string | null;
  /** 1-based place in the queue, or null when it is not waiting on the user. */
  queueNumber: number | null;
  /** For a parked or finished line outside the tree: how many threads went with it. */
  under: number;
  /** For a line in the tree: how many lines under it are not finished. */
  openUnder: number;
  /** For a line in the tree: how many rows are listed under it. Any makes it a group head. */
  members: number;
  /** Every unarchived thread under it, by state, listed or not. Null when there are none. */
  rollup: Rollup | null;
  /** Finished threads under it that are too old to list. */
  olderUnder: number;
  /** The thread's own words on what happens next, if it left any. */
  note: string | null;
}

/** Work a thread has listed as not started yet: a row in its group. */
export interface TodoRow {
  kind: "todo";
  /** What the cursor holds: unlike a thread's id, it names the owner too. */
  id: string;
  ownerId: string;
  item: TodoItem;
  /** 1-based place in its owner's list, as the CLI numbers it. */
  number: number;
  /** How many items the list has. */
  of: number;
  depth: number;
}
export type Row = { kind: "line"; id: string; depth: number; line: Line } | TodoRow;

/** What threads say about what is next for them. */
export interface Plans {
  note(threadId: string): string | null;
  todos(threadId: string): readonly TodoItem[];
}
const NO_PLANS: Plans = { note: () => null, todos: () => [] };

export const todoRowId = (ownerId: string, itemId: string): string => `todo:${ownerId}:${itemId}`;

export interface Overview {
  /** Null when the Main thread is not among `threads`. */
  main: Line | null;
  /** The tree, top to bottom: each thread under its parent in creation order, then what its parent has not started. */
  rows: Row[];
  /** The thread lines among `rows`. */
  lines: Line[];
  /** Parked by the user, longest parked first. Their descendants are only counted. */
  parked: Line[];
  /** Finished within the listing window, newest first: lines under Main with everything under them, and archived ones. */
  done: Line[];
  /** Every thread under Main that is not archived, listed or not, except under a parked one. */
  unarchived: string[];
  /** Finished longer ago: counted, not listed. */
  olderDone: number;
  /** Main and the lines that are waiting on the user, oldest first. */
  queue: Line[];
  /** How many listed lines are in each state. */
  counts: Record<LineState, number>;
}

function emptyCounts(): Record<LineState, number> {
  return { wants: 0, blocked: 0, running: 0, waiting: 0, stuck: 0, parked: 0, failed: 0, done: 0 };
}

/** The states a rollup shows, in the order it shows them. */
export const ROLLUP_ORDER: readonly LineState[] = ["wants", "blocked", "stuck", "failed", "running", "waiting", "parked", "done"];

function childrenOf(threads: readonly ThreadFacts[]): Map<string, ThreadFacts[]> {
  const children = new Map<string, ThreadFacts[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  return children;
}

/**
 * The threads that have threads under them, archived or not: the ones the
 * person talks to directly, whose replies are theirs to read.
 */
export function headIds(threads: readonly ThreadFacts[]): Set<string> {
  const heads = new Set<string>();
  for (const thread of threads) if (thread.parentThreadId !== null) heads.add(thread.parentThreadId);
  return heads;
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
  plans: Plans = NO_PLANS,
): Overview {
  const children = childrenOf(threads);
  const mainThread = threads.find((thread) => thread.id === mainId) ?? null;

  const overview: Overview = {
    main: null,
    rows: [],
    lines: [],
    parked: [],
    done: [],
    unarchived: [],
    olderDone: 0,
    queue: [],
    counts: emptyCounts(),
  };
  if (!mainThread) return overview;

  // First what every thread under Main is, then where it goes.
  interface Node {
    thread: ThreadFacts;
    derived: Derived;
    kids: Node[];
    /** Unarchived threads under it. */
    under: number;
    /** Not finished: itself, or anything under it. */
    open: boolean;
    /** When the newest thing in it finished. */
    latest: number;
    rollup: Rollup;
  }
  const seen = new Set<string>([mainId]);
  const read = (thread: ThreadFacts): Node => {
    seen.add(thread.id);
    const derived = deriveThread(thread);
    const node: Node = { thread, derived, kids: [], under: 0, open: false, latest: derived.since, rollup: emptyCounts() };
    const archived = thread.archivedAt !== null;
    const parked = derived.state === "parked";
    const planned = !archived && !parked && (plans.note(thread.id) !== null || plans.todos(thread.id).length > 0);
    node.open = !parked && (derived.state !== "done" || planned);
    for (const child of children.get(thread.id) ?? []) {
      if (seen.has(child.id)) continue;
      const kid = read(child);
      node.kids.push(kid);
      node.under += (child.archivedAt === null ? 1 : 0) + kid.under;
      // What is under a parked thread is set aside with it, and says nothing here.
      if (parked) continue;
      if (kid.open) node.open = true;
      node.latest = Math.max(node.latest, kid.latest);
      if (child.archivedAt === null) node.rollup[kid.derived.state] += 1;
      if (kid.derived.state !== "parked") {
        for (const state of ROLLUP_ORDER) node.rollup[state] += kid.rollup[state];
      }
    }
    return node;
  };

  const lineFor = (node: Node, depth: number, parentId: string | null): Line => ({
    thread: node.thread,
    derived: node.derived,
    depth,
    parentId,
    queueNumber: null,
    under: 0,
    openUnder: 0,
    members: 0,
    rollup: node.under > 0 && node.derived.state !== "parked" ? node.rollup : null,
    olderUnder: 0,
    note: node.thread.archivedAt === null ? plans.note(node.thread.id) : null,
  });
  const recent = (node: Node): boolean => now - node.latest <= LIMITS.doneListedMs;
  const noteUnarchived = (node: Node) => {
    if (node.thread.archivedAt === null) overview.unarchived.push(node.thread.id);
  };
  /**
   * A finished subtree leaves the tree whole. What still has a place of its
   * own inside it: a parked thread, on the shelf; and a thread the user
   * archived out of a group that was not archived, under Done with its reason.
   */
  const putAway = (node: Node): void => {
    noteUnarchived(node);
    for (const kid of node.kids) {
      if (kid.derived.state === "parked") shelve(kid);
      else if (kid.thread.archivedAt !== null && node.thread.archivedAt === null) fileDone(kid);
      else putAway(kid);
    }
  };
  /** One line under Done for the whole of a finished subtree, or only a count when it is old. */
  const fileDone = (node: Node): void => {
    putAway(node);
    if (recent(node)) overview.done.push({ ...lineFor(node, 0, null), under: node.under });
    else overview.olderDone += 1;
  };
  /** Everything under a parked thread is set aside with it. */
  const shelve = (node: Node): void => {
    noteUnarchived(node);
    overview.parked.push({ ...lineFor(node, 0, null), under: node.under });
  };
  /** Appends the todo rows of `ownerId` at `depth`; returns how many. */
  const todoRows = (ownerId: string, depth: number): number => {
    const items = plans.todos(ownerId);
    items.forEach((item, index) => {
      overview.rows.push({ kind: "todo", id: todoRowId(ownerId, item.id), ownerId, item, number: index + 1, of: items.length, depth });
    });
    return items.length;
  };
  /**
   * Puts `node` where it belongs. `within` is the open group it is a member
   * of, or null directly under Main.
   */
  const place = (node: Node, depth: number, within: Line | null): void => {
    const { thread, derived } = node;
    if (derived.state === "parked") return shelve(node);
    if (!node.open && (within === null || thread.archivedAt !== null)) {
      return fileDone(node);
    }
    if (!node.open && !recent(node)) {
      // A member that finished long ago is counted on its group, not listed.
      putAway(node);
      if (within) within.olderUnder += 1 + node.under;
      return;
    }
    noteUnarchived(node);
    const line = lineFor(node, depth, within?.thread.id ?? null);
    const at = overview.rows.length;
    overview.rows.push({ kind: "line", id: thread.id, depth, line });
    overview.lines.push(line);
    const linesAt = overview.lines.length;
    for (const kid of node.kids) place(kid, depth + 1, line);
    if (thread.archivedAt === null) todoRows(thread.id, depth + 1);
    line.members = overview.rows.length - at - 1;
    line.openUnder = overview.lines.slice(linesAt).filter((other) => other.derived.state !== "done").length;
  };

  const main = read(mainThread);
  const mainLine: Line = { ...lineFor(main, 0, null), rollup: null, note: plans.note(mainId) };
  overview.main = mainLine;
  for (const kid of main.kids) place(kid, 0, null);
  // What Main itself has not started comes last, under no line.
  todoRows(mainId, 0);

  const latest = new Map<string, number>();
  const stamp = (node: Node) => {
    latest.set(node.thread.id, node.latest);
    node.kids.forEach(stamp);
  };
  stamp(main);
  overview.done.sort(
    (a, b) => (latest.get(b.thread.id) ?? 0) - (latest.get(a.thread.id) ?? 0) || a.thread.id.localeCompare(b.thread.id),
  );
  overview.parked.sort((a, b) => a.derived.since - b.derived.since || a.thread.id.localeCompare(b.thread.id));
  // Main has no line of its own, but its unread reply or question is still
  // the user's to deal with, so it takes a place in the queue.
  overview.queue = [mainLine, ...overview.lines, ...overview.parked]
    .filter((line) => line.derived.waitingOnYou)
    .sort(
      (a, b) =>
        waitingSince(a.derived) - waitingSince(b.derived) || a.thread.id.localeCompare(b.thread.id),
    );
  overview.queue.forEach((line, index) => {
    line.queueNumber = index + 1;
  });
  for (const line of listed(overview)) {
    overview.counts[line.derived.state] += 1;
  }
  return overview;
}

/**
 * One thread as a line, whatever it is under: its state, how many lines are
 * still open under it, and how many threads would go with it. This is what
 * the verbs' rules read, for a thread named outside the page. Null when the
 * thread is not among `threads`.
 */
export function lineOf(
  threads: readonly ThreadFacts[],
  id: string,
  deriveThread: (thread: ThreadFacts) => Derived,
  now: number,
): Line | null {
  const under = buildOverview(threads, id, deriveThread, now);
  if (!under.main) return null;
  return {
    ...under.main,
    openUnder: under.lines.filter((line) => line.derived.state !== "done").length,
    under: under.main.derived.state === "parked" ? under.unarchived.length : 0,
  };
}

/**
 * Every unarchived thread under `mainId`: the ones a park note could be on.
 * With `archivedSince`, also the ones archived at or after that time, whose
 * archive reason the page shows.
 */
export function descendantIds(
  threads: readonly ThreadFacts[],
  mainId: string,
  archivedSince?: number,
): string[] {
  const byParent = new Map<string, ThreadFacts[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = byParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else byParent.set(thread.parentThreadId, [thread]);
  }
  const seen = new Set<string>([mainId]);
  const ids: string[] = [];
  const pending = [mainId];
  while (pending.length > 0) {
    for (const child of byParent.get(pending.pop()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      pending.push(child.id);
      if (child.archivedAt === null || (archivedSince !== undefined && child.archivedAt >= archivedSince)) {
        ids.push(child.id);
      }
    }
  }
  return ids.sort();
}

/** Every thread line on the page, top to bottom: the tree, the shelf, then Done. */
export function listed(overview: Overview): Line[] {
  return [...overview.lines, ...overview.parked, ...overview.done];
}

/** The tree's rows with the members of folded groups left out. */
export function visibleRows(overview: Overview, folded: ReadonlySet<string> = new Set()): Row[] {
  const rows: Row[] = [];
  /** Rows deeper than this are inside a folded group. */
  let hideBelow = Infinity;
  for (const row of overview.rows) {
    if (row.depth > hideBelow) continue;
    hideBelow = row.kind === "line" && row.line.members > 0 && folded.has(row.id) ? row.depth : Infinity;
    rows.push(row);
  }
  return rows;
}

/** The ids the cursor can rest on, top to bottom; a folded group's members are skipped. */
export function cursorOrder(overview: Overview, folded?: ReadonlySet<string>): string[] {
  return [
    ...visibleRows(overview, folded).map((row) => row.id),
    ...overview.parked.map((line) => line.thread.id),
    ...overview.done.map((line) => line.thread.id),
  ];
}

/** The heads of the groups the row `id` is inside, outermost first. */
export function groupsAround(overview: Overview, id: string): string[] {
  const at = overview.rows.findIndex((row) => row.id === id);
  if (at < 0) return [];
  const heads: string[] = [];
  let depth = overview.rows[at]!.depth;
  for (let i = at - 1; i >= 0 && depth > 0; i -= 1) {
    const row = overview.rows[i]!;
    if (row.depth < depth) {
      heads.unshift(row.id);
      depth = row.depth;
    }
  }
  return heads;
}

/** The fold state after making the row `id` visible: every group around it unfolded. */
export function unfoldAround(overview: Overview, folded: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const around = groupsAround(overview, id).filter((head) => folded.has(head));
  if (around.length === 0) return folded;
  const next = new Set(folded);
  for (const head of around) next.delete(head);
  return next;
}

export type FoldMove =
  /** Change what is folded; the cursor stays. */
  | { kind: "fold"; folded: ReadonlySet<string> }
  /** Move the cursor. */
  | { kind: "cursor"; id: string }
  | { kind: "none" };

/**
 * What `h` (inward: fold) and `l` (outward: unfold) do on the row `id`.
 * `h` folds an unfolded head, and anywhere else jumps to the head of the
 * group the row is in. `l` unfolds a folded head, and on an unfolded one
 * steps onto its first member.
 */
export function foldMove(overview: Overview, folded: ReadonlySet<string>, id: string | null, key: "h" | "l"): FoldMove {
  const at = id === null ? -1 : overview.rows.findIndex((row) => row.id === id);
  const row = overview.rows[at];
  if (!row) return { kind: "none" };
  const head = row.kind === "line" && row.line.members > 0;
  if (key === "h") {
    if (head && !folded.has(row.id)) return { kind: "fold", folded: new Set([...folded, row.id]) };
    const around = groupsAround(overview, row.id);
    const parent = around[around.length - 1];
    return parent === undefined ? { kind: "none" } : { kind: "cursor", id: parent };
  }
  if (!head) return { kind: "none" };
  if (folded.has(row.id)) {
    const next = new Set(folded);
    next.delete(row.id);
    return { kind: "fold", folded: next };
  }
  return { kind: "cursor", id: overview.rows[at + 1]!.id };
}

/** The fold state without threads that are no longer on the page, so it cannot grow for ever. */
export function keepFolds(overview: Overview, folded: ReadonlySet<string>): ReadonlySet<string> {
  const known = new Set(overview.unarchived);
  const kept = [...folded].filter((id) => known.has(id));
  return kept.length === folded.size ? folded : new Set(kept);
}

/** How many lines inside the group headed by `headId` wait on the user. */
export function waitingInside(overview: Overview, headId: string): number {
  return overview.queue.filter((line) => groupsAround(overview, line.thread.id).includes(headId)).length;
}

/**
 * What a line's "next move" says. The thread's own note stands in place of
 * what cow works out, except where cow's text is the key to press for
 * something only the user can do: an ask, a refusal, a failure, parked work.
 */
export function nextMove(line: Line): { text: string; own: boolean } {
  const { derived } = line;
  const act = derived.state === "parked" || (derived.waitingOnYou && !derived.reply);
  if (line.note !== null && !act && line.thread.archivedAt === null) return { text: line.note, own: true };
  return { text: derived.next, own: false };
}

/**
 * Where the cursor goes when the row `id` is about to leave its place
 * (parked, resumed, archived, removed): the next row down that is not
 * leaving with it, or the one above when nothing is below. Null when it
 * would be alone.
 */
export function afterLeaving(overview: Overview, id: string, folded?: ReadonlySet<string>): string | null {
  const order = cursorOrder(overview, folded);
  const at = order.indexOf(id);
  if (at < 0) return null;
  const leaving = new Set([id]);
  const inTree = overview.rows.findIndex((row) => row.id === id);
  if (inTree >= 0) {
    const depth = overview.rows[inTree]!.depth;
    for (let i = inTree + 1; i < overview.rows.length && overview.rows[i]!.depth > depth; i += 1) {
      leaving.add(overview.rows[i]!.id);
    }
  }
  const below = order.slice(at + 1).find((other) => !leaving.has(other));
  return below ?? order.slice(0, at).reverse().find((other) => !leaving.has(other)) ?? null;
}
