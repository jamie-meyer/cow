// What cow has read of each thread's token usage, kept in its own storage:
// the counts so far and the last event read. Reading a thread again asks bb
// only for the events after that one, and not at all when bb says the thread
// has not changed since it was last read. One key per thread.

import { z } from "zod";
import type { Kv } from "./kv.ts";
import { serial } from "./kv.ts";
import { NO_USAGE, USAGE_EVENT_TYPES, type UsageState, foldUsage } from "./usage.ts";

export const USAGE_PREFIX = "usage:";
/** bb returns at most this many events per request. */
const EVENT_PAGE = 100;
/** A single read goes this far at most; the next read carries on from where it stopped. */
const MAX_EVENT_PAGES = 200;
/** bb keeps each value to 256 KB; a thread's record is kept well under it. */
const MAX_RECORD_CHARS = 120_000;

const tokensSchema = z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() });
const byModel = z.record(z.string(), tokensSchema);
const stateSchema = z.object({
  lastSeq: z.number().nullable(),
  events: z.number().int().min(0),
  model: z.string().nullable(),
  sessions: byModel,
  restarted: z.array(z.string()).optional(),
  ttlMs: z.number().nullable(),
  total: byModel,
  days: z.record(z.string(), byModel),
});
const recordSchema = z.object({
  state: stateSchema,
  /** bb's `updatedAt` of the thread when it was last read through; null when unknown. */
  seenUpdatedAt: z.number().nullable(),
});
export type UsageRecord = z.infer<typeof recordSchema>;

/** Reads a page of a thread's prompts and usage events, oldest first, after `afterSeq`. */
export type ReadUsageEvents = (threadId: string, afterSeq: number | null) => Promise<readonly unknown[]>;

/** The SDK's `threads.events.list`, asked for prompts and usage events only. */
export const sdkUsageEvents =
  (events: { list(args: { threadId: string; limit: string; order: "asc"; afterSeq?: string; types: never }): Promise<readonly unknown[]> }): ReadUsageEvents =>
  (threadId, afterSeq) =>
    events.list({ threadId, limit: String(EVENT_PAGE), order: "asc", ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }), types: USAGE_EVENT_TYPES as never });

export interface UsageStore {
  /**
   * A thread's usage, brought up to date. With `updatedAt` (bb's, from its
   * thread list) and a record read at or after it, bb is not asked at all.
   * `fresh` says whether new usage was found.
   */
  read(threadId: string, updatedAt?: number | null): Promise<{ state: UsageState; fresh: boolean }>;
  /** What was kept, without asking bb. */
  kept(threadId: string): Promise<UsageState | null>;
  forget(threadId: string): Promise<void>;
}

/** Drop the oldest days until the record fits in what bb keeps per value. */
function fitted(record: UsageRecord): UsageRecord {
  let state = record.state;
  while (JSON.stringify({ ...record, state }).length > MAX_RECORD_CHARS && Object.keys(state.days).length > 0) {
    const days = Object.keys(state.days).sort();
    const { [days[0] as string]: _dropped, ...rest } = state.days;
    state = { ...state, days: rest };
  }
  return { ...record, state };
}

export function createUsageStore(kv: Kv, read: ReadUsageEvents): UsageStore {
  const one = serial();
  const keptRecord = async (threadId: string): Promise<UsageRecord | null> => {
    const parsed = recordSchema.safeParse(await kv.get(USAGE_PREFIX + threadId));
    return parsed.success ? parsed.data : null;
  };
  return {
    read: (threadId, updatedAt) =>
      one(threadId, async () => {
        const before = await keptRecord(threadId);
        if (before && typeof updatedAt === "number" && before.seenUpdatedAt !== null && before.seenUpdatedAt >= updatedAt) return { state: before.state, fresh: false };
        let state: UsageState = before?.state ?? NO_USAGE;
        const events = state.events;
        for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
          const got = await read(threadId, state.lastSeq);
          const last = got[got.length - 1] as { seq?: unknown } | undefined;
          state = foldUsage(state, got);
          if (got.length < EVENT_PAGE || typeof last?.seq !== "number") break;
        }
        const record = fitted({ state, seenUpdatedAt: typeof updatedAt === "number" ? updatedAt : (before?.seenUpdatedAt ?? null) });
        if (!before || before.state.lastSeq !== record.state.lastSeq || before.seenUpdatedAt !== record.seenUpdatedAt) await kv.set(USAGE_PREFIX + threadId, record);
        return { state: record.state, fresh: record.state.events > events };
      }),
    kept: async (threadId) => (await keptRecord(threadId))?.state ?? null,
    forget: (threadId) => kv.delete(USAGE_PREFIX + threadId),
  };
}
