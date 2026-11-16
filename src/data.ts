// The data layer: fetches bb's threads, keeps them current from realtime
// events, and loads each watched thread's recent activity.

import type { useSdk } from "@get-bb/plugin-sdk/app";
import type { Activity, ThreadFacts } from "./state.ts";
import { permissionSummary } from "./permission.ts";
import { describeItem, firstLine } from "./text.ts";

type Sdk = ReturnType<typeof useSdk>;

const PAGE_SIZE = 200;
/** Stop paging here; a truncated list is reported, not hidden. */
const MAX_THREADS = 5000;
/** Realtime bursts are folded into one request per this window. */
const BATCH_MS = 150;
/** One thread's activity is refreshed at most this often. */
const ACTIVITY_MIN_INTERVAL_MS = 1500;
const ACTIVITY_CONCURRENCY = 4;

export interface Snapshot {
  status: "loading" | "ready" | "error";
  error: string | null;
  threads: readonly ThreadFacts[];
  activity: ReadonlyMap<string, Activity>;
  /** True when bb has more threads than this page reads. */
  truncated: boolean;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Read one thread from bb's response, trusting nothing about its shape. */
export function toFacts(raw: unknown): ThreadFacts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.projectId !== "string") return null;
  if (num(r.deletedAt) !== null) return null;
  const createdAt = num(r.createdAt) ?? 0;
  const title =
    (typeof r.title === "string" && r.title.trim()) ||
    (typeof r.titleFallback === "string" && r.titleFallback.trim()) ||
    r.id;
  return {
    id: r.id,
    projectId: r.projectId,
    title,
    parentThreadId: typeof r.parentThreadId === "string" ? r.parentThreadId : null,
    status: typeof r.status === "string" ? r.status : "idle",
    hasPendingInteraction: r.hasPendingInteraction === true,
    archivedAt: num(r.archivedAt),
    lastReadAt: num(r.lastReadAt),
    latestAttentionAt: num(r.latestAttentionAt) ?? createdAt,
    createdAt,
  };
}

interface EventRow {
  createdAt: number;
  type: string;
  data: Record<string, unknown>;
}

function toEvent(raw: unknown): EventRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const createdAt = num(r.createdAt);
  if (createdAt === null || typeof r.type !== "string") return null;
  const data = typeof r.data === "object" && r.data !== null ? r.data : {};
  return { createdAt, type: r.type, data: data as Record<string, unknown> };
}

