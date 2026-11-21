// The ledger: what each finished worker came to. When a worker is archived
// through cow, one row is written for it in cow's own storage, so it outlives
// the thread: its model and effort, how long it took to its first report, how
// many times it was steered before that report, how many turns it ran, and
// the outcome someone judged it to have, and the label its dispatcher gave
// it: one short word for the kind of job. It holds no title, no prompt, no
// message text and no reason. It holds the tokens the worker used, as bb
// recorded them, and no dollars: dollars are worked out at list price when
// shown (prices.ts), so a corrected price applies to old rows too. Pure:
// storage is in ledger-store.ts.

import { z } from "zod";
import { starterOf } from "./attention.ts";
import { dollarText } from "./prices.ts";
import { NO_TOKENS, type Tokens, addTokens, tokenSum, tokensLine, tokensText } from "./usage.ts";

export const OUTCOMES = ["done", "partial", "redone", "dropped"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What each outcome means, wherever one is chosen. */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  done: "the work was used as it came back",
  partial: "some of it was used, or it needed a second worker",
  redone: "it was wrong, and you or another thread redid it",
  dropped: "it was not used",
};

/** Who judged an outcome, or archived a worker, when it was the person: a signed page action, or a command run outside any thread. Otherwise a thread's id. */
export const PERSON = "person";

export function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/** One judgement of an outcome: what, by whom, when. */
export const judgementSchema = z.object({ outcome: z.enum(OUTCOMES), by: z.string().min(1).max(200), at: z.number() });
export type Judgement = z.infer<typeof judgementSchema>;
/** Every judgement of one worker's outcome, oldest first. The latest stands. */
export const judgementsSchema = z.array(judgementSchema);
/** At most this many judgements per worker; after that a change is refused. */
export const MAX_JUDGEMENTS = 50;

/** A label: one short word-like value naming the kind of job, so the ledger still holds no free text. */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const LABEL_RULE = "a label is one short word: lower-case letters, digits and hyphens, starting with a letter or digit, at most 24 characters, such as lookup, draft or code-change";

/** A label as given, lower-cased; or why it is no label. */
export function labelOf(value: string): { ok: true; label: string } | { ok: false; why: string } {
  const label = value.trim().toLowerCase();
  return LABEL_PATTERN.test(label) ? { ok: true, label } : { ok: false, why: `"${value}" is not a label: ${LABEL_RULE}` };
}

/** A worker's label: what, by whom, when. One the person set is not overwritten by a thread. */
export const labelNoteSchema = z.object({ label: z.string().regex(LABEL_PATTERN), by: z.string().min(1).max(200), at: z.number() });
export type LabelNote = z.infer<typeof labelNoteSchema>;

/** Why `by` may not set or clear a label now, or null when it may. */
export function labelRefusal(current: LabelNote | null, by: string): string | null {
  return by !== PERSON && current?.by === PERSON ? `the person labelled it “${current.label}”, and a thread cannot change what the person set` : null;
}

/** THE ROW. Its keys are exactly these; a test holds them to it. */
export const ROW_KEYS = [
  "threadId",
  "projectId",
  "dispatchedBy",
  "model",
  "effort",
  "firstTurnAt",
  "firstReportAt",
  "toFirstReportMs",
  "steersByPerson",
  "steersByThreads",
  "turns",
  "outcome",
  "judgedBy",
  "judgedAt",
  "outcomeChanges",
  "archivedAt",
  "archivedBy",
  "label",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
] as const;

export const rowSchema = z.strictObject({
  threadId: z.string(),
  projectId: z.string(),
  /** Its parent when it was archived: the thread that dispatched it. Null for a thread with none. */
  dispatchedBy: z.string().nullable(),
  /** As its first prompt asked for it; null when bb did not record it. */
  model: z.string().nullable(),
  /** The reasoning effort its first prompt asked for; null when bb did not record it. */
  effort: z.string().nullable(),
  firstTurnAt: z.number().nullable(),
  /** When its first finished turn ended. */
  firstReportAt: z.number(),
  toFirstReportMs: z.number().nullable(),
  /** Messages sent into it after its first prompt and before its first report ended, by the person and by other threads. */
  steersByPerson: z.number().int().min(0),
  steersByThreads: z.number().int().min(0),
  turns: z.number().int().min(0),
  outcome: z.enum(OUTCOMES).nullable(),
  judgedBy: z.string().nullable(),
  judgedAt: z.number().nullable(),
  /** How many times the outcome was changed after it was first given. */
  outcomeChanges: z.number().int().min(0),
  archivedAt: z.number(),
  archivedBy: z.string(),
  /** The kind of job its dispatcher (or the person) named it; null when none. A row written before labels reads as none. */
  label: z.string().regex(LABEL_PATTERN).nullable().default(null),
  /** The tokens it used, as bb recorded them (usage.ts): input apart from the cache, cache reads, cache writes, output. Null when bb recorded none; a row written before 0.2.19 reads as null. */
  inputTokens: z.number().min(0).nullable().default(null),
  cacheReadTokens: z.number().min(0).nullable().default(null),
  cacheWriteTokens: z.number().min(0).nullable().default(null),
  outputTokens: z.number().min(0).nullable().default(null),
});
export type LedgerRow = z.infer<typeof rowSchema>;

