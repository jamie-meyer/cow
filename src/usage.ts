// Tokens a thread used, from bb's own record of them: the
// `thread/tokenUsage/updated` event bb writes at the end of a turn. No
// transcript is read. Pure: reading the events, and keeping what was read,
// is in usage-store.ts.
//
// What the event holds, as found on bb 0.50 with Claude Code: `total` is the
// running sum of every model call of the provider's process so far, across
// its turns and on across a compaction (whose own summarizing call is not in
// it), and `last` is the usage of the latest turn. A new provider process
// (bb writes `thread/identity` when one starts, which on a long-lived thread
// happens every few turns) starts its `total`
// at zero again, under the same session id. bb does not keep every usage
// event: older ones go after a few turns, and a compaction takes all but the
// latest. So what was used between two reads is the step from the `total`
// read before, put on the day of the event that showed it; after a
// `thread/identity`, or when a `total` falls below the one before it, the
// new `total` is all new. Usage of turns bb dropped before cow read them,
// and everything from before cow first read a thread, is not known.

/** The four counts cow keeps, as most providers price them. */
export interface Tokens {
  /** Input that was neither read from nor written to a cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export const NO_TOKENS: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
export const TOKEN_KEYS = ["input", "cacheRead", "cacheWrite", "output"] as const;

export const USAGE_EVENT_TYPE = "thread/tokenUsage/updated";
/** The prompt that starts a turn names the model it runs on: usage after it is that model's. */
export const PROMPT_EVENT_TYPE = "client/turn/requested";
/** A new provider process: the next `total` of its session starts from zero. */
export const IDENTITY_EVENT_TYPE = "thread/identity";
export const USAGE_EVENT_TYPES = [USAGE_EVENT_TYPE, PROMPT_EVENT_TYPE, IDENTITY_EVENT_TYPE] as const;

/** The key of usage whose model bb did not record. */
export const UNKNOWN_MODEL = "unknown";
/** At most this many days are kept per thread; older ones are dropped, oldest first. */
export const MAX_DAYS = 400;

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});
export const tokenSum = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite + t.output;

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * One of bb's usage counts (`total` or `last`) as the four counts. Claude
 * Code reports input apart from the cache (`totalTokens` is input plus cached
 * input plus output) and splits cached input into reads and writes. A
 * provider that counts cached input inside `inputTokens`, as OpenAI's API
 * does, has a `totalTokens` of input plus output: the cached part is taken
 * out of input. With no split, cached input is all cache reads. Reasoning
 * output is added to output only when `totalTokens` shows it is apart.
 */
export function tokensOf(raw: unknown): Tokens | null {
  const r = record(raw);
  if (!r) return null;
  const input = count(r.inputTokens);
  const output = count(r.outputTokens);
  if (input === null || output === null) return null;
  const cached = count(r.cachedInputTokens) ?? 0;
  const write = count(r.cacheWriteInputTokens);
  const read = count(r.cacheReadInputTokens);
  const reasoning = count(r.reasoningOutputTokens) ?? 0;
  const total = count(r.totalTokens);
  const cacheWrite = write ?? 0;
  const cacheRead = read ?? Math.max(0, cached - cacheWrite);
  const cachedAll = read !== null || write !== null ? cacheRead + cacheWrite : cached;
  const inside = total !== null && cachedAll > 0 && (total === input + output || total === input + output + reasoning);
  const apart = total !== null && reasoning > 0 && (total === input + cachedAll + output + reasoning || total === input + output + reasoning);
  return { input: inside ? Math.max(0, input - cachedAll) : input, cacheRead, cacheWrite, output: output + (apart ? reasoning : 0) };
}

/** What is kept of a thread's usage, and where its reading stopped. */
export interface UsageState {
  /** The last event read; the next read starts after it. */
  lastSeq: number | null;
  /** How many usage events were read. None: its usage is unknown, never zero. */
  events: number;
  /** The model of the latest prompt read. */
  model: string | null;
  /** The latest `total` of each provider session. */
  sessions: Record<string, Tokens>;
  /** Sessions whose provider process started again since their latest `total`: the next one is all new. Absent in records kept before 0.2.20. */
  restarted?: string[];
  /** The cache lifetime bb last reported, in ms; it picks a cache-write price. */
  ttlMs: number | null;
  /** All of it, by model. */
  total: Record<string, Tokens>;
  /** By day (YYYY-MM-DD, local time) and model, so a month can be summed. */
  days: Record<string, Record<string, Tokens>>;
}

export const NO_USAGE: UsageState = { lastSeq: null, events: 0, model: null, sessions: {}, ttlMs: null, total: {}, days: {} };

const pad = (n: number) => String(n).padStart(2, "0");
/** The local day of a time, as YYYY-MM-DD. */
export const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** The local month of a time, as YYYY-MM. */
export const monthOf = (at: number): string => dayOf(at).slice(0, 7);
/** When a month (YYYY-MM) starts, local time. */
export const monthStart = (month: string): number => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).getTime();
export const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** The running total's length: today and the days before it, this many in all. */
export const LAST_DAYS = 30;

/** The days a total is summed over: the last 30 days, or a calendar month. Days are local, YYYY-MM-DD, both ends in. */
export interface Period {
  kind: "last30Days" | "month";
  /** The month (YYYY-MM) when kind is "month"; null otherwise. */
  month: string | null;
  first: string;
  last: string;
}

/** The last 30 days: today and the 29 local days before it. The one place that decides it. */
export function lastDays(now: number): Period {
  const d = new Date(now);
  // Local calendar arithmetic: a daylight-saving change in between moves no day.
  const first = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (LAST_DAYS - 1)).getTime();
  return { kind: "last30Days", month: null, first: dayOf(first), last: dayOf(now) };
}

