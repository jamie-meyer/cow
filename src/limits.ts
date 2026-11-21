// The usage line and the notices before a limit. Pure: what bb reports of each
// provider's usage windows, the month's list-price dollars against a budget,
// the pace, and the rule for when the person is told, once. Reading bb, the
// timer and the notices kept are in limits-backend.ts.
//
// Nothing here acts on a thread: a notice is a line in the person's queue
// (and, when they allow it, a notification), never a stop.

import { dollarText } from "./prices.ts";
import { USAGE_GAPS_NOTE, monthStart } from "./usage.ts";

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

/** When the month after this one (YYYY-MM) starts, local time. */
export const monthEnd = (month: string): number => {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(index === 12 ? year + 1 : year, index === 12 ? 0 : index, 1).getTime();
};

/** No pace is worked out before this day of the month: two days say too little. */
export const PACE_FROM_DAY = 3;

/**
 * The month-end figure at the current pace: the dollars so far divided by
 * the fraction of the month gone (local time, to the millisecond). Null
 * before the third day of the month.
 */
export function paceOf(dollars: number, month: string, now: number): number | null {
  if (new Date(now).getDate() < PACE_FROM_DAY && now < monthEnd(month)) return null;
  const start = monthStart(month);
  const gone = Math.min(1, Math.max(0, (now - start) / (monthEnd(month) - start)));
  return gone <= 0 ? null : dollars / gone;
}

export const PACE_RULE = `the dollars so far divided by the fraction of the month gone, from the ${PACE_FROM_DAY}rd day of the month`;

/** The budget rule's first part: told when the month's dollars reach this share of the budget. */
export const SPENT_SHARE = 0.8;
export const DEFAULT_WINDOW_PERCENT = 80;

/** The month as the line shows it. */
export interface MonthLine {
  month: string;
  /** List-price dollars so far, every thread bb has; null when no model used had a price. */
  dollars: number | null;
  /** Threads with no usage recorded: not counted. */
  noUsage: number;
  /** Tokens of models with no list price: not in the dollars. */
  unpricedTokens: number;
  budget: number | null;
  pace: number | null;
}