/** A row's tokens, or null when its usage is unknown. */
export function rowTokens(row: Pick<LedgerRow, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">): Tokens | null {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = row;
  if (inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || outputTokens === null) return null;
  return { input: inputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens, output: outputTokens };
}

/** The row's token fields for tokens, or for unknown usage. */
export function tokenFields(tokens: Tokens | null): Pick<LedgerRow, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens"> {
  return {
    inputTokens: tokens?.input ?? null,
    cacheReadTokens: tokens?.cacheRead ?? null,
    cacheWriteTokens: tokens?.cacheWrite ?? null,
    outputTokens: tokens?.output ?? null,
  };
}

/** What a thread's event log says about its first report. */
export interface TurnFacts {
  model: string | null;
  effort: string | null;
  firstTurnAt: number | null;
  /** Null when it never finished a turn: it is no worker for the ledger. */
  firstReportAt: number | null;
  steersByPerson: number;
  steersByThreads: number;
  turns: number;
}

/** The event types `readTurns` reads. */
export const TURN_EVENT_TYPES = ["client/turn/requested", "turn/started", "turn/completed"] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : null);

/**
 * Read a thread's whole log of prompts and turns, in any order. The first
 * prompt says the model and effort (`execution.model`, `execution.reasoningLevel`);
 * the first report is the end of the first turn that finished normally; a
 * steer is any prompt after the first and before that end, from the person or
 * from another thread. bb's own notices are no steer.
 */
export function readTurns(events: readonly unknown[]): TurnFacts {
  const log: { seq: number; at: number; type: string; data: Record<string, unknown> }[] = [];
  for (const raw of events) {
    const r = record(raw);
    if (!r || typeof r.seq !== "number" || typeof r.type !== "string") continue;
    log.push({ seq: r.seq, at: typeof r.createdAt === "number" ? r.createdAt : 0, type: r.type, data: record(r.data) ?? {} });
  }
  log.sort((a, b) => a.seq - b.seq);
  const facts: TurnFacts = { model: null, effort: null, firstTurnAt: null, firstReportAt: null, steersByPerson: 0, steersByThreads: 0, turns: 0 };
  let prompted = false;
  for (const event of log) {
    if (event.type === "client/turn/requested") {
      if (!prompted) {
        prompted = true;
        const execution = record(event.data.execution);
        facts.model = text(execution?.model);
        facts.effort = text(execution?.reasoningLevel);
        continue;
      }
      if (facts.firstReportAt !== null) continue;
      const starter = starterOf(event.data);
      if (starter === "person") facts.steersByPerson += 1;
      else if (starter === "agent") facts.steersByThreads += 1;
    } else if (event.type === "turn/started") {
      facts.turns += 1;
      if (facts.firstTurnAt === null) facts.firstTurnAt = event.at;
    } else if (event.type === "turn/completed" && facts.firstReportAt === null && (event.data.status === "completed" || event.data.status === undefined)) {
      facts.firstReportAt = event.at;
    }
  }
  return facts;
}

/** The outcome fields of a row, from the judgements so far. */
export function outcomeFields(judgements: readonly Judgement[]): Pick<LedgerRow, "outcome" | "judgedBy" | "judgedAt" | "outcomeChanges"> {
  const latest = judgements[judgements.length - 1];
  return {
    outcome: latest?.outcome ?? null,
    judgedBy: latest?.by ?? null,
    judgedAt: latest?.at ?? null,
    outcomeChanges: Math.max(0, judgements.length - 1),
  };
}

