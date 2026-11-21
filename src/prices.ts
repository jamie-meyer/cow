// List prices, per million tokens, to turn the ledger's tokens into dollars.
// They are the providers' published API prices: an estimate of what the
// tokens would cost at list price, not a bill. Someone on a subscription is
// not billed this. Dollars are worked out when shown, so a corrected price
// applies to rows written before it. The setting `listPrices` overrides or
// adds entries.

import { z } from "zod";
import { type Tokens, tokenSum } from "./usage.ts";

/** One model's list price, USD per million tokens. */
export interface Price {
  input: number;
  cacheRead: number;
  /** Cache writes by the longest cache lifetime each price covers, shortest first. */
  cacheWrite: readonly { upToMs: number; perM: number }[];
  output: number;
  /** When it was read from its page, YYYY-MM-DD; "setting" for one the person gave. */
  taken: string;
  source: string;
}

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const TAKEN = "2026-11-21";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Anthropic: cache writes cost one price for the 5-minute cache and another for the 1-hour one. */
const anthropic = (input: number, write5m: number, write1h: number, cacheRead: number, output: number): Price => ({
  input,
  cacheRead,
  cacheWrite: [
    { upToMs: 5 * MIN, perM: write5m },
    { upToMs: HOUR, perM: write1h },
  ],
  output,
  taken: TAKEN,
  source: ANTHROPIC,
});

/** OpenAI's Standard tier, short context (up to 272K input tokens): writes for the 30-minute and the 12-hour cache. With no write price, a write is priced as input. */
const openai = (input: number, cacheRead: number, output: number, write30m?: number, write12h?: number): Price => ({
  input,
  cacheRead,
  cacheWrite:
    write30m === undefined || write12h === undefined
      ? [{ upToMs: Number.MAX_SAFE_INTEGER, perM: input }]
      : [
          { upToMs: 30 * MIN, perM: write30m },
          { upToMs: 12 * HOUR, perM: write12h },
        ],
  output,
  taken: TAKEN,
  source: OPENAI,
});

/**
 * The table: every model this bb offers on Claude Code and Codex that its
 * provider's page lists, taken on 2026-11-21 from the page named in each
 * entry. Left out: models no page prices (and every model reached through
 * OpenRouter, whose prices are its own). Claude Haiku 5.5 is priced by prompt
 * length; these are its prices for prompts up to 100,000 tokens (over that it
 * is five times as much), and OpenAI's are for prompts up to 272K tokens, so
 * a long prompt is under-counted. GPT-5.6 Sol's price is the promotional one
 * its page gives until 30 November 2026.
 */
export const LIST_PRICES: Readonly<Record<string, Price>> = {
  // Anthropic, from ANTHROPIC on 2026-11-21: input, 5m cache write, 1h cache write, cache hit, output.
  "claude-fable-5-2": anthropic(8, 10, 16, 0.2, 40),
  "claude-fable-5-1": anthropic(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": anthropic(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": anthropic(4, 5, 8, 0.2, 20),
  "claude-opus-5": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": anthropic(5, 6.25, 10, 0.5, 25),
  "claude-sonnet-5-5": anthropic(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": anthropic(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": anthropic(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": anthropic(0.1, 0.125, 0.2, 0.01, 0.5),
  "claude-haiku-4-5-20251001": anthropic(1, 1.25, 2, 0.1, 5),
  // OpenAI Standard tier, short context, from OPENAI on 2026-11-21: input, cached input, output, 30m write, 12h write.
  "gpt-6.1-sol": openai(2, 0.1, 10, 2.5, 5),
  "gpt-6.1-terra": openai(1, 0.05, 5, 1.25, 2.5),
  "gpt-6-astra": openai(10, 1, 50, 12.5, 25),
  "gpt-6-sol": openai(2, 0.2, 10, 2.5, 5),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125, 0.25),
  "gpt-5.6-sol": openai(4, 0.4, 20, 5, 10),
  "gpt-5.6-terra": openai(2, 0.2, 12, 2.5, 5),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, 0.25, 0.5),
  "gpt-5.5": openai(5, 0.5, 30),
};

/** Prefixes another provider puts before the same model, priced as the model. */
const SAME_MODEL_PREFIXES = ["openai-codex/"];

/** The setting: JSON of model id to its price per million tokens; null takes a built-in entry out. */
const overrideSchema = z.record(
  z.string().min(1).max(200),
  z.strictObject({ input: z.number().min(0), cacheRead: z.number().min(0), cacheWrite: z.number().min(0), output: z.number().min(0) }).nullable(),
);

export const PRICES_SETTING_HELP =
  'JSON of model id to list price in USD per million tokens, such as {"my-model": {"input": 3, "cacheRead": 0.3, "cacheWrite": 3.75, "output": 15}}. ' +
  "An entry replaces cow's own for that model (its cache-write price then holds for every cache lifetime); null takes cow's entry out, so the model shows tokens and no dollars. Empty: cow's table as it is.";

export type Prices = Readonly<Record<string, Price>>;

/** cow's table with the setting's changes, or the table alone and why the setting was not read. */
export function pricesWith(setting: string | undefined): { prices: Prices; error: string | null } {
  if (setting === undefined || setting.trim() === "") return { prices: LIST_PRICES, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(setting);
  } catch (cause) {
    return { prices: LIST_PRICES, error: `the listPrices setting is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = overrideSchema.safeParse(raw);
  if (!parsed.success) return { prices: LIST_PRICES, error: `the listPrices setting is not read: ${parsed.error.issues[0]?.message ?? "bad shape"}. ${PRICES_SETTING_HELP}` };
  const prices: Record<string, Price> = { ...LIST_PRICES };
  for (const [model, given] of Object.entries(parsed.data)) {
    if (given === null) delete prices[model];
    else
      prices[model] = {
        input: given.input,
        cacheRead: given.cacheRead,
        cacheWrite: [{ upToMs: Number.MAX_SAFE_INTEGER, perM: given.cacheWrite }],
        output: given.output,
        taken: "setting",
        source: "the listPrices setting",
      };
  }
  return { prices, error: null };
}

export function priceOf(prices: Prices, model: string | null): Price | null {
  if (model === null) return null;
  const exact = prices[model];
  if (exact) return exact;
  const prefix = SAME_MODEL_PREFIXES.find((p) => model.startsWith(p));
  return prefix === undefined ? null : (prices[model.slice(prefix.length)] ?? null);
}

/** The cache-write price for a cache lifetime: the first that covers it; with none known, the shortest. */
export function cacheWritePrice(price: Price, ttlMs: number | null): number {
  const first = price.cacheWrite[0]?.perM ?? price.input;
  if (ttlMs === null) return first;
  return (price.cacheWrite.find((step) => ttlMs <= step.upToMs) ?? price.cacheWrite[price.cacheWrite.length - 1])?.perM ?? first;
}

/** Tokens at list price, in USD. */
export function dollarsOf(tokens: Tokens, price: Price, ttlMs: number | null): number {
  return (tokens.input * price.input + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * cacheWritePrice(price, ttlMs) + tokens.output * price.output) / 1_000_000;
}

/** Dollars, short, always marked as list price: "$1.23 list". */
export function dollarText(usd: number): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 3 : 2;
  return `$${usd.toFixed(digits)}`;
}

/** Said wherever dollars are shown. */
export const LIST_PRICE_NOTE = "Dollars are an estimate at the providers' list prices, not a bill: on a subscription you are not billed this.";

/** A model with tokens but no price: its tokens count, its dollars are not guessed. */
export const hasTokens = (t: Tokens | null): t is Tokens => t !== null && tokenSum(t) > 0;
