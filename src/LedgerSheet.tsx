// The ledger on the page: L opens a sheet over it with the summary by model,
// by dispatching thread and by label (b shows one grouping at a time), and
// the latest rows, with tokens and list-price dollars; and the last 30 days' spend
// under Main. Keyboard only; q or Esc closes it. The rows hold no titles: a
// title shown here is bb's, read now.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import { GROUPINGS, GROUPING_TEXT, type GroupSummary, type Grouping, type Judgement, LEDGER_COST_NOTE, type LedgerRow, type LedgerSummary, OUTCOMES, OUTCOME_TEXT, SMALL_GROUP, costText, durationText, rowTokens, rowUsageText, whoText } from "./ledger.ts";
import { dollarText } from "./prices.ts";
import { SPEND_KINDS, SPEND_KIND_TEXT, type Spend, type SpendPart } from "./spend.ts";
import { tokensLine } from "./usage.ts";
import { LEDGER_CHANGED } from "./ledger-store.ts";
import { scrollKey } from "./scroll.ts";

/** The window the sheet reads, as `bb cow ledger` does by default. */
export const LEDGER_DAYS = 14;
/** The sheet lists this many rows, newest first. */
const ROWS_SHOWN = 20;

export interface LedgerData {
  rows: readonly LedgerRow[];
  summary: LedgerSummary | null;
  /** The latest outcome of each worker that has one, open or archived. */
  outcomes: ReadonlyMap<string, Judgement>;
  /** Each row's list-price dollars, worked out when read; null: usage unknown or no price. */
  costs: Readonly<Record<string, number | null>>;
  priceError: string | null;
  error: string | null;
}

