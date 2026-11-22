// Automations: bb's scheduled runs, one row per automation with its recent
// run threads under it. A run of an agent automation is a new thread with no
// parent, so the tree never reaches it; this section does.
//
// Everything here is pure: what the automations plugin answered, read
// without trusting its shape, and shaped into rows. cow's server asks the
// plugin (see `automations-backend.ts`); the page and the CLI shape the same
// answer the same way.

import type { ThreadFacts } from "./state.ts";
import { firstLine } from "./text.ts";
import type { Line } from "./tree.ts";

/** Realtime channel: published whenever cow records, or clears, which thread a script automation's run started. */
export const AUTOMATION_RUNS_CHANGED = "automation-runs-changed";

/** The bundled plugin that runs automations. */
export const AUTOMATIONS_PLUGIN = "automations";

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export type Trigger =
  | { kind: "schedule"; cron: string; timezone: string | null }
  | { kind: "once"; runAt: number | null }
  | { kind: "other" };

export interface AutomationRecord {
  id: string;
  projectId: string;
  /** Its bb project's name, as the plugin gives it; null without. */
  projectName: string | null;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  mode: "agent" | "script";
  /** An agent automation that sends into an existing thread instead of starting one. */
  targetThreadId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  lastRunStatus: RunStatus | null;
  lastRunThreadId: string | null;
  lastError: string | null;
}

