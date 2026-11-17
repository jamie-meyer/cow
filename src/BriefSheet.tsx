// A thread's brief as a sheet over the page: what the checker disputes
// first, then the decisions that are the person's, then the other claims,
// then what was left undone, then the agent's summary.
//
// Two voices are kept apart throughout. The agent's label is printed as what
// the agent says. Only the checker's verdict is printed as a verdict, and a
// claim it supported is said to be supported by that audit, no more.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Ask } from "./asks/ask.ts";
import type { Label } from "./briefs/brief.ts";
import { type ReviewedClaim, type Verdict, earlierDisputesText, review } from "./briefs/review.ts";
import type { BriefRecord } from "./briefs/service.ts";
import { type SheetItem, checkLine, moveStop, sheetItems } from "./briefs/sheet.ts";
import type { Command } from "./keys.ts";
import type { RaisedData } from "./raisedData.ts";
import { fileAttribute } from "./reader/trigger.ts";
import { formatAge } from "./text.ts";

const LABEL_TEXT: Record<Label, string> = { checked: "checked", inferred: "inferred", "not-checked": "not checked" };
const VERDICT_TEXT: Record<Verdict, string> = { supported: "supported", "not-supported": "not supported", "cannot-tell": "cannot tell" };

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface SheetHost {
  raised: RaisedData;
  /** The title of a thread on the page. */
  titleOf: (threadId: string) => string;
  now: number;
  say: (message: string) => void;
  /** Open the ask card for one ask, in place. */
  startAsk: (threadId: string, askId: string) => void;
  /** The ask card, when it is open for this ask. */
  askCard: (askId: string) => ReactNode;
  /** The sheet closed: the cursor goes back to its line. */
  onClose: (threadId: string) => void;
}

export interface BriefSheetControl {
  /** The thread whose brief is open, or null. */
  threadId: string | null;
  open: (threadId: string) => void;
  /** A key's command while the sheet is open. False when the sheet has no use for it. */
  onCommand: (command: Command) => boolean;
  /** Set while the sheet asks for a yes or no: it takes the next key. */
  onKey: ((key: string) => void) | null;
  node: ReactNode;
}

interface Open {
  threadId: string;
  /** Null while it is being read; "none" when the thread has no brief. */
  record: BriefRecord | null | "none";
  error: string;
  cursor: string | null;
  expanded: ReadonlySet<string>;
  confirming: boolean;
  note: string;
}

