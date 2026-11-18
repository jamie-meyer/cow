// What asks and briefs add to the overview as the CLI gives it. The state of
// a line already says when it asks or its brief waits (see state.ts); this
// adds the asks themselves and what each brief came to.

import type { Ask } from "./asks/ask.ts";
import { type BriefMark, markText } from "./briefs/review.ts";
import { STATUS_LIMITS, type StatusLine, type StatusReport } from "./status.ts";

/** Realtime channel: published whenever an ask or a brief changes. */
export const RAISED_CHANGED = "raised-changed";

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export interface StatusWithRaised extends StatusReport {
  /** Open asks of threads in this report, oldest first. */
  asks: Ask[];
  /** Thread id to what its latest brief came to. */
  briefs: Record<string, BriefMark>;
  /** Open asks in this project on threads this report does not list. */
  asksElsewhere: number;
}

/** The overview with its asks listed, and each line saying what its brief came to. */
export function withRaised(report: StatusReport, openAsks: readonly Ask[], briefs: ReadonlyMap<string, BriefMark>, projectId: string | null): StatusWithRaised {
  const marked = <T extends StatusLine>(line: T): T => {
    const brief = briefs.get(line.id);
    // A line that waits on its brief says so already.
    if (!brief || line.doing.startsWith("brief: ")) return line;
    return { ...line, doing: cut([line.doing, markText(brief)].filter((part) => part !== "").join(" · "), STATUS_LIMITS.text) };
  };
  const out = {
    ...report,
    main: marked(report.main),
    queue: report.queue.map(marked),
    threads: report.threads.map(marked),
    parked: report.parked.map(marked),
    settle: report.settle.map(marked),
    kept: report.kept.map(marked),
    archived: report.archived.map(marked),
  };
  // The queue too: an ask of a thread under a parked or kept one is listed only there.
  const listed = new Set([out.main, ...out.queue, ...out.threads, ...out.parked, ...out.settle, ...out.kept, ...out.archived].map((line) => line.id));
  return {
    ...out,
    asks: openAsks.filter((ask) => listed.has(ask.threadId)).sort((a, b) => a.createdAt - b.createdAt),
    briefs: Object.fromEntries([...briefs].filter(([id]) => listed.has(id))),
    asksElsewhere: openAsks.filter((ask) => !listed.has(ask.threadId) && (projectId === null || ask.projectId === projectId)).length,
  };
}
