// The usage line and the notices before a limit. Pure: what bb reports of each
// provider's usage windows, the last 30 days' list-price dollars against a
// budget, and the rule for when the person is told, once. Reading bb, the
// timer and the notices kept are in limits-backend.ts.
//
// Nothing here acts on a thread: a notice is a line in the person's queue
// (and, when they allow it, a notification), never a stop.

import { dollarText } from "./prices.ts";
import { keptNotes } from "./spend.ts";
import { LAST_DAYS, USAGE_GAPS_NOTE, monthOf } from "./usage.ts";

/** Realtime channel: published whenever the line's figures or the notices change. */
export const LIMITS_CHANGED = "cow-limits";

/** One usage window of one signed-in provider, as bb reports it. */
export interface UsageWindow {
  /** bb's provider id, such as claude-code or codex. */
  provider: string;
  label: string;
  usedPercent: number;
  /** When it resets, ms; null when bb does not say. */
  resetsAt: number | null;
  /** bb's kind of window, such as weekly or session; null when not given. */
  kind: string | null;
  /** The model the window is for; null when it is for every model. */
  model: string | null;
}

const PROVIDER_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
export const providerName = (id: string): string => PROVIDER_NAMES[id] ?? id;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 120) : null);

/**
 * Every window of every provider whose status is "ok", in bb's order. A
 * provider that is not installed, not signed in, expired or in error, or
 * that reports no windows, gives none: it is left out, not shown as an
 * error. The account's address bb returns is never read.
 */
export function windowsOf(response: unknown): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [provider, raw] of Object.entries(record(response) ?? {})) {
    const entry = record(raw);
    if (!entry || entry.status !== "ok" || !Array.isArray(entry.windows)) continue;
    for (const item of entry.windows) {
      const w = record(item);
      const label = text(w?.label);
      const used = w?.usedPercent;
      if (!w || label === null || typeof used !== "number" || !Number.isFinite(used)) continue;
      const resets = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN;
      out.push({ provider, label, usedPercent: Math.max(0, used), resetsAt: Number.isFinite(resets) ? resets : null, kind: text(w.kind), model: text(w.model) });
    }
  }
  return out;
}

/** Which window this is, the same from one read to the next. */
export const windowKey = (w: UsageWindow): string => [w.provider, w.kind ?? "", w.model ?? "", w.label].join("|");

/** The budget rule's first part: told when the last 30 days' dollars reach this share of the budget. */
export const SPENT_SHARE = 0.8;
export const DEFAULT_WINDOW_PERCENT = 80;

/** The last 30 days as the line shows them. */
export interface TotalLine {
  /** The first and last day summed, local YYYY-MM-DD: 30 days, today the last. */
  first: string;
  last: string;
  /** List-price dollars, every thread bb has; null when no model used had a price. */
  dollars: number | null;
  /** Threads with no usage recorded: not counted. */
  noUsage: number;
  /** Tokens of models with no list price: not in the dollars. */
  unpricedTokens: number;
  /** The budget for 30 days; null when none is set. */
  budget: number | null;
  /** Threads bb deleted whose kept usage is counted, and of those the ones made from a ledger row. */
  deleted?: number;
  fromLedger?: number;
  /** Kept usage records that could not be read: not counted. */
  unreadable?: number;
}

