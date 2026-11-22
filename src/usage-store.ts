// What cow has read of each thread's token usage, kept in its own storage:
// the counts so far and the last event read. Reading a thread again asks bb
// only for the events after that one, and not at all when bb says the thread
// has not changed since it was last read. One key per thread.

import { z } from "zod";
import type { Kv } from "./kv.ts";
import { serial } from "./kv.ts";
import { NO_USAGE, TOKEN_KEYS, type Tokens, UNKNOWN_MODEL, USAGE_EVENT_TYPES, type UsageState, dayOf, foldUsage } from "./usage.ts";

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
/** Where a thread stood, kept so its usage can be placed under its Main after bb no longer has it. No title, no text. */
const placeSchema = z.object({
  parentThreadId: z.string().nullable(),
  projectId: z.string(),
  /** One of cow's checker runs. */
  checker: z.boolean(),
  /** Marked as a project thread when spend last placed it; absent when not known. */
  project: z.boolean().optional(),
});
export type UsagePlace = z.infer<typeof placeSchema>;
const recordSchema = z.object({
  state: stateSchema,
  /** bb's `updatedAt` of the thread when it was last read through; null when unknown. */
  seenUpdatedAt: z.number().nullable(),
  /** Where the thread stood when it was last read (from 0.2.24); absent in records kept before. */
  place: placeSchema.optional(),
  /** When cow found that bb deleted the thread; its usage is kept until forgotten on purpose (`bb cow spend forget --deleted`). */
  deletedAt: z.number().nullable().optional(),
  /** Made from the thread's ledger row after it was deleted: its tokens are all on the day it was archived. */
  fromLedger: z.boolean().optional(),
});
export type UsageRecord = z.infer<typeof recordSchema>;

/** A stored record that does not parse: kept as it is, never written over, said. */
export class UnreadableUsage extends Error {
  readonly threadId: string;
  constructor(threadId: string) {
    super(`the usage record of ${threadId} could not be read: it is kept as it is and not written over`);
    this.threadId = threadId;
  }
}

/** What a kept record says, as spend needs it. */
export type KeptUsage = { kind: "ok"; record: UsageRecord } | { kind: "none" } | { kind: "unreadable" };

/** Whether `after` holds less than `before` of any model's tokens, or fewer events: such a record is never written over `before`. */
export function lowers(before: UsageState, after: UsageState): boolean {
  if (after.events < before.events) return true;
  for (const [model, was] of Object.entries(before.total)) {
    const now = after.total[model];
    if (!now || TOKEN_KEYS.some((key) => now[key] < was[key])) return true;
  }
  return false;
}

/** A record made from a deleted thread's ledger row: its four counts on its archive day, its dispatcher as its parent. */
export function ledgerRecord(row: { model: string | null; archivedAt: number; dispatchedBy: string | null; projectId: string }, tokens: Tokens, noticedAt: number): UsageRecord {
  const model = row.model ?? UNKNOWN_MODEL;
  return {
    state: { ...NO_USAGE, events: 1, model: row.model, total: { [model]: tokens }, days: { [dayOf(row.archivedAt)]: { [model]: tokens } } },
    seenUpdatedAt: null,
    place: { parentThreadId: row.dispatchedBy, projectId: row.projectId, checker: false },
    deletedAt: noticedAt,
    fromLedger: true,
  };
}

/** Reads a page of a thread's prompts and usage events, oldest first, after `afterSeq`. */
export type ReadUsageEvents = (threadId: string, afterSeq: number | null) => Promise<readonly unknown[]>;

/** The SDK's `threads.events.list`, asked for prompts and usage events only. */
export const sdkUsageEvents =
  (events: { list(args: { threadId: string; limit: string; order: "asc"; afterSeq?: string; types: never }): Promise<readonly unknown[]> }): ReadUsageEvents =>
  (threadId, afterSeq) =>
    events.list({ threadId, limit: String(EVENT_PAGE), order: "asc", ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }), types: USAGE_EVENT_TYPES as never });

/** What is known of where a thread stands, as it is read. `checker` and `project` only when known. */
export type PlaceSeen = { parentThreadId: string | null; projectId: string; checker?: boolean; project?: boolean };

