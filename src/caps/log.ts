// The capability log (named for capabilities, it holds more): every
// creation, deletion and restoring of a capability, every notice acknowledged, every request cow allowed through a
// capability, every decision made through cow's page, every decision cow saw
// made somewhere else, every capability a thread asked for, and everything
// else the person did on the page that is signed: a message sent, an ask
// answered, a reply marked as seen, a refusal dismissed, a brief read, a key
// enrolled; and every trace of an agent taking something out of the
// person's queue (see traces.ts). Entries are only ever appended. Pure: the hash function is passed in.
//
// Each entry carries its number and the hash of the entry before it, so an
// entry taken out of the middle, or changed, shows as a break. That is all
// the chain can show. It holds no secret: whoever can write cow's storage
// can rewrite the whole log with a chain that checks out, or cut entries off
// its end.

import { z } from "zod";
import { canonical } from "../signing/canonical.ts";
import { OUTSIDE_WHERE } from "../state.ts";
import { TRACE_ACTIONS } from "../traces.ts";
import { VIA_TEXT, type Via } from "./cap.ts";

const what = z.string().max(2000);
/** The thread a capability names: what says whose tree an entry belongs to. Entries written before this was kept have none. */
const scopeThread = z.string().nullable().default(null);

const eventSchema = z.union([
  /** A capability was made. `summary` is its notice text: name, rule and who it applies to. */
  z.object({ kind: z.literal("created"), capabilityId: z.string(), name: z.string(), summary: what, via: z.string(), sourceThreadId: z.string().nullable(), scopeThreadId: scopeThread }),
  z.object({ kind: z.literal("deleted"), capabilityId: z.string(), name: z.string(), scopeThreadId: scopeThread }),
  /** A deleted capability was put back in force. */
  z.object({ kind: z.literal("restored"), capabilityId: z.string(), name: z.string(), summary: what, scopeThreadId: scopeThread }),
  /** A notice was acknowledged on the page. `scopeThreadId`: for a capability's notice, the thread the capability names. */
  z.object({ kind: z.literal("acknowledged"), noticeId: z.string(), capabilityId: z.string().nullable(), threadId: z.string().nullable(), summary: what, scopeThreadId: scopeThread }),
  /** cow answered a request "allow once" through a capability. `links`: whether symbolic links in the paths could be followed. */
  z.object({ kind: z.literal("auto-allowed"), threadId: z.string(), interactionId: z.string(), capabilityId: z.string(), name: z.string(), what, links: z.enum(["followed", "not-followed", "none"]) }),
  /** A request was decided through cow's page. cow cannot tell who pressed the keys. */
  z.object({ kind: z.literal("decided"), threadId: z.string(), interactionId: z.string(), decision: z.string(), what }),
  /** A request was decided, and cow did not do it: in bb's own view, or by another thread. */
  z.object({ kind: z.literal("outside"), threadId: z.string(), interactionId: z.string(), decision: z.string(), what }),
  /** A thread asked for a capability, with `bb cow cap request`. */
  z.object({ kind: z.literal("requested"), threadId: z.string(), askId: z.string(), what }),
  /** A message was sent to a thread as the person, from cow's page. */
  z.object({ kind: z.literal("sent"), threadId: z.string(), what }),
  /** An ask was answered on cow's page, or closed there as already answered in chat. */
  z.object({ kind: z.literal("ask-answered"), threadId: z.string(), askId: z.string(), what }),
  z.object({ kind: z.literal("ask-closed"), threadId: z.string(), askId: z.string() }),
  /** A thread's reply was marked as seen on cow's page, up to `seq` in its event log; null: the mark was taken back. */
  z.object({ kind: z.literal("seen"), threadId: z.string(), seq: z.number().nullable() }),
  /** What bb refused a thread was dismissed on cow's page, up to `throughSeq` in its event log; null: it is shown again. */
  z.object({ kind: z.literal("refusals-dismissed"), threadId: z.string(), throughSeq: z.number().nullable() }),
  /** A version of a thread's brief was marked as read on cow's page, by opening it; `read` false: it waits again. */
  z.object({ kind: z.literal("brief-read"), threadId: z.string(), version: z.number(), read: z.boolean() }),
  /** A thread was recorded as its project's Main, where a new window starts; a null thread: the record was forgotten. */
  z.object({ kind: z.literal("main-chosen"), projectId: z.string(), threadId: z.string().nullable() }),
  /** One of bb's automations was deleted from cow's page, through the automations plugin. `name` is what the confirmation named. */
  z.object({ kind: z.literal("automation-deleted"), projectId: z.string(), automationId: z.string(), name: z.string() }),
  /** What a finished worker came to was judged on cow's page, for the ledger. */
  z.object({ kind: z.literal("outcome-set"), threadId: z.string(), outcome: z.string() }),
  /** A page's key was enrolled: the first one by itself, any later one by a page already enrolled. */
  z.object({ kind: z.literal("key-enrolled"), fingerprint: z.string(), how: z.enum(["first", "approved"]), label: z.string() }),
  /** A page asked for its key to be enrolled. Anyone can ask; only an enrolled page can approve. */
  z.object({ kind: z.literal("key-requested"), fingerprint: z.string(), label: z.string() }),
  z.object({ kind: z.literal("key-refused"), fingerprint: z.string() }),
  z.object({ kind: z.literal("key-removed"), fingerprint: z.string() }),
  /** Every enrolled key was cleared, because the reset file was found. `keys`: how many. */
  z.object({ kind: z.literal("enrollment-reset"), keys: z.number() }),
  /**
   * An agent took something out of the person's queue: parked a thread that
   * waited on them, withdrew an ask, or closed one as answered in chat when
   * they had not written since. `what` is the notice's sentence.
   */
  z.object({ kind: z.literal("trace"), action: z.enum(TRACE_ACTIONS), actorThreadId: z.string(), threadId: z.string(), askId: z.string().nullable(), what }),
]);
export type LogEvent = z.infer<typeof eventSchema>;

