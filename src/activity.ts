// Reading bb's threads: one thread's facts, and what its event log adds to
// them. The page and the backend both read through here, so a line on the
// page and a line from the CLI are derived from the same things.

import { findReplies } from "./attention.ts";
import { permissionSummary } from "./permission.ts";
import { findRefusals } from "./refusal.ts";
import type { Activity, ThreadFacts } from "./state.ts";
import { describeItem, firstLine } from "./text.ts";

/** bb returns at most this many events per request. */
const EVENT_PAGE = "100";
/** How many turn starts and ends are read to tell whose the latest replies are. */
const TURN_PAGE = "40";
const PAGE_SIZE = 200;
/** Stop paging here; a truncated list is reported, not hidden. */
export const MAX_THREADS = 5000;

type EventTypes = readonly [string, ...string[]];

/** The part of bb's SDK this reads; the page's SDK and the backend's both fit. */
export interface ThreadReader {
  list(args: { limit: number; offset?: number; threadIds?: string[] }): Promise<readonly unknown[]>;
  events: {
    // The SDK names its event types; any of them is a string.
    list(args: { threadId: string; limit: string; order: "desc"; types: never }): Promise<readonly unknown[]>;
  };
  output(args: { threadId: string }): Promise<{ output?: unknown }>;
  interactions: { list(args: { threadId: string }): Promise<readonly unknown[]> };
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

/** Every thread bb has, up to MAX_THREADS. */
export async function listThreads(reader: ThreadReader): Promise<{ threads: ThreadFacts[]; truncated: boolean }> {
  const threads: ThreadFacts[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await reader.list({ limit: PAGE_SIZE, offset });
    for (const raw of page) {
      const facts = toFacts(raw);
      if (facts) threads.push(facts);
    }
    if (page.length < PAGE_SIZE) return { threads, truncated: false };
    if (offset + PAGE_SIZE >= MAX_THREADS) return { threads, truncated: true };
  }
}

export interface ActivityHints {
  /** bb says the thread has a pending interaction: read what it asks. */
  asking: boolean;
  /** The newest event seen live, ahead of this read. */
  seenEventAt?: number;
  /** What it last said; bb reports no output while a turn runs. */
  previousOutput?: string;
}

/** What one thread's event log adds to its facts. */
export async function readActivity(reader: ThreadReader, threadId: string, hints: ActivityHints): Promise<Activity> {
  const events = (types: EventTypes, limit: string) =>
    reader.events.list({ threadId, limit, order: "desc", types: types as never });
  const [turns, items, recent, output, interactions] = await Promise.all([
    events(["client/turn/requested", "turn/started", "turn/completed"], TURN_PAGE),
    events(["item/started", "item/completed"], "1"),
    // Refusals are read from the thread's latest turn; this many events back
    // is as far as one request reaches.
    events(["client/turn/requested", "turn/started", "item/completed"], EVENT_PAGE),
    reader.output({ threadId }),
    hints.asking ? reader.interactions.list({ threadId }) : [],
  ]);
  // Newest first: the first turn boundary is the latest.
  const turn = turns.map(toEvent).find((event) => event !== null && event.type !== "client/turn/requested") ?? null;
  const item = toEvent(items[0]);
  const lastEventAt = Math.max(turn?.createdAt ?? 0, item?.createdAt ?? 0, hints.seenEventAt ?? 0);
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
    output: (typeof output.output === "string" && output.output) || (hints.previousOutput ?? ""),
    ask: toAsk(interactions),
    refusals: findRefusals(recent),
    replies: findReplies(turns),
  };
}
