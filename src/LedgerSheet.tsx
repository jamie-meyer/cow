// The ledger on the page: L opens a sheet over it with the summary by model
// and by dispatching thread, and the latest rows. Keyboard only; q or Esc
// closes it. The rows hold no titles: a title shown here is bb's, read now.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { type GroupSummary, type Judgement, type LedgerRow, type LedgerSummary, OUTCOMES, OUTCOME_TEXT, SMALL_GROUP, durationText, whoText } from "./ledger.ts";
import { LEDGER_CHANGED } from "./ledger-store.ts";

/** The window the sheet reads, as `bb cow ledger` does by default. */
export const LEDGER_DAYS = 14;
/** The sheet lists this many rows, newest first. */
const ROWS_SHOWN = 20;

export interface LedgerData {
  rows: readonly LedgerRow[];
  summary: LedgerSummary | null;
  /** The latest outcome of each worker that has one, open or archived. */
  outcomes: ReadonlyMap<string, Judgement>;
  error: string | null;
}

export function useLedger(): LedgerData {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<LedgerData>({ rows: [], summary: null, outcomes: new Map(), error: null });
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    rpc.call("ledger_read", { days: LEDGER_DAYS }).then(
      ({ rows, summary, outcomes }) => {
        if (seq === request.current) setData({ rows, summary, outcomes: new Map(Object.entries(outcomes)), error: null });
      },
      (cause: unknown) => {
        if (seq === request.current) setData((current) => ({ ...current, error: cause instanceof Error ? cause.message : String(cause) }));
      },
    );
  }, [rpc]);
  useEffect(reload, [reload]);
  useRealtime(LEDGER_CHANGED, reload);
  return data;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const steersText = (value: number | null) => (value === null ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(1));

function Group({ group, name }: { group: GroupSummary; name: string }) {
  return (
    <div className="cow-row" data-cow-ledger-group={group.key} data-cow-ledger-small={group.small || undefined}>
      <span>
        <b>{group.workers}</b>
      </span>
      <span>
        <b>{name}</b> ·{" "}
        {[...OUTCOMES, "unsaid" as const].map((outcome) => (
          <span key={outcome} data-cow-ledger-count={outcome}>
            {outcome} {group.outcomes[outcome]}
            {group.shares ? ` (${percent(group.shares.outcomes[outcome])})` : ""}
            {", "}
          </span>
        ))}
        median to first report {durationText(group.medianToFirstReportMs)} · median steers before it {steersText(group.medianSteers)} · judged by you{" "}
        {group.judgedByPerson}
        {group.shares ? ` (${percent(group.shares.judgedByPerson)})` : ""}
        {group.small ? <small> · fewer than {SMALL_GROUP}: too small to compare</small> : null}
      </span>
    </div>
  );
}

export function LedgerSheet({ data, titleOf, onClose }: { data: LedgerData; titleOf: (threadId: string) => string | null; onClose: () => void }) {
  const { summary, rows, error } = data;
  const name = (id: string) => (id === "none" || id === "unknown" ? id : (titleOf(id) ?? id));
  return (
    <div className="cow-help" data-cow-ledger="" onClick={onClose}>
      <div className="cow-card" onClick={(event) => event.stopPropagation()}>
        <h3>
          The ledger · the last {LEDGER_DAYS} days · j k scroll, q or Esc closes it
        </h3>
        <p className="cow-ledger-about">
          One row per worker archived through cow: its model and effort, its time to first report, how many times it was steered before that
          report, its turns, and what it came to. It holds no titles, prompts or message text. The outcomes:{" "}
          {OUTCOMES.map((outcome) => `${outcome}, ${OUTCOME_TEXT[outcome]}`).join("; ")}. <kbd>o</kbd> on a line under Archived or To settle sets
          or changes one. Groups of fewer than {SMALL_GROUP} are counted, not compared.
        </p>
        {error ? <p data-cow-ledger-error="">could not read the ledger: {error}</p> : null}
        {summary === null ? (
          <p>reading…</p>
        ) : summary.rows === 0 ? (
          <p data-cow-ledger-empty="">Nothing yet: a row is written when a worker that finished a turn is archived through cow.</p>
        ) : (
          <>
            <h3>By model</h3>
            {summary.byModel.map((group) => (
              <Group key={group.key} group={group} name={group.key} />
            ))}
            <h3>By dispatching thread</h3>
            {summary.byDispatcher.map((group) => (
              <Group key={group.key} group={group} name={name(group.key)} />
            ))}
            <h3>
              Latest rows{rows.length > ROWS_SHOWN ? ` (${ROWS_SHOWN} of ${rows.length}; bb cow ledger lists them all)` : ""}
            </h3>
            {rows.slice(0, ROWS_SHOWN).map((row) => (
              <div className="cow-row" key={row.threadId} data-cow-ledger-row={row.threadId} data-cow-ledger-outcome={row.outcome ?? "unsaid"}>
                <span>
                  <b>{row.outcome ?? "unsaid"}</b>
                </span>
                <span>
                  {titleOf(row.threadId) ?? row.threadId} · {row.model ?? "model unknown"}
                  {row.effort ? ` · ${row.effort}` : ""} · first report after {durationText(row.toFirstReportMs)} · steered {row.steersByPerson} by you,{" "}
                  {row.steersByThreads} by threads · {row.turns} {row.turns === 1 ? "turn" : "turns"}
                  {row.outcome ? ` · judged by ${row.judgedBy === "person" ? "you" : name(row.judgedBy ?? "")}${row.outcomeChanges > 0 ? `, changed ${row.outcomeChanges}×` : ""}` : ""} · archived
                  by {row.archivedBy === "person" ? "you" : whoText(row.archivedBy)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The sheet's keys: q or Esc closes; j k, g G and Space scroll. */
export function ledgerKey(key: string, close: () => void): true {
  if (key === "Escape" || key === "q" || key === "L") close();
  const card = document.querySelector<HTMLElement>("[data-cow-ledger] .cow-card");
  if (card) {
    if (key === "j" || key === "ArrowDown") card.scrollBy({ top: 60 });
    else if (key === "k" || key === "ArrowUp") card.scrollBy({ top: -60 });
    else if (key === "G") card.scrollTo({ top: card.scrollHeight });
    else if (key === "g") card.scrollTo({ top: 0 });
    else if (key === " ") card.scrollBy({ top: card.clientHeight * 0.8 });
  }
  return true;
}
