// Caps and stuck checks on the page: a mark on a worker's line saying what it
// is over or caught by, and one notice per worker per reason in the queue,
// acknowledged by a signed call. What they show comes from cow's server,
// which checks when a worker's events change and on its one timer; the page
// only reads it. Nothing here, or on the server, stops a worker.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { type Finding, WATCH_CHANGED } from "./progress.ts";
import type { Signer } from "./signing/page.ts";
import { formatAge } from "./text.ts";
import type { WatchNotice, WatchReport } from "./watch-backend.ts";

/** The page reads the marks again this often, besides whenever the server says they changed: the time-based ones move by the minute. */
const READ_EVERY_MS = 60_000;

export interface WatchData {
  marks: Readonly<Record<string, readonly Finding[]>>;
  notices: readonly WatchNotice[];
  errors: readonly string[];
  acknowledge: (noticeId: string) => Promise<void>;
}

export function useWatch(signer: Signer): WatchData {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<WatchReport | null>(null);
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    rpc.call("watch_read", null).then(
      (got) => seq === request.current && setReport(got),
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    reload();
    const every = setInterval(reload, READ_EVERY_MS);
    return () => clearInterval(every);
  }, [reload]);
  useRealtime(WATCH_CHANGED, reload);
  return useMemo(
    () => ({
      marks: report?.marks ?? {},
      notices: report?.notices ?? [],
      errors: report?.errors ?? [],
      acknowledge: async (noticeId) => {
        await signer.call("watch_ack", { noticeId });
        setReport((current) => (current ? { ...current, notices: current.notices.filter((notice) => notice.id !== noticeId) } : current));
        reload();
      },
    }),
    [report, signer, reload],
  );
}

/** On a worker's line: what it is over or caught by, while it is true. */
export function WatchMark({ found }: { found: readonly Finding[] }) {
  return (
    <b className="cow-watch" data-cow-watch={found.map((f) => f.reason).join(" ")} title="shown, never enforced: cow does not stop a worker">
      {found.map((f) => f.mark).join(" · ")}
      {" · "}
    </b>
  );
}

/** A worker notice in the queue: a click, or its hint, acknowledges it (signed). */
export function WatchNoticeItem({ notice, now, onAck }: { notice: WatchNotice; now: number; onAck: (id: string) => void }) {
  return (
    <li className="cow-q cow-q-notice" data-cow-watch-notice={notice.id} data-cow-watch-reason={notice.reason} data-cow-watch-thread={notice.threadId} data-cow-hint="" onClick={() => onAck(notice.id)}>
      <span className="cow-qn">!</span>
      <span className="cow-gl" />
      <div>
        <p>{notice.text}</p>
        <small>worker · {formatAge(Math.max(0, now - notice.at))} · a click or its hint acknowledges it; it does not come back for this worker</small>
      </div>
    </li>
  );
}
