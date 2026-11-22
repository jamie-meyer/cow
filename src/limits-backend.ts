// The usage line and the notices before a limit, on cow's server: the
// settings, the windows read from bb, the last 30 days read from the ledger's usage,
// a check on a timer that raises a notice once, and its acknowledgement. The
// check runs with the page closed.
//
// Nothing here starts a thread, sends one a message, or pauses or stops one:
// a notice is a line in the person's queue, and a notification when they
// allow it.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LogStore } from "./caps/logstore.ts";
import { Refusal, type Kv, serial } from "./kv.ts";
import {
  DEFAULT_WINDOW_PERCENT,
  LIMITS_CHANGED,
  type LimitRule,
  NO_RAISED,
  type NoticeDraft,
  SPENT_SHARE,
  type TotalLine,
  type UsageWindow,
  budgetSetting,
  decide,
  raisedOf,
  windowPercentOf,
  windowsOf,
} from "./limits.ts";
import type { SpendPart } from "./spend.ts";
import type { Ticker } from "./ticker.ts";
import type { Period } from "./usage.ts";
import { pushNotify } from "./push.ts";

/** How often the server checks, with the page open or not. */
export const CHECK_EVERY_MS = 5 * 60_000;
/** A line read this recently is given again without asking bb. */
const FRESH_MS = 60_000;
const NOTICE = "limit-notice:";
const RAISED = "limits-raised";

export const limitNoticeSchema = z.object({
  id: z.string(),
  rule: z.enum(["window", "spent", "budget", "pace"]),
  key: z.string(),
  text: z.string(),
  at: z.number(),
});
export type LimitNotice = z.infer<typeof limitNoticeSchema>;

const raisedSchema = z.object({
  windows: z.record(z.string(), z.object({ resetsAt: z.number().nullable(), at: z.number() })),
  // A budget rule is when it was raised; 0.2.20 kept the month (YYYY-MM) in `spent` and `pace`, read by raisedOf.
  rules: z.object({ spent: z.union([z.number(), z.string()]).optional(), budget: z.number().optional(), pace: z.string().optional() }),
});

/** What the line, `bb cow usage` and the page's notices show. */
export interface UsageReport {
  at: number;
  windows: UsageWindow[];
  /** The last 30 days; null when they could not be read, and `errors` says why. */
  total: TotalLine | null;
  windowPercent: number;
  /** Errors reading the windows, the last 30 days or the settings; none of them stops the rest. */
  errors: string[];
  notices: LimitNotice[];
}

export interface LimitsDeps {
  kv: Kv;
  now: () => number;
  newId: () => string;
  /** bb's usage windows response, every provider. */
  usageLimits: () => Promise<unknown>;
  /** The last 30 days' figures, every thread bb has. */
  total: () => Promise<SpendPart & { period: Period; unreadable?: number; priceError: string | null }>;
  settings: () => Promise<{ budget30Days: string; monthlyBudget: string; windowPercent: number; notify: boolean }>;
  /** Send the person a notification; rejects when it cannot. */
  notify: (title: string, body: string) => Promise<void>;
  log: Pick<LogStore, "append">;
  changed: () => void;
  warn: (text: string) => void;
}

export interface Limits {
  /** The line's figures and the notices waiting. `fresh` asks bb again even when the last read is recent. */
  report(fresh?: boolean): Promise<UsageReport>;
  /** Read, and raise what is due. What the timer runs. */
  check(): Promise<{ report: UsageReport; raised: LimitNotice[] }>;
  /** The person acknowledged a notice (a signed call). */
  acknowledge(noticeId: string, by: string): Promise<LimitNotice>;
  notices(): Promise<LimitNotice[]>;
}

