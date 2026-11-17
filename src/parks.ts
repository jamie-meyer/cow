// The page's copy of cow's notes on threads (why one is parked, why one was
// archived, which refused permissions were dismissed), kept current across
// windows and with what the CLI changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { Signer } from "./signing/page.ts";
import {
  type ArchiveNote,
  type Dismissal,
  NOTES_CHANGED,
  type NextNote,
  type ParkRecord,
  type ProjectMark,
  type Seen,
  type TodoItem,
  type WaitNote,
} from "./shared.ts";

export interface Parks {
  /** Thread id to its note; null until the first load finishes. */
  notes: ReadonlyMap<string, ParkRecord> | null;
  /** Thread id to why it was archived. */
  archives: ReadonlyMap<string, ArchiveNote>;
  /** Thread id to the refused permissions the user dismissed. */
  dismissals: ReadonlyMap<string, Dismissal>;
  /** Thread id to its own words on what is next, and to what it has not started. */
  nexts: ReadonlyMap<string, NextNote>;
  todos: ReadonlyMap<string, readonly TodoItem[]>;
  /** Thread id to the reply the person has seen. */
  seen: ReadonlyMap<string, Seen>;
  /** The threads marked as projects. */
  projects: ReadonlyMap<string, ProjectMark>;
  /** Mark a thread as a project, or take the mark off with null. */
  setProject: (threadId: string, project: ProjectMark | null) => Promise<void>;
  /** Thread id to who or what it says it waits on. */
  waits: ReadonlyMap<string, WaitNote>;
  /** Say a thread waits on someone other than the person, or with null that it no longer does. */
  setWait: (threadId: string, wait: WaitNote | null) => Promise<void>;
  error: string | null;
  reload: () => void;
  /** Record the reply the person has seen, or forget it with null. */
  setSeen: (threadId: string, seen: Seen | null) => Promise<void>;
  /** Take an item off a thread's list of work not started, or move it one place. */
  changeTodo: (threadId: string, itemId: string, change: "remove" | "up" | "down") => Promise<void>;
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
export function useParks(threadIds: readonly string[] | null, signer: Signer): Parks {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<ReadonlyMap<string, ParkRecord> | null>(null);
  const [archives, setArchives] = useState<ReadonlyMap<string, ArchiveNote>>(new Map());
  const [dismissals, setDismissals] = useState<ReadonlyMap<string, Dismissal>>(new Map());
  const [nexts, setNexts] = useState<ReadonlyMap<string, NextNote>>(new Map());
  const [todos, setTodos] = useState<ReadonlyMap<string, readonly TodoItem[]>>(new Map());
  const [seen, setSeenMap] = useState<ReadonlyMap<string, Seen>>(new Map());
  const [projects, setProjects] = useState<ReadonlyMap<string, ProjectMark>>(new Map());
  const [waits, setWaits] = useState<ReadonlyMap<string, WaitNote>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const ids = useRef(threadIds);
  ids.current = threadIds;
  const request = useRef(0);
  const sign = signer.call;

  const reload = useCallback(() => {
    const wanted = ids.current;
    if (wanted === null) return;
    const seq = ++request.current;
    rpc.call("notes_list", { threadIds: [...wanted] }).then(
      ({ parks, archives: archived, dismissals: dismissed, nexts: next, todos: todo, seen: saw, projects: marked, waits: waiting }) => {
        if (seq !== request.current) return;
        setWaits(new Map(Object.entries(waiting)));
        setProjects(new Map(Object.entries(marked)));
        setNexts(new Map(Object.entries(next)));
        setTodos(new Map(Object.entries(todo)));
        setSeenMap(new Map(Object.entries(saw)));
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
      // Dismissing takes a line out of the queue, so it is the person's: signed.
      await sign("dismissal_set", { threadId, dismissal });
      request.current += 1;
      setDismissals((current) => {
        const next = new Map(current);
        if (dismissal === null) next.delete(threadId);
        else next.set(threadId, dismissal);
        return next;
      });
      reload();
    },
    [sign, reload],
  );

  const setSeen = useCallback(
    async (threadId: string, value: Seen | null) => {
      // So is marking a reply as seen, whether Space did it or opening the chat.
      await sign("seen_set", { threadId, seen: value });
      request.current += 1;
      setSeenMap((current) => {
        const next = new Map(current);
        if (value === null) next.delete(threadId);
        else next.set(threadId, value);
        return next;
      });
      reload();
    },
    [sign, reload],
  );

  const setProject = useCallback(
    async (threadId: string, project: ProjectMark | null) => {
      await rpc.call("project_set", { threadId, project });
      request.current += 1;
      setProjects((current) => {
        const next = new Map(current);
        if (project === null) next.delete(threadId);
        else next.set(threadId, project);
        return next;
      });
      reload();
    },
    [rpc, reload],
  );

  const setWait = useCallback(
    async (threadId: string, wait: WaitNote | null) => {
      await rpc.call("wait_set", { threadId, wait });
      request.current += 1;
      setWaits((current) => {
        const next = new Map(current);
        if (wait === null) next.delete(threadId);
        else next.set(threadId, wait);
        return next;
      });
      reload();
    },
    [rpc, reload],
  );

  const changeTodo = useCallback(
    async (threadId: string, itemId: string, change: "remove" | "up" | "down") => {
      await rpc.call("todo_change", { threadId, itemId, change });
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

  return { notes, archives, dismissals, nexts, todos, seen, projects, setProject, waits, setWait, error, reload, set, setArchive, setDismissal, setSeen, changeTodo, archive };
}
