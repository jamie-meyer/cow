// The ledger on cow's server: its store, the usage read from bb's events,
// the list-price setting, and the month's spend under a Main. Registered
// from server.ts.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { toFacts } from "./activity.ts";
import { LEDGER_CHANGED, type LedgerStore, createLedgerStore, sdkEvents } from "./ledger-store.ts";
import { type LedgerRow, type RowCost, rowTokens } from "./ledger.ts";
import { PRICES_SETTING_HELP, type Prices, dollarsOf, priceOf, pricesWith } from "./prices.ts";
import { descendantIds } from "./tree.ts";
import { type Spend, type SpendFacts, spendOf, spendThreads } from "./spend.ts";
import { type UsageStore, createUsageStore, sdkUsageEvents } from "./usage-store.ts";
import { MONTH_PATTERN, NO_USAGE, monthOf, monthStart } from "./usage.ts";

const PAGE = 200;
const MAX_THREADS = 5000;
/** How many threads' usage is read at once. */
const CONCURRENCY = 6;

export interface LedgerBackend {
  ledger: LedgerStore;
  usage: UsageStore;
  /** What each row cost at list price, with the prices as set now. */
  costing(rows: readonly LedgerRow[]): Promise<{ cost: RowCost; error: string | null }>;
  /** The month's (YYYY-MM; default this one) spend under a Main. */
  spend(mainId: string, month?: string): Promise<Spend & { priceError: string | null }>;
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

export function registerLedger(bb: BbPluginApi, projectMarks: (threadIds: readonly string[]) => Promise<string[]>): LedgerBackend {
  const settings = bb.settings.define({
    listPrices: {
      type: "string",
      label: "List prices",
      description: `Change or add list prices for the ledger's dollars. ${PRICES_SETTING_HELP}`,
      default: "",
    },
  });
  const prices = async (): Promise<{ prices: Prices; error: string | null }> => pricesWith((await settings.get()).listPrices);

  const usage = createUsageStore(bb.storage.kv, sdkUsageEvents(bb.sdk.threads.events as never));
  // The ledger lives in cow's own storage, and reads each worker's prompts, turns and usage when it is archived.
  const ledger = createLedgerStore(bb.storage.kv, sdkEvents(bb.sdk.threads.events as never), () => bb.realtime.publish(LEDGER_CHANGED, {}), usage);

  // bb keeps only some of a thread's usage events (older ones go, a compaction
  // takes them all but the latest), and each one's `total` is the sum so far.
  // So the usage is read as each turn ends: the step from the last one read
  // is then that turn's, on its own day. One request per turn. A turn that
  // ends after its worker was archived (a dropped one, stopped late) brings
  // its row up to date.
  bb.events.on("thread.idle", ({ thread }) => {
    void usage
      .read(thread.id)
      .then(({ fresh }) => (fresh && thread.archivedAt !== null ? ledger.syncUsage(thread.id) : null))
      .catch((cause: unknown) => bb.log.warn(`could not read the usage of ${thread.id}: ${String(cause)}`));
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void usage.forget(thread.id).catch(() => undefined);
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

  const spend: LedgerBackend["spend"] = async (mainId, month = monthOf(Date.now())) => {
    if (!MONTH_PATTERN.test(month)) throw new Error(`"${month}" is not a month: YYYY-MM`);
    const since = monthStart(month);
    const { threads, truncated } = await allThreads();
    // Only the threads under this Main are asked for their project marks, and only the month's hidden ones for a checker's.
    const marked = await projectMarks(descendantIds(threads, mainId, since));
    const recent = threads.filter((thread) => thread.updatedAt === null || thread.updatedAt >= since);
    const wanted = spendThreads(threads, mainId, marked, await checkers(recent), since);
    const read: { kind: (typeof wanted)[number]["kind"]; state: typeof NO_USAGE }[] = [];
    await eachLimited(wanted, async ({ id, kind, updatedAt }) => {
      const got = await usage.read(id, updatedAt).catch(() => ({ state: NO_USAGE, fresh: false }));
      read.push({ kind, state: got.state });
      // A worker archived before its last usage arrived gets it in its row now.
      if (got.fresh && kind === "workers") await ledger.syncUsage(id).catch(() => null);
    });
    const set = await prices();
    return { ...spendOf(month, mainId, read, set.prices, truncated), priceError: set.error };
  };

  return { ledger, usage, costing, spend };
}
