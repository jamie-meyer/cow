// Other plugins on cow's page: their badges at the end of a thread's line,
// and their actions for the selected line. bb draws the badges and binds the
// actions; the other plugin's own code renders and runs them.

import { memo, useEffect, useMemo, useRef } from "react";
import {
  type PluginSidebarThread,
  type PluginThreadActionEntry,
  experimental_ThreadRowMetadata as ThreadRowMetadata,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
} from "@get-bb/plugin-sdk/app";
import { type FactsLike, type MenuRow, PICK_KEYS, actionTarget, indexById, otherActions } from "./plugins.ts";

const choiceKey = (index: number): string => PICK_KEYS[index] ?? "";

/** bb's own threads, by id: what a line's badges and actions are evaluated with. */
export function useSidebarIndex(): ReadonlyMap<string, PluginSidebarThread> {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => indexById(threads), [threads]);
}

/**
 * Every badge other plugins registered for a thread's row. It never takes
 * focus: a press on it does not move the cursor out of the overview, and
 * the click still reaches the line, which selects it.
 */
export const RowBadges = memo(function RowBadges({ thread }: { thread: PluginSidebarThread }) {
  return (
    <span className="cow-bx" data-cow-badges="" onMouseDown={(event) => event.preventDefault()}>
      <ThreadRowMetadata thread={thread} />
    </span>
  );
});

export type ActionRow = MenuRow<PluginThreadActionEntry>;

/**
 * The actions other plugins offer for one thread, kept current. Rendered only
 * for the selected line, so bb evaluates one thread's actions, not every line's.
 */
export function useOtherActions(facts: FactsLike, sidebar: PluginSidebarThread | undefined): ActionRow[] {
  const target = useMemo(() => actionTarget(facts, sidebar), [facts, sidebar]);
  const entries = experimental_useThreadActions(target as Parameters<typeof experimental_useThreadActions>[0]);
  const own = experimental_usePluginId();
  return useMemo(() => otherActions(entries, own), [entries, own]);
}

/** Reports the selected line's actions to the page, which shows `. more` only when there are some. */
export function ActionsProbe({
  facts,
  sidebar,
  onRows,
}: {
  facts: FactsLike;
  sidebar: PluginSidebarThread | undefined;
  onRows: (threadId: string, rows: ActionRow[]) => void;
}) {
  const rows = useOtherActions(facts, sidebar);
  const report = useRef(onRows);
  report.current = onRows;
  useEffect(() => report.current(facts.id, rows), [facts.id, rows]);
  useEffect(() => () => report.current(facts.id, []), [facts.id]);
  return null;
}

/** The menu `.` opens: which thread, and whose choices show when an action has them. */
export interface MoreState {
  threadId: string;
  /** The pick key of the action whose choices show; null for the list of actions. */
  choicesOf: string | null;
}

/**
 * The actions other plugins offer for the selected line, opened in place
 * under it. A row is picked by its key or its hint; a disabled one is dimmed
 * and takes neither.
 */
export function MoreCard({ state, rows, onPick }: { state: MoreState; rows: readonly ActionRow[]; onPick: (key: string) => void }) {
  const open = state.choicesOf === null ? null : (rows.find((row) => row.pick === state.choicesOf) ?? null);
  return (
    <div className="cow-ans cow-perm cow-more" data-cow-more={state.threadId} role="menu" aria-label="what other plugins offer for this thread" onClick={(event) => event.stopPropagation()}>
      {open === null ? (
        <>
          <p className="cow-perm-kind">Other plugins · drawn and run by them, not by cow</p>
          {rows.map((row, index) => {
            const { action } = row.entry;
            const off = action.disabled === true || row.pick === "";
            const newGroup = index > 0 && rows[index - 1]!.entry.group !== row.entry.group;
            return (
              <div
                key={row.entry.key}
                className={["cow-ans-o", off ? "cow-off" : "", newGroup ? "cow-more-group" : ""].join(" ").trim()}
                role="menuitem"
                aria-disabled={off || undefined}
                data-cow-more-action={row.entry.key}
                data-cow-more-disabled={action.disabled ? "" : undefined}
                data-cow-hint={off ? undefined : ""}
                onClick={off ? undefined : () => onPick(row.pick)}
              >
                <kbd>{row.pick}</kbd>
                <span className="cow-ans-mark">{action.choices ? "▸" : action.variant === "destructive" ? "!" : "·"}</span>
                <span>
                  {action.label}
                  {action.detail ? <small> · {action.detail}</small> : null}
                  <small className="cow-more-from"> · {row.from}</small>
                </span>
              </div>
            );
          })}
          <p className="cow-ans-keys">
            <kbd>{rows[0]?.pick ?? "1"}</kbd>–<kbd>{rows[rows.length - 1]?.pick || "9"}</kbd> run it in the plugin that offers it · <kbd>f</kbd> hints · <kbd>Esc</kbd> close
          </p>
        </>
      ) : (
        <>
          <p className="cow-perm-kind">
            {open.entry.action.choices?.heading ?? open.entry.action.label} · {open.from}
          </p>
          {(open.entry.action.choices?.items ?? []).map((choice, index) => {
            const pick = choiceKey(index);
            const off = choice.disabled === true || pick === "";
            return (
              <div
                key={choice.id}
                className={["cow-ans-o", off ? "cow-off" : "", choice.selected ? "cow-chosen" : ""].join(" ").trim()}
                role="menuitemradio"
                aria-checked={choice.selected ?? false}
                aria-disabled={off || undefined}
                data-cow-more-choice={choice.id}
                data-cow-more-disabled={choice.disabled ? "" : undefined}
                data-cow-hint={off ? undefined : ""}
                onClick={off ? undefined : () => onPick(pick)}
              >
                <kbd>{pick}</kbd>
                <span className="cow-ans-mark">{choice.selected ? "◉" : "○"}</span>
                <span>{choice.label}</span>
              </div>
            );
          })}
          {open.entry.action.choices?.hint ? <p className="cow-ans-why">{open.entry.action.choices.hint}</p> : null}
          <p className="cow-ans-keys">
            pick one to run it in {open.from} · <kbd>Esc</kbd> back to the list
          </p>
        </>
      )}
    </div>
  );
}
