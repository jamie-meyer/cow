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
  reason: z.string().min(1).max(300),
  /** When the reason was given. */
  at: z.number(),
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