export interface UsageStore {
  /**
   * A thread's usage, brought up to date. With `updatedAt` (bb's, from its
   * thread list) and a record read at or after it, bb is not asked at all.
   * `fresh` says whether new usage was found. With `place`, where the thread
   * stands is kept with it, and a deletion mark is taken off (bb has it).
   * A stored record that does not parse is left as it is: UnreadableUsage is
   * thrown, and nothing is written.
   */
  read(threadId: string, updatedAt?: number | null, place?: PlaceSeen): Promise<{ state: UsageState; fresh: boolean }>;
  /** What was kept, without asking bb. */
  kept(threadId: string): Promise<UsageState | null>;
  /** The whole kept record, or that there is none, or that it does not parse. */
  record(threadId: string): Promise<KeptUsage>;
  /** Every thread with a kept record. */
  ids(): Promise<string[]>;
  /** Mark a kept record as of a thread bb deleted; where it stood, if not known yet. Nothing for a thread with no record or an unreadable one. */
  markDeleted(threadId: string, at: number, place?: PlaceSeen): Promise<void>;
  /** Write a record made from a ledger row, only when the thread has none at all. Whether it was written. */
  restore(threadId: string, record: UsageRecord): Promise<boolean>;
  /** Remove a kept record (the caller knows bb deleted its thread); never an unreadable one. Whether it was removed. */
  forgetDeleted(threadId: string): Promise<boolean>;
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

const placed = (was: UsagePlace | undefined, seen: PlaceSeen | undefined): UsagePlace | undefined => {
  if (!seen) return was;
  const project = seen.project ?? was?.project;
  return { parentThreadId: seen.parentThreadId, projectId: seen.projectId, checker: seen.checker ?? was?.checker ?? false, ...(project === undefined ? {} : { project }) };
};
const samePlace = (a: UsagePlace | undefined, b: UsagePlace | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createUsageStore(kv: Kv, read: ReadUsageEvents, warn: (text: string) => void = () => undefined): UsageStore {
  const one = serial();
  const said = new Set<string>();
  const unreadable = (threadId: string): never => {
    const error = new UnreadableUsage(threadId);
    if (!said.has(threadId)) {
      said.add(threadId);
      warn(error.message);
    }
    throw error;
  };
  const keptOf = async (threadId: string): Promise<KeptUsage> => {
    const raw = await kv.get(USAGE_PREFIX + threadId);
    if (raw === undefined || raw === null) return { kind: "none" };
    const parsed = recordSchema.safeParse(raw);
    return parsed.success ? { kind: "ok", record: parsed.data } : { kind: "unreadable" };
  };
  /** The kept record, null when there is none; throws when there is one that does not parse. */
  const keptRecord = async (threadId: string): Promise<UsageRecord | null> => {
    const kept = await keptOf(threadId);
    if (kept.kind === "unreadable") return unreadable(threadId);
    return kept.kind === "ok" ? kept.record : null;
  };
  /** Write a record, unless what is stored now does not parse or holds more. */
  const write = async (threadId: string, record: UsageRecord): Promise<UsageRecord> => {
    const now = await keptOf(threadId);
    if (now.kind === "unreadable") return unreadable(threadId);
    if (now.kind === "ok" && lowers(now.record.state, record.state)) {
      warn(`the usage of ${threadId} was not written: it would hold less than the record kept`);
      return now.record;
    }
    await kv.set(USAGE_PREFIX + threadId, record);
    return record;
  };
  return {
    read: (threadId, updatedAt, place) =>
      one(threadId, async () => {
        const before = await keptRecord(threadId);
        const where = placed(before?.place, place);
        const moved = before !== null && place !== undefined && (!samePlace(before.place, where) || (before.deletedAt ?? null) !== null);
        if (before && typeof updatedAt === "number" && before.seenUpdatedAt !== null && before.seenUpdatedAt >= updatedAt) {
          if (moved) await write(threadId, { ...before, ...(where ? { place: where } : {}), deletedAt: null });
          return { state: before.state, fresh: false };
        }
        let state: UsageState = before?.state ?? NO_USAGE;
        const events = state.events;
        for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
          const got = await read(threadId, state.lastSeq);
          const last = got[got.length - 1] as { seq?: unknown } | undefined;
          state = foldUsage(state, got);
          if (got.length < EVENT_PAGE || typeof last?.seq !== "number") break;
        }
        const deletedAt = place === undefined ? (before?.deletedAt ?? null) : null;
        const next = fitted({
          ...(before ?? {}),
          state,
          seenUpdatedAt: typeof updatedAt === "number" ? updatedAt : (before?.seenUpdatedAt ?? null),
          ...(where ? { place: where } : {}),
          ...(deletedAt === null && before?.deletedAt === undefined ? {} : { deletedAt }),
        });
        const changed = !before || before.state.lastSeq !== next.state.lastSeq || before.seenUpdatedAt !== next.seenUpdatedAt || moved;
        const kept = changed ? await write(threadId, next) : next;
        return { state: kept.state, fresh: kept.state.events > events };
      }),
    kept: async (threadId) => (await keptOf(threadId).then((k) => (k.kind === "ok" ? k.record.state : null))),
    record: keptOf,
    ids: async () => (await kv.list(USAGE_PREFIX)).map((key) => key.slice(USAGE_PREFIX.length)),
    markDeleted: (threadId, at, place) =>
      one(threadId, async () => {
        const kept = await keptOf(threadId);
        if (kept.kind !== "ok" || (kept.record.deletedAt ?? null) !== null) return;
        const where = kept.record.place ?? placed(undefined, place);
        await write(threadId, { ...kept.record, ...(where ? { place: where } : {}), deletedAt: at });
      }),
    restore: (threadId, record) =>
      one(threadId, async () => {
        if ((await kv.get(USAGE_PREFIX + threadId)) !== undefined) return false;
        await kv.set(USAGE_PREFIX + threadId, record);
        return true;
      }),
    forgetDeleted: (threadId) =>
      one(threadId, async () => {
        const kept = await keptOf(threadId);
        if (kept.kind !== "ok") return false;
        await kv.delete(USAGE_PREFIX + threadId);
        return true;
      }),
  };
}
