// Where the ledger is kept: cow's own key-value storage, one key per worker
// for its row, one for the judgements of its outcome and one for its label, so a row outlives
// its thread and an agent cannot rewrite it through the thread's metadata. A row's
// tokens are read from bb's usage events (usage-store.ts) when it is written, and
// again when its thread ends a turn after that.

import { type Kv, Refusal, serial } from "./kv.ts";
import {
  type Judgement,
  type LabelNote,
  type LedgerRow,
  type Outcome,
  TURN_EVENT_TYPES,
  type WorkFacts,
  buildRow,
  judge,
  judgementsSchema,
  labelNoteSchema,
  labelRefusal,
  outcomeFields,
  readTurns,
  rowSchema,
  rowTokens,
  tokenFields,
} from "./ledger.ts";
import type { UsageStore } from "./usage-store.ts";
import { TOKEN_KEYS, usageTotal } from "./usage.ts";

export const ROW_PREFIX = "ledger:row:";
export const JUDGED_PREFIX = "ledger:judged:";
export const LABEL_PREFIX = "ledger:label:";
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
  /** A worker's label, open or archived, or null. */
  label(threadId: string): Promise<LabelNote | null>;
  /** Set (or with null, clear) a worker's label. Refused when a thread would overwrite or clear the person's. Its row, if it has one, follows. */
  setLabel(threadId: string, label: string | null, by: string, at: number): Promise<{ label: LabelNote | null; row: LedgerRow | null }>;
  /** Whether `by` could set the label now; the refusal it would get, or null. */
  labelRefusal(threadId: string, by: string): Promise<Refusal | null>;
  /** The latest outcome of every worker that has one. */
  outcomes(): Promise<Map<string, Judgement>>;
  rows(): Promise<LedgerRow[]>;
  /** Bring a row's tokens up to date with the usage bb recorded since; the row, when it changed. Nothing for a thread with no row. */
  syncUsage(threadId: string): Promise<LedgerRow | null>;
}

export function createLedgerStore(
  kv: Kv,
  read: ReadEvents,
  changed: () => void = () => undefined,
  usage?: UsageStore,
  /** A worker's tool calls and working minutes, read when its row is written. */
  work?: (threadId: string) => Promise<WorkFacts | null>,
): LedgerStore {
  const one = serial();
  const tokensNow = async (threadId: string) => (usage ? usageTotal((await usage.read(threadId)).state) : null);
  const judgementsOf = async (threadId: string): Promise<Judgement[]> => {
    const parsed = judgementsSchema.safeParse(await kv.get(JUDGED_PREFIX + threadId));
    return parsed.success ? parsed.data : [];
  };
  const rowOf = async (threadId: string): Promise<LedgerRow | null> => {
    const parsed = rowSchema.safeParse(await kv.get(ROW_PREFIX + threadId));
    return parsed.success ? parsed.data : null;
  };
  const labelOf = async (threadId: string): Promise<LabelNote | null> => {
    const parsed = labelNoteSchema.safeParse(await kv.get(LABEL_PREFIX + threadId));
    return parsed.success ? parsed.data : null;
  };
  const labelRefusalFor = (current: LabelNote | null, by: string): Refusal | null => {
    const why = labelRefusal(current, by);
    return why === null ? null : new Refusal("person_labelled", why, "Only the person changes it now: `bb cow label` run outside any thread.");
  };
  const refusalFor = (judgements: readonly Judgement[], by: string): Refusal | null => {
    const tried = judge(judgements, "done", by, 0);
    return tried.ok ? null : new Refusal(tried.code, tried.why, tried.code === "person_judged" ? "Only the person changes it now: o on its line on cow's page, or `bb cow outcome` run outside any thread." : undefined);
  };

  return {
    record: (thread, archived) =>
      one(thread.id, async () => {
        const facts = readTurns(await turnEvents(read, thread.id));
        const tokens = await tokensNow(thread.id).catch(() => null);
        const done = work ? await work(thread.id).catch(() => null) : null;
        const row = buildRow(thread, facts, archived, await judgementsOf(thread.id), (await labelOf(thread.id))?.label ?? null, tokens, done);
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

    label: labelOf,

    labelRefusal: async (threadId, by) => labelRefusalFor(await labelOf(threadId), by),

    setLabel: (threadId, label, by, at) =>
      one(threadId, async () => {
        const refused = labelRefusalFor(await labelOf(threadId), by);
        if (refused !== null) throw refused;
        const note = label === null ? null : labelNoteSchema.parse({ label, by, at });
        if (note === null) await kv.delete(LABEL_PREFIX + threadId);
        else await kv.set(LABEL_PREFIX + threadId, note);
        const was = await rowOf(threadId);
        const row = was === null ? null : { ...was, label: note?.label ?? null };
        if (row !== null) await kv.set(ROW_PREFIX + threadId, row);
        changed();
        return { label: note, row };
      }),

    outcomes: async () => {
      const found = new Map<string, Judgement>();
      for (const key of await kv.list(JUDGED_PREFIX)) {
        const parsed = judgementsSchema.safeParse(await kv.get(key));
        const latest = parsed.success ? parsed.data[parsed.data.length - 1] : undefined;
        if (latest) found.set(key.slice(JUDGED_PREFIX.length), latest);
      }
      return found;
    },

    syncUsage: (threadId) =>
      one(threadId, async () => {
        if (!usage) return null;
        const was = await rowOf(threadId);
        if (was === null) return null;
        const tokens = await tokensNow(threadId);
        const before = rowTokens(was);
        if (tokens === null || (before !== null && TOKEN_KEYS.every((key) => before[key] === tokens[key]))) return null;
        const row = { ...was, ...tokenFields(tokens) };
        await kv.set(ROW_PREFIX + threadId, row);
        changed();
        return row;
      }),

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
