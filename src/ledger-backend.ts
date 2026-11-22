// The ledger on cow's server: its store, the usage read from bb's events,
// the list-price setting, and the spend under a Main (the last 30 days, or a month). Registered
// from server.ts.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { toFacts } from "./activity.ts";
import { LEDGER_CHANGED, type LedgerStore, createLedgerStore, sdkEvents } from "./ledger-store.ts";
import { type LedgerRow, type RowCost, type WorkFacts, rowTokens } from "./ledger.ts";
import { PRICES_SETTING_HELP, type Prices, dollarsOf, priceOf, pricesWith } from "./prices.ts";
import { descendantIds } from "./tree.ts";
import { type KeptThread, type Spend, type SpendFacts, type SpendPart, type SpendRead, deletedUnder, spendOf, spendThreads, usedIn } from "./spend.ts";
import { type UsageStore, UnreadableUsage, createUsageStore, ledgerRecord, sdkUsageEvents } from "./usage-store.ts";
import { MONTH_PATTERN, NO_TOKENS, NO_USAGE, type Period, type Tokens, addTokens, lastDays, monthPeriod, periodStart, periodUsage, tokenSum, usageTotal } from "./usage.ts";
import { Refusal } from "./kv.ts";

const PAGE = 200;
const MAX_THREADS = 5000;
/** How many threads' usage is read at once. */
const CONCURRENCY = 6;

export interface LedgerBackend {
  ledger: LedgerStore;
  usage: UsageStore;
  /** What each row cost at list price, with the prices as set now. */
  costing(rows: readonly LedgerRow[]): Promise<{ cost: RowCost; error: string | null }>;
  /** The spend under a Main in a calendar month (YYYY-MM), or by default the last 30 days. */
  spend(mainId: string, month?: string): Promise<Spend & { priceError: string | null }>;
  /** The last 30 days' tokens and list-price dollars of every thread bb has, under any Main or none, hidden ones too. */
  everything(): Promise<SpendPart & { period: Period; truncated: boolean; unreadable: number; priceError: string | null }>;
  /** Make usage records from the ledger rows of threads bb deleted before cow kept a deleted thread's usage. Safe to run again. How many were made. */
  rebuild(): Promise<number>;
  /** The kept usage of threads bb has deleted; with `remove`, it is removed. Refused when bb's thread list stops short. */
  forgetDeleted(remove: boolean): Promise<ForgetDeleted>;
  /** A thread's list-price dollars so far, from the usage read as each turn ended; null when none is known or no model it used has a price. */
  dollars(threadId: string): Promise<number | null>;
  /** List-price dollars of tokens by model, at the thread's cache lifetime: for a running turn read from a transcript. Null when no model has a price. */
  priced(threadId: string, tokens: Readonly<Record<string, Tokens>>): Promise<number | null>;
}

/** What `bb cow spend forget --deleted` found, or removed. */
export interface ForgetDeleted {
  removed: boolean;
  threads: { threadId: string; tokens: number; last30Days: number; fromLedger: boolean }[];
  tokens: Tokens;
  last30Days: Tokens;
  period: Period;
}