export function useLedger(): LedgerData {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<LedgerData>({ rows: [], summary: null, outcomes: new Map(), costs: {}, priceError: null, error: null });
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    rpc.call("ledger_read", { days: LEDGER_DAYS }).then(
      ({ rows, summary, outcomes, costs, priceError }) => {
        if (seq === request.current) setData({ rows, summary, outcomes: new Map(Object.entries(outcomes)), costs, priceError, error: null });
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

/** The last 30 days' spend under Main, read when the sheet opens: cow keeps what it read of each thread, so an open asks bb only about threads that changed. */
function useSpend(mainId: string | null): { spend: Spend | null; error: string | null } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ spend: Spend | null; error: string | null }>({ spend: null, error: null });
  useEffect(() => {
    if (mainId === null) return;
    let live = true;
    rpc.call("spend_read", { mainId }).then(
      (spend) => live && setState({ spend, error: spend.priceError }),
      (cause: unknown) => live && setState({ spend: null, error: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, mainId]);
  return state;
}

function SpendLine({ name, part, kind }: { name: string; part: SpendPart; kind: string }) {
  const money = part.dollars === null ? "no list price" : `${dollarText(part.dollars)} at list price`;
  return (
    <div className="cow-row" data-cow-spend-part={kind} data-cow-spend-threads={part.threads} data-cow-spend-no-usage={part.noUsage}>
      <span>
        <b>{part.threads}</b>
      </span>
      <span>
        <b>{name}</b>
        {part.threads === 0 ? null : part.noUsage === part.threads ? (
          " · no usage recorded"
        ) : (
          <>
            {" "}· {tokensLine(part.tokens)} · <span data-cow-spend-dollars="">{money}</span>
            {part.unpricedTokens > 0 ? ` · no list price for ${part.unpricedModels.join(", ")}` : ""}
            {part.noUsage > 0 ? ` · ${part.noUsage} with no usage recorded` : ""}
          </>
        )}
      </span>
    </div>
  );
}

function SpendPartView({ mainId }: { mainId: string | null }) {
  const { spend, error } = useSpend(mainId);
  if (mainId === null) return null;
  return (
    <div data-cow-spend="">
      <h3>The last 30 days under Main{spend ? ` · ${spend.period.first} to ${spend.period.last}` : ""}, archived threads included</h3>
      {error ? <p data-cow-spend-error="">{error}</p> : null}
      {spend === null ? (
        error ? null : <p>reading…</p>
      ) : (
        <>
          {SPEND_KINDS.map((kind) => (
            <SpendLine key={kind} kind={kind} name={SPEND_KIND_TEXT[kind]} part={spend.parts[kind]} />
          ))}
          <SpendLine kind="total" name="Total" part={spend.total} />
          <p data-cow-spend-unknown={spend.total.noUsage}>
            {spend.total.noUsage === 0 ? "Every thread had usage recorded." : `${spend.total.noUsage} ${spend.total.noUsage === 1 ? "thread" : "threads"} with no usage recorded: not counted as zero, not counted at all.`}
            {spend.truncated ? " bb's thread list stopped short: there may be threads this does not count." : ""}
          </p>
        </>
      )}
    </div>
  );
}

/** Which groupings the sheet shows: all, or one; b steps through them. */
export type LedgerBy = Grouping | "all";
const BY_ORDER: readonly LedgerBy[] = ["all", ...GROUPINGS];
export const nextLedgerBy = (by: LedgerBy): LedgerBy => BY_ORDER[(BY_ORDER.indexOf(by) + 1) % BY_ORDER.length] as LedgerBy;

const percent = (share: number) => `${Math.round(share * 100)}%`;
const steersText = (value: number | null) => (value === null ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(1));

function Group({ group, name, under }: { group: GroupSummary; name: string; under?: string }) {
  return (
    <div
      className="cow-row"
      data-cow-ledger-group={under === undefined ? group.key : undefined}
      data-cow-ledger-model-in={under}
      data-cow-ledger-model={under === undefined ? undefined : group.key}
      data-cow-ledger-small={group.small || undefined}
      style={under === undefined ? undefined : { paddingLeft: "2em" }}
    >
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
        {" · "}
        <span data-cow-ledger-cost="">{costText(group)}</span>
        {group.small ? <small> · fewer than {SMALL_GROUP}: too small to compare</small> : null}
      </span>
    </div>
  );
}

export function LedgerSheet({
  data,
  titleOf,
  onClose,
  by = "all",
  mainId = null,
}: {
  data: LedgerData;
  titleOf: (threadId: string) => string | null;
  onClose: () => void;
  by?: LedgerBy;
  mainId?: string | null;
}) {
  const { summary, rows, error } = data;
  const shown = (grouping: Grouping) => by === "all" || by === grouping;
  const name = (id: string) => (id === "none" || id === "unknown" ? id : (titleOf(id) ?? id));
  return (
    <div className="cow-help" data-cow-ledger="" data-cow-ledger-by={by} onClick={onClose}>
      <div className="cow-card" onClick={(event) => event.stopPropagation()}>
        <h3>
          The ledger · the last {LEDGER_DAYS} days · {by === "all" ? "every grouping" : GROUPING_TEXT[by].toLowerCase()} · b the next grouping, j k scroll, q or Esc closes it
        </h3>
        <p className="cow-ledger-about">
          One row per worker archived through cow: its model and effort, its time to first report, how many times it was steered before that
          report, its turns, and what it came to. It holds no titles, prompts or message text. The outcomes:{" "}
          {OUTCOMES.map((outcome) => `${outcome}, ${OUTCOME_TEXT[outcome]}`).join("; ")}. <kbd>o</kbd> on a line under Archived or To settle sets
          or changes one. A label is the kind of job its dispatcher named it (<code>bb cow label</code>); within each label its workers are grouped by
          model again. Groups of fewer than {SMALL_GROUP} are counted, not compared. {LEDGER_COST_NOTE}
        </p>
        {data.priceError ? <p data-cow-ledger-price-error="">{data.priceError}</p> : null}
        <SpendPartView mainId={mainId} />
        {error ? <p data-cow-ledger-error="">could not read the ledger: {error}</p> : null}
        {summary === null ? (
          <p>reading…</p>
        ) : summary.rows === 0 ? (
          <p data-cow-ledger-empty="">Nothing yet: a row is written when a worker that finished a turn is archived through cow.</p>
        ) : (
          <>
            {shown("model") ? (
              <>
                <h3>{GROUPING_TEXT.model}</h3>
                {summary.byModel.map((group) => (
                  <Group key={group.key} group={group} name={group.key} />
                ))}
              </>
            ) : null}
            {shown("dispatcher") ? (
              <>
                <h3>{GROUPING_TEXT.dispatcher}</h3>
                {summary.byDispatcher.map((group) => (
                  <Group key={group.key} group={group} name={name(group.key)} />
                ))}
              </>
            ) : null}
            {shown("label") ? (
              <div data-cow-ledger-labels="">
                <h3>{GROUPING_TEXT.label}</h3>
                {(summary.byLabel ?? []).map((group) => (
                  <div key={group.key} data-cow-ledger-label={group.key}>
                    <Group group={group} name={group.key} />
                    {group.byModel.map((model) => (
                      <Group key={model.key} group={model} name={model.key} under={group.key} />
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <h3>
              Latest rows{rows.length > ROWS_SHOWN ? ` (${ROWS_SHOWN} of ${rows.length}; bb cow ledger lists them all)` : ""}
            </h3>
            {rows.slice(0, ROWS_SHOWN).map((row) => (
              <div className="cow-row" key={row.threadId} data-cow-ledger-row={row.threadId} data-cow-ledger-outcome={row.outcome ?? "unsaid"}>
                <span>
                  <b>{row.outcome ?? "unsaid"}</b>
                </span>
                <span>
                  {titleOf(row.threadId) ?? row.threadId}
                  {row.label ? ` · ${row.label}` : ""} · {row.model ?? "model unknown"}
                  {row.effort ? ` · ${row.effort}` : ""} · first report after {durationText(row.toFirstReportMs)} · steered {row.steersByPerson} by you,{" "}
                  {row.steersByThreads} by threads · {row.turns} {row.turns === 1 ? "turn" : "turns"}
                  {row.outcome ? ` · judged by ${row.judgedBy === "person" ? "you" : name(row.judgedBy ?? "")}${row.outcomeChanges > 0 ? `, changed ${row.outcomeChanges}×` : ""}` : ""} · archived
                  by {row.archivedBy === "person" ? "you" : whoText(row.archivedBy)} ·{" "}
                  <span data-cow-ledger-usage={rowTokens(row) === null ? "unknown" : "known"}>
                    {rowUsageText(row, data.costs[row.threadId] ?? null)}
                  </span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The sheet's keys: q or Esc closes; b the next grouping; j k, g G and Space scroll. */
export function ledgerKey(key: string, close: () => void, nextGrouping: () => void = () => undefined): true {
  if (key === "Escape" || key === "q" || key === "L") close();
  if (key === "b") nextGrouping();
  scrollKey(document.querySelector<HTMLElement>("[data-cow-ledger] .cow-card"), key);
  return true;
}
