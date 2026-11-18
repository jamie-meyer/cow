// The overview as the CLI gives it: the same lines the page shows, as plain
// data and as text, cut to a bounded size.

import { type LastResult, lastResultText, nextRunText, olderText } from "./automations.ts";
import { dueText } from "./park.ts";
import { OUTSIDE_STATE_TEXT, type OutsideState, notListedText } from "./outside.ts";
import { type LineState, STATE_LABEL, waitingSince } from "./state.ts";
import { formatAge } from "./text.ts";
import { type Line, type Overview, ROLLUP_ORDER, leftBehind, unread } from "./tree.ts";

/** How many lines of each section are given; the rest are counted. */
export const STATUS_LIMITS = { threads: 80, parked: 30, settle: 40, kept: 30, archived: 20, automations: 40, outside: 40, queue: 20, text: 140 } as const;

/** An automation of bb's, with its recent run threads. */
export interface AutomationStatusRow {
  id: string;
  name: string;
  /** Its bb project's name, when that is not Main's project; null when it is. */
  project: string | null;
  paused: boolean;
  mode: "agent" | "script";
  /** When it runs next, in words ("in 3h", "tomorrow 09:00", "paused", "ran once"), and as a time. */
  next: string;
  nextRunAt: number | null;
  /** Its last run's result, in words, and in one word. */
  last: string;
  lastKind: LastResult["kind"];
  /** Its run threads, newest first, at most five. */
  runs: StatusLine[];
  /** Run threads not listed, and whether the plugin has older runs than were read. */
  older: number;
  moreRuns: boolean;
  /** It sends into a thread under Main, so its runs are in the tree. */
  intoTree: boolean;
}

/** An open thread that is not under Main: from the thread list alone. */
export interface OutsideStatusLine {
  id: string;
  title: string;
  /** Its bb project's name, when that is not Main's project; null when it is. */
  project: string | null;
  /** running, asking (bb's own pending question or permission request) or resting. */
  state: OutsideState;
  label: string;
  /** How long since it last did anything, in milliseconds, and as the page writes it. */
  sinceMs: number;
  since: string;
  /** How many open threads are under it. */
  under: number;
}

export interface StatusLine {
  id: string;
  title: string;
  /** The state in one word, and as the page names it. */
  state: LineState;
  label: string;
  /** How long it has been in that state, in milliseconds, and as the page writes it. */
  inStateMs: number;
  inState: string;
  /** What it is doing or waiting on. */
  doing: string;
  /** What moves it next; empty when nothing does. */
  next: string;
  /** The thread's own words on what happens next, set with `bb cow next`; null without. */
  note: string | null;
  /** What it has listed as not started, in order. */
  todo: string[];
  /** For a thread with threads under it: how many are in each state. */
  under: Partial<Record<LineState, number>> | null;
  /** It is a project: never done while it is not archived, and idle when it has nothing to say. */
  project: boolean;
  /** 0 for a thread Main started; 1 for one that thread started. */
  depth: number;
  /** 1-based place in the queue, or null when it is not waiting on the user. */
  queue: number | null;
  /** The names of the capabilities that apply to it; absent when none was looked up. */
  capabilities?: string[];
  /** For a line to settle: whether a reply in it has not been seen, and what archiving it would leave behind. */
  unread?: boolean;
  leftBehind?: string[];
}

/** The same report with each line saying which capabilities its thread holds. */
export function withCapabilities<T extends StatusReport>(report: T, held: ReadonlyMap<string, readonly string[]>): T {
  const named = <L extends StatusLine>(line: L): L => ({ ...line, capabilities: [...(held.get(line.id) ?? [])] });
  return { ...report, main: named(report.main), queue: report.queue.map(named), threads: report.threads.map(named), parked: report.parked.map(named), settle: report.settle.map(named), kept: report.kept.map(named), archived: report.archived.map(named) };
}

export interface StatusReport {
  main: StatusLine;
  /** What is waiting on the user, oldest first. */
  queue: (StatusLine & { waiting: string })[];
  threads: StatusLine[];
  parked: StatusLine[];
  /** Finished and not archived, each needing the user's decision: unread first, then oldest first. */
  settle: StatusLine[];
  /** Kept around on purpose by the user, newest kept first. They ask for nothing. */
  kept: StatusLine[];
  /** Archived in the last 2 days, with their reasons. */
  archived: StatusLine[];
  /** bb's automations, enabled first; empty when the automations plugin is absent or did not answer. */
  automations: AutomationStatusRow[];
  /** Open threads with no parent that are not under Main, newest activity first. Never in the queue. */
  outside: OutsideStatusLine[];
  /** Open threads with no parent that are left out of `outside`: started by a plugin, or another project's Main. */
  outsideNotListed: { byPlugins: number; otherMains: number };
  /** Lines left out to keep the answer bounded, by section. */
  omitted: { threads: number; parked: number; settle: number; kept: number; archived: number; automations: number; outside: number; queue: number };
  /** True when bb has more threads than cow reads. */
  truncated: boolean;
}

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function toStatusLine(line: Line, now: number, todo: readonly string[] = []): StatusLine {
  const { thread, derived } = line;
  const under = line.rollup && ROLLUP_ORDER.filter((state) => line.rollup![state] > 0).map((state) => [state, line.rollup![state]]);
  const inStateMs = Math.max(0, now - derived.since);
  const doing = derived.archivedWhy
    ? `archived: ${derived.archivedWhy}${derived.doing && derived.doing !== "archived" ? ` · ${derived.doing}` : ""}`
    : derived.doing;
  return {
    id: thread.id,
    title: cut(thread.title, 80),
    state: derived.state,
    label: STATE_LABEL[derived.state],
    inStateMs,
    inState: formatAge(inStateMs),
    doing: cut(doing, STATUS_LIMITS.text),
    next: cut(derived.next, STATUS_LIMITS.text),
    note: line.note,
    todo: [...todo],
    under: under && under.length > 0 ? Object.fromEntries(under) : null,
    project: line.project !== null,
    depth: line.depth,
    queue: line.queueNumber,
  };
}