function ClaimRow({ item, current, expanded, threadId, onSelect }: { item: Extract<SheetItem, { kind: "dispute" | "claim" }>; current: boolean; expanded: boolean; threadId: string; onSelect: () => void }) {
  const entry: ReviewedClaim = item.entry;
  const { claim, verdict, dispute } = entry;
  const pieces = claim.evidence.length;
  return (
    <div
      className={["cow-bf-item", dispute ? `cow-bf-${dispute}` : "", current ? "cow-cur" : ""].join(" ").trim()}
      data-cow-brief-item={item.id}
      data-cow-brief-kind={item.kind}
      data-cow-brief-dispute={dispute ?? undefined}
      data-cow-brief-verdict={verdict?.verdict ?? "none"}
      data-cow-brief-expanded={expanded || undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      onClick={onSelect}
    >
      <p className="cow-bf-claim">
        {dispute ? (
          <b className="cow-bf-tag" data-cow-brief-tag="">
            {dispute === "contradicted" ? "contradicted" : "not established"}
          </b>
        ) : null}
        “{claim.text}”
      </p>
      <p className="cow-bf-row cow-bf-agent" data-cow-brief-label={claim.label}>
        <span>the agent says</span>
        <span>
          “{LABEL_TEXT[claim.label]}” <small>· its own word, not a check</small>
        </span>
      </p>
      {verdict ? (
        <>
          <p className="cow-bf-row">
            <span>the evidence shows</span>
            <span data-cow-brief-shows="">{verdict.shows}</span>
          </p>
          <p className="cow-bf-row cow-bf-verdict">
            <span>the checker</span>
            <span>
              {verdict.verdict === "supported" ? "found it supported" : verdict.verdict === "not-supported" ? <b>not supported: the evidence does not show this</b> : <b>cannot tell from the evidence</b>}
              {entry.disagreement ? <small data-cow-brief-disagree=""> · its runs disagreed: {entry.disagreement.map((v) => VERDICT_TEXT[v]).join(", ")}</small> : null}
            </span>
          </p>
          {verdict.needs ? (
            <p className="cow-bf-row" data-cow-brief-needs="">
              <span>would settle it</span>
              <span>{verdict.needs}</span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="cow-bf-row cow-bf-verdict">
          <span>the checker</span>
          <span>no verdict</span>
        </p>
      )}
      <p className="cow-bf-row cow-bf-ev">
        <span>evidence</span>
        <span>
          {pieces === 0 ? "none attached" : `${pieces} ${pieces === 1 ? "piece" : "pieces"}`}
          {pieces > 0 && current ? <small> · {expanded ? "h closes" : "l or ⏎ opens"}</small> : null}
        </span>
      </p>
      {expanded
        ? claim.evidence.map((piece, index) => (
            <div key={index} className="cow-bf-piece" data-cow-brief-evidence={index + 1}>
              <p>
                <b>{piece.description}</b>
                <small>
                  {" · "}
                  {piece.path === null ? (
                    "an excerpt chosen by the agent"
                  ) : (
                    <>
                      <button
                        type="button"
                        className="cow-filelink"
                        tabIndex={-1}
                        data-cow-file={fileAttribute({ kind: "rooted", threadId, root: "storage", relPath: piece.path, lines: null })}
                        data-cow-brief-file={piece.path}
                        data-cow-hint=""
                      >
                        {piece.path}
                      </button>
                      , as it was when submitted{piece.truncated ? "; cut short, as the checker read it" : ""}
                    </>
                  )}
                </small>
              </p>
              <pre className="cow-perm-diff">{piece.text}</pre>
            </div>
          ))
        : null}
    </div>
  );
}

function CallRow({ item, current, card, onSelect }: { item: Extract<SheetItem, { kind: "call" }>; current: boolean; card: ReactNode; onSelect: () => void }) {
  return (
    <div
      className={current ? "cow-bf-item cow-bf-call cow-cur" : "cow-bf-item cow-bf-call"}
      data-cow-brief-item={item.id}
      data-cow-brief-kind="call"
      data-cow-brief-ask={item.ask?.id}
      data-cow-hint=""
      aria-current={current || undefined}
      onClick={onSelect}
    >
      <p className="cow-bf-claim">{item.text}</p>
      <p className="cow-bf-row">
        <span>yours to decide</span>
        <span>
          {item.ask ? (
            <>
              open as an ask{current && !card ? <small> · a answers it here</small> : null}
            </>
          ) : item.askId ? (
            "its ask is answered or withdrawn"
          ) : (
            "not raised as an ask: tell the thread what you decide"
          )}
        </span>
      </p>
      {card}
    </div>
  );
}

function Sheet({ open, host, items, asks, onSelect }: { open: Open; host: SheetHost; items: readonly SheetItem[]; asks: readonly Ask[]; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector(".cow-bf-item.cow-cur")?.scrollIntoView({ block: "nearest" });
  }, [open.cursor, open.expanded]);
  const title = host.titleOf(open.threadId);
  const record = open.record;
  let body: ReactNode;
  if (record === null) {
    body = <p className="cow-bf-lede">{open.error ? <span className="cow-err">could not read the brief: {open.error}</span> : "Reading the brief…"}</p>;
  } else if (record === "none") {
    body = <p className="cow-bf-lede">This thread has submitted no brief. Its agent submits one with bb cow brief submit when it finishes a job.</p>;
  } else {
    const seen = review(record.brief, record.check);
    const check = checkLine(seen);
    const disputes = items.filter((item) => item.kind === "dispute");
    const calls = items.filter((item) => item.kind === "call");
    const claims = items.filter((item) => item.kind === "claim");
    const draw = (item: SheetItem) =>
      item.kind === "call" ? (
        <CallRow key={item.id} item={item} current={item.id === open.cursor} card={item.ask ? host.askCard(item.ask.id) : null} onSelect={() => onSelect(item.id)} />
      ) : (
        <ClaimRow key={item.id} item={item} current={item.id === open.cursor} expanded={open.expanded.has(item.id)} threadId={open.threadId} onSelect={() => onSelect(item.id)} />
      );
    body = (
      <>
        <p className={`cow-bf-check cow-bf-check-${check.tone}`} data-cow-brief-check={seen.state} data-cow-brief-runs={seen.runs.done}>
          {check.text}
        </p>
        {record.earlierDisputes > 0 ? (
          <p className="cow-bf-check cow-bf-check-bad" data-cow-brief-earlier={record.earlierDisputes}>
            {earlierDisputesText(record.earlierDisputes)[0]?.toUpperCase()}
            {earlierDisputesText(record.earlierDisputes).slice(1)}. This check replaced that one.
          </p>
        ) : null}
        {seen.failed.map((failure, index) => (
          <div key={index} className="cow-bf-failure" data-cow-brief-failure="">
            <p>
              a run failed{failure.retried ? ", and so did the second try" : ""}: {failure.error}
            </p>
            {failure.answer !== null ? (
              <>
                <p className="cow-bf-none">What the checker answered, as it came ({failure.answer.length} characters). None of it counts as a verdict.</p>
                <pre className="cow-perm-diff" data-cow-brief-answer="">
                  {failure.answer}
                </pre>
              </>
            ) : null}
          </div>
        ))}
        <h3 data-cow-brief-section="disputes">
          Disputed by the checker <b>{disputes.length}</b>
        </h3>
        {disputes.length === 0 ? (
          <p className="cow-bf-none">{seen.state === "checked" ? "The checker disputed none of the claims." : "Unknown: there is no check to dispute anything."}</p>
        ) : (
          disputes.map(draw)
        )}
        <h3 data-cow-brief-section="calls">
          Judgement calls for you <b>{calls.length}</b>
        </h3>
        {calls.length === 0 ? <p className="cow-bf-none">None listed: the agent left no decision to you.</p> : calls.map(draw)}
        <h3 data-cow-brief-section="claims">
          Other claims <b>{claims.length}</b>
        </h3>
        {claims.length === 0 ? <p className="cow-bf-none">None: every claim is among the disputed ones above.</p> : claims.map(draw)}
        <h3 data-cow-brief-section="not-done">
          Left undone, as the agent lists it <b>{seen.notDone.length}</b>
        </h3>
        {seen.notDone.length === 0 ? <p className="cow-bf-none">Nothing listed: the agent says it left nothing undone.</p> : seen.notDone.map((entry, index) => <p key={index} className="cow-bf-undone">{entry}</p>)}
        <h3 data-cow-brief-section="summary">The agent's summary</h3>
        <p className="cow-bf-summary">{record.brief.summary}</p>
        {asks.length > 0 ? <p className="cow-bf-none">This thread also has {asks.length === 1 ? "an ask" : `${asks.length} asks`} open: q, then a on its line.</p> : null}
      </>
    );
  }
  const version = record !== null && record !== "none" ? record : null;
  return (
    <div className="cow-sheet" data-cow-sheet={open.threadId} role="dialog" aria-label={`brief from ${title}`}>
      <div className="cow-sheet-head">
        <b data-cow-sheet-title="">
          Brief{version ? ` v${version.version}` : ""} · {title}
        </b>
        {version ? <span>submitted {formatAge(Math.max(0, host.now - version.submittedAt))} ago</span> : null}
        <span className="cow-sheet-what">An audit by one model of the evidence the agent chose to attach. It cannot see what was left out.</span>
      </div>
      <div className="cow-sheet-body" data-cow-scroll="" ref={ref}>
        {body}
      </div>
      <div className="cow-sheet-foot">
        {open.confirming ? (
          <span data-cow-sheet-confirm="">
            <b>Run the check again?</b> It starts a new audit and costs a model run for each run in cow's settings; the verdicts above are replaced. <kbd>y</kbd> run it · any other key cancels
          </span>
        ) : (
          <span>
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>l</kbd> <kbd>⏎</kbd> open evidence · <kbd>h</kbd> close it · <kbd>gg</kbd> <kbd>G</kbd> · <kbd>a</kbd> answer a judgement call · <kbd>c</kbd> check again · <kbd>f</kbd> hints · <kbd>q</kbd> <kbd>Esc</kbd> close
          </span>
        )}
        {open.note ? (
          <span className="cow-err" data-cow-sheet-note="">
            {open.note}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The sheet's state and keys. The page draws `node` over itself while a brief is open. */
export function useBriefSheet(host: SheetHost): BriefSheetControl {
  const { raised } = host;
  const [open, setOpen] = useState<Open | null>(null);
  const threadId = open?.threadId ?? null;

  // Read on opening, and again whenever a brief or an ask changes: a check that finishes shows at once.
  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    raised.brief(threadId).then(
      (record) => {
        if (cancelled) return;
        setOpen((current) => (current?.threadId === threadId ? { ...current, record: record ?? "none", error: "" } : current));
      },
      (cause: unknown) => {
        if (!cancelled) setOpen((current) => (current?.threadId === threadId ? { ...current, error: errorText(cause) } : current));
      },
    );
    return () => {
      cancelled = true;
    };
    // `raised.brief` changes identity with every reload; `changes` is what says to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, raised.changes]);

  const record = open?.record ?? null;
  const asks = useMemo(() => (threadId === null ? [] : (raised.asks.get(threadId) ?? [])), [raised.asks, threadId]);
  const items = useMemo(() => (record === null || record === "none" ? [] : sheetItems(review(record.brief, record.check), asks)), [record, asks]);

  // Having it open is having read it: the line stops waiting. Not while a check still runs.
  const unread = record !== null && record !== "none" && record.readAt === null && !record.check?.runs.some((run) => run.status === "running") ? record.version : null;
  useEffect(() => {
    // Marking it read takes it out of the queue, so it is signed: a page that is not enrolled says why it still waits.
    if (threadId !== null && unread !== null) {
      void raised.markRead(threadId, unread).catch((cause: unknown) =>
        setOpen((current) => (current?.threadId === threadId ? { ...current, note: `this brief still waits on you: ${errorText(cause)}` } : current)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, unread, record !== null && record !== "none" ? record.check?.startedAt : null]);

  const cursor = open === null ? null : items.some((item) => item.id === open.cursor) ? open.cursor : (items[0]?.id ?? null);
  const patch = useCallback((change: Partial<Open>) => setOpen((current) => (current ? { ...current, note: "", ...change } : current)), []);

  const close = () => {
    if (open === null) return;
    setOpen(null);
    host.onClose(open.threadId);
  };

  const onCommand = (command: Command): boolean => {
    if (open === null) return false;
    const item = items.find((entry) => entry.id === cursor) ?? null;
    const evidence = item !== null && item.kind !== "call" && item.entry.claim.evidence.length > 0;
    switch (command.kind) {
      case "move":
        patch({ cursor: moveStop(items, cursor, command.by) });
        return true;
      case "top":
        patch({ cursor: items[0]?.id ?? null });
        return true;
      case "bottom":
        patch({ cursor: items[items.length - 1]?.id ?? null });
        return true;
      case "open":
      case "fold": {
        const opening = command.kind === "open" || command.key === "l";
        if (item === null) return true;
        if (item.kind === "call") {
          patch({ note: opening ? (item.ask ? "a answers it here" : "there is nothing to open on a judgement call") : "" });
          return true;
        }
        if (opening && !evidence) {
          patch({ note: "this claim has no evidence attached" });
          return true;
        }
        const expanded = new Set(open.expanded);
        if (opening) expanded.add(item.id);
        else expanded.delete(item.id);
        patch({ expanded, cursor });
        return true;
      }
      case "verb":
        if (command.verb === "answer") {
          if (item?.kind === "call" && item.ask) host.startAsk(open.threadId, item.ask.id);
          else patch({ note: "a answers a judgement call that is open as an ask: move to one first" });
        } else if (command.verb === "brief") close();
        else patch({ note: "close the brief first: q" });
        return true;
      case "recheck":
        if (record === null || record === "none") return true;
        if (record.check?.runs.some((run) => run.status === "running")) patch({ note: "a check is running already" });
        else patch({ confirming: true });
        return true;
      case "close":
      case "back":
        close();
        return true;
      case "help":
        return false;
      default:
        return true;
    }
  };

  const onKey =
    open?.confirming === true
      ? (key: string) => {
          patch({ confirming: false, note: key === "y" || key === "Y" ? "starting the check…" : "not checked again" });
          if (key !== "y" && key !== "Y") return;
          raised.check(open.threadId).then(
            () => patch({ note: "" }),
            (cause: unknown) => patch({ note: `the check did not start: ${errorText(cause)}` }),
          );
        }
      : null;

  return {
    threadId,
    open: (id) => {
      host.say("");
      setOpen({ threadId: id, record: null, error: "", cursor: null, expanded: new Set(), confirming: false, note: "" });
    },
    onCommand,
    onKey,
    node: open ? <Sheet open={{ ...open, cursor }} host={host} items={items} asks={asks} onSelect={(id) => patch({ cursor: id })} /> : null,
  };
}
