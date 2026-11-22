// A period's tokens and list-price dollars (the last 30 days, or a calendar
// month) for everything under one Main,
// archived or not: its workers, its project threads, Main itself, and cow's
// checker runs. Pure: which threads, and their usage, are read in
// ledger-backend.ts. No caps, no warnings: what was used, and what is not
// known.

import { type Prices, LIST_PRICE_NOTE, dollarText, dollarsOf, priceOf } from "./prices.ts";
import type { ThreadFacts } from "./state.ts";
import { descendantIds, projectIds } from "./tree.ts";
import type { UsagePlace } from "./usage-store.ts";
import { NO_TOKENS, type Tokens, UNKNOWN_MODEL, USAGE_GAPS_NOTE, type UsageState, type Period, addTokens, periodText, periodUsage, tokenSum, tokensLine } from "./usage.ts";

export const SPEND_KINDS = ["workers", "projects", "main", "checkers"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];
export const SPEND_KIND_TEXT: Record<SpendKind, string> = {
  workers: "Workers",
  projects: "Project threads",
  main: "Main",
  checkers: "cow's checker runs",
};

/** A thread as a period's read needs it: bb's facts and when bb last changed it. */
export type SpendFacts = ThreadFacts & { updatedAt: number | null };

/**
 * The threads a period can have usage in, and what each is: Main; the threads
 * under it (archived ones too, unless archived before the period began),
 * project threads apart from workers as the page tells them; and the checker
 * threads cow started. Only threads bb changed in or after the period's start.
 */
export function spendThreads(
  threads: readonly SpendFacts[],
  mainId: string,
  marked: Iterable<string>,
  checkerIds: Iterable<string>,
  since: number,
): { id: string; kind: SpendKind; updatedAt: number | null }[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const active = (id: string) => {
    const thread = byId.get(id);
    return thread !== undefined && (thread.updatedAt === null || thread.updatedAt >= since);
  };
  const projects = projectIds(threads, marked, mainId);
  const out: { id: string; kind: SpendKind; updatedAt: number | null }[] = [];
  const seen = new Set<string>();
  const add = (id: string, kind: SpendKind) => {
    if (seen.has(id) || !active(id)) return;
    seen.add(id);
    out.push({ id, kind, updatedAt: byId.get(id)?.updatedAt ?? null });
  };
  add(mainId, "main");
  for (const id of descendantIds(threads, mainId, since)) add(id, projects.has(id) ? "projects" : "workers");
  for (const id of checkerIds) add(id, "checkers");
  return out;
}

/** A kept usage record of a thread bb no longer has, with where it stood. */
export interface KeptThread {
  id: string;
  state: UsageState;
  place: UsagePlace | null;
  fromLedger: boolean;
}

/**
 * The deleted threads a Main's period counts, and in which group: those with
 * usage in the period whose parent chain (through threads bb has, or through
 * other kept records) reaches Main, and every checker run. One whose chain
 * cannot be followed is in no Main's spend, only in the all-threads total.
 */
export function deletedUnder(threads: readonly SpendFacts[], kept: readonly KeptThread[], mainId: string, period: Period): SpendRead[] {
  const live = new Map(threads.map((thread) => [thread.id, thread]));
  const keptById = new Map(kept.map((one) => [one.id, one]));
  const parentOf = (id: string): string | null => {
    const thread = live.get(id);
    return thread ? thread.parentThreadId : (keptById.get(id)?.place?.parentThreadId ?? null);
  };
  const parents = new Set<string>();
  for (const thread of threads) if (thread.parentThreadId !== null) parents.add(thread.parentThreadId);
  for (const one of kept) if (one.place?.parentThreadId) parents.add(one.place.parentThreadId);
  const reaches = (id: string): boolean => {
    const seen = new Set<string>();
    for (let at: string | null = id; at !== null; at = parentOf(at)) {
      if (at === mainId) return true;
      if (seen.has(at)) return false;
      seen.add(at);
    }
    return false;
  };
  const out: SpendRead[] = [];
  for (const one of kept) {
    if (!usedIn(one.state, period)) continue;
    const kind: SpendKind | null = one.place?.checker
      ? "checkers"
      : !reaches(one.id)
        ? null
        : one.id === mainId
          ? "main"
          : one.place?.project || parents.has(one.id)
            ? "projects"
            : "workers";
    if (kind !== null) out.push({ kind, state: one.state, deleted: true, fromLedger: one.fromLedger });
  }
  return out;
}

export interface SpendPart {
  threads: number;
  /** Threads with no usage recorded at all: counted, never shown as zero. */
  noUsage: number;
  tokens: Tokens;
  /** List-price dollars of the tokens whose model has a price; null when none has one. */
  dollars: number | null;
  /** Tokens of models with no price: in `tokens`, not in `dollars`. */
  unpricedTokens: number;
  unpricedModels: string[];
  /** Threads bb has deleted whose kept usage is counted here. */
  deleted: number;
  /** Of those, the ones whose usage was made from their ledger row: all on the day each was archived. */
  fromLedger: number;
}

export interface Spend {
  /** Which days: the last 30, or a calendar month. */
  period: Period;
  mainId: string;
  parts: Record<SpendKind, SpendPart>;
  total: SpendPart;
  /** bb's list of threads stopped short: there may be more. */
  truncated: boolean;
  /** Kept usage records that do not parse: left as they are, not counted. */
  unreadable: number;
}

