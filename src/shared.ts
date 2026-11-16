// What the backend and the page both need to know.
import { z } from "zod";

/** Realtime channel: published whenever a Main is chosen. */
export const MAIN_CHANGED = "main-changed";
/** Realtime channel: published whenever a thread is parked or resumed. */
export const PARKS_CHANGED = "parks-changed";

/** The key of cow's note in a thread's plugin metadata. */
export const PARK_KEY = "park";

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
