// The page's copy of cow's notes on threads (why one is parked, why one was
// archived, which refused permissions were dismissed), kept current across
// windows and with what the CLI changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { type ArchiveNote, type Dismissal, NOTES_CHANGED, type ParkRecord } from "./shared.ts";

export interface Parks {
  /** Thread id to its note; null until the first load finishes. */
  notes: ReadonlyMap<string, ParkRecord> | null;
  /** Thread id to why it was archived. */
  archives: ReadonlyMap<string, ArchiveNote>;
  /** Thread id to the refused permissions the user dismissed. */
  dismissals: ReadonlyMap<string, Dismissal>;
  error: string | null;
  reload: () => void;
  /** Park a thread with this note, or resume it with null. */
  set: (threadId: string, park: ParkRecord | null) => Promise<void>;
  /** Record why a thread is archived, or forget it with null. */
  setArchive: (threadId: string, note: ArchiveNote | null) => Promise<void>;
  /** Dismiss a thread's refused permissions, or show them again with null. */
  setDismissal: (threadId: string, dismissal: Dismissal | null) => Promise<void>;
  /** Archive a thread in bb with this reason; null forgets an earlier one. `dropped` stops it first. */
  archive: (threadId: string, reason: string | null, dropped: boolean, at: number) => Promise<void>;
}

/** Load the notes on `threadIds`, and again whenever that list or any note changes. */
export function useParks(threadIds: readonly string[] | null): Parks {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<ReadonlyMap<string, ParkRecord> | null>(null);
  const [archives, setArchives] = useState<ReadonlyMap<string, ArchiveNote>>(new Map());
  const [dismissals, setDismissals] = useState<ReadonlyMap<string, Dismissal>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const ids = useRef(threadIds);
  ids.current = threadIds;
  const request = useRef(0);

  const reload = useCallback(() => {
    const wanted = ids.current;
    if (wanted === null) return;
    const seq = ++request.current;
    rpc.call("notes_list", { threadIds: [...wanted] }).then(
      ({ parks, archives: archived, dismissals: dismissed }) => {
        if (seq !== request.current) return;
        setNotes(new Map(Object.entries(parks)));
        setArchives(new Map(Object.entries(archived)));
        setDismissals(new Map(Object.entries(dismissed)));
        setError(null);
      },
      (cause: unknown) => {
        if (seq === request.current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  const key = threadIds === null ? null : threadIds.join(" ");
  useEffect(reload, [reload, key]);
  useRealtime(NOTES_CHANGED, reload);

  const set = useCallback(
    async (threadId: string, park: ParkRecord | null) => {
      await rpc.call("park_set", { threadId, park });
      // Show it at once; a load that started before the change is ignored.
      request.current += 1;
      setNotes((current) => {
        const next = new Map(current ?? []);
        if (park === null) next.delete(threadId);
        else next.set(threadId, park);
        return next;
      });
      reload();
    },
    [rpc, reload],
  );

  const setArchive = useCallback(
    async (threadId: string, note: ArchiveNote | null) => {
      await rpc.call("archive_note_set", { threadId, note });
      request.current += 1;
      setArchives((current) => {
        const next = new Map(current);
        if (note === null) next.delete(threadId);
        else next.set(threadId, note);
        return next;
      });
      reload();
    },
    [rpc, reload],
  );

  const setDismissal = useCallback(
    async (threadId: string, dismissal: Dismissal | null) => {
      await rpc.call("dismissal_set", { threadId, dismissal });
      request.current += 1;
      setDismissals((current) => {
        const next = new Map(current);
        if (dismissal === null) next.delete(threadId);
        else next.set(threadId, dismissal);
        return next;
      });
      reload();
    },
    [rpc, reload],
  );

  const archive = useCallback(
    async (threadId: string, reason: string | null, dropped: boolean, at: number) => {
      await rpc.call("thread_archive", { threadId, reason, dropped, at });
      reload();
    },
    [rpc, reload],
  );

  return { notes, archives, dismissals, error, reload, set, setArchive, setDismissal, archive };
}
