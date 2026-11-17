// The data layer: fetches bb's threads, keeps them current from realtime
// events, and loads each watched thread's recent activity.

import type { useSdk } from "@get-bb/plugin-sdk/app";
import { type ThreadReader, listThreads, readActivity, toFacts } from "./activity.ts";
import { type Activity, type ThreadFacts, isBusy } from "./state.ts";

type Sdk = ReturnType<typeof useSdk>;

const PAGE_SIZE = 200;
/** Realtime bursts are folded into one request per this window. */
const BATCH_MS = 150;
/** One thread's activity is refreshed at most this often. */
const ACTIVITY_MIN_INTERVAL_MS = 1500;
const ACTIVITY_CONCURRENCY = 4;
/** A thread that just stopped is shown as it was for at most this long while its events are read. */
const SETTLE_MS = 5000;

export interface Snapshot {
  status: "loading" | "ready" | "error";
  error: string | null;
  threads: readonly ThreadFacts[];
  activity: ReadonlyMap<string, Activity>;
  /** True when bb has more threads than this page reads. */
  truncated: boolean;
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
  /**
   * Threads bb says have just come to rest, whose events have not been read
   * since. Until they are, what the turn came to is not known, so the page
   * keeps showing the thread as running instead of as whatever its older
   * events say. The facts held back are applied when the read finishes.
   */
  private readonly settling = new Map<string, { facts: ThreadFacts; since: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(sdk: Sdk) {
    this.sdk = sdk;
  }

  private get reader(): ThreadReader {
    return this.sdk.threads;
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
      for (const held of this.settling.values()) clearTimeout(held.timer);
      this.settling.clear();
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
      const { threads: all, truncated } = await listThreads(this.reader);
      if (this.stopped || seq !== this.loadSeq) return;
      this.threads.clear();
      for (const held of this.settling.values()) clearTimeout(held.timer);
      this.settling.clear();
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
        this.store(facts);
        // What it asks is read from the facts just stored.
        this.requestActivity(facts.id);
      }
      // bb leaves deleted threads out of the answer.
      for (const id of ids) {
        if (found.has(id)) continue;
        this.release(id, false);
        this.threads.delete(id);
      }
      this.publish();
    } catch {
      // A missed update is repaired by the next change or reconnect; a full
      // reload reports the failure if bb is really unreachable.
      void this.reload();
    }
  }

  /** Take a thread's new facts; one that has just stopped keeps its running status until its events are read. */
  private store(facts: ThreadFacts): void {
    const before = this.threads.get(facts.id);
    const held = this.settling.get(facts.id);
    const stopped = !isBusy(facts) && facts.status !== "error" && facts.archivedAt === null;
    if (held) {
      // Still being read: the newer facts wait in place of the older, or it is running again.
      if (stopped) {
        held.facts = facts;
        return;
      }
      this.release(facts.id, false);
    } else if (before && isBusy(before) && stopped && this.watched.has(facts.id)) {
      const timer = setTimeout(() => this.release(facts.id, true), SETTLE_MS);
      this.settling.set(facts.id, { facts, since: Date.now(), timer });
      this.threads.set(facts.id, { ...facts, status: before.status });
      this.requestActivity(facts.id, true);
      return;
    }
    this.threads.set(facts.id, facts);
  }

  /** Stop holding a thread's facts back; with `apply`, show them. */
  private release(id: string, apply: boolean): void {
    const held = this.settling.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    this.settling.delete(id);
    if (!apply || !this.threads.has(id)) return;
    this.threads.set(id, held.facts);
    this.publish();
  }

  private requestActivity(id: string, now = false): void {
    if (!this.watched.has(id)) return;
    if (now) {
      const pending = this.activityTimers.get(id);
      if (pending) clearTimeout(pending);
      this.activityTimers.delete(id);
    } else if (this.activityTimers.has(id)) return;
    const wait = now ? 0 : Math.max(
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
      const startedAt = Date.now();
      this.activityFetchedAt.set(id, startedAt);
      void this.fetchActivity(id)
        .then((activity) => {
          if (this.stopped) return;
          this.activity.set(id, activity);
          // Its events were read after it stopped: what its turn came to is known now.
          const held = this.settling.get(id);
          if (held && startedAt >= held.since) {
            clearTimeout(held.timer);
            this.settling.delete(id);
            if (this.threads.has(id)) this.threads.set(id, held.facts);
          } else if (held) this.requestActivity(id, true);
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

  private fetchActivity(threadId: string): Promise<Activity> {
    return readActivity(this.reader, threadId, {
      asking: this.threads.get(threadId)?.hasPendingInteraction === true,
      seenEventAt: this.seenEventAt.get(threadId),
      previousOutput: this.activity.get(threadId)?.output,
    });
  }
}
