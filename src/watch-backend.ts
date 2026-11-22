// The caps and the stuck checks on cow's server: each worker's progress
// brought up to date when bb says its events changed, the checks run then
// and on cow's one timer (shared with the usage notices), a mark per worker
// for the page and `bb cow status`, and one notice per worker per reason in
// the person's queue, acknowledged by a signed page action.
//
// Nothing here starts, stops, interrupts, archives or messages a thread: it
// reads bb's threads and events, and writes cow's own storage. A worker over
// its cap, or caught by a check, is shown to the person, and that is all.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listThreads, toFacts } from "./activity.ts";
import type { LogStore } from "./caps/logstore.ts";
import { Refusal, type Kv, serial } from "./kv.ts";
import {
  type Caps,
  DEFAULT_STUCK,
  DOLLARS_NOTE,
  type Finding,
  type StuckSettings,
  WATCH_CHANGED,
  WATCH_REASONS,
  type WatchReason,
  capsOf,
  findings,
  noticeText,
  workingMinutes,
} from "./progress.ts";
import { type ProgressStore, createProgressStore, sdkProgressEvents } from "./progress-store.ts";
import { type ThreadFacts, isBusy } from "./state.ts";
import type { Ticker } from "./ticker.ts";
import { workerShaped } from "./tree.ts";
import { AUTOMATIONS_PLUGIN } from "./automations.ts";
import type { WorkFacts } from "./ledger.ts";

/** The timed checks run this often. */
export const WATCH_EVERY_MS = 60_000;
/** A burst of events for one thread is read once, this long after the first. */
const NUDGE_MS = 400;
/** The list of threads is read again after this long; the thread a nudge names is always read fresh. */
const THREADS_FRESH_MS = 10_000;
const NOTICE = "watch-notice:";
const RAISED = "watch-raised:";

export const watchNoticeSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  reason: z.enum(WATCH_REASONS as [WatchReason, ...WatchReason[]]),
  text: z.string(),
  at: z.number(),
});
export type WatchNotice = z.infer<typeof watchNoticeSchema>;
const raisedSchema = z.array(z.enum(WATCH_REASONS as [WatchReason, ...WatchReason[]]));

export interface WatchSettings {
  caps: string;
  stuck: StuckSettings;
}

/** What the page, `bb cow status` and `bb cow watch` show. */
export interface WatchReport {
  at: number;
  /** Thread id to what it is over or caught by now: shown on its line while true. */
  marks: Record<string, Finding[]>;
  notices: WatchNotice[];
  caps: Caps;
  stuck: StuckSettings;
  /** A bad caps setting, or a read that failed; none of them stops the rest. */
  errors: string[];
}

export interface WatchDeps {
  kv: Kv;
  now: () => number;
  newId: () => string;
  /** Every thread bb has, archived ones too, with bb's updatedAt where known. */
  threads: () => Promise<(ThreadFacts & { updatedAt?: number | null })[]>;
  /** One thread, read now; null when bb has none. */
  thread: (threadId: string) => Promise<(ThreadFacts & { updatedAt?: number | null }) | null>;
  /** The threads chosen as Main, every project. */
  mains: () => Promise<string[]>;
  /** Of these threads, the ones marked as projects. */
  marked: (threadIds: readonly string[]) => Promise<string[]>;
  label: (threadId: string) => Promise<string | null>;
  /** List-price dollars of its usage so far; null when not known. */
  dollars: (threadId: string) => Promise<number | null>;
  progress: ProgressStore;
  settings: () => Promise<WatchSettings>;
  log: Pick<LogStore, "append">;
  changed: () => void;
}

export interface Watch {
  /** Bring these workers (or every one) up to date, mark them, and raise what is due. What a nudge and the timer run. */
  check(threadIds?: readonly string[]): Promise<WatchReport>;
  report(): Promise<WatchReport>;
  /** The person acknowledged a notice (a signed call). That reason does not come back for that worker. */
  acknowledge(noticeId: string, by: string): Promise<WatchNotice>;
  /** A worker's tool calls and working minutes, for its ledger row. */
  work(threadId: string): Promise<WorkFacts | null>;
  forget(threadId: string): Promise<void>;
}

