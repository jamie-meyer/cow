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
import type { EnrolledKey, KeyRequest } from "../signing/envelope.ts";
import type { Signer } from "../signing/page.ts";
import { entryThread } from "./log.ts";

export interface CapSheetHost {
  caps: CapsData;
  /** This page's key, and the keys cow trusts. */
  signer: Signer;
  /** Main and every thread under it: the log shows their entries unless asked for all. */
  underMain: ReadonlySet<string>;
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

type Row =
  | { kind: "capability"; id: string; capability: Capability; notices: Notice[] }
  | { kind: "outside"; id: string; notice: Notice }
  /** A page that asks for its key to be enrolled, or was refused. */
  | { kind: "request"; id: string; request: KeyRequest }
  | { kind: "key"; id: string; key: EnrolledKey };
type KeyConfirming =
  | { on: "key"; what: "approve"; request: KeyRequest }
  | { on: "key"; what: "refuse"; request: KeyRequest }
  /** Remove an enrolled key, or forget a refusal so that page can ask again. */
  | { on: "key"; what: "remove"; fingerprint: string; label: string; enrolled: boolean };
type Confirming = { on: "capability"; what: "delete" | "restore"; capability: Capability } | KeyConfirming;
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
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /** The log shows every entry, not only those of this Main's threads. */
  const [allEntries, setAllEntries] = useState(false);
  const { signer } = host;
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
    for (const request of signer.keys?.requests ?? []) found.push({ kind: "request", id: `request:${request.fingerprint}`, request });
    for (const key of signer.keys?.keys ?? []) found.push({ kind: "key", id: `key:${key.fingerprint}`, key });
    return found;
  }, [caps.capabilities, caps.notices, signer.keys]);
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
    if (row.kind === "request" || row.kind === "key") return setNote("Space acknowledges a new capability or a decision made outside cow; a key is approved with Enter and removed with x");
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
    if (view === "log") return setLogCursor((value) => Math.max(0, Math.min(Math.max(0, shownEntries.length - 1), value + by)));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + by))];
    if (next) setCursor(next.id);
  };
  const jump = (to: "top" | "bottom") => {
    if (view === "log") return setLogCursor(to === "top" ? 0 : Math.max(0, shownEntries.length - 1));
    const next = rows[to === "top" ? 0 : rows.length - 1];
    if (next) setCursor(next.id);
  };

  const onKey = (key: string): boolean => {
    if (!open) return false;
    if (confirming !== null && confirming.on === "key") {
      const asked: KeyConfirming = confirming;
      setConfirming(null);
      if (key !== "y" && key !== "Y") {
        setNote("nothing changed");
        return true;
      }
      const done =
        asked.what === "approve"
          ? signer.call("key_approve", { fingerprint: asked.request.fingerprint }).then(() => `enrolled the key ${asked.request.fingerprint}: that page can now do what you can`)
          : asked.what === "refuse"
            ? signer.call("key_refuse", { fingerprint: asked.request.fingerprint }).then(() => `refused the key ${asked.request.fingerprint}: that page can only read`)
            : signer.call("key_remove", { fingerprint: asked.fingerprint }).then(() => (asked.enrolled ? `removed the key ${asked.fingerprint}: the page that holds it can only read now` : `forgot the refusal of ${asked.fingerprint}: that page can ask again`));
      done.then(setNote, (cause: unknown) => setNote(`not done: ${errorText(cause)}`));
      return true;
    }
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
    if (view === "log") {
      if (key === "a") {
        setAllEntries(!allEntries);
        setLogCursor(0);
      }
      return true;
    }
    switch (key) {
      case "n":
        setNote("");
        host.startNew();
        return true;
      case "x":
        if (current?.kind === "request") setConfirming(current.request.status === "pending" ? { on: "key", what: "refuse", request: current.request } : { on: "key", what: "remove", fingerprint: current.request.fingerprint, label: current.request.label, enrolled: false });
        else if (current?.kind === "key") setConfirming({ on: "key", what: "remove", fingerprint: current.key.fingerprint, label: current.key.label, enrolled: true });
        else if (current?.kind !== "capability") setNote("x deletes a capability, refuses a page's key or removes one: move to one first");
        else if (!isActive(current.capability)) setNote("it is deleted already: Space acknowledges that it was made");
        else setConfirming({ on: "capability", what: "delete", capability: current.capability });
        return true;
      case "u": {
        const last = caps.capabilities.find((capability) => capability.id === deleted[deleted.length - 1] && !isActive(capability));
        if (!last) setNote("nothing to undo: u puts back the capability deleted last from this sheet");
        else setConfirming({ on: "capability", what: "restore", capability: last });
        return true;
      }
      case " ":
        if (current) acknowledge(current);
        return true;
      case "Enter":
        if (current?.kind === "capability") toggleHistory(current.capability);
        else if (current?.kind === "request") {
          if (current.request.status === "pending") setConfirming({ on: "key", what: "approve", request: current.request });
          else setNote("it was refused: x forgets the refusal, and that page can then ask again");
        } else if (current?.kind === "key") setNote(current.key.fingerprint === signer.fingerprint ? "this is this page's own key" : "an enrolled key: x removes it");
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
    <p key={entry.seq} className={isCurrent ? "cow-caplog cow-cur" : "cow-caplog"} data-cow-caplog={entry.seq} data-cow-caplog-kind={entry.event.kind} data-cow-caplog-by={entry.by ?? undefined}>
      <span className="cow-caplog-n">{entry.seq}</span>
      <time>{when(entry.at)}</time>
      <span>
        {eventText(entry.event, host.titleOf)}
        {entry.by ? <small className="cow-caplog-by"> · signed by {entry.by}{entry.by === signer.fingerprint ? ", this page's key" : ""}</small> : null}
      </span>
    </p>
  );
  // The log's entries for this window: those of Main's own threads and those that are about no thread, unless all are asked for.
  const shownEntries = (log?.entries ?? []).filter((entry) => {
    if (allEntries) return true;
    const thread = entryThread(entry.event);
    return thread === null || host.underMain.has(thread);
  });
  const keyRow = (row: Extract<Row, { kind: "key" | "request" }>) => {
    const fingerprint = row.kind === "key" ? row.key.fingerprint : row.request.fingerprint;
    const mine = fingerprint === signer.fingerprint;
    return (
      <div
        key={row.id}
        className={["cow-cap-row", row.id === current?.id ? "cow-cur" : "", row.kind === "request" && row.request.status === "pending" ? "cow-cap-new" : ""].join(" ").trim()}
        data-cow-key={row.kind === "key" ? fingerprint : undefined}
        data-cow-key-request={row.kind === "request" ? fingerprint : undefined}
        data-cow-key-request-status={row.kind === "request" ? row.request.status : undefined}
        data-cow-key-mine={mine || undefined}
        data-cow-hint=""
        onClick={() => setCursor(row.id)}
      >
        <p className="cow-cap-line">
          {row.kind === "request" ? <b className="cow-cap-tag">{row.request.status === "pending" ? "asks to be enrolled" : "refused"}</b> : null}
          <code>{fingerprint}</code>
          <span>{row.kind === "key" ? row.key.label : row.request.label}</span>
          {mine ? <b>this page's key</b> : null}
          {row.kind === "key" ? (
            <>
              <span>
                enrolled {formatAge(Math.max(0, host.now - row.key.enrolledAt))} ago, {row.key.how === "first" ? "by first use" : `approved by ${row.key.approvedBy ?? "an enrolled key"}`}
              </span>
              <span>{row.key.lastUsedAt === null ? "never used" : `last used ${formatAge(Math.max(0, host.now - row.key.lastUsedAt))} ago`}</span>
            </>
          ) : (
            <span>
              asked {formatAge(Math.max(0, host.now - row.request.requestedAt))} ago · the name is the page's own word: compare the key with the one that page shows ·{" "}
              {row.request.status === "pending" ? (
                <>
                  <kbd>⏎</kbd> approve · <kbd>x</kbd> refuse
                </>
              ) : (
                <>
                  <kbd>x</kbd> forget the refusal
                </>
              )}
            </span>
          )}
        </p>
      </div>
    );
  };

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
        <h3 data-cow-caps-section="keys">
          Keys that may act as you <b>{signer.keys?.keys.length ?? 0}</b>
        </h3>
        <p className="cow-bf-none" data-cow-key-own={signer.fingerprint ?? ""} data-cow-key-own-status={signer.status}>
          {signer.status === "enrolled"
            ? `This page's key is ${signer.fingerprint}, and it is enrolled. What only you may do is signed with it; the private half cannot leave this browser.`
            : `${signer.why[0]?.toUpperCase() ?? ""}${signer.why.slice(1)}`}
        </p>
        {rows.map((row) => (row.kind === "request" || row.kind === "key" ? keyRow(row) : null))}
      </>
    ) : log === null ? (
      <p className="cow-bf-lede">Reading the log…</p>
    ) : (
      <>
        <p className={log.check.intact ? "cow-bf-check cow-bf-check-ok" : "cow-bf-check cow-bf-check-bad"} data-cow-caplog-check={log.check.intact ? "intact" : "broken"} data-cow-caplog-total={log.total}>
          {log.check.intact
            ? `${log.total} ${log.total === 1 ? "entry" : "entries"}, numbered without a gap, each carrying the hash of the one before.`
            : `The log is broken at entry ${log.check.at}: ${log.check.why}. Something other than cow changed its storage.`}{" "}
          Newest first{log.total > log.entries.length ? `; the newest ${log.entries.length} are read` : ""}.{" "}
          <span data-cow-caplog-shown={shownEntries.length} data-cow-caplog-all={allEntries || undefined}>
            {allEntries
              ? `Showing all ${shownEntries.length}.`
              : `Showing ${shownEntries.length}: the entries of this Main's threads, and those about no thread${log.entries.length > shownEntries.length ? `; ${log.entries.length - shownEntries.length} about other threads are left out` : ""}.`}
          </span>
        </p>
        {shownEntries.length === 0 ? <p className="cow-bf-none">Nothing has happened here yet.</p> : shownEntries.map((entry, index) => logLine(entry, index === logCursor))}
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
          A capability lets cow answer bb “allow once” without asking you. Making, deleting and acknowledging one are signed with a key this browser holds, and everything is logged.
        </span>
      </div>
      <div className="cow-sheet-body" data-cow-scroll="" ref={bodyRef}>
        {body}
      </div>
      <div className="cow-sheet-foot">
        {confirming && confirming.on === "key" ? (
          <span data-cow-sheet-confirm={confirming.what}>
            {confirming.what === "approve" ? (
              <>
                <b>Enrol the key {confirming.request.fingerprint}?</b> The page that holds it ({confirming.request.label}, by its own word) will be able to do everything only you may do. Approve it only if that page is yours and shows this same key.
              </>
            ) : confirming.what === "refuse" ? (
              <>
                <b>Refuse the key {confirming.request.fingerprint}?</b> The page that holds it can only read, and cannot ask again until the refusal is forgotten.
              </>
            ) : confirming.enrolled ? (
              <>
                <b>Remove the key {confirming.fingerprint}?</b> {confirming.fingerprint === signer.fingerprint ? "It is this page's own: this page will only be able to read, and with no key left the next page to open is enrolled." : "The page that holds it will only be able to read."}
              </>
            ) : (
              <>
                <b>Forget the refusal of {confirming.fingerprint}?</b> That page can then ask to be enrolled again.
              </>
            )}{" "}
            <kbd>y</kbd> yes · any other key cancels
          </span>
        ) : confirming ? (
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
            <kbd>j</kbd> <kbd>k</kbd> <kbd>gg</kbd> <kbd>G</kbd> move · <kbd>a</kbd> {allEntries ? "only this Main's entries" : "all entries"} · <kbd>⇥</kbd> the capabilities · <kbd>q</kbd> <kbd>Esc</kbd> close · nothing here can be edited or cleared
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
