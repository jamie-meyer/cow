// The context card: what bb's own plugins and any other plugin know about a
// thread, shown for the selected line above the legend and at the top of the
// chat pane. bb gives a plugin page no way to draw another plugin's card, so
// cow draws its own from two sources: bb's bundled git and pull-request
// plugins, read through cow's server, and any plugin that registers the
// discoverable RPC method `cow_card` (see docs/reference.md, "The context
// card").
//
// Everything here is pure: reading another plugin's answer without trusting
// it, putting the sources in order, and which thread a card belongs to.

/** The method another plugin registers, discoverable, to add sections to cow's card. */
export const CARD_METHOD = "cow_card";

export const BADGE_TONES = ["ok", "warn", "bad", "info", "muted"] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

export interface CardBadge {
  text: string;
  tone: BadgeTone;
}

export interface CardRow {
  text: string;
  /** An http or https link: the row opens it as any external link on the page. */
  url?: string;
  detail?: string;
  badges?: CardBadge[];
  /** The row that is this thread, in a list of several: it stands out quietly. */
  current?: boolean;
  indent?: 0 | 1 | 2;
  /** A changed file, relative to the thread's workspace: it opens in cow's reader. Only bb's own sections have these. */
  file?: string;
}

export interface CardSection {
  title: string;
  rows: CardRow[];
}

/** One plugin's part of the card, under its name. */
export interface CardSource {
  pluginId: string;
  name: string;
  sections: CardSection[];
}

/** A thread's card: bb's own sections first, then other plugins in a stable order. */
export interface Card {
  threadId: string;
  /** The thread's environment, for opening its changed files; null without one. */
  environmentId: string | null;
  sources: CardSource[];
}

/** What cow takes from one plugin's answer; the rest is dropped. */
export const CARD_LIMITS = {
  sections: 4,
  rows: 20,
  title: 60,
  text: 160,
  detail: 160,
  badges: 4,
  badgeText: 24,
  url: 2000,
} as const;

/** The pseudo-plugin bb's own sections are listed under. */
export const BB_SOURCE = "bb";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Plain text on one line, cut with an ellipsis to `max` characters; null when there is none. */
export function plain(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control characters, line breaks included, become spaces: a row is one line.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** An http or https URL, or null. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CARD_LIMITS.url) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function readBadge(value: unknown): CardBadge | null {
  const badge = record(value);
  if (!badge) return null;
  const text = plain(badge.text, CARD_LIMITS.badgeText);
  if (text === null || !(BADGE_TONES as readonly unknown[]).includes(badge.tone)) return null;
  return { text, tone: badge.tone as BadgeTone };
}

function readRow(value: unknown): CardRow | null {
  const row = record(value);
  if (!row) return null;
  const text = plain(row.text, CARD_LIMITS.text);
  if (text === null) return null;
  const out: CardRow = { text };
  const url = safeUrl(row.url);
  if (url !== null) out.url = url;
  const detail = plain(row.detail, CARD_LIMITS.detail);
  if (detail !== null) out.detail = detail;
  if (Array.isArray(row.badges)) {
    const badges = row.badges.map(readBadge).filter((badge): badge is CardBadge => badge !== null).slice(0, CARD_LIMITS.badges);
    if (badges.length > 0) out.badges = badges;
  }
  if (row.current === true) out.current = true;
  if (row.indent === 1 || row.indent === 2) out.indent = row.indent;
  return out;
}

/**
 * Another plugin's answer to `cow_card`, read without trusting it: sections
 * and rows that are not in the documented shape are dropped, text is cut to
 * the limits, and what is beyond the counts is left out. A section with no
 * row left is dropped too. Never throws.
 */
export function readCardAnswer(value: unknown): CardSection[] {
  const answer = record(value);
  if (!answer || !Array.isArray(answer.sections)) return [];
  const out: CardSection[] = [];
  for (const raw of answer.sections) {
    if (out.length >= CARD_LIMITS.sections) break;
    const section = record(raw);
    if (!section || !Array.isArray(section.rows)) continue;
    const title = plain(section.title, CARD_LIMITS.title);
    if (title === null) continue;
    const rows: CardRow[] = [];
    for (const row of section.rows) {
      if (rows.length >= CARD_LIMITS.rows) break;
      const read = readRow(row);
      if (read !== null) rows.push(read);
    }
    if (rows.length > 0) out.push({ title, rows });
  }
  return out;
}

/** bb's own first, then other plugins by name, then id: the same order every time. Sources with nothing are left out. */
export function orderSources(sources: readonly CardSource[]): CardSource[] {
  return sources
    .filter((source) => source.sections.length > 0)
    .sort((a, b) => {
      if ((a.pluginId === BB_SOURCE) !== (b.pluginId === BB_SOURCE)) return a.pluginId === BB_SOURCE ? -1 : 1;
      return a.name.localeCompare(b.name) || a.pluginId.localeCompare(b.pluginId);
    });
}

export const cardIsEmpty = (card: Card | null): boolean => card === null || card.sources.every((source) => source.sections.length === 0);

/** Every row of a card, in order: how tall it is. */
export const cardRowCount = (card: Card): number => card.sources.reduce((n, source) => n + source.sections.reduce((m, section) => m + 1 + section.rows.length, 0), 0);

