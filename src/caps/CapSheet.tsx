// The capabilities sheet, over the whole page: every capability as one line,
// what waits to be acknowledged, and the log. Making, deleting, restoring
// and acknowledging happen here and nowhere else.

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAge } from "../text.ts";
import { type Capability, VIA_TEXT, isActive, kindText, ruleText, scopeText } from "./cap.ts";
import type { CapsData } from "./data.ts";
import { type ChainCheck, type LogEntry, OUTSIDE_WHERE, eventText } from "./log.ts";
import { holders } from "./scope.ts";
import type { Notice } from "./service.ts";

export interface CapSheetHost {
  caps: CapsData;
  /** Every thread bb has: who a scope takes in today, and their titles. */
  threads: readonly { id: string; title: string; parentThreadId: string | null; archivedAt: number | null }[];
  titleOf: (threadId: string) => string;
  now: number;
  /** Start the steps that make a capability from scratch. */
  startNew: () => void;
  /** The steps, while they are open in the sheet. */
  steps: ReactNode;
  /** The sheet closed. */
  onClose: () => void;
}

export interface CapSheetControl {
  open: boolean;
  show: () => void;
  /** A key while the sheet is open. False when the sheet leaves it to the page (hints). */
  onKey: (key: string) => boolean;
  node: ReactNode;
}

type Row = { kind: "capability"; id: string; capability: Capability; notices: Notice[] } | { kind: "outside"; id: string; notice: Notice };
type Log = { entries: LogEntry[]; total: number; check: ChainCheck };

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const when = (at: number): string => new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const CHORD_MS = 800;
const MAX_NAMED = 6;