/** The overview as plain data. `overview.main` must be set. */
export function statusReport(overview: Overview, now: number, truncated: boolean, projectNames: ReadonlyMap<string, string> = new Map()): StatusReport {
  const main = overview.main;
  if (!main) throw new Error("the overview has no Main");
  const todos = new Map<string, string[]>();
  for (const row of overview.rows) {
    if (row.kind !== "todo") continue;
    todos.set(row.ownerId, [...(todos.get(row.ownerId) ?? []), cut(row.item.title, STATUS_LIMITS.text)]);
  }
  const lines = (from: readonly Line[], limit: number) =>
    from.slice(0, limit).map((line) => toStatusLine(line, now, todos.get(line.thread.id)));
  const omitted = (from: readonly Line[], limit: number) => Math.max(0, from.length - limit);
  return {
    main: { ...toStatusLine(main, now, todos.get(main.thread.id)), project: true },
    queue: overview.queue.slice(0, STATUS_LIMITS.queue).map((line) => {
      const park = line.derived.park;
      return {
        ...toStatusLine(line, now),
        doing: cut(park?.due ? dueText(park.record, park.due, now) : line.derived.doing, STATUS_LIMITS.text),
        waiting: formatAge(Math.max(0, now - waitingSince(line.derived))),
      };
    }),
    threads: lines(overview.lines, STATUS_LIMITS.threads),
    parked: lines(overview.parked, STATUS_LIMITS.parked),
    settle: overview.settle.slice(0, STATUS_LIMITS.settle).map((line) => ({
      ...toStatusLine(line, now),
      // How long since it finished, whatever under it finished last.
      inStateMs: Math.max(0, now - line.finishedAt),
      inState: formatAge(Math.max(0, now - line.finishedAt)),
      unread: unread(line),
      leftBehind: leftBehind(line),
    })),
    kept: lines(overview.kept, STATUS_LIMITS.kept),
    archived: lines(overview.archived, STATUS_LIMITS.archived),
    automations: overview.automations.groups.slice(0, STATUS_LIMITS.automations).map((group) => ({
      id: group.automation.id,
      name: cut(group.automation.name, 80),
      project: group.project,
      paused: !group.automation.enabled,
      mode: group.automation.mode,
      next: nextRunText(group.automation, now),
      nextRunAt: group.automation.nextRunAt,
      last: cut(lastResultText(group.last, now, formatAge), STATUS_LIMITS.text),
      lastKind: group.last.kind,
      runs: group.runs.map((line) => ({ ...toStatusLine(line, now), depth: 0 })),
      older: group.older,
      moreRuns: group.moreRuns,
      intoTree: group.intoTree,
    })),
    outside: overview.outside.lines.slice(0, STATUS_LIMITS.outside).map((line) => {
      const sinceMs = Math.max(0, now - line.lastAt);
      const { projectId } = line.thread;
      return {
        id: line.thread.id,
        title: cut(line.thread.title, 80),
        project: projectId === main.thread.projectId ? null : (projectNames.get(projectId) ?? projectId),
        state: line.state,
        label: OUTSIDE_STATE_TEXT[line.state],
        sinceMs,
        since: formatAge(sinceMs),
        under: line.under,
      };
    }),
    outsideNotListed: { byPlugins: overview.outside.byPlugins, otherMains: overview.outside.otherMains },
    omitted: {
      threads: omitted(overview.lines, STATUS_LIMITS.threads),
      parked: omitted(overview.parked, STATUS_LIMITS.parked),
      settle: omitted(overview.settle, STATUS_LIMITS.settle),
      kept: omitted(overview.kept, STATUS_LIMITS.kept),
      archived: omitted(overview.archived, STATUS_LIMITS.archived),
      automations: Math.max(0, overview.automations.groups.length - STATUS_LIMITS.automations),
      outside: Math.max(0, overview.outside.lines.length - STATUS_LIMITS.outside),
      queue: omitted(overview.queue, STATUS_LIMITS.queue),
    },
    truncated,
  };
}

