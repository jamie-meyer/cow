// The page's copy of cow's park notes, kept current across windows.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { PARKS_CHANGED, type ParkRecord } from "./shared.ts";

export interface Parks {
  /** Thread id to its note; null until the first load finishes. */
  notes: ReadonlyMap<string, ParkRecord> | null;
  error: string | null;
  reload: () => void;
  /** Park a thread with this note, or resume it with null. */
  set: (threadId: string, park: ParkRecord | null) => Promise<void>;
}

/** Load the notes on `threadIds`, and again whenever that list or any note changes. */
export function useParks(threadIds: readonly string[] | null): Parks {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<ReadonlyMap<string, ParkRecord> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useRef(threadIds);
  ids.current = threadIds;
  const request = useRef(0);

  const reload = useCallback(() => {
    const wanted = ids.current;
    if (wanted === null) return;
    const seq = ++request.current;
    rpc.call("park_list", { threadIds: [...wanted] }).then(
      ({ parks }) => {
        if (seq !== request.current) return;
        setNotes(new Map(Object.entries(parks)));
        setError(null);
      },
      (cause: unknown) => {
        if (seq === request.current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  const key = threadIds === null ? null : threadIds.join(" ");
  useEffect(reload, [reload, key]);
  useRealtime(PARKS_CHANGED, reload);

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

  return { notes, error, reload, set };
}
