// The task a brief answers to: the first message its thread was started
// with, as cow read it, and the checks its "Done means" section sets. The
// submitting agent never supplies these. Pure.

export const TASK_LIMITS = {
  /** Characters of the task the checker is shown. */
  text: 12_000,
  /** Checks taken from a "Done means" section; the rest are dropped, and the prompt says so. */
  checks: 30,
  /** Characters of one check. */
  check: 600,
} as const;

export interface TaskRead {
  /** The task as the checker is shown it: its first `TASK_LIMITS.text` characters. */
  text: string;
  /** The whole task's length. */
  chars: number;
  clipped: boolean;
  /** Whether the task has a "Done means" section. */
  hasSection: boolean;
  /** Each check its "Done means" section sets, in order. */
  checks: string[];
  /** How many checks the section had beyond `TASK_LIMITS.checks`. */
  checksDropped: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const DONE = /^done means\b/i;
/** `**Done means**`, `**Done means:**` or `__Done means__`, at the start of a line, and what follows on that line. */
const BOLD_LEAD = /^ {0,3}(\*\*|__)\s*done means\b[^*_]*?\1:?[ \t]*(.*)$/i;
const ITEM = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The checks of a "Done means" section: a heading or a bold lead-in with
 * those words, up to the next heading of the same or higher level (for a
 * lead-in, the next heading of any level). Each list item at the section's
 * outermost level is one check, with the lines under it; a section with no
 * list is one check. Null when there is no such section.
 */
export function doneMeans(task: string): string[] | null {
  const lines = task.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  /** The heading level that ends the section; 7 for a lead-in, which any heading ends. */
  let level = 7;
  const body: string[] = [];
  let fenced = false;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = HEADING.exec(line);
    if (heading && DONE.test(tidy((heading[2] ?? "").replace(/[*_`]/g, "")))) {
      start = at + 1;
      level = heading[1]?.length ?? 1;
      break;
    }
    const lead = BOLD_LEAD.exec(line);
    if (lead) {
      start = at + 1;
      if ((lead[2] ?? "").trim() !== "") body.push(lead[2] ?? "");
      break;
    }
  }
  if (start < 0) return null;
  fenced = false;
  for (let at = start; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading && (heading[1]?.length ?? 1) <= level) break;
    body.push(line);
  }

  const items: { indent: number; lines: string[] }[] = [];
  const loose: string[] = [];
  let outer: number | null = null;
  /** The item lines go on to, or null once a heading or an unindented paragraph has ended it. */
  let open: { lines: string[] } | null = null;
  let blank = false;
  for (const line of body) {
    const item = ITEM.exec(line);
    const indent = (item ? (item[1] ?? "") : (/^[ \t]*/.exec(line)?.[0] ?? "")).replace(/\t/g, "    ").length;
    if (line.trim() === "") {
      blank = true;
      continue;
    }
    if (item && (outer === null || indent <= outer)) {
      outer = indent;
      open = { lines: [item[2] ?? ""] };
      items.push({ indent, ...open });
    } else if (HEADING.test(line) || (blank && !item && indent <= (outer ?? 0))) {
      // A heading under the section, or a paragraph after a blank line at the list's own indent, ends the item it follows.
      open = null;
      if (items.length === 0 && !HEADING.test(line)) loose.push(line);
    } else if (open !== null) {
      open.lines.push(item ? (item[2] ?? "") : line);
    } else if (items.length === 0) {
      loose.push(line);
    }
    blank = false;
  }
  const checks = items.length > 0 ? items.map((item) => tidy(item.lines.join(" "))) : loose.length > 0 ? [tidy(loose.join(" "))] : [];
  return checks.filter((check) => check !== "");
}

/** Read a thread's first message as the task a brief is checked against. */
export function readTask(message: string): TaskRead {
  const found = doneMeans(message);
  const all = (found ?? []).map((check) => (check.length > TASK_LIMITS.check ? `${check.slice(0, TASK_LIMITS.check - 1)}…` : check));
  return {
    text: message.length > TASK_LIMITS.text ? message.slice(0, TASK_LIMITS.text) : message,
    chars: message.length,
    clipped: message.length > TASK_LIMITS.text,
    hasSection: found !== null,
    checks: all.slice(0, TASK_LIMITS.checks),
    checksDropped: Math.max(0, all.length - TASK_LIMITS.checks),
  };
}

/** The text of a thread's first message, from bb's `client/turn/requested` events: the oldest one's text parts. Null when there is none to read. */
export function firstMessageText(events: readonly unknown[]): string | null {
  let first: { seq: number; data: Record<string, unknown> } | null = null;
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "client/turn/requested" || typeof event.seq !== "number") continue;
    const data = typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : {};
    if (first === null || event.seq < first.seq) first = { seq: event.seq, data };
  }
  if (first === null || !Array.isArray(first.data.input)) return null;
  const parts = first.data.input.flatMap((part: unknown) => {
    const p = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : {};
    return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
  });
  const text = parts.join("\n\n");
  return text.trim() === "" ? null : text;
}
