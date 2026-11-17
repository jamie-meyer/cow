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
import type { Signer } from "./signing/page.ts";

export interface RaisedData {
  /** Thread id to its open asks, oldest first. */
  asks: ReadonlyMap<string, readonly Ask[]>;
  /** Thread id to what its latest brief came to. */
  briefs: ReadonlyMap<string, BriefMark>;
  /** Thread id to when cow delivered the person's answers to its other asks. */
  delivered: ReadonlyMap<string, readonly number[]>;
  /** Close an ask the person answered in chat. Nothing is sent to the thread. */
  close: (askId: string) => Promise<Ask>;
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
const NO_DELIVERED: ReadonlyMap<string, readonly number[]> = new Map();

/** Load the asks and briefs of `threadIds`, and again whenever that list or any of them changes. */
export function useRaised(threadIds: readonly string[] | null, signer: Signer): RaisedData {
  const rpc = useRpc<typeof attentionRpcContract>();
  const [asks, setAsks] = useState(NO_ASKS);
  const [briefs, setBriefs] = useState(NO_BRIEFS);
  const [delivered, setDelivered] = useState(NO_DELIVERED);
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
        setDelivered(new Map(Object.entries(asked.delivered)));
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

  return useMemo(() => {
    /** Gone from the page at once; the reload confirms it. */
    const gone = (done: Ask) => {
      setAsks((current) => {
        const next = new Map(current);
        const left = (next.get(done.threadId) ?? []).filter((ask) => ask.id !== done.id);
        if (left.length > 0) next.set(done.threadId, left);
        else next.delete(done.threadId);
        return next;
      });
      reload();
      return done;
    };
    return {
      asks,
      briefs,
      delivered,
      changes,
      answer: async (askId, option, text) => {
        const answered = await signer.call("ask_answer", { id: askId, option, text });
        // The message that carried it is the person's, and answers nothing else.
        if (answered.deliveredAt !== null) {
          const at = answered.deliveredAt;
          setDelivered((current) => new Map(current).set(answered.threadId, [...(current.get(answered.threadId) ?? []), at]));
        }
        return gone(answered);
      },
      close: async (askId) => gone(await signer.call("ask_close", { id: askId })),
      brief: async (threadId) => (await rpc.call("brief_get", { threadId })).record,
      markRead: async (threadId, version) => {
        await rpc.call("brief_read", { threadId, version });
        reload();
      },
      check: async (threadId) => {
        await rpc.call("brief_check", { threadId });
        reload();
      },
    };
  }, [asks, briefs, delivered, changes, rpc, reload, signer]);
}
