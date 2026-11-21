// What cow does to a thread, on the backend: its notes, archiving, and the
// rules the verbs follow. The page's RPCs and the CLI both act through here.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type Ask, asksByThread } from "./asks/ask.ts";
import type { BriefMark } from "./briefs/review.ts";
import { type ThreadReader, listThreads, readActivity, toFacts } from "./activity.ts";
import { parkNow, reparkNow } from "./park.ts";
import { parsePickUp } from "./pickup.ts";
import { waitNote } from "./waiting.ts";
import { type TodoChange, nextText, planRefused, todoAdd, todoMove, todoTake, todoTakeId, todoTitle } from "./plans.ts";
import {
  ARCHIVE_KEY,
  type ArchiveNote,
  DISMISS_KEY,
  type Dismissal,
  KEEP_KEY,
  type KeepNote,
  NEXT_KEY,
  NOTES_CHANGED,
  type NextNote,
  PARK_KEY,
  PROJECT_KEY,
  type ParkRecord,
  type ProjectMark,
  type Seen,
  TODO_KEY,
  type TodoItem,
  WAIT_KEY,
  type WaitNote,
  archiveNoteSchema,
  dismissalSchema,
  keepNoteSchema,
  nextNoteSchema,
  parkRecordSchema,
  projectMarkSchema,
  seenSchema,
  todoListSchema,
  waitNoteSchema,
} from "./shared.ts";
import { type Activity, LIMITS, type OutsideFlag, type ThreadFacts, derive, isBusy } from "./state.ts";
import { AUTOMATIONS_PLUGIN, type AutomationsRead, NO_AUTOMATIONS, runThreadIds } from "./automations.ts";
import { Refusal } from "./kv.ts";
import { type Judgement, type LabelNote, type LedgerRow, type LedgerSummary, type Outcome, PERSON, type RowCost, inWindow, labelOf, summarize } from "./ledger.ts";
import type { LedgerStore } from "./ledger-store.ts";
import { type StatusReport, statusReport } from "./status.ts";
import { type Line, archivedOutsideIds, buildOverview, descendantIds, lineOf, projectIds, workerShaped } from "./tree.ts";
import { NOT_UNDER_MAIN, insteadFromCli, verbBlocked } from "./verbs.ts";
import { archivePlace } from "./outside.ts";
import { type TraceAction, type TraceInput, parkWaitedOn } from "./traces.ts";

/** bb reads plugin metadata for at most this many threads per request. */
const METADATA_PAGE = 200;
/** Activity is read for at most this many threads per command; the rest show what bb's list says. */
const MAX_ACTIVITY = 300;
const ACTIVITY_CONCURRENCY = 6;
export const MAX_REASON = 300;
/** Where cow keeps, per thread, the reply the person has seen. */
const SEEN_PREFIX = "seen:";

/** A refusal the caller can act on: what is wrong, and what to do instead. */
export class CowError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export interface Notes {
  parks: Record<string, ParkRecord>;
  archives: Record<string, ArchiveNote>;
  dismissals: Record<string, Dismissal>;
  /** Each thread's own words on what is next, and what it has not started. */
  nexts: Record<string, NextNote>;
  todos: Record<string, TodoItem[]>;
  /** The reply of each thread the person has seen. */
  seen: Record<string, Seen>;
  /** The threads marked as projects. */
  projects: Record<string, ProjectMark>;
  /** The threads that said they wait on someone other than the person. */
  waits: Record<string, WaitNote>;
  /** The threads the person keeps on the Kept shelf. */
  keeps: Record<string, KeepNote>;
}

/** A change to a thread's list of work not started. */
export type TodoOp =
  | { kind: "add"; title: string }
  /** Started (`done`) or dropped (`rm`): either way it leaves the list. */
  | { kind: "take"; n: number }
  | { kind: "take-id"; id: string }
  | { kind: "move"; id: string; by: 1 | -1 };

export interface MainRecord {
  mains: Record<string, string>;
  currentProjectId: string | null;
}

