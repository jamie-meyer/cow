// How far a running worker has gone, from bb's events: its tool calls, its
// turns, its last event, what is in progress, and the identity of its last
// few calls. Then the caps (one setting, keyed by label) and the stuck checks
// read against it. Pure: reading the events and keeping the record is in
// progress-store.ts, the checks on a timer and the notices in watch-backend.ts.
//
// What is kept holds no message text, no file contents and no whole command:
// a call's identity is its kind, a hash of what it ran (the command, or the
// tool with its arguments, or the paths), and a label clipped to
// CALL_LABEL_CHARS: the first line of a command, or the tool's name alone.
//
// Nothing here acts on a thread: a mark on its line and a notice in the
// person's queue are all cow does about it.

import { LABEL_PATTERN } from "./ledger.ts";
import { dollarText } from "./prices.ts";
import { type LiveReading, settled } from "./live-usage.ts";

/** Realtime channel: published whenever a mark or a watch notice changes. */
export const WATCH_CHANGED = "cow-watch";

/** The event types the progress record is read from. Usage updates come once per model call: they say the turn is alive. */
export const PROGRESS_EVENT_TYPES = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
] as const;

/**
 * Items that are no tool call: what the agent says, thinks or plans, and what
 * it is told; and a background task, which is a command already counted,
 * moved to the background.
 */
const NOT_CALLS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "planSteps", "contextCompaction", "backgroundTask"]);
/** A call's label is clipped to this many characters. */
export const CALL_LABEL_CHARS = 60;
/** The last calls kept. */
export const RECENT_CALLS = 5;
/** Items in progress kept at once; more than this is not usual. */
const MAX_OPEN = 8;
/** Ids of calls counted, kept to tell a completed call already counted from one bb gave no start for. */
const MAX_COUNTED_IDS = 20;

export interface Call {
  /** bb's item id. */
  id: string;
  /** bb's item type: commandExecution, fileChange, toolCall, mcpToolCall and the like. */
  kind: string;
  /** Clipped: a command's first line, or a tool's name. Never arguments, contents or message text. */
  label: string;
  /** Of the whole identity: the full command, or the tool with its arguments, or the paths. */
  hash: string;
}

export interface Progress {
  /** The last event read. */
  lastSeq: number | null;
  /** Items that are not reasoning or messages, so far. */
  toolCalls: number;
  /** When its first turn started; the minutes cap counts from here. */
  firstTurnAt: number | null;
  /** When its current turn started; null when no turn is running. */
  turnStartedAt: number | null;
  /** The lengths of its finished turns, summed. */
  workingMs: number;
  turns: number;
  lastEventAt: number | null;
  /** Items in progress, oldest first: kind and since when. */
  open: { id: string; kind: string; label: string; since: number }[];
  lastFileChangeAt: number | null;
  /** The last few calls, oldest first. */
  recent: Call[];
  /** How many calls in a row, ending with the latest, have the latest one's identity. */
  repeat: number;
  /** Ids of the last calls counted. */
  counted: string[];
  /** Claude Code's session id, from the latest event that gave one. */
  session?: string | null;
  /** When bb's latest usage event came: what it counted ends there. */
  usageAt?: number | null;
  /** Tokens so far in the running turn, read from the provider's transcript (the liveUsage setting); absent with it off. */
  live?: LiveReading | null;
}