/** A worker's row, or null when it never finished a turn. */
export function buildRow(
  thread: { id: string; projectId: string; parentThreadId: string | null },
  facts: TurnFacts,
  archived: { at: number; by: string },
  judgements: readonly Judgement[],
  label: string | null = null,
  tokens: Tokens | null = null,
): LedgerRow | null {
  if (facts.firstReportAt === null) return null;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    dispatchedBy: thread.parentThreadId,
    model: facts.model,
    effort: facts.effort,
    firstTurnAt: facts.firstTurnAt,
    firstReportAt: facts.firstReportAt,
    toFirstReportMs: facts.firstTurnAt === null ? null : Math.max(0, facts.firstReportAt - facts.firstTurnAt),
    steersByPerson: facts.steersByPerson,
    steersByThreads: facts.steersByThreads,
    turns: facts.turns,
    ...outcomeFields(judgements),
    archivedAt: archived.at,
    archivedBy: archived.by,
    label,
    ...tokenFields(tokens),
  };
}

export type Judged = { ok: true; judgements: Judgement[] } | { ok: false; code: "person_judged" | "too_many_changes"; why: string };

/**
 * Add a judgement. An outcome the person set is never overwritten by a
 * thread: a thread trying is refused, and told so. The person may change
 * anyone's.
 */
export function judge(judgements: readonly Judgement[], outcome: Outcome, by: string, at: number): Judged {
  const latest = judgements[judgements.length - 1];
  if (by !== PERSON && latest?.by === PERSON) {
    return { ok: false, code: "person_judged", why: `the person judged it “${latest.outcome}”, and a thread cannot change what the person judged` };
  }
  if (judgements.length >= MAX_JUDGEMENTS) return { ok: false, code: "too_many_changes", why: `its outcome has been set ${MAX_JUDGEMENTS} times, and no more changes are kept` };
  return { ok: true, judgements: [...judgements, { outcome, by, at }] };
}

// ---- the summary ------------------------------------------------------------

/** Below this many rows a group is counted, and not compared: no percentages. */
export const SMALL_GROUP = 5;

export interface GroupSummary {
  /** The model, the dispatching thread's id, or the label; "unknown", "none" or "(no label)" when there is none. */
  key: string;
  workers: number;
  outcomes: Record<Outcome | "unsaid", number>;
  /** Null when no row in it has both times. */
  medianToFirstReportMs: number | null;
  /** Steers by the person and by threads together. */
  medianSteers: number | null;
  judgedByPerson: number;
  /** True when it has fewer than SMALL_GROUP rows: counts only. */
  small: boolean;
  /** Shares of its rows, from 0 to 1; null for a small group. */
  shares: { outcomes: Record<Outcome | "unsaid", number>; judgedByPerson: number } | null;
  /** The tokens of its rows whose usage is known. */
  tokens: Tokens;
  /** Rows with no usage recorded: not counted as zero, counted here. */
  unknownUsage: number;
  /** List-price dollars of its rows that have a price; null when none has one. An estimate, not a bill. */
  dollars: number | null;
  /** Rows with tokens but no price for their model: their tokens count, their dollars are not guessed. */
  unpriced: number;
  /** All its dollars (every outcome) divided by how many came to done; null with no done or no dollars. */
  dollarsPerDone: number | null;
}

/** What a row cost at list price, or null when its usage is unknown or its model has no price. */
export type RowCost = (row: LedgerRow) => number | null;
const NO_COST: RowCost = () => null;

/** A label's group, and within it the same by model: is this kind of job on the right model? */
export interface LabelGroupSummary extends GroupSummary {
  byModel: GroupSummary[];
}

/** The key of the rows with no label; no label can look like it. */
export const NO_LABEL = "(no label)";

/** How the summary is grouped; `bb cow ledger --by`, and b in the L sheet. */
export const GROUPINGS = ["model", "dispatcher", "label"] as const;
export type Grouping = (typeof GROUPINGS)[number];
export const GROUPING_TEXT: Record<Grouping, string> = { model: "By model", dispatcher: "By dispatching thread", label: "By label, then by model" };

