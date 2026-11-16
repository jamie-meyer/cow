// What the backend and the page both need to know.
import { z } from "zod";

/** Realtime channel: published whenever one of cow's notes on a thread changes. */
export const NOTES_CHANGED = "notes-changed";

/** The keys of cow's notes in a thread's plugin metadata. */
export const PARK_KEY = "park";
export const ARCHIVE_KEY = "archive";

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
