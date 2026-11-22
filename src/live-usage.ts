// Tokens so far in a running worker's turn, from Claude Code's transcript
// (read on the thread's machine by src/transcript/read.ts), with the
// `liveUsage` setting on. Pure: the read is asked for in watch-backend.ts.
//
// A reading counts only what bb has not counted yet: model calls made since
// its turn started and since bb's latest usage event (`countFrom`). When the
// turn ends, or bb writes a usage event, the reading is dropped and bb's own
// figure (the tally in usage.ts, the source of truth for the ledger and
// spend) has it: nothing is counted twice. Before a turn's first reading,
// or with the setting off, there is no reading at all.
//
// What is kept: the session id bb gave, where the next read starts, the
// four counts by model, and hashes of the last few message ids (to count a
// message whose entries span two reads once). No text, no tool input, no
// path from the transcript.

import { type Tokens, NO_TOKENS, addTokens, tokenSum } from "./usage.ts";
import type { TranscriptRead, UsageMessage } from "./transcript/read.ts";

/** Hashes of message ids kept, with what each was counted at. */
const KEPT_KEYS = 64;
/** A model call stamped this long before the turn's start (two clocks) still counts as the turn's. */
export const CLOCK_SLACK_MS = 2_000;

export interface LiveReading {
  /** Claude Code's session id: bb's `providerThreadId`. A different one starts the file again. */
  session: string;
  offset: number;
  partial: boolean;
  /** Count model calls stamped from here on; null: the turn is over, count nothing. */
  countFrom: number | null;
  /** This turn's tokens not yet in bb's figure, by model. */
  tokens: Record<string, Tokens>;
  /** Hashed message ids counted, with their counts, newest last. */
  keys: { key: string; model: string; tokens: Tokens }[];
  /** When it was last read. */
  readAt: number | null;
}

export const newReading = (session: string): LiveReading => ({ session, offset: 0, partial: false, countFrom: null, tokens: {}, keys: [], readAt: null });

/** The turn is over, or bb counted up to `at`: drop the tokens, keep where the file was read to. */
export const settled = (r: LiveReading, countFrom: number | null): LiveReading => ({ ...r, countFrom, tokens: {}, keys: [] });

const tokensOfMessage = (m: UsageMessage): Tokens => ({ input: m.input, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, output: m.output });
const over = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.max(0, a.input - b.input),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  output: Math.max(0, a.output - b.output),
});
const most = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.max(a.input, b.input),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  output: Math.max(a.output, b.output),
});

/** Fold a read into the reading. Messages from before `countFrom` move the offset and count nothing. */
export function foldReading(r: LiveReading, read: TranscriptRead, now: number): LiveReading {
  if (read.status !== "read") return { ...r, readAt: now };
  const base = read.reset ? { ...r, tokens: {}, keys: [] } : r;
  const next: LiveReading = { ...base, offset: read.offset, partial: read.partial, readAt: now, tokens: { ...base.tokens }, keys: [...base.keys] };
  if (next.countFrom === null) return next;
  for (const m of read.messages) {
    if (m.at !== null && m.at < next.countFrom - CLOCK_SLACK_MS) continue;
    const t = tokensOfMessage(m);
    const seen = next.keys.findIndex((k) => k.key === m.key);
    const add = seen < 0 ? t : over(t, next.keys[seen]!.tokens);
    if (seen >= 0) next.keys[seen] = { ...next.keys[seen]!, tokens: most(t, next.keys[seen]!.tokens) };
    else next.keys.push({ key: m.key, model: m.model, tokens: t });
    if (tokenSum(add) > 0) next.tokens[m.model] = addTokens(next.tokens[m.model] ?? NO_TOKENS, add);
  }
  next.keys = next.keys.slice(-KEPT_KEYS);
  return next;
}

/** The reading's tokens, every model together. */
export const readingTotal = (r: LiveReading | null | undefined): Tokens => Object.values(r?.tokens ?? {}).reduce(addTokens, NO_TOKENS);