export function createLimits(deps: LimitsDeps): Limits {
  const one = serial();
  let last: Omit<UsageReport, "notices"> | null = null;

  const notices = async (): Promise<LimitNotice[]> => {
    const out: LimitNotice[] = [];
    for (const key of await deps.kv.list(NOTICE)) {
      const parsed = limitNoticeSchema.safeParse(await deps.kv.get(key));
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  };

  const read = async (): Promise<Omit<UsageReport, "notices">> => {
    const at = deps.now();
    const errors: string[] = [];
    const set = await deps.settings().catch((cause: unknown) => {
      errors.push(`settings: ${String(cause)}`);
      return { budget30Days: "", monthlyBudget: "", windowPercent: DEFAULT_WINDOW_PERCENT, notify: false };
    });
    const { budget, error } = budgetSetting(set.budget30Days, set.monthlyBudget);
    if (error) errors.push(error);
    const windows = await deps.usageLimits().then(windowsOf, (cause: unknown) => {
      errors.push(`usage windows: ${cause instanceof Error ? cause.message : String(cause)}`);
      return [] as UsageWindow[];
    });
    const total = await deps.total().then(
      (part): TotalLine => {
        if (part.priceError) errors.push(part.priceError);
        return { first: part.period.first, last: part.period.last, dollars: part.dollars, noUsage: part.noUsage, unpricedTokens: part.unpricedTokens, budget, deleted: part.deleted, fromLedger: part.fromLedger, unreadable: part.unreadable ?? 0 };
      },
      (cause: unknown) => {
        errors.push(`the last 30 days: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      },
    );
    return { at, windows, total, windowPercent: windowPercentOf(set.windowPercent), errors };
  };

  const report: Limits["report"] = async (fresh = false) => {
    if (fresh || last === null || deps.now() - last.at > FRESH_MS) last = await one("read", read);
    return { ...last, notices: await notices() };
  };

  const raise = async (drafts: readonly NoticeDraft[]): Promise<LimitNotice[]> => {
    const made: LimitNotice[] = [];
    const waiting = await notices();
    for (const draft of drafts) {
      // One notice per window or rule: a new period's takes the place of one not yet acknowledged, and so does a budget rule's monthly one ("spent:2026-11").
      for (const old of waiting.filter((notice) => notice.key === draft.key || (draft.rule !== "window" && notice.key.startsWith(`${draft.key}:`)))) await deps.kv.delete(NOTICE + old.id);
      const notice: LimitNotice = { id: `limit_${deps.newId()}`, rule: draft.rule as LimitRule, key: draft.key, text: draft.text, at: deps.now() };
      await deps.kv.set(NOTICE + notice.id, notice);
      made.push(notice);
    }
    return made;
  };

  const check: Limits["check"] = () =>
    one("check", async () => {
      const got = await report(true);
      const stored = raisedSchema.safeParse(await deps.kv.get(RAISED));
      const before = stored.success ? raisedOf(stored.data, got.at) : NO_RAISED;
      const { raised, drafts } = decide(before, { windows: got.windows, windowPercent: got.windowPercent, total: got.total }, got.at);
      // Recorded before the notice is kept: a check that fails in between tells once too few, never twice.
      if (!stored.success || JSON.stringify(raised) !== JSON.stringify(stored.data)) await deps.kv.set(RAISED, raised);
      const made = await raise(drafts);
      if (made.length > 0) {
        deps.changed();
        const set = await deps.settings().catch(() => ({ notify: false }));
        if (set.notify) {
          for (const notice of made) {
            await deps.notify("🐄 cow: usage", notice.text).catch((cause: unknown) => deps.warn(`could not send a notification: ${String(cause)}`));
          }
        }
      }
      return { report: { ...got, notices: await notices() }, raised: made };
    });

  const acknowledge: Limits["acknowledge"] = (noticeId, by) =>
    one(`ack:${noticeId}`, async () => {
      const found = /^limit_[a-z0-9]{1,40}$/.test(noticeId) ? limitNoticeSchema.safeParse(await deps.kv.get(NOTICE + noticeId)) : null;
      if (!found?.success) throw new Refusal("notice_not_found", `there is no usage notice ${noticeId} to acknowledge`);
      await deps.log.append({ kind: "acknowledged", noticeId, capabilityId: null, threadId: null, summary: found.data.text.slice(0, 300), scopeThreadId: null }, by);
      await deps.kv.delete(NOTICE + noticeId);
      deps.changed();
      return found.data;
    });

  return { report, check, acknowledge, notices };
}

export const LIMIT_SETTINGS_HELP = {
  budget30Days: `Budget for the last 30 days in US dollars at list price, for every thread on this bb, such as 500. Empty: none. Not a hard stop: cow tells you once when the last 30 days' dollars reach ${SPENT_SHARE * 100}% of it and once when they reach it, and again only after they fall below and rise to it once more. Nothing is ever paused or stopped.`,
  monthlyBudget: "Renamed: Budget for 30 days (budget30Days). Read as that budget while budget30Days is empty.",
  windowPercent: `Tell you, once per window per reset period, when a provider's usage window reaches this percent, 1 to 100. Default ${DEFAULT_WINDOW_PERCENT}.`,
  notify: "Send a notification, through bb's push-notifications plugin, with the same text when a usage notice is raised. The notice in cow's queue is there either way.",
};

export function registerLimits(bb: BbPluginApi, log: LogStore, total: () => Promise<SpendPart & { period: Period; unreadable?: number; priceError: string | null }>, ticker: Ticker): Limits {
  const settings = bb.settings.define({
    budget30Days: {
      type: "string",
      label: "Budget for 30 days (USD)",
      description: LIMIT_SETTINGS_HELP.budget30Days,
      default: "",
    },
    monthlyBudget: {
      type: "string",
      label: "Monthly budget (USD), renamed",
      description: LIMIT_SETTINGS_HELP.monthlyBudget,
      default: "",
    },
    usageWindowPercent: {
      type: "number",
      label: "Usage window notice at (%)",
      description: LIMIT_SETTINGS_HELP.windowPercent,
      experimental_schema: z.number().min(1).max(100),
      default: DEFAULT_WINDOW_PERCENT,
    },
    usageNotify: {
      type: "boolean",
      label: "Notify on a usage notice",
      description: LIMIT_SETTINGS_HELP.notify,
      default: true,
    },
  });
  const limits = createLimits({
    kv: bb.storage.kv,
    now: Date.now,
    newId: () => Math.random().toString(36).slice(2, 12),
    usageLimits: () => bb.sdk.system.usageLimits({ signal: AbortSignal.timeout(20_000) }),
    total,
    settings: async () => {
      const got = await settings.get();
      return { budget30Days: got.budget30Days, monthlyBudget: got.monthlyBudget, windowPercent: got.usageWindowPercent, notify: got.usageNotify };
    },
    notify: pushNotify(bb, "usage"),
    log,
    changed: () => bb.realtime.publish(LIMITS_CHANGED, {}),
    warn: (text) => bb.log.warn(text),
  });
  const run = () => void limits.check().catch((cause: unknown) => bb.log.warn(`could not check usage: ${String(cause)}`));
  // On cow's one timer, shared with the caps and stuck checks: the first check waits for the rest of cow to load; then one every few minutes, page open or not.
  ticker.every("usage", CHECK_EVERY_MS, () => limits.check());
  settings.onChange(run);
  return limits;
}