export function createWatch(deps: WatchDeps): Watch {
  const one = serial();
  let marks: Record<string, Finding[]> = {};
  let errors: string[] = [];
  let settingsSeen: { caps: Caps; stuck: StuckSettings } = { caps: {}, stuck: DEFAULT_STUCK };
  let listed: { at: number; threads: (ThreadFacts & { updatedAt?: number | null })[] } | null = null;

  const notices = async (): Promise<WatchNotice[]> => {
    const out: WatchNotice[] = [];
    for (const key of await deps.kv.list(NOTICE)) {
      const parsed = watchNoticeSchema.safeParse(await deps.kv.get(key));
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  };
  const raisedOf = async (threadId: string): Promise<WatchReason[]> => {
    const parsed = raisedSchema.safeParse(await deps.kv.get(RAISED + threadId));
    return parsed.success ? parsed.data : [];
  };
  const threads = async (fresh: boolean) => {
    if (fresh || listed === null || deps.now() - listed.at > THREADS_FRESH_MS) listed = { at: deps.now(), threads: await deps.threads() };
    return listed.threads;
  };

  /** The workers among these candidates: under a parent, no Main, not marked, nothing live under them, no automation's run, not archived. */
  const workersOf = async (all: readonly ThreadFacts[], candidates: readonly ThreadFacts[]) => {
    const open = candidates.filter((thread) => thread.archivedAt === null && thread.parentThreadId !== null && thread.originPluginId !== AUTOMATIONS_PLUGIN);
    if (open.length === 0) return [];
    const mains = new Set(await deps.mains());
    const marked = await deps.marked(open.map((thread) => thread.id));
    return open.filter((thread) => !mains.has(thread.id) && workerShaped(all, thread, marked));
  };

  const check: Watch["check"] = (threadIds) =>
    one("check", async () => {
      const now = deps.now();
      const errs: string[] = [];
      const set = await deps.settings().catch((cause: unknown) => {
        errs.push(`settings: ${String(cause)}`);
        return { caps: "", stuck: DEFAULT_STUCK };
      });
      const { caps, error } = capsOf(set.caps);
      if (error) errs.push(error);
      settingsSeen = { caps, stuck: set.stuck };
      const anyCap = Object.keys(caps).length > 0;
      const all = await threads(threadIds === undefined);
      let candidates: ThreadFacts[];
      if (threadIds === undefined) candidates = all;
      else {
        candidates = [];
        for (const id of threadIds) {
          const found = await deps.thread(id).catch(() => null);
          if (found) candidates.push(found);
        }
      }
      const workers = await workersOf(all, candidates);
      const next: Record<string, Finding[]> = threadIds === undefined ? {} : { ...marks };
      for (const id of threadIds ?? []) delete next[id];
      const made: WatchNotice[] = [];
      for (const worker of workers) {
        const running = isBusy(worker);
        // An idle worker can only be over a cap: with none set, it is not read at all.
        if (!running && !anyCap) continue;
        try {
          const progress = await deps.progress.read(worker.id, running ? undefined : (worker as { updatedAt?: number | null }).updatedAt);
          const label = anyCap ? await deps.label(worker.id) : null;
          const dollars = Object.values(caps).some((cap) => cap.dollars !== undefined) ? await deps.dollars(worker.id).catch(() => null) : null;
          const found = findings({ progress, label, dollars, running }, caps, set.stuck, now);
          if (found.length === 0) continue;
          next[worker.id] = found;
          const raised = await raisedOf(worker.id);
          const due = found.filter((f) => !raised.includes(f.reason));
          if (due.length === 0) continue;
          // Recorded before the notice is kept: a check that fails in between tells once too few, never twice.
          await deps.kv.set(RAISED + worker.id, [...raised, ...due.map((f) => f.reason)]);
          for (const f of due) {
            const notice: WatchNotice = { id: `watch_${deps.newId()}`, threadId: worker.id, reason: f.reason, text: noticeText(worker.title, f), at: now };
            await deps.kv.set(NOTICE + notice.id, notice);
            made.push(notice);
          }
        } catch (cause) {
          errs.push(`${worker.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      const changed = made.length > 0 || JSON.stringify(next) !== JSON.stringify(marks) || JSON.stringify(errs) !== JSON.stringify(errors);
      marks = next;
      errors = errs;
      if (changed) deps.changed();
      return { at: now, marks, notices: await notices(), ...settingsSeen, errors };
    });

  const acknowledge: Watch["acknowledge"] = (noticeId, by) =>
    one(`ack:${noticeId}`, async () => {
      const found = /^watch_[a-z0-9]{1,40}$/.test(noticeId) ? watchNoticeSchema.safeParse(await deps.kv.get(NOTICE + noticeId)) : null;
      if (!found?.success) throw new Refusal("notice_not_found", `there is no worker notice ${noticeId} to acknowledge`);
      await deps.log.append({ kind: "acknowledged", noticeId, capabilityId: null, threadId: found.data.threadId, summary: found.data.text.slice(0, 300), scopeThreadId: null }, by);
      await deps.kv.delete(NOTICE + noticeId);
      deps.changed();
      return found.data;
    });

  return {
    check,
    report: async () => ({ at: deps.now(), marks, notices: await notices(), ...settingsSeen, errors }),
    acknowledge,
    work: async (threadId) => {
      const progress = await deps.progress.read(threadId);
      return progress.lastSeq === null ? null : { toolCalls: progress.toolCalls, workingMinutes: workingMinutes(progress) };
    },
    forget: async (threadId) => {
      await deps.progress.forget(threadId);
      await deps.kv.delete(RAISED + threadId);
      for (const notice of await notices()) if (notice.threadId === threadId) await deps.kv.delete(NOTICE + notice.id);
      if (marks[threadId]) {
        const { [threadId]: _gone, ...rest } = marks;
        marks = rest;
        deps.changed();
      }
    },
  };
}

export const WATCH_SETTINGS_HELP = {
  caps: `Caps per worker, shown and never enforced: JSON keyed by label (bb cow label), with "*" for workers of any other label or none. Each entry any of toolCalls, minutes (wall-clock since its first turn started) and dollars (${DOLLARS_NOTE}). Such as {"lookup": {"toolCalls": 40, "minutes": 20}, "*": {"dollars": 5}}. Empty: no caps. A value that is not in this form is reported, and no cap applies. A worker over its cap gets a mark on its line and one notice in your queue; cow never stops it.`,
  repeats: `A worker that makes the same call (the same command, or the same tool with the same arguments) this many times in a row while its turn runs gets a mark and one notice. 0: off. Default ${DEFAULT_STUCK.repeats}.`,
  quiet: `A worker whose turn runs with no event and nothing in progress for this many minutes gets a mark and one notice. 0: off. Default ${DEFAULT_STUCK.quietMinutes}.`,
  longItem: `A worker with one command or tool call in progress for this many minutes, while its turn runs, gets a mark and one notice. 0: off. Default ${DEFAULT_STUCK.longItemMinutes}.`,
};

const count = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

export function registerWatch(
  bb: BbPluginApi,
  log: LogStore,
  ticker: Ticker,
  deps: Pick<WatchDeps, "mains" | "marked" | "label" | "dollars">,
): Watch {
  const settings = bb.settings.define({
    caps: { type: "string", label: "Caps per worker (JSON by label)", description: WATCH_SETTINGS_HELP.caps, default: "" },
    stuckRepeats: { type: "number", label: "Stuck: the same call in a row", description: WATCH_SETTINGS_HELP.repeats, experimental_schema: z.number().int().min(0), default: DEFAULT_STUCK.repeats },
    stuckQuietMinutes: { type: "number", label: "Stuck: quiet minutes", description: WATCH_SETTINGS_HELP.quiet, experimental_schema: z.number().min(0), default: DEFAULT_STUCK.quietMinutes },
    stuckLongItemMinutes: { type: "number", label: "Stuck: one item in progress (minutes)", description: WATCH_SETTINGS_HELP.longItem, experimental_schema: z.number().min(0), default: DEFAULT_STUCK.longItemMinutes },
  });
  const reader = bb.sdk.threads as never;
  const watch = createWatch({
    kv: bb.storage.kv,
    now: Date.now,
    newId: () => Math.random().toString(36).slice(2, 12),
    threads: async () => (await listThreads(reader)).threads,
    thread: async (threadId) => {
      const [raw] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
      const facts = raw === undefined ? null : toFacts(raw);
      const updatedAt = (raw as { updatedAt?: unknown } | undefined)?.updatedAt;
      return facts === null ? null : { ...facts, updatedAt: typeof updatedAt === "number" ? updatedAt : null };
    },
    progress: createProgressStore(bb.storage.kv, sdkProgressEvents(bb.sdk.threads.events as never)),
    settings: async () => {
      const got = await settings.get();
      return {
        caps: got.caps,
        stuck: { repeats: count(got.stuckRepeats, DEFAULT_STUCK.repeats), quietMinutes: count(got.stuckQuietMinutes, DEFAULT_STUCK.quietMinutes), longItemMinutes: count(got.stuckLongItemMinutes, DEFAULT_STUCK.longItemMinutes) },
      };
    },
    log,
    changed: () => bb.realtime.publish(WATCH_CHANGED, {}),
    ...deps,
  });
  const quietly = (what: string) => (cause: unknown) => bb.log.warn(`could not check ${what}: ${String(cause)}`);

  // bb does not send a plugin's server the events: it says a thread's events changed, and cow reads them.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (typeof event.id !== "string" || pending.has(event.id)) return;
      const changes: readonly string[] = (event as { changes?: readonly string[] }).changes ?? [];
      if (!changes.includes("events-appended")) return;
      const threadId = event.id;
      pending.set(
        threadId,
        setTimeout(() => {
          pending.delete(threadId);
          void watch.check([threadId]).catch(quietly(`the worker ${threadId}`));
        }, NUDGE_MS),
      );
    },
  });
  // The time-based checks (quiet, one item in progress, minutes) on cow's one timer, page open or not.
  ticker.every("watch", WATCH_EVERY_MS, () => watch.check());
  settings.onChange(() => void watch.check().catch(quietly("workers")));
  bb.events.on("thread.deleted", ({ thread }) => {
    void watch.forget(thread.id).catch(() => undefined);
  });
  bb.onDispose(() => {
    unsubscribe();
    for (const timer of pending.values()) clearTimeout(timer);
  });
  return watch;
}