async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export function registerLedger(
  bb: BbPluginApi,
  projectMarks: (threadIds: readonly string[]) => Promise<string[]>,
  /** A worker's tool calls and working minutes, for its row. */
  work?: (threadId: string) => Promise<WorkFacts | null>,
): LedgerBackend {
  const settings = bb.settings.define({
    listPrices: {
      type: "string",
      label: "List prices",
      description: `Change or add list prices for the ledger's dollars. ${PRICES_SETTING_HELP}`,
      default: "",
    },
  });
  const prices = async (): Promise<{ prices: Prices; error: string | null }> => pricesWith((await settings.get()).listPrices);

  const usage = createUsageStore(bb.storage.kv, sdkUsageEvents(bb.sdk.threads.events as never), (text) => bb.log.warn(text));
  // The ledger lives in cow's own storage, and reads each worker's prompts, turns and usage when it is archived.
  const ledger = createLedgerStore(bb.storage.kv, sdkEvents(bb.sdk.threads.events as never), () => bb.realtime.publish(LEDGER_CHANGED, {}), usage, work);

  // bb keeps only some of a thread's usage events (older ones go, a compaction
  // takes them all but the latest), and each one's `total` is the sum so far.
  // So the usage is read as each turn ends: the step from the last one read
  // is then that turn's, on its own day. One request per turn. A turn that
  // ends after its worker was archived (a dropped one, stopped late) brings
  // its row up to date.
  bb.events.on("thread.idle", ({ thread }) => {
    void usage
      .read(thread.id, undefined, { parentThreadId: thread.parentThreadId ?? null, projectId: thread.projectId })
      .then(({ fresh }) => (fresh && thread.archivedAt !== null ? ledger.syncUsage(thread.id) : null))
      .catch((cause: unknown) => bb.log.warn(`could not read the usage of ${thread.id}: ${String(cause)}`));
  });
  // A deleted thread's usage is kept: the tokens were spent. It is marked, with where it stood, so spend still places it under its Main.
  bb.events.on("thread.deleted", ({ thread }) => {
    void usage
      .markDeleted(thread.id, Date.now(), { parentThreadId: thread.parentThreadId ?? null, projectId: thread.projectId })
      .catch((cause: unknown) => bb.log.warn(`could not mark the usage of the deleted thread ${thread.id}: ${String(cause)}`));
  });

  const costing: LedgerBackend["costing"] = async (rows) => {
    const set = await prices();
    const ttl = new Map<string, number | null>();
    for (const row of rows) if (rowTokens(row) !== null) ttl.set(row.threadId, (await usage.kept(row.threadId))?.ttlMs ?? null);
    return {
      error: set.error,
      cost: (row) => {
        const tokens = rowTokens(row);
        const price = priceOf(set.prices, row.model);
        return tokens === null || price === null ? null : dollarsOf(tokens, price, ttl.get(row.threadId) ?? null);
      },
    };
  };

  /** Every thread bb has, hidden ones too (cow's checkers are), with when bb last changed each. */
  const allThreads = async (): Promise<{ threads: SpendFacts[]; truncated: boolean }> => {
    const threads: SpendFacts[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await bb.sdk.threads.list({ limit: PAGE, offset, includeHidden: true });
      for (const raw of page) {
        const facts = toFacts(raw);
        const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
        if (facts) threads.push({ ...facts, updatedAt: typeof updatedAt === "number" ? updatedAt : null });
      }
      if (page.length < PAGE) return { threads, truncated: false };
      if (offset + PAGE >= MAX_THREADS) return { threads, truncated: true };
    }
  };

  /** cow's checker threads among these: hidden, started by cow, marked `checker: true`. */
  const checkers = async (threads: readonly SpendFacts[]): Promise<string[]> => {
    const candidates = threads.filter((thread) => thread.visibility === "hidden" && thread.originPluginId === bb.pluginId).map((thread) => thread.id);
    const found: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += PAGE) {
      const page = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: candidates.slice(offset, offset + PAGE) });
      for (const { threadId, metadata } of page.threads) if (metadata.checker === true) found.push(threadId);
    }
    return found;
  };

  /** The days asked for: a calendar month, or by default the last 30 days. */
  const periodFor = (month: string | undefined): Period => {
    if (month === undefined) return lastDays(Date.now());
    if (!MONTH_PATTERN.test(month)) throw new Error(`"${month}" is not a month: YYYY-MM`);
    return monthPeriod(month);
  };

  /**
   * The kept usage of every thread not in bb's list: deleted ones. A record
   * not marked yet is marked now (bb's list is whole). Records that do not
   * parse are counted, left as they are.
   */
  const saidUnreadable = new Set<string>();
  const keptGone = async (threads: readonly SpendFacts[], truncated: boolean): Promise<{ kept: KeptThread[]; unreadable: number }> => {
    const live = new Set(threads.map((thread) => thread.id));
    const kept: KeptThread[] = [];
    let unreadable = 0;
    let rows: Map<string, { dispatchedBy: string | null; projectId: string }> | null = null;
    for (const id of await usage.ids()) {
      if (live.has(id)) continue;
      const got = await usage.record(id);
      if (got.kind === "unreadable") {
        unreadable += 1;
        if (!saidUnreadable.has(id)) bb.log.warn(`the usage record of ${id} could not be read: it is kept as it is, not counted, and not written over`);
        saidUnreadable.add(id);
        continue;
      }
      if (got.kind !== "ok") continue;
      if ((got.record.deletedAt ?? null) === null && !truncated) await usage.markDeleted(id, Date.now()).catch(() => undefined);
      let place = got.record.place ?? null;
      // Kept before where a thread stood was: its ledger row says who dispatched it.
      if (place === null) {
        rows ??= new Map((await ledger.rows().catch(() => [])).map((row) => [row.threadId, row]));
        const row = rows.get(id);
        if (row) place = { parentThreadId: row.dispatchedBy, projectId: row.projectId, checker: false };
      }
      kept.push({ id, state: got.record.state, place, fromLedger: got.record.fromLedger === true });
    }
    return { kept, unreadable };
  };

  /** A thread's usage read now; null for one whose kept record does not parse. */
  const readOne = async (id: string, updatedAt: number | null, place: Parameters<UsageStore["read"]>[2]) => {
    try {
      return await usage.read(id, updatedAt, place);
    } catch (cause) {
      if (cause instanceof UnreadableUsage) return null;
      return { state: NO_USAGE, fresh: false };
    }
  };

  const spend: LedgerBackend["spend"] = async (mainId, month) => {
    const period = periodFor(month);
    const since = periodStart(period);
    const { threads, truncated } = await allThreads();
    // Only the threads under this Main are asked for their project marks, and only the period's hidden ones for a checker's.
    const marked = await projectMarks(descendantIds(threads, mainId, since));
    const recent = threads.filter((thread) => thread.updatedAt === null || thread.updatedAt >= since);
    const wanted = spendThreads(threads, mainId, marked, await checkers(recent), since);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const read: SpendRead[] = [];
    let unreadable = 0;
    await eachLimited(wanted, async ({ id, kind, updatedAt }) => {
      const thread = byId.get(id);
      const place = thread ? { parentThreadId: thread.parentThreadId, projectId: thread.projectId, checker: kind === "checkers", project: kind === "projects" } : undefined;
      const got = await readOne(id, updatedAt, place);
      if (got === null) {
        unreadable += 1;
        return;
      }
      read.push({ kind, state: got.state });
      // A worker archived before its last usage arrived gets it in its row now.
      if (got.fresh && kind === "workers") await ledger.syncUsage(id).catch(() => null);
    });
    const gone = await keptGone(threads, truncated);
    read.push(...deletedUnder(threads, gone.kept, mainId, period));
    const set = await prices();
    return { ...spendOf(period, mainId, read, set.prices, truncated, unreadable + gone.unreadable), priceError: set.error };
  };

  const everything: LedgerBackend["everything"] = async () => {
    const period = lastDays(Date.now());
    const since = periodStart(period);
    const { threads, truncated } = await allThreads();
    const recent = threads.filter((thread) => thread.updatedAt === null || thread.updatedAt >= since);
    const read: SpendRead[] = [];
    let unreadable = 0;
    await eachLimited(recent, async ({ id, updatedAt, parentThreadId, projectId }) => {
      const got = await readOne(id, updatedAt, { parentThreadId, projectId });
      if (got === null) unreadable += 1;
      else read.push({ kind: "workers", state: got.state });
    });
    const gone = await keptGone(threads, truncated);
    for (const one of gone.kept) if (usedIn(one.state, period)) read.push({ kind: "workers", state: one.state, deleted: true, fromLedger: one.fromLedger });
    unreadable += gone.unreadable;
    const set = await prices();
    return { ...spendOf(period, "", read, set.prices, truncated, unreadable).total, period, truncated, unreadable, priceError: set.error };
  };

  const rebuild: LedgerBackend["rebuild"] = async () => {
    const { threads, truncated } = await allThreads();
    // Only with bb's whole list can a thread be known to be gone.
    if (truncated) return 0;
    const live = new Set(threads.map((thread) => thread.id));
    let made = 0;
    for (const row of await ledger.rows()) {
      const tokens = rowTokens(row);
      if (tokens === null || live.has(row.threadId)) continue;
      if (await usage.restore(row.threadId, ledgerRecord(row, tokens, Date.now()))) made += 1;
    }
    return made;
  };

  const forgetDeleted: LedgerBackend["forgetDeleted"] = async (remove) => {
    const period = lastDays(Date.now());
    const { threads, truncated } = await allThreads();
    if (truncated) throw new Refusal("list_short", "bb's thread list stopped short, so which threads are deleted cannot be told: nothing is forgotten");
    const { kept } = await keptGone(threads, truncated);
    let tokens = NO_TOKENS;
    let last30Days = NO_TOKENS;
    const found: ForgetDeleted["threads"] = [];
    for (const one of kept) {
      const all = usageTotal(one.state) ?? NO_TOKENS;
      const recent = Object.values(periodUsage(one.state, period)).reduce(addTokens, NO_TOKENS);
      tokens = addTokens(tokens, all);
      last30Days = addTokens(last30Days, recent);
      found.push({ threadId: one.id, tokens: tokenSum(all), last30Days: tokenSum(recent), fromLedger: one.fromLedger });
    }
    if (remove) for (const one of found) await usage.forgetDeleted(one.threadId);
    return { removed: remove, threads: found.sort((a, b) => b.tokens - a.tokens || a.threadId.localeCompare(b.threadId)), tokens, last30Days, period };
  };

  const dollars: LedgerBackend["dollars"] = async (threadId) => {
    const state = await usage.kept(threadId);
    if (!state || state.events === 0) return null;
    const set = await prices();
    let sum: number | null = null;
    for (const [model, tokens] of Object.entries(state.total)) {
      const price = priceOf(set.prices, model);
      if (price !== null) sum = (sum ?? 0) + dollarsOf(tokens, price, state.ttlMs);
    }
    return sum;
  };

  const priced: LedgerBackend["priced"] = async (threadId, tokens) => {
    const ttl = (await usage.kept(threadId))?.ttlMs ?? null;
    const set = await prices();
    let sum: number | null = null;
    for (const [model, t] of Object.entries(tokens)) {
      const price = priceOf(set.prices, model);
      if (price !== null) sum = (sum ?? 0) + dollarsOf(t, price, ttl);
    }
    return sum;
  };

  return { ledger, usage, costing, spend, everything, rebuild, forgetDeleted, dollars, priced };
}
