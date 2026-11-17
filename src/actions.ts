// What cow does to a thread, on the backend: its notes, archiving, and the
// rules the verbs follow. The page's RPCs and the CLI both act through here.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type Ask, asksByThread } from "./asks/ask.ts";
import type { BriefMark } from "./briefs/review.ts";
import { type ThreadReader, listThreads, readActivity } from "./activity.ts";
import { parkNow, reparkNow } from "./park.ts";
import { parsePickUp } from "./pickup.ts";
import { type TodoChange, nextText, planRefused, todoAdd, todoMove, todoTake, todoTakeId, todoTitle } from "./plans.ts";
import {
  ARCHIVE_KEY,
  type ArchiveNote,
  DISMISS_KEY,
  type Dismissal,
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
  archiveNoteSchema,
  dismissalSchema,
  nextNoteSchema,
  parkRecordSchema,
  projectMarkSchema,
  seenSchema,
  todoListSchema,
} from "./shared.ts";
import { type Activity, LIMITS, type ThreadFacts, derive, isBusy } from "./state.ts";
import { type StatusReport, statusReport } from "./status.ts";
import { type Line, buildOverview, descendantIds, lineOf, projectIds } from "./tree.ts";
import { verbBlocked } from "./verbs.ts";

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
  /** Record the reason (or forget an earlier one), stop it when dropped, and archive it in bb. */
  archive(args: { threadId: string; reason: string | null; dropped: boolean; at: number }): Promise<void>;
  /** The verbs as the CLI runs them: the page's rules first, then the same action. */
  archiveChecked(threadId: string, reason: string | null): Promise<{ title: string; under: number }>;
  parkChecked(args: { threadId: string; reason: string; pickUp: string; stop: boolean }): Promise<{ title: string; record: ParkRecord; kept: boolean }>;
  resumeChecked(threadId: string): Promise<{ title: string }>;
  status(mainId: string | null, projectId: string | null): Promise<StatusReport>;
}

/** Where the actions read what threads have put in front of the user. */
export interface RaisedSource {
  openAsks(): Promise<readonly Ask[]>;
  /** Thread id to when cow delivered the person's answers to its asks. */
  delivered?(): Promise<ReadonlyMap<string, readonly number[]>>;
  marks(threadIds: readonly string[]): Promise<ReadonlyMap<string, BriefMark>>;
}