export interface LedgerSummary {
  days: number;
  since: number;
  rows: number;
  byModel: GroupSummary[];
  byDispatcher: GroupSummary[];
  byLabel: LabelGroupSummary[];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function group(key: string, rows: readonly LedgerRow[], cost: RowCost): GroupSummary {
  const outcomes: Record<Outcome | "unsaid", number> = { done: 0, partial: 0, redone: 0, dropped: 0, unsaid: 0 };
  for (const row of rows) outcomes[row.outcome ?? "unsaid"] += 1;
  const judgedByPerson = rows.filter((row) => row.outcome !== null && row.judgedBy === PERSON).length;
  const small = rows.length < SMALL_GROUP;
  const share = (n: number) => n / rows.length;
  let tokens = NO_TOKENS;
  let unknownUsage = 0;
  let dollars: number | null = null;
  let unpriced = 0;
  for (const row of rows) {
    const used = rowTokens(row);
    if (used === null) {
      unknownUsage += 1;
      continue;
    }
    tokens = addTokens(tokens, used);
    const usd = cost(row);
    if (usd === null) {
      if (tokenSum(used) > 0) unpriced += 1;
    } else dollars = (dollars ?? 0) + usd;
  }
  return {
    key,
    workers: rows.length,
    outcomes,
    medianToFirstReportMs: median(rows.flatMap((row) => (row.toFirstReportMs === null ? [] : [row.toFirstReportMs]))),
    medianSteers: median(rows.map((row) => row.steersByPerson + row.steersByThreads)),
    judgedByPerson,
    small,
    shares: small
      ? null
      : {
          outcomes: { done: share(outcomes.done), partial: share(outcomes.partial), redone: share(outcomes.redone), dropped: share(outcomes.dropped), unsaid: share(outcomes.unsaid) },
          judgedByPerson: share(judgedByPerson),
        },
    tokens,
    unknownUsage,
    dollars,
    unpriced,
    dollarsPerDone: dollars === null || outcomes.done === 0 ? null : dollars / outcomes.done,
  };
}

function groups(rows: readonly LedgerRow[], keyOf: (row: LedgerRow) => string, cost: RowCost): GroupSummary[] {
  const by = new Map<string, LedgerRow[]>();
  for (const row of rows) by.set(keyOf(row), [...(by.get(keyOf(row)) ?? []), row]);
  return [...by.entries()].map(([key, members]) => group(key, members, cost)).sort((a, b) => b.workers - a.workers || a.key.localeCompare(b.key));
}

const modelOf = (row: LedgerRow) => row.model ?? "unknown";

function byLabel(rows: readonly LedgerRow[], cost: RowCost): LabelGroupSummary[] {
  const of = (row: LedgerRow) => row.label ?? NO_LABEL;
  return groups(rows, of, cost).map((summary) => ({ ...summary, byModel: groups(rows.filter((row) => of(row) === summary.key), modelOf, cost) }));
}

/** The rows archived in the last `days` days, newest first. */
export function inWindow(rows: readonly LedgerRow[], now: number, days: number): LedgerRow[] {
  const since = now - days * 86_400_000;
  return rows.filter((row) => row.archivedAt >= since).sort((a, b) => b.archivedAt - a.archivedAt);
}

export function summarize(rows: readonly LedgerRow[], now: number, days: number, cost: RowCost = NO_COST): LedgerSummary {
  const within = inWindow(rows, now, days);
  return {
    days,
    since: now - days * 86_400_000,
    rows: within.length,
    byModel: groups(within, modelOf, cost),
    byDispatcher: groups(within, (row) => row.dispatchedBy ?? "none", cost),
    byLabel: byLabel(within, cost),
  };
}

// ---- as text -----------------------------------------------------------------

/** A duration: 45s, 12m, 1h 5m, 2d 3h. */
export function durationText(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 === 0 ? "" : ` ${hours % 24}h`}`;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const numberText = (value: number | null) => (value === null ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(1));

/** One group as a line: counts always, percentages only when it is big enough to compare. */
export function groupText(summary: GroupSummary, name = summary.key): string {
  const counts = [...OUTCOMES, "unsaid" as const].map((outcome) => `${outcome} ${summary.outcomes[outcome]}${summary.shares ? ` (${percent(summary.shares.outcomes[outcome])})` : ""}`).join(", ");
  const judged = `judged by the person ${summary.judgedByPerson}${summary.shares ? ` (${percent(summary.shares.judgedByPerson)})` : ""}`;
  const tail = summary.small ? ` · fewer than ${SMALL_GROUP} workers: too small to compare` : "";
  return `${name}: ${summary.workers} ${summary.workers === 1 ? "worker" : "workers"} · ${counts} · median to first report ${durationText(summary.medianToFirstReportMs)} · median steers before it ${numberText(summary.medianSteers)} · ${judged} · ${costText(summary)}${tail}`;
}

/** A group's tokens and list-price dollars, in words: what is unknown or unpriced is said, never shown as $0. */
export function costText(summary: Pick<GroupSummary, "workers" | "tokens" | "unknownUsage" | "dollars" | "unpriced" | "dollarsPerDone">): string {
  if (summary.unknownUsage === summary.workers) return "usage unknown";
  const parts = [`${tokensText(tokenSum(summary.tokens))} tokens`];
  if (summary.dollars !== null) parts.push(`${dollarText(summary.dollars)} at list price`, summary.dollarsPerDone === null ? "no done outcome to divide by" : `${dollarText(summary.dollarsPerDone)} per done`);
  else parts.push("no list price");
  const gaps = [
    ...(summary.unpriced > 0 && summary.dollars !== null ? [`${summary.unpriced} with no list price`] : []),
    ...(summary.unknownUsage > 0 ? [`${summary.unknownUsage} with usage unknown`] : []),
  ];
  return `${parts.join(" · ")}${gaps.length > 0 ? ` (${gaps.join(", ")})` : ""}`;
}

/** Who judged or archived, in words. */
export const whoText = (by: string | null): string => (by === null ? "–" : by === PERSON ? "the person" : by);

/** A row's tokens and list-price dollars (`usd`: undefined when not asked), in words; the sheet and the CLI both show this. */
export function rowUsageText(row: LedgerRow, usd?: number | null): string {
  const used = rowTokens(row);
  if (used === null) return "usage unknown";
  return `${tokensLine(used)}${usd === undefined ? "" : usd === null ? " · no list price" : ` · ${dollarText(usd)} at list price`}`;
}

/** One row as a line: no title, since the ledger holds none. */
export function rowText(row: LedgerRow, cost?: RowCost): string {
  const outcome = row.outcome === null ? "unsaid" : `${row.outcome} (judged by ${whoText(row.judgedBy)}${row.outcomeChanges > 0 ? `, changed ${row.outcomeChanges}×` : ""})`;
  const model = `${row.model ?? "model unknown"}${row.effort ? ` · ${row.effort}` : ""}`;
  const usage = rowUsageText(row, cost === undefined ? undefined : cost(row));
  return `${row.threadId}${row.label ? ` · ${row.label}` : ""} · ${model} · first report after ${durationText(row.toFirstReportMs)} · steered ${row.steersByPerson} by the person, ${row.steersByThreads} by threads · ${row.turns} ${row.turns === 1 ? "turn" : "turns"} · ${outcome} · dispatched by ${row.dispatchedBy ?? "none"} · archived by ${whoText(row.archivedBy)} · ${usage}`;
}

export const LEDGER_ROWS_SHOWN = 30;

export function ledgerText(summary: LedgerSummary, rows: readonly LedgerRow[], by: readonly Grouping[] = GROUPINGS, cost?: RowCost): string {
  const out = [
    `The ledger: ${summary.rows} ${summary.rows === 1 ? "worker" : "workers"} archived through cow in the last ${summary.days} ${summary.days === 1 ? "day" : "days"}. It holds no titles, prompts or message text.`,
    `${LEDGER_COST_NOTE}`,
  ];
  if (summary.rows === 0) {
    out.push("", "Nothing yet: a row is written when a worker that finished a turn is archived through cow (e on the page, or bb cow archive).");
    return out.join("\n");
  }
  for (const grouping of by) {
    out.push("", GROUPING_TEXT[grouping]);
    if (grouping === "model") for (const g of summary.byModel) out.push(`  ${groupText(g)}`);
    if (grouping === "dispatcher") for (const g of summary.byDispatcher) out.push(`  ${groupText(g)}`);
    if (grouping === "label") {
      for (const g of summary.byLabel) {
        out.push(`  ${groupText(g)}`);
        for (const m of g.byModel) out.push(`    ${groupText(m)}`);
      }
    }
  }
  out.push("", `Rows, newest first${rows.length > LEDGER_ROWS_SHOWN ? ` (the latest ${LEDGER_ROWS_SHOWN} of ${rows.length}; --json gives them all)` : ""}`);
  for (const row of rows.slice(0, LEDGER_ROWS_SHOWN)) out.push(`  ${rowText(row, cost)}`);
  return out.join("\n");
}

/** How the ledger's dollars are worked out, wherever they are shown. */
export const LEDGER_COST_NOTE =
  "Tokens are as bb recorded them. Dollars are an estimate at the providers' list prices, not a bill (on a subscription you are not billed this); per done is a group's dollars, every outcome, divided by its done outcomes.";

/** The outcomes as the page and the CLI list them to choose from. */
export const outcomeChoices = (): string => OUTCOMES.map((outcome, index) => `${index + 1} ${outcome}: ${OUTCOME_TEXT[outcome]}`).join(" · ");
