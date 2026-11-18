// What the page can take back: the last park, resume, archive, dismissal,
// mark as seen, marking as a project, saying it waits on someone else, or
// keeping it.
// Stopping a turn, answering a question and sending a message reach the
// agent, so they are never recorded.

import type { Dismissal, KeepNote, ParkRecord, ProjectMark, Seen, WaitNote } from "./shared.ts";

export type UndoEntry =
  /** Parked, or kept parked with a new pick-up; `before` is the note it replaced, and `kept` the keep note parking took off. */
  | { kind: "park"; threadId: string; title: string; before: ParkRecord | null; kept?: KeepNote | null }
  /** Kept, or taken off the Kept shelf; `before` is the keep note it had, and `parked` the park note keeping took off. */
  | { kind: "keep"; threadId: string; title: string; before: KeepNote | null; parked: ParkRecord | null }
  | { kind: "resume"; threadId: string; title: string; record: ParkRecord }
  /** Dismissed its refused permissions; `before` is the dismissal it replaced. */
  | { kind: "dismiss"; threadId: string; title: string; before: Dismissal | null }
  /** Marked its reply as seen; `before` is what was recorded as seen until then. */
  | { kind: "seen"; threadId: string; title: string; before: Seen | null }
  /** Marked as a project, or unmarked; `before` is the mark it had until then. */
  | { kind: "project"; threadId: string; title: string; before: ProjectMark | null }
  /** Said it waits on someone else, kept it waiting, or cleared it; `before` is the note it had until then. */
  | { kind: "wait"; threadId: string; title: string; before: WaitNote | null }
  /**
   * Archived; `dropped` when it was parked work, stopped and archived
   * together. bb archives a thread's descendants with it but brings back
   * only the thread asked for, so `under` lists the ones to bring back too.
   */
  | {
      kind: "archive";
      threadId: string;
      title: string;
      dropped: boolean;
      under: readonly string[];
      /** The reason given; cow keeps it on the thread when the archive is undone. */
      reason: string | null;
    };

function unarchived(under: number): string {
  if (under === 0) return "it is unarchived";
  return `it and the ${under === 1 ? "thread" : `${under} threads`} under it are unarchived`;
}

/** What undoing `entry` will do, for the confirmation and the verb bar. */
export function undoText(entry: UndoEntry): string {
  const name = `“${entry.title}”`;
  switch (entry.kind) {
    case "park":
      return entry.before === null
        ? `undo parking ${name}: it goes back into the tree`
        : `undo keeping ${name} parked: it asks again`;
    case "resume":
      return `undo resuming ${name}: it goes back on the shelf`;
    case "keep":
      return entry.before === null
        ? `undo keeping ${name}: it reads as it did before${entry.parked ? ", parked" : ""}`
        : `undo taking ${name} off Kept: it is kept again`;
    case "seen":
      return `undo marking ${name} as seen: its reply waits on you again`;
    case "project":
      return entry.before === null ? `undo marking ${name} as a project` : `undo unmarking ${name}: it is a project again`;
    case "wait":
      return entry.before === null ? `undo marking ${name} as waiting: it reads as it did before` : `undo: ${name} waits on ${entry.before.on} again, as before`;
    case "dismiss":
      return `undo dismissing what bb refused ${name}: it reads as blocked again`;
    case "archive": {
      const kept = entry.reason === null ? "" : "; its reason is kept";
      return entry.dropped
        ? `undo dropping ${name}: ${unarchived(entry.under.length)} and parked as before, but stays stopped${kept}`
        : `undo archiving ${name}: ${unarchived(entry.under.length)}${kept}`;
    }
  }
}

/** The few words the verb bar shows beside `u`. */
export function undoShort(entry: UndoEntry): string {
  if (entry.kind === "park") return entry.before === null ? "undo park" : "undo keep parked";
  if (entry.kind === "keep") return entry.before === null ? "undo keep" : "undo unkeep";
  if (entry.kind === "resume") return "undo resume";
  if (entry.kind === "dismiss") return "undo dismiss";
  if (entry.kind === "seen") return "undo seen";
  if (entry.kind === "project") return entry.before === null ? "undo project" : "undo unmark";
  if (entry.kind === "wait") return "undo wait";
  return entry.dropped ? "undo drop" : "undo archive";
}
