// What asks and briefs add to the overview: a thread with an open ask wants
// the user, each open ask is an entry in the queue, and a thread's line says
// what the checker made of its latest brief. Pure, so the page can use it.

import type { Ask } from "./asks/ask.ts";
import { asksByThread } from "./asks/ask.ts";
import { type BriefMark, markText } from "./briefs/review.ts";
import { STATE_LABEL } from "./state.ts";
import { STATUS_LIMITS, type StatusLine, type StatusReport } from "./status.ts";
import { formatAge } from "./text.ts";

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const join = (...parts: string[]): string => parts.filter((part) => part !== "").join(" · ");

export interface StatusWithAttention extends StatusReport {
  /** Open asks of threads in this report, oldest first. */
  asks: Ask[];
  /** Thread id to what its latest brief says. */
  briefs: Record<string, BriefMark>;
  /** Open asks in this project on threads this report does not list. */
  asksElsewhere: number;
}

/** A thread's line, told about its open asks and its latest brief. */
function mark(line: StatusLine, asks: readonly Ask[] | undefined, brief: BriefMark | undefined, now: number): StatusLine {
  let next = line;
  const first = asks?.[0];
  if (first) {
    const more = asks.length > 1 ? ` (and ${asks.length - 1} more)` : "";
    const asking = `asks: ${first.question.replace(/\s+/g, " ")}${more}`;
    const waited = Math.max(0, now - first.createdAt);
    next =
      line.state === "parked"
        ? { ...line, doing: cut(join(line.doing, asking), STATUS_LIMITS.text) }
        : { ...line, state: "wants", label: STATE_LABEL.wants, inStateMs: waited, inState: formatAge(waited), doing: cut(asking, STATUS_LIMITS.text), next: "answer it on cow's page" };
  }
  if (brief) next = { ...next, doing: cut(join(next.doing, markText(brief)), STATUS_LIMITS.text) };
  return next;
}

/** The overview with asks and briefs put on it. */
export function withAttention(report: StatusReport, openAsks: readonly Ask[], briefs: ReadonlyMap<string, BriefMark>, now: number, projectId: string | null): StatusWithAttention {
  const byThread = asksByThread(openAsks);
  const marked = (line: StatusLine) => mark(line, byThread.get(line.id), briefs.get(line.id), now);

  // A finished thread with an open ask is not done with: it goes back among the open threads.
  const reopened = report.done.filter((line) => byThread.has(line.id));
  const threads = [...report.threads, ...reopened.map((line) => ({ ...line, depth: 0 }))].map(marked);
  const done = report.done.filter((line) => !byThread.has(line.id)).map(marked);
  const parked = report.parked.map(marked);
  const main = marked(report.main);
  const listed = new Map([main, ...threads, ...parked, ...done].map((line) => [line.id, line]));

  const shown = openAsks.filter((ask) => listed.has(ask.threadId)).sort((a, b) => a.createdAt - b.createdAt);
  type Entry = StatusReport["queue"][number];
  const entries: { entry: Entry; waitedMs: number }[] = report.queue.map((entry) => ({ entry, waitedMs: entry.inStateMs }));
  for (const ask of shown) {
    const line = listed.get(ask.threadId);
    if (!line) continue;
    const waitedMs = Math.max(0, now - ask.createdAt);
    const risk = ask.risk ? `, risk ${ask.risk}` : "";
    entries.push({
      waitedMs,
      entry: { ...line, state: "wants", label: STATE_LABEL.wants, doing: cut(`asks (${ask.id}${risk}): ${ask.question.replace(/\s+/g, " ")}`, STATUS_LIMITS.text), next: "answer it on cow's page", waiting: formatAge(waitedMs) },
    });
  }
  // Oldest first, as the queue already is; a stable sort keeps bb's own order among equals.
  entries.sort((a, b) => b.waitedMs - a.waitedMs);
  const total = entries.length + report.omitted.queue;
  const queue = entries.slice(0, STATUS_LIMITS.queue).map(({ entry }, index) => ({ ...entry, queue: index + 1 }));
  const place = new Map<string, number>();
  for (const entry of queue) if (!place.has(entry.id)) place.set(entry.id, entry.queue);
  const placed = (line: StatusLine): StatusLine => ({ ...line, queue: place.get(line.id) ?? null });

  return {
    ...report,
    main: placed(main),
    queue,
    threads: threads.map(placed),
    parked: parked.map(placed),
    done: done.map(placed),
    omitted: { ...report.omitted, queue: total - queue.length },
    asks: shown,
    briefs: Object.fromEntries([...briefs].filter(([id]) => listed.has(id))),
    asksElsewhere: openAsks.filter((ask) => !listed.has(ask.threadId) && (projectId === null || ask.projectId === projectId)).length,
  };
}