export function useCapSheet(host: CapSheetHost): CapSheetControl {
  const { caps } = host;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "log">("list");
  const [cursor, setCursor] = useState<string | null>(null);
  const [logCursor, setLogCursor] = useState(0);
  const [history, setHistory] = useState<ReadonlyMap<string, LogEntry[]>>(new Map());
  const [log, setLog] = useState<Log | null>(null);
  const [confirming, setConfirming] = useState<{ what: "delete" | "restore"; capability: Capability } | null>(null);
  /** Deleted from this sheet, newest last: what u puts back. */
  const [deleted, setDeleted] = useState<readonly string[]>([]);
  const [note, setNote] = useState("");
  const pendingG = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo<Row[]>(() => {
    const byCapability = new Map<string, Notice[]>();
    for (const notice of caps.notices) {
      if (notice.kind === "capability" && notice.capabilityId !== null) byCapability.set(notice.capabilityId, [...(byCapability.get(notice.capabilityId) ?? []), notice]);
    }
    const found: Row[] = [];
    for (const capability of caps.capabilities) {
      const notices = byCapability.get(capability.id) ?? [];
      // A deleted capability stays listed while its notice has not been acknowledged.
      if (isActive(capability) || notices.length > 0) found.push({ kind: "capability", id: capability.id, capability, notices });
    }
    for (const notice of caps.notices) if (notice.kind === "outside") found.push({ kind: "outside", id: notice.id, notice });
    return found;
  }, [caps.capabilities, caps.notices]);
  const at = Math.max(0, rows.findIndex((row) => row.id === cursor));
  const current = rows[at] ?? null;

  // The log is read when it is shown, and again whenever anything changes.
  useEffect(() => {
    if (!open || view !== "log") return;
    let cancelled = false;
    caps.log().then(
      (read) => {
        if (!cancelled) setLog(read);
      },
      (cause: unknown) => {
        if (!cancelled) setNote(`could not read the log: ${errorText(cause)}`);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, caps.changes]);
  // An open history is read again when its capability is used or changed.
  const openIds = [...history.keys()].join(" ");
  useEffect(() => {
    if (!open || openIds === "") return;
    let cancelled = false;
    for (const id of openIds.split(" ")) {
      void caps.log(id).then(
        (read) => {
          if (!cancelled) setHistory((before) => (before.has(id) ? new Map(before).set(id, read.entries) : before));
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openIds, caps.changes]);

  useLayoutEffect(() => {
    bodyRef.current?.querySelector(".cow-cur")?.scrollIntoView({ block: "nearest" });
  }, [cursor, logCursor, view, history]);

  const close = () => {
    setOpen(false);
    setConfirming(null);
    setNote("");
    host.onClose();
  };

  const acknowledge = (row: Row) => {
    const notices = row.kind === "outside" ? [row.notice] : row.notices;
    if (notices.length === 0) return setNote("there is nothing to acknowledge on this line");
    Promise.all(notices.map((notice) => caps.acknowledge(notice.id))).then(
      () => setNote("acknowledged: it is in the log"),
      (cause: unknown) => setNote(`not acknowledged: ${errorText(cause)}`),
    );
  };

  const toggleHistory = (capability: Capability) => {
    if (history.has(capability.id)) {
      const next = new Map(history);
      next.delete(capability.id);
      return setHistory(next);
    }
    setHistory(new Map(history).set(capability.id, []));
  };

  /** The threads that lose a capability, named: the confirmation says who. */
  const losers = (capability: Capability): string => {
    const ids = holders(capability.scope, host.threads.filter((thread) => thread.archivedAt === null));
    if (ids.length === 0) return "no open thread holds it now";
    const names = ids.slice(0, MAX_NAMED).map((id) => `“${host.titleOf(id)}”`);
    return `${ids.length === 1 ? "this thread loses" : `these ${ids.length} threads lose`} it: ${names.join(", ")}${ids.length > MAX_NAMED ? ` and ${ids.length - MAX_NAMED} more` : ""}`;
  };

  const move = (by: number) => {
    setNote("");
    if (view === "log") return setLogCursor((value) => Math.max(0, Math.min((log?.entries.length ?? 1) - 1, value + by)));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + by))];
    if (next) setCursor(next.id);
  };
  const jump = (to: "top" | "bottom") => {
    if (view === "log") return setLogCursor(to === "top" ? 0 : Math.max(0, (log?.entries.length ?? 1) - 1));
    const next = rows[to === "top" ? 0 : rows.length - 1];
    if (next) setCursor(next.id);
  };

  const onKey = (key: string): boolean => {
    if (!open) return false;
    if (confirming !== null) {
      const { what, capability } = confirming;
      setConfirming(null);
      if (key !== "y" && key !== "Y") {
        setNote(what === "delete" ? "not deleted" : "not restored");
        return true;
      }
      if (what === "delete") {
        caps.remove(capability.id).then(
          () => {
            setDeleted((before) => [...before, capability.id]);
            setNote(`deleted “${capability.name}”: it allows nothing from now · u puts it back`);
          },
          (cause: unknown) => setNote(`not deleted: ${errorText(cause)}`),
        );
      } else {
        caps.restore(capability.id).then(
          () => {
            setDeleted((before) => before.filter((id) => id !== capability.id));
            setCursor(capability.id);
            setNote(`“${capability.name}” is back in force: it is marked new until you acknowledge it`);
          },
          (cause: unknown) => setNote(`not restored: ${errorText(cause)}`),
        );
      }
      return true;
    }
    const chord = key === "g" && Date.now() - pendingG.current < CHORD_MS;
    pendingG.current = key === "g" && !chord ? Date.now() : 0;
    switch (key) {
      case "f":
        return false;
      case "j":
      case "ArrowDown":
        move(1);
        return true;
      case "k":
      case "ArrowUp":
        move(-1);
        return true;
      case "g":
        if (chord) jump("top");
        return true;
      case "G":
        jump("bottom");
        return true;
      case "Tab":
        setNote("");
        setView(view === "list" ? "log" : "list");
        return true;
      case "q":
      case "Escape":
      case "C":
        close();
        return true;
    }
    if (view === "log") return true;
    switch (key) {
      case "n":
        setNote("");
        host.startNew();
        return true;
      case "x":
        if (current?.kind !== "capability") setNote("x deletes a capability: move to one first");
        else if (!isActive(current.capability)) setNote("it is deleted already: Space acknowledges that it was made");
        else setConfirming({ what: "delete", capability: current.capability });
        return true;
      case "u": {
        const last = caps.capabilities.find((capability) => capability.id === deleted[deleted.length - 1] && !isActive(capability));
        if (!last) setNote("nothing to undo: u puts back the capability deleted last from this sheet");
        else setConfirming({ what: "restore", capability: last });
        return true;
      }
      case " ":
        if (current) acknowledge(current);
        return true;
      case "Enter":
        if (current?.kind === "capability") toggleHistory(current.capability);
        else if (current) setNote("Space acknowledges it; the log has the rest: Tab");
        return true;
      default:
        return true;
    }
  };

  const capabilityRow = (row: Extract<Row, { kind: "capability" }>) => {
    const { capability } = row;
    const fresh = row.notices.length > 0;
    const gone = !isActive(capability);
    const entries = history.get(capability.id);
    return (
      <div
        key={row.id}
        className={["cow-cap-row", row.id === current?.id ? "cow-cur" : "", fresh ? "cow-cap-new" : "", gone ? "cow-cap-gone" : ""].join(" ").trim()}
        data-cow-cap={capability.id}
        data-cow-cap-name={capability.name}
        data-cow-cap-new={fresh || undefined}
        data-cow-cap-deleted={gone || undefined}
        data-cow-hint=""
        aria-current={row.id === current?.id || undefined}
        onClick={() => setCursor(row.id)}
      >
        <p className="cow-cap-line">
          {fresh ? (
            <b className="cow-cap-tag" data-cow-cap-tag="">
              {gone ? "new · deleted" : "new"}
            </b>
          ) : null}
          <b className="cow-cap-name">{capability.name}</b>
          <span className="cow-cap-kind">{kindText(capability.rule)}</span>
          <code data-cow-cap-rule="">{ruleText(capability.rule)}</code>
          <span data-cow-cap-scope={capability.scope.kind}>for {scopeText(capability.scope, host.titleOf)}</span>
          <span data-cow-cap-uses={capability.uses}>{capability.uses === 0 ? "never used" : `used ${capability.uses}×, last ${formatAge(Math.max(0, host.now - (capability.lastUsedAt ?? host.now)))} ago`}</span>
          <span>
            made {formatAge(Math.max(0, host.now - capability.createdAt))} ago {VIA_TEXT[capability.via]}
            {capability.sourceThreadId ? ` on “${host.titleOf(capability.sourceThreadId)}”` : ""}
          </span>
        </p>
        {capability.note ? <p className="cow-cap-note">{capability.note}</p> : null}
        {fresh ? (
          <p className="cow-cap-note" data-cow-cap-notice="">
            {row.notices.map((notice) => notice.text).join(" · ")} · <kbd>␣</kbd> acknowledges it{gone ? ": it was made and deleted before you saw it" : ""}
          </p>
        ) : null}
        {entries ? (
          <div className="cow-cap-history" data-cow-cap-history={entries.length}>
            {entries.length === 0 ? <p>Reading its history…</p> : entries.map((entry) => logLine(entry, false))}
          </div>
        ) : null}
      </div>
    );
  };

  const logLine = (entry: LogEntry, isCurrent: boolean) => (
    <p key={entry.seq} className={isCurrent ? "cow-caplog cow-cur" : "cow-caplog"} data-cow-caplog={entry.seq} data-cow-caplog-kind={entry.event.kind}>
      <span className="cow-caplog-n">{entry.seq}</span>
      <time>{when(entry.at)}</time>
      <span>{eventText(entry.event, host.titleOf)}</span>
    </p>
  );

  const body =
    view === "list" ? (
      <>
        {host.steps}
        {rows.length === 0 && !host.steps ? (
          <p className="cow-bf-lede" data-cow-caps-empty="">
            No capabilities. Until there is one, cow allows nothing by itself: every permission request is yours. <kbd>n</kbd> makes one, or choose “save as a capability” on a permission request.
          </p>
        ) : null}
        {rows.some((row) => row.kind === "capability") ? <h3 data-cow-caps-section="capabilities">Capabilities <b>{rows.filter((row) => row.kind === "capability" && isActive(row.capability)).length}</b></h3> : null}
        {rows.map((row) => (row.kind === "capability" ? capabilityRow(row) : null))}
        {rows.some((row) => row.kind === "outside") ? <h3 data-cow-caps-section="outside">Decided outside cow, not yet acknowledged <b>{rows.filter((row) => row.kind === "outside").length}</b></h3> : null}
        {rows.map((row) =>
          row.kind === "outside" ? (
            <div key={row.id} className={row.id === current?.id ? "cow-cap-row cow-cap-new cow-cur" : "cow-cap-row cow-cap-new"} data-cow-cap-outside={row.notice.id} data-cow-hint="" onClick={() => setCursor(row.id)}>
              <p className="cow-cap-line">
                <b className="cow-cap-tag">not cow</b>
                <span>{row.notice.text}</span>
                <span>on “{row.notice.threadId ? host.titleOf(row.notice.threadId) : "a thread"}”</span>
                <span>
                  {OUTSIDE_WHERE} · {formatAge(Math.max(0, host.now - row.notice.at))} ago
                </span>
              </p>
            </div>
          ) : null,
        )}
      </>
    ) : log === null ? (
      <p className="cow-bf-lede">Reading the log…</p>
    ) : (
      <>
        <p className={log.check.intact ? "cow-bf-check cow-bf-check-ok" : "cow-bf-check cow-bf-check-bad"} data-cow-caplog-check={log.check.intact ? "intact" : "broken"} data-cow-caplog-total={log.total}>
          {log.check.intact
            ? `${log.total} ${log.total === 1 ? "entry" : "entries"}, numbered without a gap, each carrying the hash of the one before.`
            : `The log is broken at entry ${log.check.at}: ${log.check.why}. Something other than cow changed its storage.`}{" "}
          Newest first{log.total > log.entries.length ? `; the newest ${log.entries.length} are shown` : ""}.
        </p>
        {log.entries.length === 0 ? <p className="cow-bf-none">Nothing has happened yet.</p> : log.entries.map((entry, index) => logLine(entry, index === logCursor))}
      </>
    );

  const node = open ? (
    <div className="cow-sheet cow-capsheet" data-cow-sheet="capabilities" data-cow-capsheet-view={view} role="dialog" aria-label="capabilities">
      <div className="cow-sheet-head">
        <b data-cow-sheet-title="">{view === "list" ? "Capabilities" : "Capabilities · the log"}</b>
        <span>
          {caps.capabilities.filter(isActive).length} in force · {caps.notices.length} to acknowledge
        </span>
        <span className="cow-sheet-what">
          A capability lets cow answer bb “allow once” without asking you. Everything made, deleted and allowed is logged and shown to you; cow cannot tell who called it, only show what was done.
        </span>
      </div>
      <div className="cow-sheet-body" data-cow-scroll="" ref={bodyRef}>
        {body}
      </div>
      <div className="cow-sheet-foot">
        {confirming ? (
          <span data-cow-sheet-confirm={confirming.what}>
            {confirming.what === "delete" ? (
              <>
                <b>Delete “{confirming.capability.name}”?</b> It allows nothing from that moment; {losers(confirming.capability)}.
              </>
            ) : (
              <>
                <b>Put “{confirming.capability.name}” back in force?</b> {ruleText(confirming.capability.rule)} for {scopeText(confirming.capability.scope, host.titleOf)}.
              </>
            )}{" "}
            <kbd>y</kbd> yes · any other key cancels
          </span>
        ) : view === "list" ? (
          <span>
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>n</kbd> new · <kbd>x</kbd> delete · <kbd>u</kbd> undo a delete · <kbd>⏎</kbd> its history · <kbd>␣</kbd> acknowledge · <kbd>⇥</kbd> the log · <kbd>f</kbd> hints · <kbd>q</kbd> <kbd>Esc</kbd> close
          </span>
        ) : (
          <span>
            <kbd>j</kbd> <kbd>k</kbd> <kbd>gg</kbd> <kbd>G</kbd> move · <kbd>⇥</kbd> the capabilities · <kbd>q</kbd> <kbd>Esc</kbd> close · nothing here can be edited or cleared
          </span>
        )}
        {note ? (
          <span className="cow-err" data-cow-sheet-note="">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  ) : null;

  return {
    open,
    show: () => {
      setOpen(true);
      setView("list");
      setNote("");
      setConfirming(null);
    },
    onKey,
    node,
  };
}
