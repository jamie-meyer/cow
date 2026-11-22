// A period's tokens and list-price dollars (the last 30 days, or a calendar
// month) for everything under one Main,
// archived or not: its workers, its project threads, Main itself, and cow's
// checker runs. Pure: which threads, and their usage, are read in
// ledger-backend.ts. No caps, no warnings: what was used, and what is not
// known.

import { type Prices, LIST_PRICE_NOTE, dollarText, dollarsOf, priceOf } from "./prices.ts";
import type { ThreadFacts } from "./state.ts";
import { descendantIds, projectIds } from "./tree.ts";
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
}

export interface Spend {
  /** Which days: the last 30, or a calendar month. */
  period: Period;
  mainId: string;
  parts: Record<SpendKind, SpendPart>;
  total: SpendPart;
  /** bb's list of threads stopped short: there may be more. */
  truncated: boolean;
}

const emptyPart = (): SpendPart => ({ threads: 0, noUsage: 0, tokens: NO_TOKENS, dollars: null, unpricedTokens: 0, unpricedModels: [] });

function addThread(part: SpendPart, state: UsageState, period: Period, prices: Prices): SpendPart {
  const next = { ...part, threads: part.threads + 1, unpricedModels: [...part.unpricedModels] };
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

export function spendOf(period: Period, mainId: string, read: readonly { kind: SpendKind; state: UsageState }[], prices: Prices, truncated = false): Spend {
  const parts = Object.fromEntries(SPEND_KINDS.map((kind) => [kind, emptyPart()])) as Record<SpendKind, SpendPart>;
  let total = emptyPart();
  for (const { kind, state } of read) {
    parts[kind] = addThread(parts[kind], state, period, prices);
    total = addThread(total, state, period, prices);
  }
  return { period, mainId, parts, total, truncated };
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
  if (spend.truncated) out.push("bb's thread list stopped short: there may be threads this does not count.");
  out.push(USAGE_GAPS_NOTE);
  return out.join("\n");
}