// ---- bb's own plugins ------------------------------------------------------

/** bb's bundled plugins the card reads, and their methods. */
export const BB_GIT = { pluginId: "bb--git", method: "status" } as const;
export const BB_PULL_REQUEST = { pluginId: "bb--github-pr-status", method: "pullRequests" } as const;

/** How many changed files are named; the count says how many more there are. */
export const FILES_NAMED = 5;

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const CHECK_BADGE: Record<string, CardBadge | null> = {
  passing: { text: "checks pass", tone: "ok" },
  failing: { text: "checks fail", tone: "bad" },
  pending: { text: "checks running", tone: "warn" },
  no_checks: null,
  unknown: null,
};
const REVIEW_BADGE: Record<string, CardBadge | null> = {
  approved: { text: "approved", tone: "ok" },
  changes_requested: { text: "changes requested", tone: "bad" },
  review_required: { text: "review required", tone: "warn" },
  review_requested: { text: "review requested", tone: "info" },
  none: null,
};
const STATE_BADGE: Record<string, CardBadge> = {
  draft: { text: "draft", tone: "muted" },
  open: { text: "open", tone: "info" },
  merged: { text: "merged", tone: "ok" },
  closed: { text: "closed", tone: "muted" },
};

/** The pull-request plugin's answer for one environment, as a section; null when it has none. */
export function pullRequestSection(answer: unknown, environmentId: string): CardSection | null {
  const entry = record(record(answer)?.[environmentId]);
  if (!entry || entry.outcome !== "available") return null;
  const pr = record(entry.pullRequest);
  const number = num(pr?.number);
  const title = plain(pr?.title, CARD_LIMITS.text);
  if (!pr || number === null || title === null) return null;
  const badges = [
    STATE_BADGE[String(pr.state)] ?? null,
    CHECK_BADGE[String(record(pr.checks)?.state)] ?? null,
    REVIEW_BADGE[String(record(pr.review)?.state)] ?? null,
  ].filter((badge): badge is CardBadge => badge !== null);
  const row: CardRow = { text: `#${number} ${title}` };
  const url = safeUrl(pr.url);
  if (url !== null) row.url = url;
  if (badges.length > 0) row.badges = badges;
  const head = str(pr.headRefName);
  const base = str(pr.baseRefName);
  if (head !== null && base !== null) row.detail = plain(`${head} → ${base}`, CARD_LIMITS.detail) ?? undefined;
  return { title: "Pull request", rows: [row] };
}

/**
 * The git plugin's answer for one environment, as a section: what is
 * committed on the branch and not merged, and what is not committed, each
 * path once, the first few named. Null when nothing has changed.
 */
export function changedFilesSection(answer: unknown, environmentId: string): CardSection | null {
  const entry = record(record(answer)?.[environmentId]);
  if (!entry || entry.outcome !== "available") return null;
  const workspace = record(entry.workspace);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const part of [record(workspace?.mergeBase), record(workspace?.workingTree)]) {
    if (!part || !Array.isArray(part.files)) continue;
    for (const file of part.files) {
      const path = str(record(file)?.path);
      if (path !== null && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  const counted = num(record(workspace?.allChanges)?.fileCount);
  const count = Math.max(paths.length, counted ?? 0);
  if (count === 0) return null;
  const rows: CardRow[] = paths.slice(0, FILES_NAMED).map((path) => ({ text: plain(path, CARD_LIMITS.text) ?? path, file: path }));
  if (count > rows.length) rows.push({ text: `and ${count - rows.length} more`, detail: "all of them in bb's thread view" });
  return { title: `Changed files · ${count}`, rows };
}

// ---- which card the page shows ---------------------------------------------

/** How long a thread's card is kept on the page before it is read again. */
export const CARD_FRESH_MS = 30_000;
/** How long the cursor rests on a line before its card is read. */
export const CARD_REST_MS = 150;

/** The thread a line's card is for: a thread's own line, never a heading, an automation's row or a not-started item. */
export function cardThreadOf(lineId: string | null, isThread: (id: string) => boolean): string | null {
  if (lineId === null || /^(section|automation|todo):/.test(lineId)) return null;
  return isThread(lineId) ? lineId : null;
}

/** Each thread's card as last read, for a short time. */
export class CardCache {
  private readonly entries = new Map<string, { at: number; card: Card }>();
  private readonly freshMs: number;
  constructor(freshMs = CARD_FRESH_MS) {
    this.freshMs = freshMs;
  }

  put(card: Card, now: number): void {
    this.entries.set(card.threadId, { at: now, card });
  }

  /** The card kept for this thread, fresh or not; null when none was read. */
  get(threadId: string): Card | null {
    return this.entries.get(threadId)?.card ?? null;
  }

  fresh(threadId: string, now: number): boolean {
    const entry = this.entries.get(threadId);
    return entry !== undefined && now - entry.at < this.freshMs;
  }
}

/** The card to show under a thread's line: only ever that thread's own, or nothing. */
export function cardShown(threadId: string | null, card: Card | null): Card | null {
  if (threadId === null || card === null || card.threadId !== threadId) return null;
  return cardIsEmpty(card) ? null : card;
}

/** In the chat pane the card is folded to its section titles when it would take more than this many lines. */
export const PANE_OPEN_LINES = 4;