/** The oldest pending question or permission request among a thread's interactions. */
export function toAsk(interactions: readonly unknown[]): Activity["ask"] {
  let oldest: Activity["ask"] = null;
  for (const raw of interactions) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.status !== "pending") continue;
    const at = num(r.createdAt) ?? 0;
    if (oldest && oldest.at <= at) continue;
    const payload = (typeof r.payload === "object" && r.payload !== null ? r.payload : {}) as Record<
      string,
      unknown
    >;
    const question = Array.isArray(payload.questions) ? payload.questions[0] : null;
    const prompt =
      typeof question === "object" && question !== null
        ? (question as Record<string, unknown>).prompt
        : null;
    const text = [prompt, payload.title, r.title].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
    oldest =
      payload.kind === "approval"
        ? { kind: "permission", text: permissionSummary(payload), at }
        : { kind: "question", text: firstLine(text) || "it is waiting for your input", at };
  }
  return oldest;
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class ThreadStore {
  private readonly sdk: Sdk;
  private readonly threads = new Map<string, ThreadFacts>();
  private readonly activity = new Map<string, Activity>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Snapshot = {
    status: "loading",
    error: null,
    threads: [],
    activity: new Map(),
    truncated: false,
  };
  private status: Snapshot["status"] = "loading";
  private error: string | null = null;
  private truncated = false;
  private stopped = false;
  private loadSeq = 0;

  private readonly changedIds = new Set<string>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  private watched = new Set<string>();
  /** Newest event seen live per thread, ahead of any fetch. */
  private readonly seenEventAt = new Map<string, number>();
  private readonly activityFetchedAt = new Map<string, number>();
  private readonly activityQueue: string[] = [];
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activityInFlight = 0;

  constructor(sdk: Sdk) {
    this.sdk = sdk;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  /** Load everything and follow changes. Returns the stop function. */
  start(): () => void {
    this.stopped = false;
    void this.reload();
    const stopThreads = this.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (typeof event.id !== "string") return;
        const changes: readonly string[] = event.changes ?? [];
        if (changes.includes("events-appended")) {
          this.seenEventAt.set(event.id, Date.now());
          this.requestActivity(event.id);
        }
        if (changes.some((change) => change !== "events-appended")) {
          this.changedIds.add(event.id);
          this.batchTimer ??= setTimeout(() => void this.flushChanged(), BATCH_MS);
        }
      },
    });
    const stopConnection = this.sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) void this.reload();
      },
    });
    return () => {
      this.stopped = true;
      stopThreads();
      stopConnection();
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = null;
      for (const timer of this.activityTimers.values()) clearTimeout(timer);
      this.activityTimers.clear();
      this.activityQueue.length = 0;
    };
  }

  /** Fetch the whole thread list again. */
  async reload(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.status === "error") {
      this.status = "loading";
      this.publish();
    }
    try {
      const all: ThreadFacts[] = [];
      let truncated = false;
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await this.sdk.threads.list({ limit: PAGE_SIZE, offset });
        for (const raw of page) {
          const facts = toFacts(raw);
          if (facts) all.push(facts);
        }
        if (page.length < PAGE_SIZE) break;
        if (offset + PAGE_SIZE >= MAX_THREADS) {
          truncated = true;
          break;
        }
      }
      if (this.stopped || seq !== this.loadSeq) return;
      this.threads.clear();
      for (const facts of all) this.threads.set(facts.id, facts);
      this.status = "ready";
      this.error = null;
      this.truncated = truncated;
    } catch (cause) {
      if (this.stopped || seq !== this.loadSeq) return;
      this.status = "error";
      this.error = errorText(cause);
    }
    this.publish();
  }

  /** Name the threads whose activity the page shows; others are not fetched. */
  watch(ids: readonly string[]): void {
    const before = this.watched;
    this.watched = new Set(ids);
    // Events for a thread nobody watched were skipped, so what is known about
    // a newly watched thread may be stale.
    for (const id of ids) if (!before.has(id)) this.requestActivity(id);
  }

  private publish(): void {
    this.snapshot = {
      status: this.status,
      error: this.error,
      threads: [...this.threads.values()],
      activity: new Map(this.activity),
      truncated: this.truncated,
    };
    for (const listener of this.listeners) listener();
  }

  private async flushChanged(): Promise<void> {
    this.batchTimer = null;
    const ids = [...this.changedIds].slice(0, PAGE_SIZE);
    for (const id of ids) this.changedIds.delete(id);
    if (this.changedIds.size > 0) {
      this.batchTimer = setTimeout(() => void this.flushChanged(), BATCH_MS);
    }
    try {
      const page = await this.sdk.threads.list({ threadIds: ids, limit: PAGE_SIZE });
      if (this.stopped) return;
      const found = new Set<string>();
      for (const raw of page) {
        const facts = toFacts(raw);
        if (!facts) continue;
        found.add(facts.id);
        this.threads.set(facts.id, facts);
        // What it asks is read from the facts just stored.
        this.requestActivity(facts.id);
      }
      // bb leaves deleted threads out of the answer.
      for (const id of ids) if (!found.has(id)) this.threads.delete(id);
      this.publish();
    } catch {
      // A missed update is repaired by the next change or reconnect; a full
      // reload reports the failure if bb is really unreachable.
      void this.reload();
    }
  }

  private requestActivity(id: string): void {
    if (!this.watched.has(id) || this.activityTimers.has(id)) return;
    const wait = Math.max(
      0,
      (this.activityFetchedAt.get(id) ?? 0) + ACTIVITY_MIN_INTERVAL_MS - Date.now(),
    );
    this.activityTimers.set(
      id,
      setTimeout(() => {
        this.activityTimers.delete(id);
        if (!this.activityQueue.includes(id)) this.activityQueue.push(id);
        this.pumpActivity();
      }, wait),
    );
  }

  private pumpActivity(): void {
    while (this.activityInFlight < ACTIVITY_CONCURRENCY && this.activityQueue.length > 0) {
      const id = this.activityQueue.shift()!;
      this.activityInFlight += 1;
      this.activityFetchedAt.set(id, Date.now());
      void this.fetchActivity(id)
        .then((activity) => {
          if (this.stopped) return;
          this.activity.set(id, activity);
          this.publish();
        })
        // Activity only enriches a line; without it the line still shows its
        // state, so a failed fetch is retried on the thread's next event.
        .catch(() => this.activityFetchedAt.delete(id))
        .finally(() => {
          this.activityInFlight -= 1;
          this.pumpActivity();
        });
    }
  }

  private async fetchActivity(threadId: string): Promise<Activity> {
    const latest = { threadId, limit: "1", order: "desc" } as const;
    const asking = this.threads.get(threadId)?.hasPendingInteraction === true;
    const [turns, items, output, interactions] = await Promise.all([
      this.sdk.threads.events.list({ ...latest, types: ["turn/started", "turn/completed"] }),
      this.sdk.threads.events.list({ ...latest, types: ["item/started", "item/completed"] }),
      this.sdk.threads.output({ threadId }),
      asking ? this.sdk.threads.interactions.list({ threadId }) : [],
    ]);
    const turn = toEvent(turns[0]);
    const item = toEvent(items[0]);
    const lastEventAt = Math.max(
      turn?.createdAt ?? 0,
      item?.createdAt ?? 0,
      this.seenEventAt.get(threadId) ?? 0,
    );
    return {
      lastEventAt: lastEventAt || null,
      turn: turn
        ? {
            phase: turn.type === "turn/started" ? "started" : "completed",
            at: turn.createdAt,
            failed: turn.type === "turn/completed" && turn.data.status === "failed",
          }
        : null,
      latestStep: describeItem(item?.data.item as Parameters<typeof describeItem>[0]),
      // bb reports no output while a turn runs; keep what it last said.
      output:
        (typeof output.output === "string" && output.output) ||
        (this.activity.get(threadId)?.output ?? ""),
      ask: toAsk(interactions),
    };
  }
}