export const logEntrySchema = z.object({
  /** Its number, from 1, with no gaps. */
  seq: z.number().int().min(1),
  at: z.number(),
  /** The hash of the entry before it; empty for the first. */
  prev: z.string(),
  hash: z.string(),
  /**
   * The fingerprint of the key that signed the call this entry records; null
   * for what cow did by itself or saw (an allowance through a capability, a
   * decision made outside cow, a thread's request, a reset).
   */
  by: z.string().nullable().default(null),
  event: eventSchema,
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export type Hash = (text: string) => string;

/** The hash of an entry: over its number, time, the hash before it, and what happened. */
export function entryHash(entry: Pick<LogEntry, "seq" | "at" | "prev" | "event" | "by">, hash: Hash): string {
  return hash(canonical({ seq: entry.seq, at: entry.at, prev: entry.prev, by: entry.by, event: entry.event }));
}

/** The entry that follows `last` (null for the first). `by`: the key that signed the call it records. */
export function nextEntry(last: Pick<LogEntry, "seq" | "hash"> | null, event: LogEvent, at: number, hash: Hash, by: string | null = null): LogEntry {
  const base = { seq: (last?.seq ?? 0) + 1, at, prev: last?.hash ?? "", by, event };
  return { ...base, hash: entryHash(base, hash) };
}

/** What an entry needs a signature for: these kinds are written only for a call a key signed. */
export const SIGNED_KINDS: readonly LogEvent["kind"][] = ["created", "deleted", "restored", "acknowledged", "decided", "sent", "ask-answered", "ask-closed", "seen", "refusals-dismissed", "brief-read", "main-chosen", "automation-deleted", "outcome-set", "key-refused", "key-removed"];

/**
 * The marks: light things the page signs many times a day, often as a side
 * effect of opening a chat or a brief. They are entries like any other; a
 * listing counts its length in the other entries, so that marks never push
 * a capability, a decision or a key out of what is read.
 */
export const MARK_KINDS: readonly LogEvent["kind"][] = ["seen", "refusals-dismissed", "brief-read", "main-chosen"];

/**
 * The newest `limit` entries that are not marks, with the marks made since
 * the oldest of them (the newest `limit` of those at most), newest first.
 */
export function newestEntries(entries: readonly LogEntry[], limit: number): LogEntry[] {
  const isMark = (entry: LogEntry) => MARK_KINDS.includes(entry.event.kind);
  const rest = entries.filter((entry) => !isMark(entry)).slice(-limit);
  const marks = entries.filter(isMark);
  // With fewer entries than the limit, every mark is recent enough.
  const since = rest.length < limit ? 0 : (rest[0]?.seq ?? 0);
  return [...rest, ...marks.filter((entry) => entry.seq > since).slice(-limit)].sort((a, b) => b.seq - a.seq);
}

/** The thread whose tree an entry belongs to, or null when it belongs to none (a key, a reset). */
export function entryThread(event: LogEvent): string | null {
  if ("threadId" in event && event.threadId) return event.threadId;
  if ("scopeThreadId" in event && event.scopeThreadId) return event.scopeThreadId;
  if ("sourceThreadId" in event && event.sourceThreadId) return event.sourceThreadId;
  return null;
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
export { OUTSIDE_WHERE };

/** One entry as a sentence. `titleOf` names a thread. */
export function eventText(event: LogEvent, titleOf: (threadId: string) => string): string {
  const on = (threadId: string) => `“${titleOf(threadId)}”`;
  switch (event.kind) {
    case "created":
      return `${event.summary} · made ${VIA_TEXT[event.via as Via] ?? event.via}${event.sourceThreadId ? `, on ${on(event.sourceThreadId)}` : ""}`;
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
    case "sent":
      return `sent as you to ${on(event.threadId)}: ${event.what}`;
    case "ask-answered":
      return `answered an ask of ${on(event.threadId)}: ${event.what}`;
    case "ask-closed":
      return `closed an ask of ${on(event.threadId)} as already answered in chat`;
    case "seen":
      return event.seq === null ? `took back marking a reply of ${on(event.threadId)} as seen: it waits again` : `marked a reply of ${on(event.threadId)} as seen: it no longer waits`;
    case "refusals-dismissed":
      return event.throughSeq === null ? `showed again what bb refused ${on(event.threadId)}: it reads as blocked again` : `dismissed what bb refused ${on(event.threadId)}: it no longer reads as blocked`;
    case "brief-read":
      return event.read ? `opened the brief of ${on(event.threadId)}, version ${event.version}: it no longer waits` : `marked the brief of ${on(event.threadId)}, version ${event.version}, as not read: it waits again`;
    case "main-chosen":
      return event.threadId === null ? "forgot which thread is Main for a project: a new window asks" : `chose ${on(event.threadId)} as Main: a new window starts there`;
    case "automation-deleted":
      return `deleted the automation “${event.name}” (${event.automationId}); its past run threads stay`;
    case "outcome-set":
      return `judged what ${on(event.threadId)} came to: ${event.outcome}`;
    case "key-enrolled":
      return event.how === "first" ? `key ${event.fingerprint} enrolled by first use: ${event.label}` : `key ${event.fingerprint} enrolled, approved from an enrolled page: ${event.label}`;
    case "key-requested":
      return `a page asked for its key ${event.fingerprint} to be enrolled: ${event.label}`;
    case "key-refused":
      return `key ${event.fingerprint} was refused`;
    case "key-removed":
      return `key ${event.fingerprint} was removed`;
    case "trace":
      return event.what;
    case "enrollment-reset":
      return `enrollment was reset from the reset file: ${event.keys} ${event.keys === 1 ? "key" : "keys"} cleared`;
  }
}

/** The capability an entry is about, if it is about one. */
export function entryCapability(event: LogEvent): string | null {
  return "capabilityId" in event ? event.capabilityId : null;
}
