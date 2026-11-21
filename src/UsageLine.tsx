// The usage line on the page, always in the same place above the status
// line, and the usage notices in the person's queue. What it shows comes
// from cow's server, which checks on a timer whether the page is open or
// not; the page only reads it, and acknowledges a notice by a signed call.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { LimitNotice, UsageReport } from "./limits-backend.ts";
import { LIMITS_CHANGED, PACE_RULE, monthText, windowKey, windowText } from "./limits.ts";
import type { Signer } from "./signing/page.ts";
import { formatAge } from "./text.ts";

/** The page reads the line again this often, besides whenever the server says it changed. */
const READ_EVERY_MS = 5 * 60_000;

export interface LimitsData {
  report: UsageReport | null;
  error: string | null;
  notices: readonly LimitNotice[];
  acknowledge: (noticeId: string) => Promise<void>;
}

export function useLimits(signer: Signer): LimitsData {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    rpc.call("usage_read", {}).then(
      (got) => {
        if (seq !== request.current) return;
        setReport(got);
        setError(null);
      },
      (cause: unknown) => seq === request.current && setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    reload();
    const every = setInterval(reload, READ_EVERY_MS);
    return () => clearInterval(every);
  }, [reload]);
  useRealtime(LIMITS_CHANGED, reload);
  return useMemo(
    () => ({
      report,
      error,
      notices: report?.notices ?? [],
      acknowledge: async (noticeId) => {
        await signer.call("limit_ack", { noticeId });
        // Gone from the page at once; the reload confirms it.
        setReport((current) => (current ? { ...current, notices: current.notices.filter((notice) => notice.id !== noticeId) } : current));
        reload();
      },
    }),
    [report, error, signer, reload],
  );
}

/** One quiet line: each window with its percent and reset, then the month. */
export function UsageLine({ data, now }: { data: LimitsData; now: number }) {
  const { report, error } = data;
  const why = report?.month?.budget != null ? `pace: ${PACE_RULE}` : "list-price dollars of every thread on this bb; no monthly budget is set";
  return (
    <div className="cow-usage" data-cow-usage={report === null ? "loading" : "read"} title={report?.errors.join("\n") || undefined}>
      {report === null ? (
        <span>{error ? `usage: ${error}` : "usage …"}</span>
      ) : (
        <>
          {report.windows.map((w) => (
            <span key={windowKey(w)} className={w.usedPercent >= report.windowPercent ? "cow-usage-w cow-usage-hot" : "cow-usage-w"} data-cow-usage-window={windowKey(w)} data-cow-usage-percent={w.usedPercent}>
              {windowText(w, now)}
            </span>
          ))}
          {report.month ? (
            <span className="cow-usage-m" data-cow-usage-month={report.month.month} data-cow-usage-budget={report.month.budget ?? ""} data-cow-usage-pace={report.month.pace ?? ""} title={why}>
              {monthText(report.month)}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A usage notice in the queue: a click, or its hint, acknowledges it (signed). */
export function UsageNotice({ notice, now, onAck }: { notice: LimitNotice; now: number; onAck: (id: string) => void }) {
  return (
    <li className="cow-q cow-q-notice" data-cow-limit-notice={notice.id} data-cow-limit-rule={notice.rule} data-cow-hint="" onClick={() => onAck(notice.id)}>
      <span className="cow-qn">!</span>
      <span className="cow-gl" />
      <div>
        <p>{notice.text}</p>
        <small>
          usage · {formatAge(Math.max(0, now - notice.at))} · a click or its hint acknowledges it; it does not come back until the next period
        </small>
      </div>
    </li>
  );
}