export function createActions(bb: BbPluginApi, readMains: () => Promise<MainRecord>, raised?: RaisedSource): Actions {
  const reader: ThreadReader = bb.sdk.threads;

  const notes = async (threadIds: readonly string[]): Promise<Notes> => {
    const found: Notes = { parks: {}, archives: {}, dismissals: {}, nexts: {}, todos: {}, seen: {}, projects: {} };
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

  const setNote = async (threadId: string, key: string, value: ParkRecord | ArchiveNote | Dismissal | NextNote | ProjectMark | TodoItem[] | null) => {
    await bb.sdk.threads.updatePluginMetadata(
      value === null ? { threadId, remove: [key] } : { threadId, set: { [key]: value } },
    );
    bb.realtime.publish(NOTES_CHANGED, {});
  };
  const setPark = (threadId: string, park: ParkRecord | null) => setNote(threadId, PARK_KEY, park);
  const setArchiveNote = (threadId: string, note: ArchiveNote | null) => setNote(threadId, ARCHIVE_KEY, note);
  const setDismissal = (threadId: string, dismissal: Dismissal | null) => setNote(threadId, DISMISS_KEY, dismissal);
  const setProject = (threadId: string, project: ProjectMark | null) => setNote(threadId, PROJECT_KEY, project);

  // What cow keeps per thread: its notes and plans in the thread's own
  // metadata, and the reply the person has seen in cow's storage.
  const forget = async (threadId: string) => {
    await bb.storage.kv.delete(SEEN_PREFIX + threadId);
    // bb drops a deleted thread's metadata with it; where it has not, cow's keys are taken off.
    await bb.sdk.threads
      .updatePluginMetadata({ threadId, remove: [PARK_KEY, ARCHIVE_KEY, DISMISS_KEY, NEXT_KEY, TODO_KEY, PROJECT_KEY] })
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

  const archive: Actions["archive"] = async ({ threadId, reason, dropped, at }) => {
    // The reason is cow's note on the thread; archiving without one forgets an earlier reason.
    if (reason !== null) await setArchiveNote(threadId, { reason, at });
    else if ((await notes([threadId])).archives[threadId]) await setArchiveNote(threadId, null);
    // Dropping ends whatever the thread still runs; a thread at rest has
    // nothing to stop, which is not a reason to keep it.
    if (dropped) await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    await bb.sdk.threads.archive({ threadId });
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
  const look = async (rootId: string) => {
    const { threads, truncated } = await listThreads(reader);
    const now = Date.now();
    const root = threads.find((thread) => thread.id === rootId);
    if (!root) throw new CowError("thread_not_found", `there is no thread ${rootId}`, "Run `bb thread list` to see thread ids.");
    const under = descendantIds(threads, rootId, now - LIMITS.doneListedMs);
    const noted = await notes([rootId, ...under]);
    // The root is Main when the overview is asked for; a thread named to a verb is read as it would be on a page.
    const projects = projectIds(threads, Object.keys(noted.projects), null);
    const wanted = new Set([rootId, ...under]);
    const activity = await activities(threads.filter((thread) => wanted.has(thread.id) && thread.archivedAt === null));
    const asks = asksByThread(raised ? await raised.openAsks() : []);
    const briefs = raised ? await raised.marks([...wanted]) : new Map<string, BriefMark>();
    const delivered = (await raised?.delivered?.()) ?? new Map<string, readonly number[]>();
    const deriveThread = (isRoot: (id: string) => boolean) => (thread: ThreadFacts) =>
      derive(
        thread,
        activity.get(thread.id),
        now,
        // The page's heading is never parked; a thread named to a verb can be.
        isRoot(thread.id) ? null : noted.parks[thread.id],
        noted.archives[thread.id]?.reason,
        noted.dismissals[thread.id]?.throughSeq,
        { head: projects.has(thread.id), project: projects.has(thread.id) || isRoot(thread.id), seenSeq: noted.seen[thread.id]?.seq ?? null },
        { asks: asks.get(thread.id) ?? [], brief: briefs.get(thread.id) ?? null, delivered: delivered.get(thread.id) },
      );
    const plans = {
      note: (id: string) => noted.nexts[id]?.text ?? null,
      todos: (id: string) => noted.todos[id] ?? [],
      marked: (id: string) => noted.projects[id] !== undefined,
    };
    return { threads, truncated, now, root, noted, deriveThread, plans };
  };

  /** The thread as a line, for a verb's rule; and whether it is a Main. */
  const lineFor = async (threadId: string): Promise<{ line: Line; isMain: boolean; threads: readonly ThreadFacts[]; now: number }> => {
    const seen = await look(threadId);
    const line = lineOf(seen.threads, threadId, seen.deriveThread(() => false), seen.now);
    if (!line) throw new CowError("thread_not_found", `there is no thread ${threadId}`);
    const mains = await readMains();
    const isMain = line.thread.parentThreadId === null || mains.mains[line.thread.projectId] === threadId;
    return { line, isMain, threads: seen.threads, now: seen.now };
  };

  const refuse = (verb: string, line: Line, why: string): never => {
    throw new CowError(`cannot_${verb}`, `cannot ${verb} “${line.thread.title}” (${line.thread.id}): ${why}`);
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
    forget,
    sweep,

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

    async archiveChecked(threadId, reason) {
      const { line, isMain, threads, now } = await lineFor(threadId);
      const why = verbBlocked("archive", line, isMain);
      if (why !== null) refuse("archive", line, why);
      const under = descendantIds(threads, threadId).length;
      await archive({ threadId, reason, dropped: false, at: now });
      return { title: line.thread.title, under };
    },

    async parkChecked({ threadId, reason, pickUp, stop }) {
      const { line, isMain, now } = await lineFor(threadId);
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
      await setPark(threadId, record);
      return { title: line.thread.title, record, kept: before !== undefined };
    },

    async resumeChecked(threadId) {
      const { line, isMain } = await lineFor(threadId);
      const why = verbBlocked("resume", line, isMain);
      if (why !== null) refuse("resume", line, why);
      await setPark(threadId, null);
      return { title: line.thread.title };
    },

    async status(mainId, projectId) {
      let id = mainId;
      if (id === null) {
        const mains = await readMains();
        id = (projectId ? mains.mains[projectId] : undefined) ?? (mains.currentProjectId ? mains.mains[mains.currentProjectId] : undefined) ?? null;
      }
      if (id === null) {
        throw new CowError("no_main", "no Main thread is chosen", "Pass --main <thread>, or choose a Main on cow's page.");
      }
      const seen = await look(id);
      if (seen.root.archivedAt !== null) throw new CowError("main_archived", `the Main thread ${id} is archived`, "Pass --main <thread>.");
      const overview = buildOverview(seen.threads, id, seen.deriveThread((other) => other === id), seen.now, seen.plans);
      return statusReport(overview, seen.now, seen.truncated);
    },
  };
}
