// Threads a script automation started. A script run has no thread of its
// own: when the script starts one (`bb thread spawn …`), it says so with
// `bb cow automation started <thread> --automation "$BB_AUTOMATION_ID"`, and
// cow lists that thread under the automation as it lists an agent run's.
//
// The record is cow's alone, kept in its own storage: nothing in bb is
// changed, no thread is re-parented, and a thread under Main stays in the
// tree. It changes only where a thread is listed, so any thread or script on
// the machine may make it; each one made or cleared goes in cow's log.

import { z } from "zod";
import type { AutomationRecord, AutomationsRead, RunRecord } from "./automations.ts";
import { type Kv, Refusal, serial } from "./kv.ts";

export { AUTOMATION_RUNS_CHANGED } from "./automations.ts";

export const runRecordSchema = z.object({
  automationId: z.string().min(1).max(200),
  /** The run that started it, when the script said (`$BB_AUTOMATION_RUN_ID`). */
  runId: z.string().min(1).max(200).nullable(),
  at: z.number(),
  /** The thread that ran the command; null for a script or a terminal. */
  by: z.string().nullable(),
});
export type StartedRecord = z.infer<typeof runRecordSchema>;

/** The id a run row made from a record has, when no run of the plugin's is known to be it. */
export const recordedRunId = (threadId: string): string => `cow-recorded:${threadId}`;

/**
 * The automations as read, with each recorded thread put where it belongs:
 * on its run when that run was read and names no thread, otherwise as a run
 * of its own at the time it was recorded. A record for an automation that is
 * not there (deleted) is left out: its thread is listed wherever it would be
 * without it, as an agent automation's threads are once it is deleted.
 */
export function withRecorded(read: AutomationsRead, records: ReadonlyMap<string, StartedRecord>): AutomationsRead {
  if (!read.available || records.size === 0) return read;
  const byAutomation = new Map<string, [string, StartedRecord][]>();
  for (const entry of records) byAutomation.set(entry[1].automationId, [...(byAutomation.get(entry[1].automationId) ?? []), entry]);
  return {
    ...read,
    automations: read.automations.map((entry) => {
      const mine = byAutomation.get(entry.automation.id);
      if (!mine) return entry;
      const runs = entry.runs.map((run) => ({ ...run }));
      const named = new Set(runs.flatMap((run) => (run.threadId === null ? [] : [run.threadId])));
      for (const [threadId, record] of mine) {
        if (named.has(threadId)) continue;
        const own = record.runId === null ? undefined : runs.find((run) => run.id === record.runId && run.threadId === null);
        if (own) own.threadId = threadId;
        else runs.push(recordedRun(threadId, record));
        named.add(threadId);
      }
      runs.sort((a, b) => (b.startedAt ?? b.scheduledFor ?? b.finishedAt ?? 0) - (a.startedAt ?? a.scheduledFor ?? a.finishedAt ?? 0) || a.id.localeCompare(b.id));
      return { ...entry, runs };
    }),
  };
}

function recordedRun(threadId: string, record: StartedRecord): RunRecord {
  return { id: recordedRunId(threadId), threadId, status: "succeeded", skipReason: null, error: null, output: null, exitCode: null, scheduledFor: null, startedAt: record.at, finishedAt: record.at };
}

// ---- the store and the command's rules ---------------------------------------

const KEY = "automation-run:";

export interface StartedDeps {
  kv: Kv;
  now(): number;
  /** The thread's title, or null when bb has no such thread. */
  thread(threadId: string): Promise<{ title: string } | null>;
  /** bb's automations as read now, without the records. */
  automations(): Promise<AutomationsRead>;
  /** The ids of an automation's latest runs, newest first; null when they could not be read. */
  runIds(automation: AutomationRecord): Promise<readonly string[] | null>;
  /** Write what was done to cow's log. */
  log(event: { action: "recorded" | "cleared"; threadId: string; automationId: string; name: string; runId: string | null; by: string | null }): Promise<void>;
  changed(): void;
}

export interface StartedResult {
  threadId: string;
  title: string;
  automation: { id: string; name: string };
  runId: string | null;
  /** False when the same record was there already, or there was none to clear. */
  changed: boolean;
}

export interface StartedStore {
  all(): Promise<Map<string, StartedRecord>>;
  /** Record that `threadId` was started by a run of `automation` (its id or name). */
  record(args: { threadId: string; automation: string; runId: string | null; callerId: string | null }): Promise<StartedResult>;
  /** Take the record away; with `automation`, only when it is that one's. */
  clear(args: { threadId: string; automation: string | null; callerId: string | null }): Promise<StartedResult>;
  /** Forget a thread bb deleted. */
  forget(threadId: string): Promise<void>;
}

const LIST_HINT = "`bb automation list --project <project>` lists ids and names; a script automation's run has its own as $BB_AUTOMATION_ID.";

/** The automation `given` names: its id, or a name only one automation has. */
function findAutomation(read: AutomationsRead, given: string): AutomationRecord {
  if (!read.available) throw new Refusal("automations_unavailable", "bb's automations could not be read just now", "Check that the automations plugin is enabled (`bb plugin list`), then try again.");
  const all = read.automations.map((entry) => entry.automation);
  const byId = all.find((automation) => automation.id === given);
  if (byId) return byId;
  const named = all.filter((automation) => automation.name === given.trim());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Refusal("automation_ambiguous", `${named.length} automations are named “${given.trim()}”: ${named.map((a) => a.id).join(", ")}`, "Pass the automation's id with --automation.");
  throw new Refusal("automation_not_found", `there is no automation ${given}`, LIST_HINT);
}

