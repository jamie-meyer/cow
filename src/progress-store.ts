// Where each worker's progress record (progress.ts) is kept: cow's own
// storage, one key per thread. Reading a thread again asks bb only for the
// events after the last one read, and not at all when bb says the thread has
// not changed since. The record holds counts, times, item kinds, hashes and
// clipped labels: no message text, no file contents.

import { z } from "zod";
import { type Kv, serial } from "./kv.ts";
import { NO_PROGRESS, PROGRESS_EVENT_TYPES, type Progress, foldProgress } from "./progress.ts";

export const PROGRESS_PREFIX = "progress:";
/** bb returns at most this many events per request. */
const EVENT_PAGE = 100;
/** A single read goes this far at most; the next read carries on from where it stopped. */
const MAX_EVENT_PAGES = 100;

const tokensSchema = z.object({ input: z.number().min(0), cacheRead: z.number().min(0), cacheWrite: z.number().min(0), output: z.number().min(0) });
const liveSchema = z.object({
  session: z.string().max(128),
  offset: z.number().int().min(0),
  partial: z.boolean(),
  countFrom: z.number().nullable(),
  tokens: z.record(z.string().max(100), tokensSchema),
  keys: z.array(z.object({ key: z.string().max(32), model: z.string().max(100), tokens: tokensSchema })).max(64),
  readAt: z.number().nullable(),
});
const callSchema = z.object({ id: z.string(), kind: z.string(), label: z.string(), hash: z.string() });
const progressSchema = z.object({
  lastSeq: z.number().nullable(),
  toolCalls: z.number().int().min(0),
  firstTurnAt: z.number().nullable(),
  turnStartedAt: z.number().nullable(),
  workingMs: z.number().min(0),
  turns: z.number().int().min(0),
  lastEventAt: z.number().nullable(),
  open: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), since: z.number() })),
  lastFileChangeAt: z.number().nullable(),
  recent: z.array(callSchema),
  repeat: z.number().int().min(0),
  counted: z.array(z.string()),
  session: z.string().nullable().optional(),
  usageAt: z.number().nullable().optional(),
  live: liveSchema.nullable().optional(),
});
const recordSchema = z.object({ progress: progressSchema, seenUpdatedAt: z.number().nullable() });

/** Reads a page of a thread's turn, item and usage events, oldest first, after `afterSeq`. */
export type ReadProgressEvents = (threadId: string, afterSeq: number | null) => Promise<readonly unknown[]>;

export const sdkProgressEvents =
  (events: { list(args: { threadId: string; limit: string; order: "asc"; afterSeq?: string; types: never }): Promise<readonly unknown[]> }): ReadProgressEvents =>
  (threadId, afterSeq) =>
    events.list({ threadId, limit: String(EVENT_PAGE), order: "asc", ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }), types: PROGRESS_EVENT_TYPES as never });

export interface ProgressStore {
  /** A thread's progress, brought up to date. With `updatedAt` (bb's) no later than the last read, bb is not asked. */
  read(threadId: string, updatedAt?: number | null): Promise<Progress>;
  kept(threadId: string): Promise<Progress | null>;
  /** Change what is kept, in turn with reads: the transcript reading. */
  update(threadId: string, change: (p: Progress) => Progress): Promise<Progress>;
  forget(threadId: string): Promise<void>;
}

export function createProgressStore(kv: Kv, read: ReadProgressEvents): ProgressStore {
  const one = serial();
  const keptRecord = async (threadId: string) => {
    const parsed = recordSchema.safeParse(await kv.get(PROGRESS_PREFIX + threadId));
    return parsed.success ? parsed.data : null;
  };
  return {
    read: (threadId, updatedAt) =>
      one(threadId, async () => {
        const before = await keptRecord(threadId);
        if (before && typeof updatedAt === "number" && before.seenUpdatedAt !== null && before.seenUpdatedAt >= updatedAt) return before.progress;
        let progress: Progress = before?.progress ?? NO_PROGRESS;
        for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
          const got = await read(threadId, progress.lastSeq);
          const last = got[got.length - 1] as { seq?: unknown } | undefined;
          progress = foldProgress(progress, got);
          if (got.length < EVENT_PAGE || typeof last?.seq !== "number") break;
        }
        const seenUpdatedAt = typeof updatedAt === "number" ? updatedAt : (before?.seenUpdatedAt ?? null);
        if (!before || before.progress.lastSeq !== progress.lastSeq || before.seenUpdatedAt !== seenUpdatedAt) await kv.set(PROGRESS_PREFIX + threadId, { progress, seenUpdatedAt });
        return progress;
      }),
    kept: async (threadId) => (await keptRecord(threadId))?.progress ?? null,
    update: (threadId, change) =>
      one(threadId, async () => {
        const before = await keptRecord(threadId);
        const progress = change(before?.progress ?? NO_PROGRESS);
        await kv.set(PROGRESS_PREFIX + threadId, { progress, seenUpdatedAt: before?.seenUpdatedAt ?? null });
        return progress;
      }),
    forget: (threadId) => kv.delete(PROGRESS_PREFIX + threadId),
  };
}