export interface Actions {
  notes(threadIds: readonly string[]): Promise<Notes>;
  setPark(threadId: string, park: ParkRecord | null): Promise<void>;
  setArchiveNote(threadId: string, note: ArchiveNote | null): Promise<void>;
  setDismissal(threadId: string, dismissal: Dismissal | null): Promise<void>;
  /** Record the reply the person has seen, or with null forget it. Kept in cow's own storage. */
  setSeen(threadId: string, seen: Seen | null): Promise<void>;
  /** Mark a thread as a project, or with null take the mark off. */
  setProject(threadId: string, project: ProjectMark | null): Promise<void>;
  /** Say a thread waits on someone other than the person, or with null that it no longer does. */
  setWait(threadId: string, wait: WaitNote | null): Promise<void>;
  /** Keep a thread on the Kept shelf, or with null take it off. Keeping it takes it off the Parked shelf. */
  setKeep(threadId: string, keep: KeepNote | null): Promise<void>;
  /** The same as the CLI sets it: `callerId` may set it only on itself and what is under it. */
  waitChecked(args: { callerId: string | null; threadId: string; wait: { on: string; for: string | null; remind: string } | null }): Promise<{ title: string; wait: WaitNote | null }>;
  /** The mark as the CLI sets it: `callerId` may mark only itself and what is under it. */
  projectChecked(args: { callerId: string | null; threadId: string; on: boolean }): Promise<{ title: string; project: ProjectMark | null }>;
  /** Forget what cow keeps about a thread that bb has deleted. */
  forget(threadId: string): Promise<void>;
  /** Forget what cow keeps in its own storage about threads bb no longer has. Returns how many it forgot. */
  sweep(): Promise<number>;
  /** Change a thread's list of work not started; the page's own changes come through here. */
  todo(threadId: string, op: TodoOp): Promise<{ list: TodoItem[]; item: TodoItem }>;
  /** The plans as the CLI writes them: `callerId` may plan only for itself and what is under it. */
  nextChecked(args: { callerId: string | null; threadId: string; text: string | null }): Promise<{ title: string; note: NextNote | null }>;
  todoChecked(args: { callerId: string | null; threadId: string; op: TodoOp | null }): Promise<{ title: string; list: TodoItem[]; item: TodoItem | null }>;
  /** Record the reason (or forget an earlier one), stop it when dropped, and archive it in bb. A worker gets its ledger row. `by`: "person" (the default) or the archiving thread's id. */
  archive(args: { threadId: string; reason: string | null; dropped: boolean; at: number; by?: string }): Promise<void>;
  /** The verbs as the CLI runs them: the page's rules first, then the same action. */
  /** `callerId`: the thread that ran the command, or null for the person. Outside Main, only Main, the person, or the thread itself archives. */
  /** `outcome`: what the worker came to, judged by the caller; refused before anything is archived when it cannot be given. */
  /** `label`: the kind of job, set under `labelChecked`'s rule; refused before anything is archived when it cannot be set. */
  archiveChecked(args: { callerId: string | null; threadId: string; reason: string | null; outcome?: Outcome | null; label?: string | null }): Promise<{ title: string; under: number; outside: boolean }>;
  /** Judge what a worker came to, open or archived, under archive's rule of who may. `callerId` null: the person. `label` as on archive. */
  outcomeChecked(args: { callerId: string | null; threadId: string; outcome: Outcome; label?: string | null }): Promise<{ title: string; archived: boolean; judgement: Judgement; changes: number; row: boolean }>;
  /**
   * A worker's label, the kind of job: shown (`label` undefined), set, or cleared (null). Who may set it is who may
   * set its outcome: archive's rule of where it stands, and a thread never overwrites or clears the person's.
   * It can be set before the worker finished a turn, and after it is archived; its row follows.
   */
  labelChecked(args: { callerId: string | null; threadId: string; label?: string | null }): Promise<{ title: string; archived: boolean; label: LabelNote | null; row: boolean }>;
  /**
   * The ledger's rows archived in the last `days` days, newest first, their summary, and the latest outcome of every worker that has one.
   * `costs`: each row's list-price dollars, worked out now (null: usage unknown or no price); `priceError`: why the price setting was not read.
   */
  ledger(days: number): Promise<{ rows: LedgerRow[]; summary: LedgerSummary; outcomes: Record<string, Judgement>; costs: Record<string, number | null>; priceError: string | null }>;
  /** The main the CLI means: the one given, or the one chosen for this project, or the last one chosen. */
  mainFor(mainId: string | null, projectId: string | null): Promise<string>;
  /** `callerId`: the thread that ran the command, or null for one run outside any thread (the person). An agent that parks what waited on the person leaves a trace. */
  parkChecked(args: { callerId: string | null; threadId: string; reason: string; pickUp: string; stop: boolean }): Promise<{ title: string; record: ParkRecord; kept: boolean; traced: boolean }>;
  resumeChecked(threadId: string): Promise<{ title: string }>;
  status(mainId: string | null, projectId: string | null): Promise<StatusReport>;
}

/** Where the actions read what threads have put in front of the user. */
export interface RaisedSource {
  openAsks(): Promise<readonly Ask[]>;
  /** Thread id to when cow delivered the person's answers to its asks. */
  delivered?(): Promise<ReadonlyMap<string, readonly number[]>>;
  marks(threadIds: readonly string[]): Promise<ReadonlyMap<string, BriefMark>>;
  /** Thread id to the decisions on its permission requests that were made outside cow and are not acknowledged. */
  outside?(): Promise<ReadonlyMap<string, readonly OutsideFlag[]>>;
  /** bb's automations and their latest runs, for the overview's Automations section. */
  automations?(): Promise<AutomationsRead>;
  /** Record a trace: an agent took something out of the person's queue. */
  trace?(input: TraceInput): Promise<void>;
  /** The traces the person has not acknowledged, oldest first. */
  traces?(): Promise<readonly TraceNotice[]>;
}