/** A calendar month (YYYY-MM) as a period. */
export function monthPeriod(month: string): Period {
  const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
  return { kind: "month", month, first: `${month}-01`, last: dayOf(end.getTime()) };
}

/** When a period's first day starts, local time. */
export const periodStart = (period: Period): number =>
  new Date(Number(period.first.slice(0, 4)), Number(period.first.slice(5, 7)) - 1, Number(period.first.slice(8, 10))).getTime();

/** A period in words: "the last 30 days (2026-10-23 to 2026-11-21)" or "2026-10". */
export const periodText = (period: Period): string => (period.kind === "month" ? (period.month ?? period.first.slice(0, 7)) : `the last ${LAST_DAYS} days (${period.first} to ${period.last})`);

const behind = (now: Tokens, before: Tokens): boolean => TOKEN_KEYS.some((key) => now[key] < before[key]);
const minus = (a: Tokens, b: Tokens): Tokens => ({ input: a.input - b.input, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite, output: a.output - b.output });
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : null);

const addTo = (into: Record<string, Tokens>, key: string, t: Tokens) => {
  into[key] = addTokens(into[key] ?? NO_TOKENS, t);
};

/**
 * Read more of a thread's events into what was kept: prompts (for the model)
 * and usage events, in any order; those at or before `lastSeq` are skipped.
 * Each usage event's step from the session's previous `total` goes to the
 * day of the event and the model of the prompt before it.
 */
export function foldUsage(state: UsageState, events: readonly unknown[], day: (at: number) => string = dayOf): UsageState {
  const log: { seq: number; at: number; type: string; data: Record<string, unknown> }[] = [];
  for (const raw of events) {
    const r = record(raw);
    if (!r || typeof r.seq !== "number" || typeof r.type !== "string") continue;
    if (state.lastSeq !== null && r.seq <= state.lastSeq) continue;
    log.push({ seq: r.seq, at: typeof r.createdAt === "number" ? r.createdAt : 0, type: r.type, data: record(r.data) ?? {} });
  }
  if (log.length === 0) return state;
  log.sort((a, b) => a.seq - b.seq);
  const next: UsageState = {
    ...state,
    sessions: { ...state.sessions },
    restarted: [...(state.restarted ?? [])],
    total: { ...state.total },
    days: Object.fromEntries(Object.entries(state.days).map(([d, models]) => [d, { ...models }])),
  };
  for (const event of log) {
    next.lastSeq = event.seq;
    if (event.type === PROMPT_EVENT_TYPE) {
      next.model = text(record(event.data.execution)?.model) ?? next.model;
      continue;
    }
    if (event.type === IDENTITY_EVENT_TYPE) {
      const session = text(event.data.providerThreadId) ?? "";
      if (next.sessions[session] !== undefined && !next.restarted?.includes(session)) next.restarted?.push(session);
      continue;
    }
    if (event.type !== USAGE_EVENT_TYPE) continue;
    const usage = record(event.data.tokenUsage);
    const total = tokensOf(usage?.total);
    if (!usage || !total) continue;
    next.events += 1;
    const ttl = count(usage.promptCacheTtlMs);
    if (ttl !== null) next.ttlMs = ttl;
    const session = text(event.data.providerThreadId) ?? "";
    const before = next.sessions[session];
    const fresh = next.restarted?.includes(session) ?? false;
    const step = before === undefined || fresh || behind(total, before) ? total : minus(total, before);
    next.sessions[session] = total;
    if (fresh) next.restarted = next.restarted?.filter((other) => other !== session);
    const model = next.model ?? UNKNOWN_MODEL;
    addTo(next.total, model, step);
    const d = day(event.at);
    next.days[d] = { ...(next.days[d] ?? {}) };
    addTo(next.days[d] as Record<string, Tokens>, model, step);
  }
  const days = Object.keys(next.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete next.days[old];
  return next;
}

export const readUsage = (events: readonly unknown[], day?: (at: number) => string): UsageState => foldUsage(NO_USAGE, events, day);

/** All of a thread's tokens, every model together; null when its usage is unknown. */
export function usageTotal(state: UsageState): Tokens | null {
  if (state.events === 0) return null;
  return Object.values(state.total).reduce(addTokens, NO_TOKENS);
}

/** A period's tokens by model, from the per-day tally. */
export function periodUsage(state: UsageState, period: Period): Record<string, Tokens> {
  const out: Record<string, Tokens> = {};
  for (const [d, models] of Object.entries(state.days)) {
    if (d < period.first || d > period.last) continue;
    for (const [model, t] of Object.entries(models)) addTo(out, model, t);
  }
  return out;
}

/** A month's (YYYY-MM) tokens by model. */
export const monthUsage = (state: UsageState, month: string): Record<string, Tokens> => periodUsage(state, monthPeriod(month));

/** What cannot be known, said wherever a period's usage is shown. */
export const USAGE_GAPS_NOTE =
  "bb keeps only a thread's latest usage events, so what a thread used before cow first read it (cow reads each thread as each of its turns ends, from 0.2.19 on) is not known: a thread older than that shows less than it used. Before 0.2.20, a turn that started a new provider process could be counted short.";

/** A count of tokens, short: 950, 12.3k, 4.56M. */
export function tokensText(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** The four counts, in words. */
export const tokensLine = (t: Tokens): string =>
  `${tokensText(tokenSum(t))} tokens (input ${tokensText(t.input)}, cache read ${tokensText(t.cacheRead)}, cache write ${tokensText(t.cacheWrite)}, output ${tokensText(t.output)})`;
