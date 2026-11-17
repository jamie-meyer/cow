// The capability log: every creation, deletion and restoring of a
// capability, every notice acknowledged, every request cow allowed through a
// capability, every decision made through cow's page, every decision cow saw
// made somewhere else, and every capability a thread asked for. Entries are
// only ever appended. Pure: the hash function is passed in.
//
// Each entry carries its number and the hash of the entry before it, so an
// entry taken out of the middle, or changed, shows as a break. That is all
// the chain can show. It holds no secret: whoever can write cow's storage
// can rewrite the whole log with a chain that checks out, or cut entries off
// its end.

import { z } from "zod";

const what = z.string().max(2000);

const eventSchema = z.union([
  /** A capability was made. `summary` is its notice text: name, rule and who it applies to. */
  z.object({ kind: z.literal("created"), capabilityId: z.string(), name: z.string(), summary: what, via: z.string(), sourceThreadId: z.string().nullable() }),
  z.object({ kind: z.literal("deleted"), capabilityId: z.string(), name: z.string() }),
  /** A deleted capability was put back in force. */
  z.object({ kind: z.literal("restored"), capabilityId: z.string(), name: z.string(), summary: what }),
  /** A notice was acknowledged on the page. */
  z.object({ kind: z.literal("acknowledged"), noticeId: z.string(), capabilityId: z.string().nullable(), threadId: z.string().nullable(), summary: what }),
  /** cow answered a request "allow once" through a capability. `links`: whether symbolic links in the paths could be followed. */
  z.object({ kind: z.literal("auto-allowed"), threadId: z.string(), interactionId: z.string(), capabilityId: z.string(), name: z.string(), what, links: z.enum(["followed", "not-followed", "none"]) }),
  /** A request was decided through cow's page. cow cannot tell who pressed the keys. */
  z.object({ kind: z.literal("decided"), threadId: z.string(), interactionId: z.string(), decision: z.string(), what }),
  /** A request was decided, and cow did not do it: in bb's own view, or by another thread. */
  z.object({ kind: z.literal("outside"), threadId: z.string(), interactionId: z.string(), decision: z.string(), what }),
  /** A thread asked for a capability, with `bb cow cap request`. */
  z.object({ kind: z.literal("requested"), threadId: z.string(), askId: z.string(), what }),
]);
export type LogEvent = z.infer<typeof eventSchema>;

export const logEntrySchema = z.object({
  /** Its number, from 1, with no gaps. */
  seq: z.number().int().min(1),
  at: z.number(),
  /** The hash of the entry before it; empty for the first. */
  prev: z.string(),
  hash: z.string(),
  event: eventSchema,
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export type Hash = (text: string) => string;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** The hash of an entry: over its number, time, the hash before it, and what happened. */
export function entryHash(entry: Pick<LogEntry, "seq" | "at" | "prev" | "event">, hash: Hash): string {
  return hash(canonical({ seq: entry.seq, at: entry.at, prev: entry.prev, event: entry.event }));
}

/** The entry that follows `last` (null for the first). */
export function nextEntry(last: Pick<LogEntry, "seq" | "hash"> | null, event: LogEvent, at: number, hash: Hash): LogEntry {
  const base = { seq: (last?.seq ?? 0) + 1, at, prev: last?.hash ?? "", event };
  return { ...base, hash: entryHash(base, hash) };
}

export type ChainCheck =
  | { intact: true; entries: number }
  /** `at` is the number of the first entry that does not follow from the one before it. */
  | { intact: false; entries: number; at: number; why: string };

/**
 * Check entries that should be the whole log, in any order. `head` is the
 * number and hash the log was last known to end with, when that is known:
 * with it, entries cut off the end show too.
 */
export function checkChain(entries: readonly LogEntry[], hash: Hash, head?: { seq: number; hash: string } | null): ChainCheck {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let prev = "";
  let expected = 1;
  for (const entry of sorted) {
    if (entry.seq !== expected) return { intact: false, entries: sorted.length, at: expected, why: entry.seq < expected ? `two entries are numbered ${entry.seq}` : `entry ${expected} is missing` };
    if (entry.prev !== prev) return { intact: false, entries: sorted.length, at: entry.seq, why: `entry ${entry.seq} does not follow the entry before it` };
    if (entryHash(entry, hash) !== entry.hash) return { intact: false, entries: sorted.length, at: entry.seq, why: `entry ${entry.seq} was changed after it was written` };
    prev = entry.hash;
    expected += 1;
  }
  if (head && (head.seq !== sorted.length || head.hash !== prev)) {
    return { intact: false, entries: sorted.length, at: sorted.length + 1, why: head.seq > sorted.length ? `the log ended at entry ${head.seq}, and entries after ${sorted.length} are missing` : "the log's end does not match its record of it" };
  }
  return { intact: true, entries: sorted.length };
}

const DECISION_TEXT: Record<string, string> = { allow_once: "allowed once", allow_for_session: "allowed for the session", deny: "denied" };
export const decisionText = (decision: string): string => DECISION_TEXT[decision] ?? decision;

/** What an outside decision is called on a line and in the queue. */
export function outsideText(decision: string, text: string): string {
  const verb = decision === "deny" ? "denied" : decision === "allow_for_session" ? "approved for the session" : "approved";
  return `${verb} outside cow: ${text}`;
}
/** Where an outside decision was made, as far as cow can say. */
export const OUTSIDE_WHERE = "in bb's own view, or by another thread";

/** One entry as a sentence. `titleOf` names a thread. */
export function eventText(event: LogEvent, titleOf: (threadId: string) => string): string {
  const on = (threadId: string) => `“${titleOf(threadId)}”`;
  switch (event.kind) {
    case "created":
      return `${event.summary} · made ${event.via}${event.sourceThreadId ? `, on ${on(event.sourceThreadId)}` : ""}`;
    case "deleted":
      return `capability deleted: ${event.name}`;
    case "restored":
      return event.summary;
    case "acknowledged":
      return `acknowledged: ${event.summary}`;
    case "auto-allowed":
      return `allowed by ${event.name}: ${event.what} · on ${on(event.threadId)}${event.links === "not-followed" ? " · symbolic links could not be followed on its machine" : ""}`;
    case "decided":
      return `${decisionText(event.decision)} on cow's page: ${event.what} · on ${on(event.threadId)}`;
    case "outside":
      return `${outsideText(event.decision, event.what)} · on ${on(event.threadId)} · ${OUTSIDE_WHERE}`;
    case "requested":
      return `${on(event.threadId)} asked for a capability: ${event.what}`;
  }
}

/** The capability an entry is about, if it is about one. */
export function entryCapability(event: LogEvent): string | null {
  return "capabilityId" in event ? event.capabilityId : null;
}
