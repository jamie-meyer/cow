// The page's copy of what threads have put in front of the person: open
// asks and what each brief came to, kept current with what the CLI and the
// checker change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { type Ask, asksByThread } from "./asks/ask.ts";
import type { BriefMark } from "./briefs/review.ts";
import type { BriefRecord } from "./briefs/service.ts";
import type { attentionRpcContract } from "./raised-backend.ts";
import { RAISED_CHANGED } from "./raised.ts";

export interface RaisedData {
  /** Thread id to its open asks, oldest first. */
  asks: ReadonlyMap<string, readonly Ask[]>;
  /** Thread id to what its latest brief came to. */
  briefs: ReadonlyMap<string, BriefMark>;
  /** Counts up whenever an ask or a brief changes anywhere: a reason to read a brief again. */
  changes: number;
  /** Record the person's answer and send it to the asking thread. */
  answer: (askId: string, option: number | null, text: string | null) => Promise<Ask>;
  /** A thread's brief, with its evidence and its check; null when it has none. */
  brief: (threadId: string) => Promise<BriefRecord | null>;
  /** Record that the person opened this version of a brief. */
  markRead: (threadId: string, version: number) => Promise<void>;
  /** Start a new check of a thread's latest brief. */
  check: (threadId: string) => Promise<void>;
}

const NO_ASKS: ReadonlyMap<string, readonly Ask[]> = new Map();
const NO_BRIEFS: ReadonlyMap<string, BriefMark> = new Map();

/** Load the asks and briefs of `threadIds`, and again whenever that list or any of them changes. */
export function useRaised(threadIds: readonly string[] | null): RaisedData {
  const rpc = useRpc<typeof attentionRpcContract>();
  const [asks, setAsks] = useState(NO_ASKS);
  const [briefs, setBriefs] = useState(NO_BRIEFS);
  const [changes, setChanges] = useState(0);
  const ids = useRef(threadIds);
  ids.current = threadIds;
  const request = useRef(0);

  const reload = useCallback(() => {
    const wanted = ids.current;
    if (wanted === null) return;
    const seq = ++request.current;
    // Asks and briefs only add to a line; if they cannot be read the page still shows its threads.
    Promise.all([rpc.call("asks_list", {}), rpc.call("brief_marks", { threadIds: [...wanted] })]).then(
      ([asked, marked]) => {
        if (seq !== request.current) return;
        setAsks(asksByThread(asked.asks));
        setBriefs(new Map(Object.entries(marked.marks)));
      },
      () => undefined,
    );
  }, [rpc]);

  const key = threadIds === null ? null : threadIds.join(" ");
  useEffect(reload, [reload, key]);
  useRealtime(RAISED_CHANGED, () => {
    setChanges((value) => value + 1);
    reload();
  });

  return useMemo(
    () => ({
      asks,
      briefs,
      changes,
      answer: async (askId, option, text) => {
        const answered = await rpc.call("ask_answer", { id: askId, option, text });
        // Gone from the page at once; the reload confirms it.
        setAsks((current) => {
          const next = new Map(current);
          const left = (next.get(answered.threadId) ?? []).filter((ask) => ask.id !== askId);
          if (left.length > 0) next.set(answered.threadId, left);
          else next.delete(answered.threadId);
          return next;
        });
        reload();
        return answered;
      },
      brief: async (threadId) => (await rpc.call("brief_get", { threadId })).record,
      markRead: async (threadId, version) => {
        await rpc.call("brief_read", { threadId, version });
        reload();
      },
      check: async (threadId) => {
        await rpc.call("brief_check", { threadId });
        reload();
      },
    }),
    [asks, briefs, changes, rpc, reload],
  );
}