/** What is next for a line: its own words when it left any, else what cow works out. */
const nextOf = (line: StatusLine): string => (line.note !== null ? ` → next, in its words: ${line.note}` : line.next ? ` → ${line.next}` : "");

/** The capabilities a line's thread holds, by name. */
const holds = (line: StatusLine): string => (line.capabilities && line.capabilities.length > 0 ? `  [holds: ${line.capabilities.join(", ")}]` : "");

function row(line: StatusLine, indent: boolean): string[] {
  const place = line.queue === null ? "  " : String(line.queue).padStart(2);
  const pad = indent ? "  ".repeat(line.depth) : "";
  const under = line.under
    ? `  [under it: ${Object.entries(line.under).map(([state, count]) => `${count} ${state}`).join(", ")}]`
    : "";
  const unreadMark = line.unread ? " [unread]" : "";
  const behind = line.leftBehind && line.leftBehind.length > 0 ? `  [archiving leaves: ${line.leftBehind.join(", ")}]` : "";
  return [
    `${place}  ${line.state.padEnd(7)} ${line.inState.padStart(4)}  ${pad}${line.title} (${line.id})${line.project ? " [project]" : ""}${unreadMark}  ${line.doing}${nextOf(line)}${under}${behind}${holds(line)}`,
    ...line.todo.map((title, index) => `${" ".repeat(18)}${pad}  not started ${index + 1}: ${title}`),
  ];
}

/** A run line, indented under its automation. */
const row_ = (line: StatusLine): string[] => row(line, false).map((text) => `    ${text}`);

const more = (count: number): string[] => (count > 0 ? [`    … and ${count} more, not listed`] : []);

/** The overview as text: one line per thread. */
export function statusText(report: StatusReport): string {
  const { main, omitted } = report;
  const waiting = report.queue.length + omitted.queue;
  const out: string[] = [
    `Main: ${main.title} (${main.id}) · ${main.label} ${main.inState}${main.doing ? ` · ${main.doing}` : ""}${main.note !== null ? nextOf(main) : ""}${holds(main)}`,
    ...main.todo.map((title, index) => `    not started ${index + 1}: ${title}`),
    "",
    `Waiting on the user (${waiting})`,
  ];
  if (report.queue.length === 0) out.push("    nothing");
  for (const line of report.queue) {
    out.push(`${String(line.queue ?? "").padStart(2)}  ${line.title} (${line.id})  ${line.doing} · waiting ${line.waiting}`);
  }
  out.push(...more(omitted.queue), "", `Threads (${report.threads.length + omitted.threads})`);
  if (report.threads.length === 0) out.push("    none open");
  for (const line of report.threads) out.push(...row(line, true));
  out.push(...more(omitted.threads), "", `Parked (${report.parked.length + omitted.parked})`);
  if (report.parked.length === 0) out.push("    nothing");
  for (const line of report.parked) out.push(...row(line, false));
  out.push(...more(omitted.parked), "", `To settle: finished, not archived, each for the user to decide (${report.settle.length + omitted.settle}; unread first, then oldest first)`);
  if (report.settle.length === 0) out.push("    nothing");
  for (const line of report.settle) out.push(...row(line, false));
  out.push(...more(omitted.settle), "", `Kept: around on purpose, asking for nothing (${report.kept.length + omitted.kept})`);
  if (report.kept.length === 0) out.push("    nothing");
  for (const line of report.kept) out.push(...row(line, false));
  out.push(...more(omitted.kept), "", `Archived in the last 2 days (${report.archived.length + omitted.archived})`);
  for (const line of report.archived) out.push(...row(line, false));
  out.push(...more(omitted.archived));
  if (report.automations.length + omitted.automations > 0) {
    out.push("", `Automations: bb's scheduled runs, each with its recent run threads (${report.automations.length + omitted.automations})`);
    for (const row of report.automations) {
      const where = row.project === null ? "" : `  [project: ${row.project}]`;
      const into = row.intoTree ? "  [runs in a thread under Main]" : "";
      out.push(`    ${row.name} (${row.id}) · ${row.mode} · next: ${row.next} · last: ${row.last}${where}${into}`);
      for (const line of row.runs) out.push(...row_(line));
      const older = olderText({ older: row.older, moreRuns: row.moreRuns });
      if (older) out.push(`          ${older}`);
    }
    out.push(...more(omitted.automations));
  }
  const notListed = notListedText({ lines: [], ...report.outsideNotListed });
  out.push("", `Outside Main: open, with no parent, not under Main (${report.outside.length + omitted.outside}${notListed ? `; ${notListed}` : ""})`);
  if (report.outside.length === 0) out.push("    nothing");
  for (const line of report.outside) {
    const where = line.project === null ? "" : `  [project: ${line.project}]`;
    const under = line.under === 0 ? "" : `  [${line.under} under it]`;
    out.push(`    ${line.label} · ${line.since}  ${line.title} (${line.id})${where}${under}`);
  }
  out.push(...more(omitted.outside));
  if (report.truncated) out.push("", "bb has more threads than cow reads; some may be missing.");
  return `${out.join("\n")}\n`;
}