/** A trace not yet acknowledged, as `bb cow status` lists it. */
export interface TraceNotice {
  id: string;
  threadId: string;
  actorThreadId: string;
  action: TraceAction;
  text: string;
  at: number;
}

/** What each ledger row cost at list price, with the prices as set now. */
export type Costing = (rows: readonly LedgerRow[]) => Promise<{ cost: RowCost; error: string | null }>;

export function createActions(bb: BbPluginApi, readMains: () => Promise<MainRecord>, raised?: RaisedSource, ledger?: LedgerStore, costing?: Costing): Actions {
  const reader: ThreadReader = bb.sdk.threads;

  const notes = async (threadIds: readonly string[]): Promise<Notes> => {
    const found: Notes = { parks: {}, archives: {}, dismissals: {}, nexts: {}, todos: {}, seen: {}, projects: {}, waits: {}, keeps: {} };
    for (let offset = 0; offset < threadIds.length; offset += METADATA_PAGE) {
      const page = await bb.sdk.threads.experimental_listPluginMetadata({
        threadIds: threadIds.slice(offset, offset + METADATA_PAGE),
      });
      for (const { threadId, metadata } of page.threads) {
        const park = parkRecordSchema.safeParse(metadata[PARK_KEY]);
        if (park.success) found.parks[threadId] = park.data;
        const archive = archiveNoteSchema.safeParse(metadata[ARCHIVE_KEY]);
        if (archive.success) found.archives[threadId] = archive.data;
        const dismissal = dismissalSchema.safeParse(metadata[DISMISS_KEY]);
        if (dismissal.success) found.dismissals[threadId] = dismissal.data;
        const next = nextNoteSchema.safeParse(metadata[NEXT_KEY]);
        if (next.success) found.nexts[threadId] = next.data;
        const project = projectMarkSchema.safeParse(metadata[PROJECT_KEY]);
        if (project.success) found.projects[threadId] = project.data;
        const wait = waitNoteSchema.safeParse(metadata[WAIT_KEY]);
        if (wait.success) found.waits[threadId] = wait.data;
        const keep = keepNoteSchema.safeParse(metadata[KEEP_KEY]);
        if (keep.success) found.keeps[threadId] = keep.data;
        const todo = todoListSchema.safeParse(metadata[TODO_KEY]);
        if (todo.success && todo.data.length > 0) found.todos[threadId] = todo.data;
      }
    }
    // One key per thread, so marking one never rewrites another.
    const wanted = new Set(threadIds);
    const keys = (await bb.storage.kv.list(SEEN_PREFIX)).filter((key) => wanted.has(key.slice(SEEN_PREFIX.length)));
    await Promise.all(
      keys.map(async (key) => {
        const seen = seenSchema.safeParse(await bb.storage.kv.get(key));
        if (seen.success) found.seen[key.slice(SEEN_PREFIX.length)] = seen.data;
      }),
    );
    return found;
  };

  const setNote = async (threadId: string, key: string, value: ParkRecord | ArchiveNote | Dismissal | NextNote | ProjectMark | TodoItem[] | WaitNote | KeepNote | null, alsoRemove: readonly string[] = []) => {
    await bb.sdk.threads.updatePluginMetadata(
      value === null ? { threadId, remove: [key, ...alsoRemove] } : { threadId, set: { [key]: value }, ...(alsoRemove.length > 0 ? { remove: [...alsoRemove] } : {}) },
    );
    bb.realtime.publish(NOTES_CHANGED, {});
  };
  // Parking a thread ends its wait on someone else: the person has set it
  // aside. A thread is on one shelf at a time, so parking takes it off Kept.
  const setPark = (threadId: string, park: ParkRecord | null) => setNote(threadId, PARK_KEY, park, park === null ? [] : [WAIT_KEY, KEEP_KEY]);
  const setKeep = (threadId: string, keep: KeepNote | null) => setNote(threadId, KEEP_KEY, keep, keep === null ? [] : [PARK_KEY]);
  const setWait = (threadId: string, wait: WaitNote | null) => setNote(threadId, WAIT_KEY, wait);
  const setArchiveNote = (threadId: string, note: ArchiveNote | null) => setNote(threadId, ARCHIVE_KEY, note);
  const setDismissal = (threadId: string, dismissal: Dismissal | null) => setNote(threadId, DISMISS_KEY, dismissal);
  const setProject = (threadId: string, project: ProjectMark | null) => setNote(threadId, PROJECT_KEY, project);

  // What cow keeps per thread: its notes and plans in the thread's own
  // metadata, and the reply the person has seen in cow's storage.
  const forget = async (threadId: string) => {
    await bb.storage.kv.delete(SEEN_PREFIX + threadId);
    // bb drops a deleted thread's metadata with it; where it has not, cow's keys are taken off.
    await bb.sdk.threads
      .updatePluginMetadata({ threadId, remove: [PARK_KEY, ARCHIVE_KEY, DISMISS_KEY, NEXT_KEY, TODO_KEY, PROJECT_KEY, WAIT_KEY, KEEP_KEY] })
      .catch(() => undefined);
    bb.realtime.publish(NOTES_CHANGED, {});
  };
  const sweep = async () => {
    const ids = (await bb.storage.kv.list(SEEN_PREFIX)).map((key) => key.slice(SEEN_PREFIX.length));
    let forgotten = 0;
    for (let offset = 0; offset < ids.length; offset += METADATA_PAGE) {
      const page = ids.slice(offset, offset + METADATA_PAGE);
      const alive = new Set<string>();
      for (const raw of await bb.sdk.threads.list({ threadIds: page, limit: METADATA_PAGE, includeHidden: true })) {
        if (raw.deletedAt == null) alive.add(raw.id);
      }
      for (const id of page) {
        if (alive.has(id)) continue;
        await bb.storage.kv.delete(SEEN_PREFIX + id);
        forgotten += 1;
      }
    }
    return forgotten;
  };

  const setSeen = async (threadId: string, seen: Seen | null) => {
    if (seen === null) await bb.storage.kv.delete(SEEN_PREFIX + threadId);
    else await bb.storage.kv.set(SEEN_PREFIX + threadId, seen);
    bb.realtime.publish(NOTES_CHANGED, {});
  };

  /** One change to a thread's list at a time: each reads the list it changes. */
  const todoQueue = new Map<string, Promise<unknown>>();
  const todo: Actions["todo"] = (threadId, op) => {
    const change = async () => {
      const list = (await notes([threadId])).todos[threadId] ?? [];
      const now = Date.now();
      const changed: TodoChange =
        op.kind === "add"
          ? todoAdd(list, op.title, now, `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`)
          : op.kind === "take"
            ? todoTake(list, op.n)
            : op.kind === "take-id"
              ? todoTakeId(list, op.id)
              : todoMove(list, op.id, op.by);
      if (!changed.ok) throw new CowError("bad_todo", changed.error);
      await setNote(threadId, TODO_KEY, changed.list.length === 0 ? null : changed.list);
      return { list: changed.list, item: changed.item };
    };
    const run = (todoQueue.get(threadId) ?? Promise.resolve()).then(change, change);
    todoQueue.set(threadId, run.catch(() => undefined));
    return run;
  };

  /** The thread a plan is for, once the caller is known to be allowed to write it. */
  const planTarget = async (callerId: string | null, threadId: string): Promise<ThreadFacts> => {
    const { threads } = await listThreads(reader);
    const target = threads.find((thread) => thread.id === threadId);
    if (!target) throw new CowError("thread_not_found", `there is no thread ${threadId}`, "Run `bb thread list` to see thread ids.");
    const why = planRefused(threads, callerId, threadId);
    if (why !== null) throw new CowError("not_yours", `cannot set this on “${target.title}” (${threadId}): ${why}`, "Your own id is in $BB_THREAD_ID.");
    return target;
  };

  /** Whether the thread has no parent and is no Main: a line of Outside Main. */
  const isOutside = async (threadId: string): Promise<boolean> => {
    const [raw] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    const found = raw === undefined ? null : toFacts(raw);
    if (found === null || found.parentThreadId !== null) return false;
    return !Object.values((await readMains()).mains).includes(threadId);
  };

  /** Why a thread is no worker for the ledger, or null when it is one: a Main, a project, or an automation's run is not. Whether it finished a turn is the ledger's to say. */
  const notWorker = async (threads: readonly ThreadFacts[], target: ThreadFacts): Promise<string | null> => {
    if (Object.values((await readMains()).mains).includes(target.id)) return "it is a Main, not a worker";
    const marked = Object.keys((await notes([target.id])).projects);
    // A thread under another whose own threads are all archived is a worker; one with a live thread under it, or marked, is a project.
    const project = target.parentThreadId !== null ? !workerShaped(threads, target, marked) : projectIds(threads, marked, null).has(target.id);
    if (project) return "it is a project, not a worker";
    const automations = (await raised?.automations?.().catch(() => NO_AUTOMATIONS)) ?? NO_AUTOMATIONS;
    if (target.originPluginId === AUTOMATIONS_PLUGIN || runThreadIds(automations).includes(target.id)) return "it is an automation's run, not a worker";
    return null;
  };

  /** Write a worker's ledger row once it is archived. Never fails the archive: a row that cannot be written is logged. */
  const recordWorker = async (target: ThreadFacts | undefined, threads: readonly ThreadFacts[], archived: { at: number; by: string }) => {
    if (!ledger || !target) return;
    try {
      if ((await notWorker(threads, target)) !== null) return;
      await ledger.record(target, archived);
    } catch (cause) {
      bb.log.warn(`could not write the ledger row of ${target.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  /** The Main given, or the one chosen for this project, or the last one chosen. */
  const mainOf = async (mainId: string | null, projectId: string | null): Promise<string> => {
    if (mainId !== null) return mainId;
    const mains = await readMains();
    const id = (projectId ? mains.mains[projectId] : undefined) ?? (mains.currentProjectId ? mains.mains[mains.currentProjectId] : undefined) ?? null;
    if (id === null) throw new CowError("no_main", "no Main thread is chosen", "Pass --main <thread>, or choose a Main on cow's page.");
    return id;
  };

  const archive: Actions["archive"] = async ({ threadId, reason, dropped, at, by = PERSON }) => {
    // Its parent now, before bb archives it: the thread that dispatched it.
    const { threads: before } = ledger ? await listThreads(reader) : { threads: [] as ThreadFacts[] };
    // The reason is cow's note on the thread; archiving without one forgets an earlier reason.
    // A thread outside Main keeps a note either way: under no Main once archived, the note is what lists it under Archived.
    const outside = await isOutside(threadId);
    if (reason !== null || outside) await setArchiveNote(threadId, { ...(reason === null ? {} : { reason }), at, ...(outside ? { outside: true as const } : {}) });
    else if ((await notes([threadId])).archives[threadId]) await setArchiveNote(threadId, null);
    // Dropping ends whatever the thread still runs; a thread at rest has
    // nothing to stop, which is not a reason to keep it.
    if (dropped) await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId });
    await recordWorker(before.find((thread) => thread.id === threadId), before, { at, by });
    // An archived thread waits on nobody and is kept by nobody; unarchived, it starts without either note.
    const after = await notes([threadId]);
    if (after.waits[threadId]) await setWait(threadId, null);
    if (after.keeps[threadId]) await setKeep(threadId, null);
  };

  /** Activity for these threads, a few at a time. A thread whose read fails is derived without it. */
  const activities = async (threads: readonly ThreadFacts[]): Promise<Map<string, Activity>> => {
    const found = new Map<string, Activity>();
    const pending = threads.slice(0, MAX_ACTIVITY);
    const work = async () => {
      for (let thread = pending.shift(); thread; thread = pending.shift()) {
        const { id, hasPendingInteraction } = thread;
        await readActivity(reader, id, { asking: hasPendingInteraction }).then(
          (activity) => found.set(id, activity),
          () => undefined,
        );
      }
    };
    await Promise.all(Array.from({ length: ACTIVITY_CONCURRENCY }, work));
    return found;
  };

  /** Everything the rules need to know about what is under `rootId`, read now. */
  const look = async (rootId: string, extra: readonly string[] = []) => {
    const { threads, truncated } = await listThreads(reader);
    const now = Date.now();
    const root = threads.find((thread) => thread.id === rootId);
    if (!root) throw new CowError("thread_not_found", `there is no thread ${rootId}`, "Run `bb thread list` to see thread ids.");
    // With the overview, the threads of the automations' runs are read as the ones under Main are.
    const since = now - LIMITS.archivedListedMs;
    const under = [...new Set([...descendantIds(threads, rootId, since), ...archivedOutsideIds(threads, rootId, since), ...extra])].filter((id) => id !== rootId);
    const noted = await notes([rootId, ...under]);
    // The root is Main when the overview is asked for; a thread named to a verb is read as it would be on a page.
    const projects = projectIds(threads, Object.keys(noted.projects), null);
    const wanted = new Set([rootId, ...under]);
    const activity = await activities(threads.filter((thread) => wanted.has(thread.id) && thread.archivedAt === null));
    const asks = asksByThread(raised ? await raised.openAsks() : []);
    const briefs = raised ? await raised.marks([...wanted]) : new Map<string, BriefMark>();
    const delivered = (await raised?.delivered?.()) ?? new Map<string, readonly number[]>();
    const outside = (await raised?.outside?.()) ?? new Map<string, readonly OutsideFlag[]>();
    const deriveThread = (isRoot: (id: string) => boolean) => (thread: ThreadFacts) =>
      derive(
        thread,
        activity.get(thread.id),
        now,
        // The page's heading is never parked; a thread named to a verb can be.
        isRoot(thread.id) ? null : noted.parks[thread.id],
        noted.archives[thread.id]?.reason,
        noted.dismissals[thread.id]?.throughSeq,
        { project: projects.has(thread.id) || isRoot(thread.id), main: isRoot(thread.id), seenSeq: noted.seen[thread.id]?.seq ?? null },
        { asks: asks.get(thread.id) ?? [], brief: briefs.get(thread.id) ?? null, delivered: delivered.get(thread.id), outside: outside.get(thread.id) },
        noted.waits[thread.id],
        // The page's heading is never kept, as it is never parked.
        isRoot(thread.id) ? null : noted.keeps[thread.id],
      );
    const plans = {
      note: (id: string) => noted.nexts[id]?.text ?? null,
      todos: (id: string) => noted.todos[id] ?? [],
      marked: (id: string) => noted.projects[id] !== undefined,
      archivedOutside: (id: string) => noted.archives[id]?.outside === true,
    };
    return { threads, truncated, now, root, noted, deriveThread, plans };
  };

  /** The thread as a line, for a verb's rule; and whether it is a Main. */
  const lineFor = async (threadId: string): Promise<{ line: Line; isMain: boolean; threads: readonly ThreadFacts[]; now: number; mains: MainRecord }> => {
    const seen = await look(threadId);
    const line = lineOf(seen.threads, threadId, seen.deriveThread(() => false), seen.now);
    if (!line) throw new CowError("thread_not_found", `there is no thread ${threadId}`);
    const mains = await readMains();
    // A Main is a thread chosen as one; a thread with no parent that is not is listed under Outside Main.
    const isMain = Object.values(mains.mains).includes(threadId);
    return { line, isMain, threads: seen.threads, now: seen.now, mains };
  };

  /** A refusal of the ledger's, as the actions' kind. */
  const asCow = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof Refusal) throw new CowError(cause.code, cause.message, cause.hint);
      throw cause;
    }
  };

  /** Refuse unless `by` may judge what this worker came to now: it must be a worker that finished a turn, and a thread never overwrites the person. */
  const judgeable = async (threads: readonly ThreadFacts[], target: ThreadFacts, by: string, verb: "archive" | "outcome") => {
    if (!ledger) throw new CowError("no_ledger", "cow keeps no ledger here");
    const lead = verb === "archive" ? `cannot archive “${target.title}” (${target.id}) with an outcome` : `cannot set what “${target.title}” (${target.id}) came to`;
    const hint = verb === "archive" ? "Archive it without --outcome." : undefined;
    const why = (await notWorker(threads, target)) ?? ((await ledger.finished(target.id)) ? null : "it never finished a turn, so it has no outcome");
    if (why !== null) throw new CowError("not_a_worker", `${lead}: ${why}`, hint);
    const refused = await ledger.refusal(target.id, by);
    if (refused !== null) throw new CowError(refused.code, `${lead}: ${refused.message}`, verb === "archive" ? hint : refused.hint);
  };

  /** The label as given, checked; refused when `by` may not set it now. Null: clear it. */
  const labelable = async (target: ThreadFacts, label: string | null, by: string): Promise<string | null> => {
    if (!ledger) throw new CowError("no_ledger", "cow keeps no ledger here");
    let checked: string | null = null;
    if (label !== null) {
      const parsed = labelOf(label);
      if (!parsed.ok) throw new CowError("bad_label", parsed.why);
      checked = parsed.label;
    }
    const refused = await ledger.labelRefusal(target.id, by);
    if (refused !== null) throw new CowError(refused.code, `cannot label “${target.title}” (${target.id}): ${refused.message}`, refused.hint);
    return checked;
  };

  /** Where a thread stands for an outcome or a label: archive's rule. Returns the threads and the target. */
  const judgePlace = async (callerId: string | null, threadId: string, lead: (title: string) => string, check = true) => {
    const { threads } = await listThreads(reader);
    const target = threads.find((thread) => thread.id === threadId);
    if (!target) throw new CowError("thread_not_found", `there is no thread ${threadId}`, "Run `bb thread list` to see thread ids.");
    const mains = await readMains();
    const caller = callerId === null ? undefined : threads.find((thread) => thread.id === callerId);
    const ownProject = callerId === null ? mains.currentProjectId : (caller?.projectId ?? null);
    const place = archivePlace(threads, mains.mains, callerId, ownProject, threadId);
    if (check && place.why !== null) throw new CowError("cannot_judge", `${lead(target.title)}: ${place.why}`, insteadFromCli(place.why) || undefined);
    return { threads, target };
  };

  const refuse = (verb: string, line: Line, why: string): never => {
    throw new CowError(`cannot_${verb}`, `cannot ${verb} “${line.thread.title}” (${line.thread.id}): ${why}`, insteadFromCli(why) || undefined);
  };

  return {
    notes,
    setPark,
    setArchiveNote,
    setDismissal,
    setSeen,
    todo,
    archive,
    setProject,
    setWait,
    setKeep,
    forget,
    sweep,

    async waitChecked({ callerId, threadId, wait }) {
      const target = await planTarget(callerId, threadId);
      if (wait === null) {
        await setWait(threadId, null);
        return { title: target.title, wait: null };
      }
      if (target.archivedAt !== null) throw new CowError("archived", `“${target.title}” (${threadId}) is archived, so it waits on nobody`, "`bb thread unarchive` brings it back.");
      if ((await notes([threadId])).parks[threadId]) throw new CowError("parked", `“${target.title}” (${threadId}) is parked: the person set it aside`, "`bb cow resume <thread>` takes it off the shelf first.");
      const note = waitNote(wait, Date.now(), callerId);
      if (!note.ok) throw new CowError("bad_wait", note.error);
      await setWait(threadId, note.note);
      return { title: target.title, wait: note.note };
    },

    async projectChecked({ callerId, threadId, on }) {
      const target = await planTarget(callerId, threadId);
      if (target.archivedAt !== null) throw new CowError("archived", `“${target.title}” (${threadId}) is archived`, "`bb thread unarchive` brings it back.");
      const project = on ? { at: Date.now(), by: callerId } : null;
      await setProject(threadId, project);
      return { title: target.title, project };
    },

    async nextChecked({ callerId, threadId, text }) {
      const target = await planTarget(callerId, threadId);
      let note: NextNote | null = null;
      if (text !== null) {
        const parsed = nextText(text);
        if (!parsed.ok) throw new CowError("bad_next", parsed.error);
        note = { text: parsed.text, at: Date.now(), by: callerId };
      }
      await setNote(threadId, NEXT_KEY, note);
      return { title: target.title, note };
    },

    async todoChecked({ callerId, threadId, op }) {
      const target = await planTarget(callerId, threadId);
      if (op === null) return { title: target.title, list: (await notes([threadId])).todos[threadId] ?? [], item: null };
      let checked = op;
      if (op.kind === "add") {
        const parsed = todoTitle(op.title);
        if (!parsed.ok) throw new CowError("bad_todo", parsed.error);
        checked = { kind: "add", title: parsed.text };
      }
      return { title: target.title, ...(await todo(threadId, checked)) };
    },

    async archiveChecked({ callerId, threadId, reason, outcome = null, label }) {
      const { line, isMain, threads, now, mains } = await lineFor(threadId);
      const caller = callerId === null ? undefined : threads.find((thread) => thread.id === callerId);
      const ownProject = callerId === null ? mains.currentProjectId : (caller?.projectId ?? null);
      const place = archivePlace(threads, mains.mains, callerId, ownProject, threadId);
      if (place.why !== null) refuse("archive", line, place.why);
      const why = verbBlocked("archive", line, isMain);
      if (why !== null) refuse("archive", line, why);
      const by = callerId ?? PERSON;
      // An outcome that cannot be given refuses the whole archive, before anything is done.
      if (outcome !== null) await judgeable(threads, line.thread, by, "archive");
      const labelled = label === undefined ? undefined : await labelable(line.thread, label, by);
      const under = descendantIds(threads, threadId).length;
      // The label first, so the row is written with it.
      if (labelled !== undefined && ledger) await asCow(() => ledger.setLabel(threadId, labelled, by, now));
      await archive({ threadId, reason, dropped: false, at: now, by });
      if (outcome !== null && ledger) await asCow(() => ledger.judge(threadId, outcome, by, Date.now()));
      return { title: line.thread.title, under, outside: place.outside };
    },

    async outcomeChecked({ callerId, threadId, outcome, label }) {
      if (!ledger) throw new CowError("no_ledger", "cow keeps no ledger here");
      const { threads, target } = await judgePlace(callerId, threadId, (title) => `cannot set what “${title}” (${threadId}) came to`);
      const by = callerId ?? PERSON;
      await judgeable(threads, target, by, "outcome");
      const labelled = label === undefined ? undefined : await labelable(target, label, by);
      const judged = await asCow(() => ledger.judge(threadId, outcome, by, Date.now()));
      if (labelled !== undefined) await asCow(() => ledger.setLabel(threadId, labelled, by, Date.now()));
      const judgement = judged.judgements[judged.judgements.length - 1] as Judgement;
      return { title: target.title, archived: target.archivedAt !== null, judgement, changes: judged.judgements.length - 1, row: judged.row !== null };
    },

    async labelChecked({ callerId, threadId, label }) {
      if (!ledger) throw new CowError("no_ledger", "cow keeps no ledger here");
      // Anyone may read a label; setting one is under archive's rule.
      const { target } = await judgePlace(callerId, threadId, (title) => `cannot label “${title}” (${threadId})`, label !== undefined);
      const archived = target.archivedAt !== null;
      if (label === undefined) {
        const note = await ledger.label(threadId);
        const row = (await ledger.rows()).some((r) => r.threadId === threadId);
        return { title: target.title, archived, label: note, row };
      }
      const by = callerId ?? PERSON;
      const checked = await labelable(target, label, by);
      const set = await asCow(() => ledger.setLabel(threadId, checked, by, Date.now()));
      return { title: target.title, archived, label: set.label, row: set.row !== null };
    },

    async ledger(days) {
      if (!ledger) return { rows: [], summary: summarize([], Date.now(), days), outcomes: {}, costs: {}, priceError: null };
      const now = Date.now();
      const all = await ledger.rows();
      const rows = inWindow(all, now, days);
      // Dollars are worked out now, from the prices as set now: a corrected price applies to rows written before it.
      const { cost, error } = costing ? await costing(rows) : { cost: () => null, error: null };
      return {
        rows,
        summary: summarize(all, now, days, cost),
        outcomes: Object.fromEntries(await ledger.outcomes()),
        costs: Object.fromEntries(rows.map((row) => [row.threadId, cost(row)])),
        priceError: error,
      };
    },

    mainFor: (mainId, projectId) => mainOf(mainId, projectId),

    async parkChecked({ callerId, threadId, reason, pickUp, stop }) {
      const { line, isMain, now } = await lineFor(threadId);
      // A thread outside Main has no place on the shelf of a Main's page.
      if (!isMain && line.thread.parentThreadId === null) refuse("park", line, NOT_UNDER_MAIN);
      const why = verbBlocked("park", line, isMain);
      if (why !== null) refuse("park", line, why);
      const parsed = parsePickUp(pickUp, now);
      if (!parsed.ok) throw new CowError("bad_pickup", `--pickup: ${parsed.error}`);
      const before = line.derived.park?.record;
      if (!before && isBusy(line.thread)) {
        if (!stop) {
          throw new CowError(
            "turn_running",
            `cannot park “${line.thread.title}” (${threadId}): its turn is running`,
            "Add --stop to stop its turn and park it. Stopping cannot be undone.",
          );
        }
        await bb.sdk.threads.stop({ threadId });
      }
      // Parked work that came back is kept parked: it stays parked since when it was.
      const record = before ? { ...reparkNow(before, parsed.pickUp, now), reason } : parkNow(reason, parsed.pickUp, now);
      // What it waited on the person for, read before it was parked.
      const waited = parkWaitedOn(line);
      await setPark(threadId, record);
      // A park by a thread that takes something out of the person's queue is put in front of them. The park stands either way.
      let traced = false;
      if (callerId !== null && waited.length > 0 && raised?.trace) {
        traced = await raised.trace({ action: "parked", actorThreadId: callerId, threadId, askId: null, question: null, claim: reason, waited }).then(
          () => true,
          (cause: unknown) => {
            bb.log.warn(`could not record that ${callerId} parked ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
            return false;
          },
        );
      }
      return { title: line.thread.title, record, kept: before !== undefined, traced };
    },

    async resumeChecked(threadId) {
      const { line, isMain } = await lineFor(threadId);
      const why = verbBlocked("resume", line, isMain);
      if (why !== null) refuse("resume", line, why);
      await setPark(threadId, null);
      return { title: line.thread.title };
    },

    async status(mainId, projectId) {
      const id = await mainOf(mainId, projectId);
      const automations = (await raised?.automations?.().catch(() => NO_AUTOMATIONS)) ?? NO_AUTOMATIONS;
      const seen = await look(id, runThreadIds(automations));
      if (seen.root.archivedAt !== null) {
        const title = seen.root.title.trim() || id;
        throw new CowError(
          "main_archived",
          mainId === null ? `the Main chosen for this project, “${title}” (${id}), is archived, so there is no overview to give` : `“${title}” (${id}) is archived, so it cannot be read as Main`,
          `Choose another Main on cow's page (M), or pass --main <thread>; \`bb thread unarchive ${id}\` brings this one back.`,
        );
      }
      const mains = await readMains();
      const otherMains = new Set(Object.values(mains.mains).filter((other) => other !== id));
      const overview = buildOverview(seen.threads, id, seen.deriveThread((other) => other === id), seen.now, { ...seen.plans, otherMains, automations });
      // A thread outside Main names its project when it is another one; without the names, its id.
      const projectNames = await Promise.resolve()
        .then(() => bb.sdk.projects.list())
        .then(
        (projects) => new Map(projects.map((project) => [project.id, project.name])),
        () => new Map<string, string>(),
      );
      // The traces about this Main's threads, or made by one of them.
      const ours = new Set([id, ...descendantIds(seen.threads, id)]);
      const traces = ((await raised?.traces?.().catch(() => [])) ?? []).filter((trace) => ours.has(trace.threadId) || ours.has(trace.actorThreadId));
      const report = statusReport(overview, seen.now, seen.truncated, projectNames);
      // An archived worker shows what it came to, when someone said.
      const outcomes = ledger ? await ledger.outcomes().catch(() => new Map<string, Judgement>()) : new Map<string, Judgement>();
      const archived = report.archived.map((line) => {
        const judged = outcomes.get(line.id);
        return judged ? { ...line, outcome: { outcome: judged.outcome, by: judged.by } } : line;
      });
      return { ...report, archived, traces: traces.map((trace) => ({ ...trace })) };
    },
  };
}