/** A budget setting: a number of dollars, or empty for none. Anything else is an error, said. */
export function budgetOf(value: string | number | undefined, name = "budget for 30 days"): { budget: number | null; error: string | null } {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? { budget: value, error: null } : { budget: null, error: null };
  const raw = (value ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (raw === "") return { budget: null, error: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { budget: null, error: `the ${name} "${value}" is not a number of dollars: no budget is applied` };
  return { budget: n, error: null };
}

/**
 * The budget from the settings: `budget30Days`, or when that is empty the
 * older `monthlyBudget` it was renamed from, read as the same thing.
 */
export function budgetSetting(budget30Days: string | undefined, monthlyBudget: string | undefined): { budget: number | null; error: string | null } {
  if ((budget30Days ?? "").trim() !== "") return budgetOf(budget30Days, "budget for 30 days");
  return budgetOf(monthlyBudget, "budget for 30 days (set as monthlyBudget)");
}

/** The window percent setting, 1 to 100; anything else is the default. */
export const windowPercentOf = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100 ? value : DEFAULT_WINDOW_PERCENT;

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a window resets: "in 3h 10m (Sun 22 Nov 13:00)", local time. */
export function resetText(at: number | null, now: number): string {
  if (at === null) return "reset time not given";
  const d = new Date(at);
  const when = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const left = at - now;
  if (left <= 0) return `reset ${when}`;
  const mins = Math.round(left / 60_000);
  const span = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${Math.round(mins / (24 * 60))}d`;
  return `resets in ${span} (${when})`;
}

const percentText = (n: number) => `${Math.round(n)}%`;
const windowName = (w: UsageWindow) => `${providerName(w.provider)} ${w.label}`;

/** One window on the line: "Claude Code Weekly limit 47%, resets in 3h (Sun 22 Nov 13:00)". */
export const windowText = (w: UsageWindow, now: number): string => `${windowName(w)} ${percentText(w.usedPercent)}, ${resetText(w.resetsAt, now)}`;

/** The last 30 days on the line: "last 30 days $653.07 at list price" and, with a budget, the budget beside it. */
export function totalText(t: TotalLine): string {
  const so = t.dollars === null ? `last ${LAST_DAYS} days: no list-priced usage` : `last ${LAST_DAYS} days ${dollarText(t.dollars)} at list price`;
  return t.budget === null ? so : `${so} of ${dollarText(t.budget)} budget`;
}

/** The whole line, in the order the page shows it. */
export function usageLineText(windows: readonly UsageWindow[], total: TotalLine | null, now: number): string {
  const parts = windows.map((w) => windowText(w, now));
  if (total) parts.push(totalText(total));
  return parts.length === 0 ? "No usage windows reported" : parts.join(" · ");
}

// ---- Telling the person, once ----------------------------------------------

/** "pace" is only in a notice kept from the monthly rules of an older cow: read and acknowledged, never raised. */
export type LimitRule = "window" | "spent" | "budget" | "pace";

/** What was raised already: each window's period, and each budget rule while the total stays at or above it. */
export interface Raised {
  /** Window key to the reset time of the period it was raised in (null: bb gave none). */
  windows: Record<string, { resetsAt: number | null; at: number }>;
  /** Budget rule to when it was raised; gone once the total falls below its threshold. */
  rules: { spent?: number; budget?: number };
}
export const NO_RAISED: Raised = { windows: {}, rules: {} };

/**
 * A stored record of what was raised, in today's shape or 0.2.20's, where a
 * budget rule held the month (YYYY-MM) it was raised in and "pace" was a
 * rule. A month's 80% notice raised this calendar month counts as raised
 * now, so it is not raised twice; one from an earlier month, and the pace,
 * are dropped.
 */
export function raisedOf(stored: { windows: Raised["windows"]; rules: { spent?: string | number; budget?: number; pace?: string } }, now: number): Raised {
  const rules: Raised["rules"] = {};
  const { spent, budget } = stored.rules;
  if (typeof spent === "number") rules.spent = spent;
  else if (typeof spent === "string" && spent === monthOf(now)) rules.spent = now;
  if (typeof budget === "number") rules.budget = budget;
  return { windows: stored.windows, rules };
}

/** A notice to raise: the facts, and the sentence that says them. */
export interface NoticeDraft {
  rule: LimitRule;
  /** The window's key, or the budget rule: one notice per key is kept. */
  key: string;
  text: string;
}

export interface LimitInput {
  windows: readonly UsageWindow[];
  /** Tell when a window reaches this percent. */
  windowPercent: number;
  total: TotalLine | null;
}

/** A reset time read again can move by a little; a new period is one that resets this much later than the last. */
const SAME_PERIOD_MS = 10 * 60_000;

/** The sentence of a window's notice. */
export const windowNoticeText = (w: UsageWindow, percent: number, now: number): string =>
  `${windowName(w)}${w.model && !w.label.toLowerCase().includes(w.model.toLowerCase()) ? ` (${w.model})` : ""} is at ${percentText(w.usedPercent)} of its window (told at ${percentText(percent)}); it ${resetText(w.resetsAt, now)}.`;

export const spentNoticeText = (t: TotalLine & { dollars: number; budget: number }): string =>
  `The last ${LAST_DAYS} days' list-price dollars are ${dollarText(t.dollars)}, ${percentText((t.dollars / t.budget) * 100)} of the ${dollarText(t.budget)} budget for ${LAST_DAYS} days (told at ${percentText(SPENT_SHARE * 100)}). Nothing is stopped.`;

export const budgetNoticeText = (t: TotalLine & { dollars: number; budget: number }): string =>
  `The last ${LAST_DAYS} days' list-price dollars are ${dollarText(t.dollars)}, at or over the ${dollarText(t.budget)} budget for ${LAST_DAYS} days. Nothing is stopped.`;

/** The budget rules: the share of the budget each is told at. */
const BUDGET_RULES = [
  { rule: "spent", share: SPENT_SHARE, text: spentNoticeText },
  { rule: "budget", share: 1, text: budgetNoticeText },
] as const;

/**
 * What to raise now, and what is then recorded as raised. A window raises
 * one notice when it reaches its percent, and no other until its period has
 * reset: until bb reports it with a reset time later than the one it was
 * raised in, once that time has passed. A window bb gives no reset time for
 * can raise again once it was seen below its percent. A window whose reset
 * time is past is stale and raises nothing. Each budget rule raises once
 * when the last 30 days' dollars reach its threshold, 80% of the budget and
 * the budget, and again only after the total has fallen below it and risen
 * to it once more.
 */
export function decide(raised: Raised, input: LimitInput, now: number): { raised: Raised; drafts: NoticeDraft[] } {
  const windows = { ...raised.windows };
  const rules = { ...raised.rules };
  const drafts: NoticeDraft[] = [];
  const seen = new Set<string>();
  for (const w of input.windows) {
    const key = windowKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    const before = windows[key];
    const over = w.usedPercent >= input.windowPercent;
    if (!over) {
      if (before && (before.resetsAt === null || now >= before.resetsAt)) delete windows[key];
      continue;
    }
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    const newPeriod =
      before === undefined ||
      (before.resetsAt !== null && now >= before.resetsAt && (w.resetsAt === null || w.resetsAt > before.resetsAt + SAME_PERIOD_MS));
    if (!newPeriod) continue;
    windows[key] = { resetsAt: w.resetsAt, at: now };
    drafts.push({ rule: "window", key: `window:${key}`, text: windowNoticeText(w, input.windowPercent, now) });
  }
  const t = input.total;
  if (t && t.budget !== null && t.dollars !== null) {
    const facts = { ...t, budget: t.budget, dollars: t.dollars };
    for (const { rule, share, text } of BUDGET_RULES) {
      if (t.dollars < share * t.budget) delete rules[rule];
      else if (rules[rule] === undefined) {
        rules[rule] = now;
        drafts.push({ rule, key: rule, text: text(facts) });
      }
    }
  }
  return { raised: { windows, rules }, drafts };
}

/** `bb cow usage`: the line, then how it is worked out, then the notices waiting. */
export function usageReportText(
  report: { windows: readonly UsageWindow[]; total: TotalLine | null; windowPercent: number; errors: readonly string[]; notices: readonly { text: string; at: number }[] },
  now: number,
): string {
  const out = [usageLineText(report.windows, report.total, now), ""];
  if (report.windows.length === 0) out.push("No signed-in provider reports a usage window.");
  for (const w of report.windows) out.push(`  ${windowText(w, now)}`);
  const t = report.total;
  if (t) {
    out.push(`  ${totalText(t)}`);
    out.push(`    ${t.first} to ${t.last}: today and the ${LAST_DAYS - 1} days before it, local time. Every thread on this bb, under any Main or none. An estimate at the providers' list prices, not a bill.${t.noUsage > 0 ? ` ${t.noUsage} ${t.noUsage === 1 ? "thread" : "threads"} with no usage recorded: not counted.` : ""}${t.unpricedTokens > 0 ? " Tokens of models with no list price are not in the dollars." : ""}`);
    for (const note of keptNotes({ deleted: t.deleted ?? 0, fromLedger: t.fromLedger ?? 0 }, t.unreadable ?? 0)) out.push(`    ${note}`);
    if (t.budget === null) out.push(`    No budget is set (the budget30Days setting).`);
    out.push(`    ${USAGE_GAPS_NOTE}`);
  }
  out.push("", `Told at ${Math.round(report.windowPercent)}% of a window, once per reset period${t?.budget != null ? `; and once each when the last ${LAST_DAYS} days' dollars reach ${SPENT_SHARE * 100}% of the budget and when they reach the budget, again only after falling below it` : ""}. Nothing is ever paused or stopped.`);
  if (report.notices.length > 0) {
    out.push("", `Usage notices waiting for the person (acknowledged on the page): ${report.notices.length}`);
    for (const notice of report.notices) out.push(`  ${notice.text}`);
  }
  for (const error of report.errors) out.push(`Could not read: ${error}`);
  return out.join("\n");
}