export interface RunRecord {
  id: string;
  threadId: string | null;
  status: RunStatus;
  skipReason: string | null;
  error: string | null;
  /** What a script printed, as the plugin kept it. */
  output: string | null;
  exitCode: number | null;
  scheduledFor: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** What cow's server answers: every automation, and for each enabled one its latest runs, newest first. */
export interface AutomationsRead {
  /** False when the automations plugin is absent, disabled, or did not answer in time: then there is no section. */
  available: boolean;
  automations: { automation: AutomationRecord; runs: RunRecord[]; moreRuns: boolean }[];
}

export const NO_AUTOMATIONS: AutomationsRead = { available: false, automations: [] };

/** Every thread the automations' runs name, newest runs first: the threads whose notes and activity are read with the overview. */
export function runThreadIds(read: AutomationsRead): string[] {
  const ids = new Set<string>();
  for (const { automation, runs } of read.automations) {
    for (const run of runs) if (run.threadId !== null) ids.add(run.threadId);
    if (automation.lastRunThreadId !== null) ids.add(automation.lastRunThreadId);
  }
  return [...ids];
}

// ---- reading the plugin's answers ------------------------------------------

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const status = (value: unknown): RunStatus | null =>
  value === "running" || value === "succeeded" || value === "failed" || value === "skipped" ? value : null;
/** What is kept of a long text the plugin gives: enough for a line and a look. */
const MAX_TEXT = 20_000;
const clip = (value: unknown): string | null => {
  const text = str(value);
  return text === null ? null : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
};

function toTrigger(raw: unknown): Trigger {
  const r = record(raw);
  if (r?.triggerType === "schedule" && typeof r.cron === "string") return { kind: "schedule", cron: r.cron, timezone: str(r.timezone) };
  if (r?.triggerType === "once") return { kind: "once", runAt: num(r.runAt) };
  return { kind: "other" };
}

/** One automation, from an entry of `automations_overview`: `{automation, project}` or the automation alone. */
export function toAutomation(raw: unknown): AutomationRecord | null {
  const entry = record(raw);
  const r = record(entry?.automation) ?? entry;
  if (!r) return null;
  const id = str(r.id);
  const projectId = str(r.projectId);
  if (id === null || projectId === null) return null;
  const execution = record(r.execution);
  return {
    id,
    projectId,
    projectName: str(record(entry?.project)?.name),
    name: str(r.name)?.trim() || id,
    enabled: r.enabled !== false,
    trigger: toTrigger(r.trigger),
    mode: execution?.mode === "script" ? "script" : "agent",
    targetThreadId: str(execution?.targetThreadId),
    nextRunAt: num(r.nextRunAt),
    lastRunAt: num(r.lastRunAt),
    runCount: num(r.runCount) ?? 0,
    lastRunStatus: status(r.lastRunStatus),
    lastRunThreadId: str(r.lastRunThreadId),
    lastError: clip(r.lastError),
  };
}

/** Every automation in an `automations_overview` answer; what cannot be read is left out. */
export function parseOverview(raw: unknown): AutomationRecord[] {
  const list = record(raw)?.automations ?? raw;
  if (!Array.isArray(list)) return [];
  return list.map(toAutomation).filter((found): found is AutomationRecord => found !== null);
}

export function toRun(raw: unknown): RunRecord | null {
  const r = record(raw);
  const id = str(r?.id);
  const runStatus = status(r?.status);
  if (!r || id === null || runStatus === null) return null;
  return {
    id,
    threadId: str(r.threadId),
    status: runStatus,
    skipReason: clip(r.skipReason),
    error: clip(r.error),
    output: clip(r.output),
    exitCode: num(r.exitCode),
    scheduledFor: num(r.scheduledFor),
    startedAt: num(r.startedAt),
    finishedAt: num(r.finishedAt),
  };
}

/** When a run happened, for ordering: started, else due, else finished. */
export const runAt = (run: RunRecord): number => run.startedAt ?? run.scheduledFor ?? run.finishedAt ?? 0;

/** The runs in an `automations_runs` answer, newest first, and whether it has more. */
export function parseRuns(raw: unknown): { runs: RunRecord[]; more: boolean } {
  const r = record(raw);
  const list = Array.isArray(r?.runs) ? r.runs : [];
  const runs = list.map(toRun).filter((found): found is RunRecord => found !== null);
  runs.sort((a, b) => runAt(b) - runAt(a) || a.id.localeCompare(b.id));
  return { runs, more: str(r?.nextCursor) !== null };
}

// ---- in words ----------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A time's day and hour in `timeZone` (the machine's own when absent). */
function local(at: number, timeZone?: string): { day: string; weekday: string; date: string; time: string } {
  const parts = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...options, ...(timeZone ? { timeZone } : {}) }).format(at);
  return {
    day: parts({ year: "numeric", month: "2-digit", day: "2-digit" }),
    weekday: parts({ weekday: "short" }),
    date: parts({ day: "numeric", month: "short" }),
    time: parts({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
}

/** When an automation runs next, in plain words: "in 3h", "tomorrow 09:00", "paused", "ran once". */
export function nextRunText(automation: AutomationRecord, now: number, timeZone?: string): string {
  if (!automation.enabled) return "paused";
  const at = automation.nextRunAt;
  if (at === null) return automation.trigger.kind === "once" && automation.runCount > 0 ? "ran once" : "not scheduled";
  const wait = at - now;
  if (wait < MINUTE) return "due now";
  if (wait < HOUR) return `in ${Math.floor(wait / MINUTE)}m`;
  if (wait < 12 * HOUR) return `in ${Math.floor(wait / HOUR)}h`;
  const then = local(at, timeZone);
  if (then.day === local(now, timeZone).day) return `today ${then.time}`;
  if (then.day === local(now + DAY, timeZone).day) return `tomorrow ${then.time}`;
  if (wait < 6 * DAY) return `${then.weekday} ${then.time}`;
  return `${then.date} ${then.time}`;
}

/**
 * What `e` asks before it deletes an automation: its name, whether it is
 * enabled and when it would run next, that its past runs stay, and that it
 * cannot be undone.
 */
export function deleteConfirmText(automation: AutomationRecord, now: number, timeZone?: string): string {
  const state = !automation.enabled ? "it is paused" : automation.nextRunAt === null ? `it is enabled, ${nextRunText(automation, now, timeZone)}` : `it is enabled and would next run ${nextRunText(automation, now, timeZone)}`;
  return `delete the automation “${automation.name}”? ${state} · its past run threads are not deleted · this cannot be undone · y deletes it, any other key cancels`;
}

/** What an automation's last run came to. */
export interface LastResult {
  kind: "never" | "running" | "done" | "succeeded" | "wants" | "failed" | "skipped";
  /** When it started, for one running; when it ended otherwise. Null when not known. */
  at: number | null;
  /** For a failed or skipped run: the first line of why. */
  why: string | null;
}

/**
 * The last run's result. For an agent run, the plugin's "succeeded" only
 * means the turn ended: what the run came to is its thread's state, as cow
 * reads it, when that thread is known. So it is for a script run that
 * recorded the thread it started (`automation-runs.ts`).
 */
export function lastResult(automation: AutomationRecord, latest: RunRecord | null, thread: Line | null): LastResult {
  const statusOf = latest?.status ?? automation.lastRunStatus;
  const at = latest ? (latest.status === "running" ? runAt(latest) : (latest.finishedAt ?? runAt(latest))) : automation.lastRunAt;
  if (statusOf === null) return { kind: "never", at: null, why: null };
  if (statusOf === "running") return { kind: "running", at, why: null };
  if (statusOf === "failed") return { kind: "failed", at, why: firstLine(latest?.error ?? automation.lastError) || null };
  if (statusOf === "skipped") return { kind: "skipped", at, why: firstLine(latest?.skipReason) || null };
  // A script run's thread, when the script said which it started, is read as an agent run's.
  if (automation.mode === "script" && thread === null) return { kind: "succeeded", at, why: null };
  if (thread === null) return { kind: "done", at, why: null };
  const { derived } = thread;
  if (derived.state === "failed") return { kind: "failed", at: derived.since, why: firstLine(derived.doing) || null };
  if (derived.waitingOnYou) return { kind: "wants", at: derived.since, why: null };
  if (derived.state === "running" || derived.state === "stuck") return { kind: "running", at: derived.since, why: null };
  return { kind: "done", at, why: null };
}

const RESULT_WORD: Record<LastResult["kind"], string> = {
  never: "never ran",
  running: "running",
  done: "done",
  succeeded: "succeeded",
  wants: "wants you",
  failed: "failed",
  skipped: "skipped",
};

/** The last result as a row says it: "failed 2h ago: exit code 1", "running for 5m", "never ran". */
export function lastResultText(result: LastResult, now: number, age: (ms: number) => string): string {
  const word = RESULT_WORD[result.kind];
  if (result.at === null) return word;
  const ago = age(Math.max(0, now - result.at));
  const when = result.kind === "running" ? `${word} for ${ago}` : result.kind === "wants" ? `${word} · ${ago}` : `${word} ${ago} ago`;
  return result.why ? `${when}: ${result.why}` : when;
}

// ---- rows --------------------------------------------------------------------

/** At most this many run threads are listed under an automation; the rest are counted. */
export const RUNS_LISTED = 5;

export const automationRowId = (automationId: string): string => `automation:${automationId}`;
export const isAutomationRow = (id: string | null): boolean => id !== null && id.startsWith("automation:");

export interface AutomationGroup {
  /** What the cursor holds on its row. */
  id: string;
  automation: AutomationRecord;
  /** Its project's name, when that is not Main's project. */
  project: string | null;
  /** Its recent run threads, newest first, at most `RUNS_LISTED`, as cow lines. */
  runs: Line[];
  /** Run threads not listed: older ones, open, that were read. */
  older: number;
  /** The plugin has older runs than were read. */
  moreRuns: boolean;
  /** Its latest run, when one was read. */
  latest: RunRecord | null;
  last: LastResult;
  /** An agent automation that sends into a thread under Main: its runs are in the tree, not here. */
  intoTree: boolean;
}

export interface AutomationSection {
  /** False when there is no section to show. */
  available: boolean;
  groups: AutomationGroup[];
  /** Every run thread this section takes, listed or counted: they are not counted again under Outside Main. */
  threadIds: ReadonlySet<string>;
}

export const NO_SECTION: AutomationSection = { available: false, groups: [], threadIds: new Set() };

/**
 * One row per automation, enabled ones first, then by name; under each, its
 * run threads that are open and not under Main, newest first. A thread under
 * Main (or Main itself, or one above it) stays where the tree has it.
 */
export function automationSection(
  read: AutomationsRead,
  threads: readonly ThreadFacts[],
  inTree: ReadonlySet<string>,
  mainProjectId: string,
  lineOf: (thread: ThreadFacts, group: string) => Line,
): AutomationSection {
  if (!read.available) return NO_SECTION;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const taken = new Set<string>();
  const groups: AutomationGroup[] = [];
  const entries = [...read.automations].sort(
    (a, b) => Number(b.automation.enabled) - Number(a.automation.enabled) || a.automation.name.localeCompare(b.automation.name) || a.automation.id.localeCompare(b.automation.id),
  );
  for (const { automation, runs, moreRuns } of entries) {
    const id = automationRowId(automation.id);
    const named = runs.map((run) => run.threadId);
    // Without runs read (a paused one), its last run's thread still belongs to it.
    if (named.length === 0 && automation.lastRunThreadId !== null) named.push(automation.lastRunThreadId);
    const own: ThreadFacts[] = [];
    for (const threadId of named) {
      if (threadId === null || taken.has(threadId) || inTree.has(threadId)) continue;
      const thread = byId.get(threadId);
      if (!thread || thread.archivedAt !== null) continue;
      taken.add(threadId);
      own.push(thread);
    }
    const lines = own.slice(0, RUNS_LISTED).map((thread) => lineOf(thread, id));
    const latest = runs[0] ?? null;
    const latestThread = latest?.threadId ?? automation.lastRunThreadId;
    const latestLine = lines.find((line) => line.thread.id === latestThread) ?? null;
    groups.push({
      id,
      automation,
      project: automation.projectId === mainProjectId ? null : (automation.projectName ?? automation.projectId),
      runs: lines,
      older: Math.max(0, own.length - RUNS_LISTED),
      moreRuns,
      latest,
      last: lastResult(automation, latest, latestLine),
      intoTree: automation.targetThreadId !== null && inTree.has(automation.targetThreadId),
    });
  }
  return { available: true, groups, threadIds: taken };
}

/** What is said after an automation's run lines: how many are not listed. */
export function olderText(group: Pick<AutomationGroup, "older" | "moreRuns">): string {
  if (group.older === 0 && !group.moreRuns) return "";
  return group.moreRuns ? `${group.older > 0 ? `${group.older} older, and more` : "older runs"} not listed` : `${group.older} older not listed`;
}

/**
 * What a run thread waits on the person for: only bb's own question or
 * permission request, an open ask, or a permission bb refused it without
 * asking that has not been dismissed (granting or dismissing it is theirs).
 */
export const runNeedsPerson = (line: Line): boolean =>
  line.thread.hasPendingInteraction || (line.derived.asks?.length ?? 0) > 0 || line.derived.blocked !== undefined;

/** The script output of an automation's latest run, for the reader; null when there is none to show. */
export function scriptOutput(group: AutomationGroup): string | null {
  const run = group.latest;
  if (group.automation.mode !== "script" || !run) return null;
  const parts = [run.output, run.error ? `error: ${run.error}` : null].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `${parts.join("\n\n")}${run.exitCode !== null ? `\n\nexit code ${run.exitCode}` : ""}`;
}
