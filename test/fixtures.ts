import type { Activity, ThreadFacts } from "../src/state.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** A fixed "now" so every test is deterministic. */
export const NOW = 1_800_000_000_000;

let created = 0;

/** A finished, read thread created a day ago, with any fields overridden. */
export function thread(overrides: Partial<ThreadFacts> & { id: string }): ThreadFacts {
  created += 1;
  return {
    projectId: "proj_test",
    title: overrides.id,
    parentThreadId: null,
    status: "idle",
    hasPendingInteraction: false,
    archivedAt: null,
    lastReadAt: NOW - HOUR,
    latestAttentionAt: NOW - 2 * HOUR,
    createdAt: NOW - DAY + created,
    ...overrides,
  };
}

export function activity(overrides: Partial<Activity> = {}): Activity {
  return { lastEventAt: null, turn: null, latestStep: "", output: "", ask: null, ...overrides };
}