export function createStartedStore(deps: StartedDeps): StartedStore {
  const locked = serial();
  const read = async (threadId: string): Promise<StartedRecord | null> => {
    const found = runRecordSchema.safeParse(await deps.kv.get(KEY + threadId));
    return found.success ? found.data : null;
  };
  const all = async () => {
    const keys = await deps.kv.list(KEY);
    const found = new Map<string, StartedRecord>();
    for (const key of keys) {
      const parsed = runRecordSchema.safeParse(await deps.kv.get(key));
      if (parsed.success) found.set(key.slice(KEY.length), parsed.data);
    }
    return found;
  };
  const thread = async (threadId: string) => {
    const found = await deps.thread(threadId);
    if (!found) throw new Refusal("thread_not_found", `there is no thread ${threadId}`, "Pass the id `bb thread spawn --json` printed (its .id); `bb thread list` shows thread ids.");
    return found;
  };
  const result = (threadId: string, title: string, automation: StartedResult["automation"], runId: string | null, changed: boolean): StartedResult => ({
    threadId,
    title,
    automation: { id: automation.id, name: automation.name },
    runId,
    changed,
  });

  return {
    all,
    record: ({ threadId, automation: given, runId, callerId }) =>
      locked(threadId, async () => {
        const { title } = await thread(threadId);
        const read_ = await deps.automations();
        const automation = findAutomation(read_, given);
        if (automation.mode !== "script") {
          throw new Refusal("not_a_script", `“${automation.name}” (${automation.id}) is an agent automation: bb records the thread of each of its runs itself`, "Only a script automation's runs need this.");
        }
        // A thread bb itself names as another automation's run stays that one's.
        const theirs = read_.automations.find((entry) => entry.automation.id !== automation.id && (entry.automation.lastRunThreadId === threadId || entry.runs.some((run) => run.threadId === threadId)));
        if (theirs) {
          throw new Refusal("thread_is_another_run", `${threadId} is a run of the automation “${theirs.automation.name}” (${theirs.automation.id}), as bb records it`, "Check the id the script printed: it is not the thread this run started.");
        }
        const before = await read(threadId);
        const known = new Set(read_.automations.map((entry) => entry.automation.id));
        if (before && before.automationId !== automation.id && known.has(before.automationId)) {
          const other = read_.automations.find((entry) => entry.automation.id === before.automationId)!.automation;
          throw new Refusal(
            "recorded_for_another",
            `${threadId} is already recorded as started by the automation “${other.name}” (${other.id})`,
            `If that is wrong, clear it first: bb cow automation started ${threadId} --clear`,
          );
        }
        if (runId !== null) {
          const ids = await deps.runIds(automation);
          if (ids !== null && !ids.includes(runId)) {
            throw new Refusal("run_not_found", `the automation “${automation.name}” (${automation.id}) has no recent run ${runId}`, "Pass the run's own id, $BB_AUTOMATION_RUN_ID, or leave --run out: the thread is then listed as a run of its own.");
          }
        }
        if (before && before.automationId === automation.id) {
          if (before.runId === runId || runId === null) return result(threadId, title, automation, before.runId, false);
          if (before.runId !== null) {
            throw new Refusal("recorded_for_another_run", `${threadId} is already recorded as started by run ${before.runId} of “${automation.name}”`, `If that is wrong, clear it first: bb cow automation started ${threadId} --clear`);
          }
        }
        const record: StartedRecord = { automationId: automation.id, runId, at: deps.now(), by: callerId };
        await deps.kv.set(KEY + threadId, record);
        await deps.log({ action: "recorded", threadId, automationId: automation.id, name: automation.name, runId, by: callerId });
        deps.changed();
        return result(threadId, title, automation, runId, true);
      }),
    clear: ({ threadId, automation: given, callerId }) =>
      locked(threadId, async () => {
        const before = await read(threadId);
        const read_ = await deps.automations();
        const named = given === null ? null : findAutomation(read_, given);
        const title = (await deps.thread(threadId))?.title ?? threadId;
        const id = named?.id ?? before?.automationId ?? "";
        // A record whose automation was deleted is named by its id.
        const automation = { id, name: read_.automations.find((entry) => entry.automation.id === id)?.automation.name ?? id };
        if (!before) return result(threadId, title, automation, null, false);
        if (named && named.id !== before.automationId) {
          throw new Refusal("recorded_for_another", `${threadId} is recorded as started by the automation ${before.automationId}, not “${named.name}” (${named.id})`, `Leave --automation out to clear it whichever it is: bb cow automation started ${threadId} --clear`);
        }
        await deps.kv.delete(KEY + threadId);
        await deps.log({ action: "cleared", threadId, automationId: before.automationId, name: automation.name, runId: before.runId, by: callerId });
        deps.changed();
        return result(threadId, title, automation, before.runId, true);
      }),
    forget: (threadId) =>
      locked(threadId, async () => {
        if ((await read(threadId)) === null) return;
        await deps.kv.delete(KEY + threadId);
        deps.changed();
      }),
  };
}
