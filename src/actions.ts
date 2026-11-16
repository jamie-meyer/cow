// What cow does to a thread, on the backend: its notes, archiving, and the
// rules the verbs follow. The page's RPCs and the CLI both act through here.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type ThreadReader, listThreads, readActivity } from "./activity.ts";
import { parkNow, reparkNow } from "./park.ts";
import { parsePickUp } from "./pickup.ts";
import {
  ARCHIVE_KEY,
  type ArchiveNote,
  DISMISS_KEY,
  type Dismissal,
  NOTES_CHANGED,
  PARK_KEY,
  type ParkRecord,
  archiveNoteSchema,
  dismissalSchema,
  parkRecordSchema,
} from "./shared.ts";
import { type Activity, LIMITS, type ThreadFacts, derive, isBusy } from "./state.ts";
import { type StatusReport, statusReport } from "./status.ts";
import { type Line, buildOverview, descendantIds, lineOf } from "./tree.ts";
import { verbBlocked } from "./verbs.ts";

/** bb reads plugin metadata for at most this many threads per request. */
const METADATA_PAGE = 200;
/** Activity is read for at most this many threads per command; the rest show what bb's list says. */
const MAX_ACTIVITY = 300;
const ACTIVITY_CONCURRENCY = 6;
export const MAX_REASON = 300;

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
}

export interface MainRecord {
  mains: Record<string, string>;
  currentProjectId: string | null;
}

export interface Actions {
  notes(threadIds: readonly string[]): Promise<Notes>;
  setPark(threadId: string, park: ParkRecord | null): Promise<void>;
  setArchiveNote(threadId: string, note: ArchiveNote | null): Promise<void>;
  setDismissal(threadId: string, dismissal: Dismissal | null): Promise<void>;
  /** Record the reason (or forget an earlier one), stop it when dropped, and archive it in bb. */
  archive(args: { threadId: string; reason: string | null; dropped: boolean; at: number }): Promise<void>;
  /** The verbs as the CLI runs them: the page's rules first, then the same action. */
  archiveChecked(threadId: string, reason: string | null): Promise<{ title: string; under: number }>;
  parkChecked(args: { threadId: string; reason: string; pickUp: string; stop: boolean }): Promise<{ title: string; record: ParkRecord; kept: boolean }>;
  resumeChecked(threadId: string): Promise<{ title: string }>;
  status(mainId: string | null, projectId: string | null): Promise<StatusReport>;
}

export function createActions(bb: BbPluginApi, readMains: () => Promise<MainRecord>): Actions {
  const reader: ThreadReader = bb.sdk.threads;

  const notes = async (threadIds: readonly string[]): Promise<Notes> => {
    const found: Notes = { parks: {}, archives: {}, dismissals: {} };
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
      }
    }
    return found;
  };

  const setNote = async (threadId: string, key: string, value: ParkRecord | ArchiveNote | Dismissal | null) => {
    await bb.sdk.threads.updatePluginMetadata(
      value === null ? { threadId, remove: [key] } : { threadId, set: { [key]: value } },
    );
    bb.realtime.publish(NOTES_CHANGED, {});
  };
  const setPark = (threadId: string, park: ParkRecord | null) => setNote(threadId, PARK_KEY, park);
  const setArchiveNote = (threadId: string, note: ArchiveNote | null) => setNote(threadId, ARCHIVE_KEY, note);
  const setDismissal = (threadId: string, dismissal: Dismissal | null) => setNote(threadId, DISMISS_KEY, dismissal);

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
    const wanted = new Set([rootId, ...under]);
    const activity = await activities(threads.filter((thread) => wanted.has(thread.id) && thread.archivedAt === null));
    const deriveThread = (isRoot: (id: string) => boolean) => (thread: ThreadFacts) =>
      derive(
        thread,
        activity.get(thread.id),
        now,
        // The page's heading is never parked; a thread named to a verb can be.
        isRoot(thread.id) ? null : noted.parks[thread.id],
        noted.archives[thread.id]?.reason,
        noted.dismissals[thread.id]?.throughSeq,
      );
    return { threads, truncated, now, root, noted, deriveThread };
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
    archive,

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
      const overview = buildOverview(seen.threads, id, seen.deriveThread((other) => other === id), seen.now);
      return statusReport(overview, seen.now, seen.truncated);
    },
  };
}
