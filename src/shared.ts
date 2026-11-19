// What the backend and the page both need to know.
import { z } from "zod";

/** Realtime channel: published whenever one of cow's notes on a thread changes. */
export const NOTES_CHANGED = "notes-changed";

/** The keys of cow's notes in a thread's plugin metadata. */
export const PARK_KEY = "park";
export const ARCHIVE_KEY = "archive";
export const DISMISS_KEY = "refusals-dismissed";

const pickUpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), at: z.number() }),
  z.object({ kind: z.literal("condition"), text: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("none") }),
]);

/** cow's note on a parked thread. Times are epoch milliseconds. */
export const parkRecordSchema = z.object({
  /** When it was parked. */
  at: z.number(),
  reason: z.string().min(1).max(300),
  pickUp: pickUpSchema,
  /** When the user last decided to keep it parked; the four-week check counts from here. */
  checkedAt: z.number(),
});
export type ParkRecord = z.infer<typeof parkRecordSchema>;

/** cow's note on why a thread was archived. It stays if the archive is undone. */
export const archiveNoteSchema = z.object({
  /** Absent when it was archived without one: the note is then kept only for `outside`. */
  reason: z.string().min(1).max(300).optional(),
  /** When the reason was given. */
  at: z.number(),
  /**
   * It had no parent and was no Main when it was archived: listed under
   * Outside Main. Archived, it is under no Main, so this is what lists it
   * under Archived for two days.
   */
  outside: z.literal(true).optional(),
});
export type ArchiveNote = z.infer<typeof archiveNoteSchema>;

/**
 * cow's note that the user dismissed a thread's refused permissions: every
 * refusal up to this place in the thread's event log is no longer shown.
 */
export const dismissalSchema = z.object({
  throughSeq: z.number(),
  /** When it was dismissed. */
  at: z.number(),
});
export type Dismissal = z.infer<typeof dismissalSchema>;

/**
 * cow's note that a thread is a project: long-lived, and one the person
 * talks to. A project is never done: when it has nothing to say it is idle.
 */
export const PROJECT_KEY = "project";
export const projectMarkSchema = z.object({
  /** When it was marked, and by which thread when the CLI knew. */
  at: z.number(),
  by: z.string().nullable(),
});
export type ProjectMark = z.infer<typeof projectMarkSchema>;

/** A thread's own words on what happens next for it. */
export const NEXT_KEY = "next";
export const MAX_NEXT = 160;
export const nextNoteSchema = z.object({
  text: z.string().min(1).max(MAX_NEXT),
  /** When it was set, and by which thread when the CLI knew. */
  at: z.number(),
  by: z.string().nullable(),
});
export type NextNote = z.infer<typeof nextNoteSchema>;

/**
 * A thread's note that its next move belongs to someone other than the
 * person: a reviewer, CI, someone outside the team. It holds until the
 * thread starts a new turn, and with a reminder it comes back to the
 * person's queue on that day.
 */
export const WAIT_KEY = "waiting";
export const MAX_WAIT_ON = 80;
export const MAX_WAIT_FOR = 160;
export const waitNoteSchema = z.object({
  /** Who or what it waits on, in a few words: "the reviewer", "CI". */
  on: z.string().min(1).max(MAX_WAIT_ON),
  /** What is needed from them, if said. */
  for: z.string().min(1).max(MAX_WAIT_FOR).nullable(),
  /** When to put it in front of the person if it is still waiting; null for never. */
  remindAt: z.number().nullable(),
  /** When it was set, and by which thread when the CLI knew. */
  at: z.number(),
  by: z.string().nullable(),
});
export type WaitNote = z.infer<typeof waitNoteSchema>;

/** A thread's short list of work it has not started yet, in order. */
export const TODO_KEY = "todo";
export const MAX_TODOS = 12;
export const MAX_TODO_TITLE = 160;
export const todoItemSchema = z.object({
  /** Stable for as long as the item lives; its number in the list is its place. */
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(MAX_TODO_TITLE),
  at: z.number(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;
export const todoListSchema = z.array(todoItemSchema).max(MAX_TODOS);

/**
 * cow's record that the person has seen a thread's reply: the turn they last
 * saw, as the place of its end in the thread's event log. Kept in the
 * plugin's own storage, not on the thread, so only cow's page writes it.
 */
export const seenSchema = z.object({
  seq: z.number(),
  /** When it was marked. */
  at: z.number(),
});
export type Seen = z.infer<typeof seenSchema>;

/**
 * cow's note that the person keeps a thread around on purpose, asking for
 * nothing: it is on the Kept shelf, never in the queue for anything but what
 * truly needs them, and with no reminder. It holds until the thread starts a
 * new turn. Set only from the page.
 */
export const KEEP_KEY = "keep";
export const MAX_KEEP_WORDS = 120;
export const keepNoteSchema = z.object({
  /** A few words of the person's, shown on its line; null when none were typed. */
  words: z.string().min(1).max(MAX_KEEP_WORDS).nullable(),
  /** When it was kept. */
  at: z.number(),
});
export type KeepNote = z.infer<typeof keepNoteSchema>;
