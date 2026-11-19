// Where the ledger is kept: cow's own key-value storage, one key per worker
// for its row and one for the judgements of its outcome, so a row outlives
// its thread and an agent cannot rewrite it through the thread's metadata.

import { type Kv, Refusal, serial } from "./kv.ts";
import {
  type Judgement,
  type LedgerRow,
  type Outcome,
  TURN_EVENT_TYPES,
  buildRow,
  judge,
  judgementsSchema,
  outcomeFields,
  readTurns,
  rowSchema,
} from "./ledger.ts";

export const ROW_PREFIX = "ledger:row:";
export const JUDGED_PREFIX = "ledger:judged:";
/** Published when a row or an outcome changes. */
export const LEDGER_CHANGED = "cow.ledger.changed";

/** bb returns at most this many events per request. */
const EVENT_PAGE = 100;
/** A thread's log is read this far at most: 100 pages of prompts and turns. */
const MAX_EVENT_PAGES = 100;

/** Reads a page of a thread's events, oldest first, after `afterSeq`. */
export type ReadEvents = (threadId: string, afterSeq: number | null) => Promise<readonly unknown[]>;

/** Every prompt and turn of a thread, oldest first. */
export async function turnEvents(read: ReadEvents, threadId: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let after: number | null = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const events = await read(threadId, after);
    all.push(...events);
    const last = events[events.length - 1] as { seq?: unknown } | undefined;
    if (events.length < EVENT_PAGE || typeof last?.seq !== "number") break;
    after = last.seq;
  }
  return all;
}

/** The SDK's `threads.events.list`, asked for prompts and turns only. */
export const sdkEvents =
  (events: { list(args: { threadId: string; limit: string; order: "asc"; afterSeq?: string; types: never }): Promise<readonly unknown[]> }): ReadEvents =>
  (threadId, afterSeq) =>
    events.list({ threadId, limit: String(EVENT_PAGE), order: "asc", ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }), types: TURN_EVENT_TYPES as never });

export interface LedgerStore {
  /** Write a worker's row when it is archived. Null, and nothing written, when it never finished a turn. */
  record(thread: { id: string; projectId: string; parentThreadId: string | null }, archived: { at: number; by: string }): Promise<LedgerRow | null>;
  /** Whether the thread finished a turn: only a worker that did has an outcome. */
  finished(threadId: string): Promise<boolean>;
  /** Judge a worker's outcome, open or archived. Refused when a thread would overwrite the person. Its row, if it has one, follows. */
  judge(threadId: string, outcome: Outcome, by: string, at: number): Promise<{ judgements: Judgement[]; row: LedgerRow | null }>;
  /** Whether the outcome could be judged by `by` now; the refusal it would get, or null. */
  refusal(threadId: string, by: string): Promise<Refusal | null>;
  judgements(threadId: string): Promise<Judgement[]>;
  /** The latest outcome of every worker that has one. */
  outcomes(): Promise<Map<string, Judgement>>;
  rows(): Promise<LedgerRow[]>;
}

export function createLedgerStore(kv: Kv, read: ReadEvents, changed: () => void = () => undefined): LedgerStore {
  const one = serial();
  const judgementsOf = async (threadId: string): Promise<Judgement[]> => {
    const parsed = judgementsSchema.safeParse(await kv.get(JUDGED_PREFIX + threadId));
    return parsed.success ? parsed.data : [];
  };
  const rowOf = async (threadId: string): Promise<LedgerRow | null> => {
    const parsed = rowSchema.safeParse(await kv.get(ROW_PREFIX + threadId));
    return parsed.success ? parsed.data : null;
  };
  const refusalFor = (judgements: readonly Judgement[], by: string): Refusal | null => {
    const tried = judge(judgements, "done", by, 0);
    return tried.ok ? null : new Refusal(tried.code, tried.why, tried.code === "person_judged" ? "Only the person changes it now: o on its line on cow's page, or `bb cow outcome` run outside any thread." : undefined);
  };

  return {
    record: (thread, archived) =>
      one(thread.id, async () => {
        const facts = readTurns(await turnEvents(read, thread.id));
        const row = buildRow(thread, facts, archived, await judgementsOf(thread.id));
        if (row === null) return null;
        await kv.set(ROW_PREFIX + thread.id, row);
        changed();
        return row;
      }),

    finished: async (threadId) => readTurns(await turnEvents(read, threadId)).firstReportAt !== null,

    judge: (threadId, outcome, by, at) =>
      one(threadId, async () => {
        const before = await judgementsOf(threadId);
        const refused = refusalFor(before, by);
        if (refused !== null) throw refused;
        const judged = judge(before, outcome, by, at);
        if (!judged.ok) throw new Refusal(judged.code, judged.why);
        await kv.set(JUDGED_PREFIX + threadId, judged.judgements);
        const was = await rowOf(threadId);
        const row = was === null ? null : { ...was, ...outcomeFields(judged.judgements) };
        if (row !== null) await kv.set(ROW_PREFIX + threadId, row);
        changed();
        return { judgements: judged.judgements, row };
      }),

    refusal: async (threadId, by) => refusalFor(await judgementsOf(threadId), by),

    judgements: judgementsOf,

    outcomes: async () => {
      const found = new Map<string, Judgement>();
      for (const key of await kv.list(JUDGED_PREFIX)) {
        const parsed = judgementsSchema.safeParse(await kv.get(key));
        const latest = parsed.success ? parsed.data[parsed.data.length - 1] : undefined;
        if (latest) found.set(key.slice(JUDGED_PREFIX.length), latest);
      }
      return found;
    },

    rows: async () => {
      const found: LedgerRow[] = [];
      for (const key of await kv.list(ROW_PREFIX)) {
        const row = await rowOf(key.slice(ROW_PREFIX.length));
        if (row) found.push(row);
      }
      return found;
    },
  };
}