/** A thread's usage as a period's sum takes it: deleted when bb no longer has it. */
export interface SpendRead {
  kind: SpendKind;
  state: UsageState;
  deleted?: boolean;
  fromLedger?: boolean;
}

const emptyPart = (): SpendPart => ({ threads: 0, noUsage: 0, tokens: NO_TOKENS, dollars: null, unpricedTokens: 0, unpricedModels: [], deleted: 0, fromLedger: 0 });

function addThread(part: SpendPart, { state, deleted, fromLedger }: SpendRead, period: Period, prices: Prices): SpendPart {
  const next = { ...part, threads: part.threads + 1, unpricedModels: [...part.unpricedModels], deleted: part.deleted + (deleted ? 1 : 0), fromLedger: part.fromLedger + (deleted && fromLedger ? 1 : 0) };
  if (state.events === 0) return { ...next, noUsage: next.noUsage + 1 };
  for (const [model, used] of Object.entries(periodUsage(state, period))) {
    next.tokens = addTokens(next.tokens, used);
    const price = priceOf(prices, model === UNKNOWN_MODEL ? null : model);
    if (price === null) {
      if (tokenSum(used) === 0) continue;
      next.unpricedTokens += tokenSum(used);
      if (!next.unpricedModels.includes(model)) next.unpricedModels.push(model);
    } else next.dollars = (next.dollars ?? 0) + dollarsOf(used, price, state.ttlMs);
  }
  return next;
}

/** Whether a thread used any tokens in the period: a deleted thread is counted only then. */
export const usedIn = (state: UsageState, period: Period): boolean => Object.values(periodUsage(state, period)).some((t) => tokenSum(t) > 0);

export function spendOf(period: Period, mainId: string, read: readonly SpendRead[], prices: Prices, truncated = false, unreadable = 0): Spend {
  const parts = Object.fromEntries(SPEND_KINDS.map((kind) => [kind, emptyPart()])) as Record<SpendKind, SpendPart>;
  let total = emptyPart();
  for (const one of read) {
    parts[one.kind] = addThread(parts[one.kind], one, period, prices);
    total = addThread(total, one, period, prices);
  }
  return { period, mainId, parts, total, truncated, unreadable };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What is said of deleted threads counted, usage made from ledger rows, and records that could not be read; nothing when there are none. */
export function keptNotes(part: Pick<SpendPart, "deleted" | "fromLedger">, unreadable: number): string[] {
  const out: string[] = [];
  if (part.deleted > 0) {
    out.push(
      `${plural(part.deleted, "deleted thread is", "deleted threads are")} still counted: bb no longer has ${part.deleted === 1 ? "it" : "them"}, and cow keeps a deleted thread's usage until \`bb cow spend forget --deleted\`.`,
    );
  }
  if (part.fromLedger > 0) {
    out.push(`${plural(part.fromLedger, "of them was", "of them were")} deleted before cow kept a deleted thread's usage: its usage is its ledger row's, all on its archive day.`);
  }
  if (unreadable > 0) {
    out.push(`${plural(unreadable, "usage record", "usage records")} could not be read: kept as stored, not counted, and not written over (cow's log names the thread).`);
  }
  return out;
}

function partText(name: string, part: SpendPart): string {
  const head = `${name}: ${part.threads} ${part.threads === 1 ? "thread" : "threads"}`;
  if (part.threads === 0) return head;
  if (part.noUsage === part.threads) return `${head} · no usage recorded`;
  const money = part.dollars === null ? "no list price" : `${dollarText(part.dollars)} at list price`;
  const gaps = [
    ...(part.unpricedTokens > 0 && part.dollars !== null ? [`tokens of ${part.unpricedModels.join(", ")} have no list price`] : []),
    ...(part.unpricedTokens > 0 && part.dollars === null ? [`no list price for ${part.unpricedModels.join(", ")}`] : []),
    ...(part.noUsage > 0 ? [`${part.noUsage} with no usage recorded`] : []),
  ];
  return `${head} · ${tokensLine(part.tokens)} · ${money}${gaps.length > 0 ? ` (${gaps.join("; ")})` : ""}`;
}

export function spendText(spend: Spend, mainTitle: string | null = null): string {
  const out = [
    `Spend in ${periodText(spend.period)} under Main ${mainTitle ? `“${mainTitle}” (${spend.mainId})` : spend.mainId}, archived threads included: tokens by the day bb recorded them.`,
    LIST_PRICE_NOTE,
    "",
  ];
  for (const kind of SPEND_KINDS) out.push(`  ${partText(SPEND_KIND_TEXT[kind], spend.parts[kind])}`);
  out.push(`  ${partText("Total", spend.total)}`);
  out.push("", `cow's checker runs are every check cow ran in ${spend.period.kind === "month" ? "the month" : "those days"}, whichever Main's brief it checked.`);
  out.push(spend.total.noUsage === 0 ? "Every thread had usage recorded." : `${spend.total.noUsage} ${spend.total.noUsage === 1 ? "thread" : "threads"} with no usage recorded: not counted as zero, not counted at all.`);
  out.push(...keptNotes(spend.total, spend.unreadable));
  if (spend.truncated) out.push("bb's thread list stopped short: there may be threads this does not count.");
  out.push(USAGE_GAPS_NOTE);
  return out.join("\n");
}