/** The budget setting: a number of dollars, or empty for none. Anything else is an error, said. */
export function budgetOf(value: string | number | undefined): { budget: number | null; error: string | null } {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? { budget: value, error: null } : { budget: null, error: null };
  const raw = (value ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (raw === "") return { budget: null, error: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { budget: null, error: `the monthly budget "${value}" is not a number of dollars: no budget is applied` };
  return { budget: n, error: null };
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

/** The month on the line: "November so far $43.03 at list price" and, with a budget, its budget and pace. */
export function monthText(m: MonthLine): string {
  const name = MONTHS[Number(m.month.slice(5, 7)) - 1] ?? m.month;
  const so = m.dollars === null ? `${name} so far: no list-priced usage` : `${name} so far ${dollarText(m.dollars)} at list price`;
  if (m.budget === null) return so;
  const pace = m.pace === null ? `pace from the ${PACE_FROM_DAY}rd` : `pace ${dollarText(m.pace)} by month end`;
  return `${so} of ${dollarText(m.budget)} budget · ${pace}`;
}

/** The whole line, in the order the page shows it. */
export function usageLineText(windows: readonly UsageWindow[], month: MonthLine | null, now: number): string {
  const parts = windows.map((w) => windowText(w, now));
  if (month) parts.push(monthText(month));
  return parts.length === 0 ? "No usage windows reported" : parts.join(" · ");
}

// ---- Telling the person, once ----------------------------------------------

export type LimitRule = "window" | "spent" | "pace";

/** What was raised already: each window's period, and each budget rule's month. */
export interface Raised {
  /** Window key to the reset time of the period it was raised in (null: bb gave none). */
  windows: Record<string, { resetsAt: number | null; at: number }>;
  /** Budget rule to the month (YYYY-MM) it was raised in. */
  rules: { spent?: string; pace?: string };
}
export const NO_RAISED: Raised = { windows: {}, rules: {} };

/** A notice to raise: the facts, and the sentence that says them. */
export interface NoticeDraft {
  rule: LimitRule;
  /** The window's key, or the rule and month: one notice per key is kept. */
  key: string;
  text: string;
}

export interface LimitInput {
  windows: readonly UsageWindow[];
  /** Tell when a window reaches this percent. */
  windowPercent: number;
  month: MonthLine | null;
}

/** A reset time read again can move by a little; a new period is one that resets this much later than the last. */
const SAME_PERIOD_MS = 10 * 60_000;

/** The sentence of a window's notice. */
export const windowNoticeText = (w: UsageWindow, percent: number, now: number): string =>
  `${windowName(w)}${w.model && !w.label.toLowerCase().includes(w.model.toLowerCase()) ? ` (${w.model})` : ""} is at ${percentText(w.usedPercent)} of its window (told at ${percentText(percent)}); it ${resetText(w.resetsAt, now)}.`;

export const spentNoticeText = (m: MonthLine & { dollars: number; budget: number }): string =>
  `This month's list-price dollars are ${dollarText(m.dollars)}, ${percentText((m.dollars / m.budget) * 100)} of the ${dollarText(m.budget)} monthly budget (told at ${percentText(SPENT_SHARE * 100)}). Nothing is stopped.`;

export const paceNoticeText = (m: MonthLine & { dollars: number; budget: number; pace: number }, now: number): string => {
  const gone = (now - monthStart(m.month)) / (monthEnd(m.month) - monthStart(m.month));
  return `At this month's pace, ${dollarText(m.pace)} by the month's end, over the ${dollarText(m.budget)} monthly budget: ${dollarText(m.dollars)} so far with ${percentText(gone * 100)} of the month gone. Nothing is stopped.`;
};

/**
 * What to raise now, and what is then recorded as raised. A window raises
 * one notice when it reaches its percent, and no other until its period has
 * reset: until bb reports it with a reset time later than the one it was
 * raised in, once that time has passed. A window bb gives no reset time for
 * can raise again once it was seen below its percent. A window whose reset
 * time is past is stale and raises nothing. Each budget rule raises once a
 * month: the dollars reaching 80% of the budget, and the pace going over it.
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
  const m = input.month;
  if (m && m.budget !== null && m.dollars !== null) {
    const facts = { ...m, budget: m.budget, dollars: m.dollars };
    if (rules.spent !== m.month && m.dollars >= SPENT_SHARE * m.budget) {
      rules.spent = m.month;
      drafts.push({ rule: "spent", key: `spent:${m.month}`, text: spentNoticeText(facts) });
    }
    if (rules.pace !== m.month && m.pace !== null && m.pace > m.budget) {
      rules.pace = m.month;
      drafts.push({ rule: "pace", key: `pace:${m.month}`, text: paceNoticeText({ ...facts, pace: m.pace }, now) });
    }
  }
  return { raised: { windows, rules }, drafts };
}

/** `bb cow usage`: the line, then how it is worked out, then the notices waiting. */
export function usageReportText(
  report: { windows: readonly UsageWindow[]; month: MonthLine | null; windowPercent: number; errors: readonly string[]; notices: readonly { text: string; at: number }[] },
  now: number,
): string {
  const out = [usageLineText(report.windows, report.month, now), ""];
  if (report.windows.length === 0) out.push("No signed-in provider reports a usage window.");
  for (const w of report.windows) out.push(`  ${windowText(w, now)}`);
  const m = report.month;
  if (m) {
    out.push(`  ${monthText(m)}`);
    out.push(`    Every thread on this bb, under any Main or none. An estimate at the providers' list prices, not a bill.${m.noUsage > 0 ? ` ${m.noUsage} ${m.noUsage === 1 ? "thread" : "threads"} with no usage recorded: not counted.` : ""}${m.unpricedTokens > 0 ? " Tokens of models with no list price are not in the dollars." : ""}`);
    out.push(m.budget === null ? "    No monthly budget is set (the monthlyBudget setting)." : `    Pace: ${PACE_RULE}.`);
    out.push(`    ${USAGE_GAPS_NOTE}`);
  }
  out.push("", `Told at ${Math.round(report.windowPercent)}% of a window, once per reset period${m?.budget != null ? `; and once a month each when the dollars reach ${SPENT_SHARE * 100}% of the budget and when the pace goes over it` : ""}. Nothing is ever paused or stopped.`);
  if (report.notices.length > 0) {
    out.push("", `Usage notices waiting for the person (acknowledged on the page): ${report.notices.length}`);
    for (const notice of report.notices) out.push(`  ${notice.text}`);
  }
  for (const error of report.errors) out.push(`Could not read: ${error}`);
  return out.join("\n");
}