export const NO_PROGRESS: Progress = {
  lastSeq: null,
  toolCalls: 0,
  firstTurnAt: null,
  turnStartedAt: null,
  workingMs: 0,
  turns: 0,
  lastEventAt: null,
  open: [],
  lastFileChangeAt: null,
  recent: [],
  repeat: 0,
  counted: [],
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** FNV-1a, twice over with two seeds: 16 hex digits. Enough to tell calls apart; it is no secret. */
export function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const clip = (text: string): string => {
  const line = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > CALL_LABEL_CHARS ? `${line.slice(0, CALL_LABEL_CHARS - 1)}…` : line;
};

/** Stable JSON: keys sorted, so the same arguments hash the same. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const r = record(value);
  if (r) return `{${Object.keys(r).sort().map((key) => `${JSON.stringify(key)}:${stable(r[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

/** A call's identity from bb's item: what is kept of it. */
export function callOf(item: Record<string, unknown>): Call | null {
  const kind = str(item.type);
  const id = str(item.id);
  if (kind === null || id === null || NOT_CALLS.has(kind)) return null;
  let label: string = kind;
  let whole: string = kind;
  if (kind === "commandExecution") {
    const command = str(item.command) ?? "";
    label = clip(command) || kind;
    whole = `${kind}\n${command}`;
  } else if (kind === "toolCall" || kind === "mcpToolCall") {
    const tool = str(item.tool) ?? str(item.name) ?? "tool";
    const server = str(item.server);
    label = clip(server ? `${server}.${tool}` : tool);
    whole = `${kind}\n${server ?? ""}\n${tool}\n${stable(item.arguments ?? null)}`;
  } else if (kind === "fileChange") {
    const paths = (Array.isArray(item.changes) ? item.changes : []).map((change) => str(record(change)?.path) ?? "").sort();
    label = `${paths.length} ${paths.length === 1 ? "file" : "files"}`;
    whole = `${kind}\n${paths.join("\n")}`;
  } else {
    // fileRead, search, webSearch, webFetch and the rest: the kind, and a hash of what it names.
    const named = [item.path, item.pattern, item.url, item.queries, item.query].filter((part) => part !== undefined);
    whole = `${kind}\n${stable(named)}`;
  }
  return { id, kind, label, hash: hashText(whole) };
}

/** Fold events, in any order, into the record. Events at or before `lastSeq` are skipped. */
export function foldProgress(before: Progress, events: readonly unknown[]): Progress {
  const log: { seq: number; at: number; type: string; data: Record<string, unknown> }[] = [];
  for (const raw of events) {
    const r = record(raw);
    if (!r || typeof r.seq !== "number" || typeof r.type !== "string") continue;
    if (before.lastSeq !== null && r.seq <= before.lastSeq) continue;
    log.push({ seq: r.seq, at: typeof r.createdAt === "number" ? r.createdAt : 0, type: r.type, data: record(r.data) ?? {} });
  }
  if (log.length === 0) return before;
  log.sort((a, b) => a.seq - b.seq);
  const p: Progress = { ...before, open: [...before.open], recent: [...before.recent], counted: [...before.counted] };
  const count = (call: Call) => {
    p.toolCalls += 1;
    const last = p.recent[p.recent.length - 1];
    p.repeat = last !== undefined && last.hash === call.hash ? p.repeat + 1 : 1;
    p.recent = [...p.recent, call].slice(-RECENT_CALLS);
    p.counted = [...p.counted, call.id].slice(-MAX_COUNTED_IDS);
  };
  for (const event of log) {
    p.lastSeq = event.seq;
    const session = str(event.data.providerThreadId);
    if (session !== null && session !== "") p.session = session;
    if (event.at > 0) p.lastEventAt = Math.max(p.lastEventAt ?? 0, event.at);
    if (event.type === "turn/started") {
      p.turns += 1;
      p.turnStartedAt = event.at;
      if (p.firstTurnAt === null) p.firstTurnAt = event.at;
      p.open = [];
      if (p.live) p.live = settled(p.live, event.at);
    } else if (event.type === "turn/completed") {
      if (p.turnStartedAt !== null) p.workingMs += Math.max(0, event.at - p.turnStartedAt);
      p.turnStartedAt = null;
      p.open = [];
      // bb's figure has the turn now: the reading is dropped.
      if (p.live) p.live = settled(p.live, null);
    } else if (event.type === "thread/tokenUsage/updated") {
      p.usageAt = event.at;
      if (p.live) p.live = settled(p.live, p.turnStartedAt === null ? null : event.at);
    } else if (event.type === "item/started" || event.type === "item/completed") {
      const item = record(event.data.item);
      const id = str(item?.id);
      if (!item || id === null) continue;
      const call = callOf(item);
      if (item.type === "fileChange" && event.type === "item/completed") p.lastFileChangeAt = event.at;
      if (event.type === "item/started") {
        if (call && !p.counted.includes(id)) count(call);
        if (!p.open.some((open) => open.id === id)) p.open = [...p.open, { id, kind: str(item.type) ?? "item", label: call?.label ?? str(item.type) ?? "item", since: event.at }].slice(-MAX_OPEN);
      } else {
        // A call bb gave no start for is counted when it completes.
        if (call && !p.counted.includes(id)) count(call);
        p.open = p.open.filter((open) => open.id !== id);
      }
    }
  }
  return p;
}

/** The working minutes of a record: its finished turns, and the running one up to `now` when given. */
export function workingMinutes(p: Progress, now?: number): number {
  const running = now !== undefined && p.turnStartedAt !== null ? Math.max(0, now - p.turnStartedAt) : 0;
  return Math.round((p.workingMs + running) / 6000) / 10;
}

// ---- Caps -------------------------------------------------------------------

export const CAP_KEYS = ["toolCalls", "minutes", "dollars"] as const;
export type CapKey = (typeof CAP_KEYS)[number];
export type Cap = Partial<Record<CapKey, number>>;
/** Label to its cap; `*` for workers of any other label, or none. */
export type Caps = Record<string, Cap>;
export const ANY_LABEL = "*";

/**
 * The caps setting: JSON keyed by label, with `*` for any other label or
 * none, each entry any of toolCalls (a whole number), minutes and dollars
 * (numbers), all above zero. Empty is no caps. Anything else is an error,
 * said, and then no cap at all applies: never some of them.
 */
export function capsOf(value: string | undefined): { caps: Caps; error: string | null } {
  const raw = (value ?? "").trim();
  if (raw === "") return { caps: {}, error: null };
  const bad = (why: string) => ({ caps: {}, error: `the caps setting is not applied: ${why}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad("it is not JSON");
  }
  const top = record(parsed);
  if (!top) return bad('it must be a JSON object keyed by label, such as {"lookup": {"toolCalls": 40}, "*": {"minutes": 90}}');
  const caps: Caps = {};
  for (const [label, entry] of Object.entries(top)) {
    if (label !== ANY_LABEL && !LABEL_PATTERN.test(label)) return bad(`"${label.slice(0, 40)}" is not a label or *`);
    const fields = record(entry);
    if (!fields || Object.keys(fields).length === 0) return bad(`the entry for "${label}" must be an object with any of ${CAP_KEYS.join(", ")}`);
    const cap: Cap = {};
    for (const [key, n] of Object.entries(fields)) {
      if (!(CAP_KEYS as readonly string[]).includes(key)) return bad(`"${key.slice(0, 40)}" in "${label}" is none of ${CAP_KEYS.join(", ")}`);
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || (key === "toolCalls" && !Number.isInteger(n))) return bad(`${key} in "${label}" must be a number above zero${key === "toolCalls" ? ", whole" : ""}`);
      cap[key as CapKey] = n;
    }
    caps[label] = cap;
  }
  return { caps, error: null };
}

/** The cap for a worker of this label: its own entry, or `*`'s, or none. */
export const capFor = (caps: Caps, label: string | null): Cap | null => (label !== null && caps[label] ? caps[label] : caps[ANY_LABEL]) ?? null;

// ---- What is shown ----------------------------------------------------------

export type WatchReason = "cap-toolCalls" | "cap-minutes" | "cap-dollars" | "repeat" | "quiet" | "long-item";
export const WATCH_REASONS: readonly WatchReason[] = ["cap-toolCalls", "cap-minutes", "cap-dollars", "repeat", "quiet", "long-item"];

export interface StuckSettings {
  /** The same call this many times in a row; 0: off. */
  repeats: number;
  /** A running turn with no event and nothing in progress this many minutes; 0: off. */
  quietMinutes: number;
  /** One item in progress this many minutes; 0: off. */
  longItemMinutes: number;
}
export const DEFAULT_STUCK: StuckSettings = { repeats: 3, quietMinutes: 15, longItemMinutes: 45 };

/** What a worker is over or caught by, with the mark's words. */
export interface Finding {
  reason: WatchReason;
  /** On its line: "over cap: 512 of 400 tool calls", "the same command 4 times", "quiet 22m". */
  mark: string;
  /** The facts behind it, for the notice and `--json`. */
  facts: Record<string, string | number | null>;
}

export const DOLLARS_NOTE = "list price, known only once a turn has ended";
/** With the liveUsage setting on, for a worker whose turn runs on Claude Code. */
export const LIVE_DOLLARS_NOTE = "list price, the running turn read from Claude Code's transcript";

const KIND_NOUN: Record<string, string> = { commandExecution: "command", fileChange: "file change", toolCall: "tool call", mcpToolCall: "tool call", fileRead: "file read", search: "search", webSearch: "web search", webFetch: "web fetch" };
const nounOf = (kind: string) => KIND_NOUN[kind] ?? `${kind} call`;

/** Minutes as the marks give them: "22m", "1h 5m". */
export function spanText(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
}

const minutesSince = (from: number | null, now: number) => (from === null ? null : Math.floor(Math.max(0, now - from) / 60_000));

export interface WorkerNow {
  progress: Progress;
  label: string | null;
  /** List-price dollars of its usage so far; null when not known yet (no turn ended) or no price. */
  dollars: number | null;
  /** bb says its turn is running. */
  running: boolean;
  /** `dollars` includes the running turn, read from the provider's transcript. */
  live?: boolean;
}

/**
 * What a worker is over and caught by now. Caps apply whether its turn runs
 * or not; the stuck checks only while it runs. A cap is gone over, never
 * reached: a cap of 2 tool calls is over at 3.
 */
export function findings(w: WorkerNow, caps: Caps, stuck: StuckSettings, now: number): Finding[] {
  const out: Finding[] = [];
  const p = w.progress;
  const cap = capFor(caps, w.label);
  const elapsed = minutesSince(p.firstTurnAt, now);
  const base = { toolCalls: p.toolCalls, minutesSinceFirstTurn: elapsed, label: w.label };
  if (cap?.toolCalls !== undefined && p.toolCalls > cap.toolCalls) {
    out.push({ reason: "cap-toolCalls", mark: `over cap: ${p.toolCalls} of ${cap.toolCalls} tool calls`, facts: { ...base, cap: cap.toolCalls } });
  }
  if (cap?.minutes !== undefined && elapsed !== null && elapsed > cap.minutes) {
    out.push({ reason: "cap-minutes", mark: `over cap: ${elapsed} of ${cap.minutes} minutes`, facts: { ...base, cap: cap.minutes } });
  }
  if (cap?.dollars !== undefined && w.dollars !== null && w.dollars > cap.dollars) {
    out.push({
      reason: "cap-dollars",
      mark: `over cap: ${dollarText(w.dollars)} of ${dollarText(cap.dollars)} (${w.live ? LIVE_DOLLARS_NOTE : DOLLARS_NOTE})`,
      facts: { ...base, dollars: Math.round(w.dollars * 10000) / 10000, cap: cap.dollars, source: w.live ? "transcript" : "bb" },
    });
  }
  if (!w.running) return out;
  const last = p.recent[p.recent.length - 1];
  if (stuck.repeats > 0 && last !== undefined && p.repeat >= stuck.repeats) {
    out.push({ reason: "repeat", mark: `the same ${nounOf(last.kind)} ${p.repeat} times`, facts: { ...base, times: p.repeat, kind: last.kind, call: last.label } });
  }
  if (stuck.quietMinutes > 0 && p.open.length === 0 && p.lastEventAt !== null && now - p.lastEventAt >= stuck.quietMinutes * 60_000) {
    out.push({ reason: "quiet", mark: `quiet ${spanText(now - p.lastEventAt)}`, facts: { ...base, lastEventAt: p.lastEventAt, quietMinutes: minutesSince(p.lastEventAt, now) } });
  }
  const oldest = p.open[0];
  if (stuck.longItemMinutes > 0 && oldest !== undefined && now - oldest.since >= stuck.longItemMinutes * 60_000) {
    out.push({ reason: "long-item", mark: `one ${nounOf(oldest.kind)} in progress ${spanText(now - oldest.since)}`, facts: { ...base, kind: oldest.kind, call: oldest.label, since: oldest.since, minutes: minutesSince(oldest.since, now) } });
  }
  return out;
}

/** The notice's sentence: the worker, what it is over or caught by, and the facts cow collected. */
export function noticeText(title: string, f: Finding): string {
  const facts = f.facts;
  const label = facts.label ? ` (${facts.label})` : "";
  const tally = `${facts.toolCalls} tool calls${facts.minutesSinceFirstTurn === null ? "" : `, ${facts.minutesSinceFirstTurn}m since its first turn started`}`;
  const what = (() => {
    switch (f.reason) {
      case "cap-toolCalls":
      case "cap-minutes":
      case "cap-dollars":
        return `is ${f.mark}`;
      case "repeat":
        return `ran ${f.mark} in a row: ${facts.call}`;
      case "quiet":
        return `is ${f.mark} while its turn runs: no event and nothing in progress`;
      case "long-item":
        return `has had ${f.mark}: ${facts.call}`;
    }
  })();
  return `“${title}”${label} ${what}. ${tally}. cow does not stop it.`;
}
