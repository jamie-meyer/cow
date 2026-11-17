// The page: Main's heading, one line per thread, the queue at the side, the
// status line at the bottom, and the real chat in a pane when asked for.

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ThreadChat,
  useBbContext,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { MainState, rpcContract } from "../server.ts";
import { type BriefSheetControl, useBriefSheet } from "./BriefSheet.tsx";
import { type BriefMark, disputeCount } from "./briefs/review.ts";
import { type RaisedData, useRaised } from "./raisedData.ts";
import { useNow } from "./clock.ts";
import { ThreadStore } from "./data.ts";
import { filterOverview } from "./filter.ts";
import { hintLabels, matchHint } from "./hints.ts";
import { dueText } from "./park.ts";
import { type Parks, useParks } from "./parks.ts";
import {
  WINDOW_MAINS_KEY,
  type WindowMains,
  adopt,
  chooseInWindow,
  parseWindowMains,
  resolveMain,
} from "./main.ts";
import {
  type Command,
  type HintTarget,
  KEY_MAP,
  KeyReader,
  activate,
  attachKeys,
  takesCaret,
  collectHintTargets,
} from "./keys.ts";
import {
  type Derived,
  LIMITS,
  type LineState,
  STATE_LABEL,
  type ThreadFacts,
  derive,
  waitingSince,
} from "./state.ts";
import { formatAge } from "./text.ts";
import {
  type Line,
  type Overview,
  ROLLUP_ORDER,
  type Rollup,
  type TodoRow,
  buildOverview,
  cursorOrder,
  descendantIds,
  foldMove,
  headIds,
  keepFolds,
  listed,
  nextMove,
  unfoldAround,
  visibleRows,
  waitingInside,
} from "./tree.ts";
import { undoShort } from "./undo.ts";
import { useVerbs } from "./useVerbs.tsx";
import { VERB_KEYS, type Verb as VerbName, verbBlocked, verbLabel } from "./verbs.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FLASH_MS = 1800;
/** State changes this soon after the page opens are loading, not events. */
const LOAD_SETTLE_MS = 4000;
/** How long after opening a chat its own focus grabs are undone. */
const CHAT_SETTLE_MS = 2500;
/** The picker lists this many threads, most recently active first. */
const PICKER_LIMIT = 300;
/** Where a window keeps which groups are folded. */
const FOLDS_KEY = "cow:folds";

/** Whether the page is open: the "choose Main" command is offered only then. */
export const pageSignal = {
  mounted: false,
  chooseMain: null as (() => void) | null,
};

const GLYPH_PATH: Record<LineState, ReactNode> = {
  wants: <circle cx="6" cy="6" r="4.3" fill="currentColor" />,
  blocked: (
    <>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.9 9.1 9.1 2.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  running: <path d="M2.8 1.6 10.6 6 2.8 10.4z" fill="currentColor" />,
  waiting: (
    <>
      <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 3.3V6l2 1.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  stuck: <path d="M6 .6 11.4 6 6 11.4.6 6z" fill="currentColor" />,
  parked: <path d="M2.9 1.8h2.2v8.4H2.9zM6.9 1.8h2.2v8.4H6.9z" fill="currentColor" />,
  failed: (
    <path d="M2.4 2.4l7.2 7.2M9.6 2.4 2.4 9.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  ),
  done: (
    <path
      d="M1.8 6.5 4.7 9.4 10.2 2.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

/** The states this version can produce, in legend order, with what each means. */
const LEGEND: readonly { state: LineState; name?: string; short: string; long: string }[] = [
  {
    state: "wants",
    short: "it asks, or replied to you",
    long: "It has an ask open for you (“asks you: …”, press a), it asked a question or for permission in its chat, its brief has disputes or judgement calls you have not read (press b), or it finished with a reply that is yours to read: Main, a thread with threads under it, or any thread you sent the message to. Enter opens its chat; Space marks a reply seen. Listed in the queue.",
  },
  {
    state: "blocked",
    // The side legend's column fits one word.
    name: "blocked",
    short: "bb refused it a permission",
    long: "Detected: bb refused it a command or a file change without asking you, because another thread started its turn. Press a to ask again as you (bb then asks you), tell it to carry on, or dismiss. Listed in the queue.",
  },
  {
    state: "running",
    short: "an agent is working",
    long: "A turn is in progress. The line says what it did last.",
  },
  {
    state: "stuck",
    short: "quiet too long, detected",
    long: `Detected, never chosen: running with no event for ${formatAge(LIMITS.runningQuietMs)}, or waiting on you for ${formatAge(LIMITS.waitingOnUserMs)}.`,
  },
  {
    state: "parked",
    short: "set aside by you, with p",
    long: "Chosen by you with p: a reason and a pick-up. It waits on the shelf with everything under it, and comes back to the queue when its date arrives, or every 4 weeks without one.",
  },
  {
    state: "failed",
    short: "its last turn failed",
    long: "Its last turn ended in an error. Open it to retry, or archive it with e. Listed in the queue.",
  },
  {
    state: "done",
    short: "ended in the last 2 days",
    long: "Finished and reported to the thread that started it, or archived, in the last 2 days. A finished member stays in its group, dimmed. Older ones are counted, not listed.",
  },
];

function Glyph({ state }: { state: LineState }) {
  return (
    <svg className={`cow-g cow-s-${state}`} viewBox="0 0 12 12" role="img" aria-label={STATE_LABEL[state]}>
      {GLYPH_PATH[state]}
    </svg>
  );
}

function Pips({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="cow-pips">
      {Array.from({ length: Math.min(count, 8) }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

/** Time in state: heavier the longer it has been, one square per full week. */
function Age({ derived, now }: { derived: Derived; now: number }) {
  const ms = Math.max(0, now - derived.since);
  const calm = derived.state === "done";
  const weight = calm || ms < HOUR ? 0 : ms < DAY ? 1 : ms < WEEK ? 2 : 3;
  return (
    <span className={`cow-ag cow-a${weight} cow-s-${derived.state}`} title="time in this state">
      <Pips count={calm ? 0 : Math.floor(ms / WEEK)} />
      <b>{formatAge(ms)}</b>
    </span>
  );
}

/** The two marks a brief adds: the brief itself, and "disputed". */
const BRIEF_GLYPH = (
  <svg className="cow-g" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.6 1.1h4.6l2.2 2.2v7.6H2.6z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M4.4 5.4h3.2M4.4 7.6h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);
const DISPUTED_GLYPH = (
  <svg className="cow-g" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 4.3h8M2 7.7h8M8.2 1.6 3.8 10.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

type BriefKind = "disputed" | "clean" | "failed" | "checking" | "unchecked";
export function briefKind(mark: BriefMark): BriefKind {
  if (mark.state === "running") return "checking";
  if (mark.state === "failed") return "failed";
  if (mark.state === "unchecked") return "unchecked";
  return disputeCount(mark) > 0 ? "disputed" : "clean";
}

/** What a thread's latest brief came to, in a few marks. Only a checker's answer is ever shown as a result. */
function BriefMarks({ mark }: { mark: BriefMark }) {
  const kind = briefKind(mark);
  const disputed = disputeCount(mark);
  const calls = mark.judgementCalls;
  const words: Record<BriefKind, string> = {
    disputed: `the checker disputes ${disputed} ${disputed === 1 ? "claim" : "claims"}${mark.contradicted > 0 ? `: ${mark.contradicted} contradicted` : ""}${mark.notEstablished > 0 ? `${mark.contradicted > 0 ? "," : ":"} ${mark.notEstablished} not established` : ""}`,
    clean: "the checker disputed none of its claims; that is one audit of the evidence attached, not proof",
    failed: "the check failed: nothing in the brief is verified",
    checking: "a checker is auditing it now",
    unchecked: "no checker has audited it",
  };
  return (
    <span
      className={`cow-brief cow-b-${kind}${mark.read ? " cow-b-read" : ""}`}
      data-cow-brief={kind}
      data-cow-brief-count={disputed}
      data-cow-brief-read={mark.read || undefined}
      title={`brief v${mark.version}: ${words[kind]}${calls > 0 ? `; ${calls} ${calls === 1 ? "judgement call" : "judgement calls"} for you` : ""} · b opens it`}
    >
      {BRIEF_GLYPH}
      {kind === "disputed" ? (
        <>
          {DISPUTED_GLYPH}
          {disputed}
        </>
      ) : kind === "clean" ? (
        <Glyph state="done" />
      ) : kind === "failed" ? (
        <Glyph state="failed" />
      ) : kind === "checking" ? (
        <Glyph state="running" />
      ) : (
        <small>unchecked</small>
      )}
    </span>
  );
}

/** The rules that tie a row to the groups it is in: one for each level above it. */
function Rails({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <i className="cow-rail" key={index} />
      ))}
    </>
  );
}

/** Everything under a group head, by state: the same marks as the lines. */
function RollupMarks({ rollup, older }: { rollup: Rollup; older: number }) {
  const shown = ROLLUP_ORDER.filter((state) => rollup[state] > 0);
  if (shown.length === 0) return null;
  const words = shown.map((state) => `${rollup[state]} ${STATE_LABEL[state]}`).join(", ");
  return (
    <span
      className="cow-roll"
      data-cow-rollup={shown.map((state) => `${state}:${rollup[state]}`).join(" ")}
      title={`under it: ${words}${older > 0 ? ` (${older} finished more than 2 days ago, not listed)` : ""}`}
    >
      {shown.map((state) => (
        <span key={state} className={`cow-s-${state}`}>
          <Glyph state={state} />
          {rollup[state]}
        </span>
      ))}
    </span>
  );
}

function LineRow({
  line,
  now,
  flat,
  parentTitle,
  current,
  flash,
  fold,
  waitingInside,
  open,
  context,
  onSelect,
  onOpen,
  onFold,
}: {
  line: Line;
  now: number;
  flat: boolean;
  parentTitle: string | null;
  current: boolean;
  flash: boolean;
  /** For a group head: whether its members are showing. Null for any other line. */
  fold: "open" | "folded" | null;
  /** For a folded head: how many lines inside it wait on the user. */
  waitingInside: number;
  /** Its chat is the one open in the pane. */
  open: boolean;
  /** While filtering: shown only as the head of a match, not a match itself. */
  context: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onFold: (id: string) => void;
}) {
  const { thread, derived } = line;
  const returned = derived.park?.due != null;
  const next = nextMove(line);
  const classes = ["cow-ln", `cow-d-${derived.state}`];
  if (returned) classes.push("cow-up");
  if (current) classes.push("cow-cur");
  if (flash) classes.push("cow-flash");
  if (open) classes.push("cow-open");
  if (context) classes.push("cow-context");
  if (fold !== null) classes.push("cow-grouphead");
  if (!flat && (fold !== null || line.depth > 0)) classes.push("cow-ingroup");
  if (!flat && line.depth === 0) classes.push("cow-top");
  const nextNode = next.own ? (
    <span className="cow-own" data-cow-note="" title="what is next, in the thread's own words">
      “{next.text}”
    </span>
  ) : (
    next.text
  );
  return (
    <div
      className={classes.join(" ")}
      data-cow-line={thread.id}
      data-cow-state={derived.state}
      data-cow-depth={flat ? undefined : line.depth}
      data-cow-fold={fold ?? undefined}
      data-cow-reply={derived.reply ? "" : undefined}
      data-cow-asks={derived.asks?.length}
      data-cow-open={open ? "" : undefined}
      data-cow-context={context ? "" : undefined}
      data-cow-returned={returned || undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      aria-expanded={fold === null ? undefined : fold === "open"}
      onClick={() => onSelect(thread.id)}
      onDoubleClick={() => onOpen(thread.id)}
    >
      <span className="cow-qn">{line.queueNumber ?? ""}</span>
      <span className="cow-gl">
        <Glyph state={derived.state} />
      </span>
      <Age derived={derived} now={now} />
      <span className="cow-nm">
        {flat ? null : <Rails depth={line.depth} />}
        {fold === null ? (
          // Where a head has its fold mark, so every title at one level starts at the same place.
          <i className="cow-fold" aria-hidden="true" />
        ) : (
          <i
            className="cow-fold cow-foldable"
            title={fold === "open" ? "fold: h" : "unfold: l"}
            onClick={(event) => {
              event.stopPropagation();
              onFold(thread.id);
            }}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d={fold === "open" ? "M1.5 3 5 7.2 8.5 3z" : "M3 1.5 7.2 5 3 8.5z"} fill="currentColor" />
            </svg>
          </i>
        )}
        <span className="cow-title">
          {thread.title}
          {flat && parentTitle ? <small> · {parentTitle}</small> : null}
          {open ? <small className="cow-openmark"> · chat open</small> : null}
          {fold === "folded" ? (
            <small data-cow-folded={line.members}>
              {" "}
              · {line.members} folded
            </small>
          ) : null}
          {line.under > 0 ? (
            <small data-cow-under={line.under}>
              {" "}
              · with {line.under} {line.under === 1 ? "thread" : "threads"} under it
            </small>
          ) : null}
        </span>
        {derived.brief ? <BriefMarks mark={derived.brief} /> : null}
        {!flat && line.rollup ? <RollupMarks rollup={line.rollup} older={line.olderUnder} /> : null}
      </span>
      <span className="cow-wh">
        {waitingInside > 0 ? (
          <b className="cow-inside" data-cow-inside={waitingInside}>
            {waitingInside} inside {waitingInside === 1 ? "waits" : "wait"} on you
            {" · "}
          </b>
        ) : null}
        {derived.archivedWhy ? (
          <b className="cow-why" data-cow-archive-reason="">
            archived: {derived.archivedWhy}
            {derived.doing && derived.doing !== "archived" ? " · " : ""}
          </b>
        ) : null}
        {derived.archivedWhy && derived.doing === "archived" ? null : derived.doing}
        {next.text ? <span className="cow-nx2"> → {nextNode}</span> : null}
      </span>
      <span className="cow-nx">{nextNode}</span>
    </div>
  );
}

/** Work a thread has listed as not started: a row in its group, after its members. */
function TodoLine({ row, current, onSelect }: { row: TodoRow; current: boolean; onSelect: (id: string) => void }) {
  return (
    <div
      className={current ? "cow-ln cow-todo cow-ingroup cow-cur" : "cow-ln cow-todo cow-ingroup"}
      data-cow-todo={row.id}
      data-cow-todo-of={row.ownerId}
      data-cow-depth={row.depth}
      data-cow-hint=""
      aria-current={current || undefined}
      onClick={() => onSelect(row.id)}
    >
      <span className="cow-qn" />
      <span className="cow-gl">
        <svg className="cow-g" viewBox="0 0 12 12" role="img" aria-label="not started">
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.9" />
        </svg>
      </span>
      <span className="cow-ag">
        <b>
          {row.number}/{row.of}
        </b>
      </span>
      <span className="cow-nm">
        <Rails depth={row.depth} />
        <i className="cow-fold" aria-hidden="true" />
        <span className="cow-title">{row.item.title}</span>
      </span>
      <span className="cow-wh">not started</span>
      <span className="cow-nx">{current ? "x removes · J K move" : ""}</span>
    </div>
  );
}

/** What a queue entry says: the question, the failure, or why parked work is back. */
function queueText(line: Line, now: number): string {
  const park = line.derived.park;
  return park?.due ? dueText(park.record, park.due, now) : line.derived.doing;
}

function ColumnHead() {
  return (
    <div className="cow-colhead">
      <span />
      <span />
      <span className="cow-ag">in state</span>
      <span>thread</span>
      <span>doing, or waiting on</span>
      <span className="cow-nx">next move</span>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cow-notice" role="status">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** One entry of the verb bar. A greyed-out verb takes no hint, and says why when used. */
function Verb({
  keys,
  label,
  onRun,
  off,
  name,
  why,
}: {
  keys: string;
  label: string;
  onRun: () => void;
  off?: boolean;
  name?: string;
  why?: string;
}) {
  return (
    <button
      type="button"
      className={off ? "cow-vb cow-off" : "cow-vb"}
      data-cow-verb={name}
      data-cow-hint={off ? undefined : ""}
      aria-disabled={off || undefined}
      title={why}
      tabIndex={-1}
      onClick={onRun}
    >
      <kbd>{keys}</kbd>
      {label}
    </button>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="cow-help" data-cow-help="" onClick={onClose}>
      <div className="cow-card" onClick={(event) => event.stopPropagation()}>
        <div>
          <h3>Legend: every mark on the page</h3>
          {LEGEND.map((entry) => (
            <div className="cow-row" key={entry.state}>
              <span>
                <Glyph state={entry.state} />
              </span>
              <span>
                <b>{STATE_LABEL[entry.state]}.</b> {entry.long}
              </span>
            </div>
          ))}
          <div className="cow-row">
            <span>
              19d <Pips count={2} />
            </span>
            <span>
              <b>time in state.</b> How long it has been in this state; one square per full week.
            </span>
          </div>
          <div className="cow-row">
            <span>
              <span className="cow-qn">3</span>
            </span>
            <span>
              <b>margin number.</b> Its place in the queue at the side.
            </span>
          </div>
          <div className="cow-row">
            <span>▾ ▸</span>
            <span>
              <b>a group.</b> A thread with threads under it, drawn with them along one rule. Its line counts
              what is under it, by state. <kbd>h</kbd> folds it, <kbd>l</kbd> unfolds it.
            </span>
          </div>
          <div className="cow-row">
            <span>chat open</span>
            <span>
              <b>the chat in the pane.</b> The line, or the heading, whose chat is open beside the overview:
              a bar at its far edge. <kbd>i</kbd> types into it wherever the cursor is.
            </span>
          </div>
          <div className="cow-row">
            <span>“ ”</span>
            <span>
              <b>next, in its own words.</b> What the thread itself says happens next, set with bb cow next.
            </span>
          </div>
          <div className="cow-row">
            <span>
              {BRIEF_GLYPH}
              <Glyph state="done" />
            </span>
            <span>
              <b>a brief.</b> The thread submitted its finished job as claims with evidence. Beside it, what a
              separate checker made of it: <Glyph state="done" /> it disputed nothing, <Glyph state="running" /> it is
              checking, <Glyph state="failed" /> the check failed, so nothing is verified. <kbd>b</kbd> opens it.
              A check is one model's audit of the evidence the agent attached, not proof.
            </span>
          </div>
          <div className="cow-row">
            <span>
              {BRIEF_GLYPH}
              {DISPUTED_GLYPH}2
            </span>
            <span>
              <b>disputed.</b> The checker's verdict on that many claims is weaker than the agent's own label:
              contradicted by the evidence, or not established by it.
            </span>
          </div>
          <div className="cow-row">
            <span>◌ 1/3</span>
            <span>
              <b>not started.</b> Work a thread has listed for later, in order, with bb cow todo.{" "}
              <kbd>x</kbd> removes one; <kbd>J</kbd> <kbd>K</kbd> move it.
            </span>
          </div>
        </div>
        <div className="cow-keys">
          <h3>Keys</h3>
          {KEY_MAP.map((entry) => (
            <div className="cow-row" key={entry.keys}>
              <span>{entry.keys}</span>
              <span>{entry.does}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface HintState {
  typed: string;
  targets: HintTarget[];
  labels: string[];
}

/**
 * The hint labels, drawn over the whole window so they also reach a menu bb
 * opened outside the page. It is the one thing cow adds outside its own
 * root, and it is removed when hint mode ends.
 */
function HintLayer({ hint }: { hint: HintState }) {
  useLayoutEffect(() => {
    const layer = document.createElement("div");
    layer.className = "cow-hints";
    layer.dataset.cowHints = "";
    hint.targets.forEach((target, index) => {
      const label = hint.labels[index]!;
      const tag = document.createElement("span");
      tag.className = label.startsWith(hint.typed) ? "cow-ht" : "cow-ht cow-dim";
      tag.dataset.cowHintLabel = label;
      // What the label is for, in words: a line's id, or the kind of thing and its name.
      const el = target.element;
      tag.dataset.cowHintFor =
        el.dataset.cowLine ??
        el.dataset.cowTodo ??
        `${el.tagName.toLowerCase()}:${(el.getAttribute("href") ?? el.getAttribute("aria-label") ?? el.title ?? "") || (el.textContent ?? "").trim().slice(0, 40)}`;
      tag.dataset.cowHintIn = el.closest("[data-cow-chat]") ? "chat" : el.closest("[data-cow-root]") ? "page" : "popup";
      tag.style.left = `${target.left}px`;
      tag.style.top = `${target.top}px`;
      tag.textContent = label;
      layer.append(tag);
    });
    document.body.append(layer);
    return () => layer.remove();
  }, [hint]);
  return null;
}

/** Move through `order` from `current`, staying inside it. */
function step(order: readonly string[], current: string | null, by: number): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index < 0) return order[by > 0 ? 0 : order.length - 1]!;
  return order[Math.max(0, Math.min(order.length - 1, index + by))]!;
}

function useThreadStore(): { store: ThreadStore; snapshot: ReturnType<ThreadStore["getSnapshot"]> } {
  const sdk = useSdk();
  const store = useMemo(() => new ThreadStore(sdk), [sdk]);
  useEffect(() => store.start(), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}

function readFolds(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(FOLDS_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function readWindowMains(): WindowMains {
  try {
    return parseWindowMains(window.sessionStorage.getItem(WINDOW_MAINS_KEY));
  } catch {
    return parseWindowMains(null);
  }
}

/**
 * Which thread is Main in this window. The server's record is read once, as
 * the place to start; after that the window follows only its own choices.
 */
function useMainState(scopedProjectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [stored, setStored] = useState<MainState | null>(null);
  const [own, setOwn] = useState<WindowMains>(readWindowMains);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("main_state").then(
      (next) => {
        setStored(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);

  const resolved = resolveMain(own, stored, scopedProjectId);
  // A start taken from the server becomes this window's own.
  const adopted = adopt(own, resolved);
  useEffect(() => {
    if (adopted !== own) setOwn(adopted);
  }, [adopted, own]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(WINDOW_MAINS_KEY, JSON.stringify(own));
    } catch {
      // Without storage the choice lasts as long as the page does.
    }
  }, [own]);

  const choose = useCallback(
    (thread: ThreadFacts) => {
      setOwn((current) => chooseInWindow(current, thread.projectId, thread.id));
      // Remembered on the server as where a new window starts.
      return rpc.call("main_choose", { projectId: thread.projectId, threadId: thread.id }).then(setStored);
    },
    [rpc],
  );
  return { loaded: stored !== null, projectId: resolved.projectId, mainId: resolved.mainId, error, load, choose };
}

/** j/k/gg/G/Enter/f over any list of ids; shared by the overview and the picker. */
interface ListKeys {
  order: readonly string[];
  cursor: string | null;
  setCursor: (id: string | null) => void;
}

function moveInList(list: ListKeys, command: Command): boolean {
  switch (command.kind) {
    case "move":
      list.setCursor(step(list.order, list.cursor, command.by));
      return true;
    case "top":
      list.setCursor(list.order[0] ?? null);
      return true;
    case "bottom":
      list.setCursor(list.order[list.order.length - 1] ?? null);
      return true;
    default:
      return false;
  }
}

/**
 * Hint mode and the key listener, for whichever screen is showing. `onCommand`
 * gets every normal-mode command; hint mode is handled here.
 */
function usePageKeys(
  rootRef: { current: HTMLDivElement | null },
  onCommand: (command: Command) => void,
  onLeaveChat: () => void,
  blocked: ((key: string) => boolean) | null,
  /** Called with a hint's target just before and just after it is used. */
  beforeActivate?: (element: HTMLElement) => void,
  afterActivate?: (element: HTMLElement) => void,
) {
  const [hint, setHint] = useState<HintState | null>(null);
  const reader = useRef(new KeyReader());
  const live = useRef({ onCommand, onLeaveChat, blocked, hint, beforeActivate, afterActivate });
  live.current = { onCommand, onLeaveChat, blocked, hint, beforeActivate, afterActivate };

  const startHints = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = collectHintTargets(root);
    if (targets.length === 0) return;
    const labels = hintLabels(targets.length);
    setHint({ typed: "", targets: targets.slice(0, labels.length), labels });
  }, [rootRef]);

  useEffect(
    () =>
      attachKeys({
        onLeaveChat: () => live.current.onLeaveChat(),
        capturing: () => live.current.hint !== null,
        onKey(key, shift) {
          const { hint: active, blocked: isBlocked } = live.current;
          if (!active && isBlocked?.(key)) return;
          if (active) {
            if (key === "Escape") return setHint(null);
            if (key.length !== 1) return;
            const typed = active.typed + key.toLowerCase();
            const match = matchHint(active.labels, typed);
            if (match.kind === "partial") return setHint({ ...active, typed });
            setHint(null);
            if (match.kind !== "hit") return;
            const { element } = active.targets[match.index]!;
            if (!element.isConnected) return;
            live.current.beforeActivate?.(element);
            // cow's own targets have plain click handlers; anything of bb's gets the whole gesture.
            if (element.hasAttribute("data-cow-hint")) element.click();
            else activate(element);
            live.current.afterActivate?.(element);
            return;
          }
          const command = reader.current.read(key, shift, Date.now());
          if (!command) return;
          if (command.kind === "hints") startHints();
          else live.current.onCommand(command);
        },
      }),
    [startHints],
  );
  return { hint, startHints };
}

function Picker({
  threads,
  projectNames,
  scopedToProject,
  currentMainId,
  notice,
  canCancel,
  onChoose,
  onCancel,
  now,
}: {
  threads: readonly ThreadFacts[];
  projectNames: ReadonlyMap<string, string>;
  scopedToProject: boolean;
  currentMainId: string | null;
  notice: string | null;
  canCancel: boolean;
  onChoose: (thread: ThreadFacts) => void;
  onCancel: () => void;
  now: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const candidates = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null)
        .sort((a, b) => b.latestAttentionAt - a.latestAttentionAt)
        .slice(0, PICKER_LIMIT),
    [threads],
  );
  const order = useMemo(() => candidates.map((thread) => thread.id), [candidates]);
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = cursor !== null && order.includes(cursor) ? cursor : (order[0] ?? null);
  const choose = (id: string | null) => {
    const thread = candidates.find((candidate) => candidate.id === id);
    if (thread) onChoose(thread);
  };
  const [help, setHelp] = useState(false);
  const { hint, startHints } = usePageKeys(
    rootRef,
    (command) => {
      if (moveInList({ order, cursor: selected, setCursor }, command)) return;
      if (command.kind === "open") choose(selected);
      else if (command.kind === "help") setHelp(true);
      else if (command.kind === "back" && canCancel) onCancel();
    },
    () => undefined,
    help
      ? (key) => {
          if (key === "Escape" || key === "?" || key === "q") setHelp(false);
          return true;
        }
      : null,
  );
  useLayoutEffect(() => {
    rootRef.current?.querySelector(".cow-cur")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="cow" data-cow-root="" data-cow-screen="picker" ref={rootRef}>
      <div className="cow-app">
        <header className="cow-head">
          <h1 className="cow-crumbs">
            <span className="cow-emoji">🐄</span>
            <b>Choose your Main thread</b>
          </h1>
        </header>
        <div className="cow-main cow-picker" data-cow-scroll="">
          <p className="cow-lede">
            {notice ? <b>{notice} </b> : null}
            Main is the one long-lived thread you run your work through. This page then shows every
            thread Main has started, and every thread those have started.
            {scopedToProject ? " Listed: this project's threads, most recent first." : " Listed: all threads, most recent first."}
          </p>
          {candidates.length === 0 ? (
            <Notice title="There are no threads to choose from">
              <p>Start a thread in bb first, then come back here and pick it as Main.</p>
            </Notice>
          ) : (
            candidates.map((thread) => {
              const derived = derive(thread, undefined, now);
              return (
                <div
                  key={thread.id}
                  className={thread.id === selected ? "cow-ln cow-pick cow-cur" : "cow-ln cow-pick"}
                  data-cow-line={thread.id}
                  data-cow-hint=""
                  onClick={() => choose(thread.id)}
                >
                  <span className="cow-qn" />
                  <span className="cow-gl">
                    <Glyph state={derived.state} />
                  </span>
                  <Age derived={derived} now={now} />
                  <span className="cow-nm">
                    <span className="cow-title">
                      {thread.title}
                      {thread.id === currentMainId ? <small> · Main now</small> : null}
                    </span>
                  </span>
                  <span className="cow-wh">
                    {scopedToProject ? "" : (projectNames.get(thread.projectId) ?? "")}
                    {thread.parentThreadId ? " · started by another thread" : ""}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <footer className="cow-foot">
          <span className={hint ? "cow-mode cow-m-hint" : "cow-mode"}>{hint ? "HINT" : "PICK"}</span>
          <span className="cow-verbs">
            <Verb keys="⏎" label="make it Main" onRun={() => choose(selected)} />
            <Verb keys="f" label="hints" onRun={startHints} />
            {canCancel ? <Verb keys="Esc" label="keep the current Main" onRun={onCancel} /> : null}
          </span>
          <span className="cow-sep">·</span>
          <span>
            <kbd>j</kbd> <kbd>k</kbd> move
          </span>
        </footer>
      </div>
      {hint ? <HintLayer hint={hint} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

function OverviewScreen({
  overview,
  main,
  now,
  truncated,
  parks,
  raised,
  threads,
  onChooseMain,
}: {
  overview: Overview;
  main: Line;
  now: number;
  truncated: boolean;
  parks: Parks;
  raised: RaisedData;
  threads: readonly ThreadFacts[];
  onChooseMain: () => void;
}) {
  const sdk = useSdk();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sayRef = useRef<HTMLInputElement | null>(null);
  // Which groups are folded is this window's own, and outlives a reload.
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolds);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(FOLDS_KEY, JSON.stringify([...folded]));
    } catch {
      // Without storage the folds last as long as the page does.
    }
  }, [folded]);
  useEffect(() => setFolded((current) => keepFolds(overview, current)), [overview]);
  // Filtering narrows the page to what matches. Folds are left alone, so
  // closing the filter puts the page back as it was.
  const [filter, setFilter] = useState<{ text: string; cursorBefore: string | null } | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const filterText = filter?.text ?? null;
  const found = useMemo(() => (filterText === null ? null : filterOverview(overview, filterText)), [overview, filterText]);
  const rows = useMemo(
    () => (found ? overview.rows.filter((row) => found.keep.has(row.id)) : visibleRows(overview, folded)),
    [overview, folded, found],
  );
  const hit = useMemo(() => (found ? new Set(found.matches) : null), [found]);
  const parkedShown = hit ? overview.parked.filter((line) => hit.has(line.thread.id)) : overview.parked;
  const doneShown = hit ? overview.done.filter((line) => hit.has(line.thread.id)) : overview.done;
  // The heading is the first stop: Main is a line like any other to the cursor.
  const order = useMemo(
    () => (found ? found.matches : [main.thread.id, ...cursorOrder(overview, folded)]),
    [overview, folded, found, main.thread.id],
  );
  const titles = useMemo(() => {
    const map = new Map<string, string>([[main.thread.id, main.thread.title]]);
    for (const line of listed(overview)) map.set(line.thread.id, line.thread.title);
    return map;
  }, [overview, main]);

  // The cursor is a thread id, so live updates never move it. If its line
  // leaves the page, it lands on the line that took its place: the next one
  // down. The verbs that move a line say where the cursor goes themselves.
  const [cursor, setCursorRaw] = useState<string | null>(null);
  /** Put the cursor on a row, unfolding whatever hides it. */
  const setCursor = useCallback(
    (id: string | null) => {
      if (id !== null) setFolded((current) => unfoldAround(overview, current, id));
      setCursorRaw(id);
    },
    [overview],
  );
  // A page starts on its first line, below the heading.
  const lastIndex = useRef(1);
  const cursorIndex = cursor === null ? -1 : order.indexOf(cursor);
  const selected =
    cursorIndex >= 0
      ? cursor
      : found
        ? // While filtering, the cursor is on the first match until it is moved.
          (order[0] ?? null)
        : (order[Math.min(lastIndex.current, order.length - 1)] ?? null);
  const onMain = selected === main.thread.id;
  useEffect(() => {
    if (selected !== null && !found) lastIndex.current = order.indexOf(selected);
  }, [selected, found, order]);

  const startFilter = () => {
    setFilter({ text: "", cursorBefore: selected });
    setMessage("");
  };
  useEffect(() => {
    if (filter !== null) filterRef.current?.focus();
  }, [filter !== null]);
  /** Close the filter: on the line chosen, or back where the cursor was. */
  const endFilter = (keep: boolean) => {
    if (filter === null) return;
    const to = keep && selected !== null ? selected : filter.cursorBefore;
    setFilter(null);
    setCursor(to);
    focusOverview();
  };
  const moveInFilter = (by: 1 | -1) => setCursorRaw(step(order, selected, by));

  const [pane, setPane] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [sayTo, setSayTo] = useState<string | null>(null);
  const [sayText, setSayText] = useState("");
  const [sending, setSending] = useState(false);
  const [help, setHelp] = useState(false);
  const [message, setMessage] = useState("");

  // A line whose state just changed glows briefly, since it does not move.
  const lastStates = useRef(new Map<string, LineState>());
  const openedAt = useRef(Date.now());
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const changed: string[] = [];
    const next = new Map<string, LineState>();
    for (const line of listed(overview)) {
      const before = lastStates.current.get(line.thread.id);
      if (before !== undefined && before !== line.derived.state) changed.push(line.thread.id);
      next.set(line.thread.id, line.derived.state);
    }
    lastStates.current = next;
    // States settle as activity loads; that is not news.
    if (changed.length === 0 || Date.now() - openedAt.current < LOAD_SETTLE_MS) return;
    setFlashing((current) => new Set([...current, ...changed]));
    const timer = setTimeout(() => {
      setFlashing((current) => new Set([...current].filter((id) => !changed.includes(id))));
    }, FLASH_MS);
    return () => clearTimeout(timer);
  }, [overview]);

  const focusOverview = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // bb's chat focuses its composer when it mounts. Opening the pane must not
  // move the keyboard, so focus is handed back until the user asks for it.
  const chatMayFocus = useRef(false);
  useEffect(() => {
    chatMayFocus.current = false;
    if (pane === null) return;
    const chat = rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]");
    if (!chat) return;
    const guard = () => {
      if (!chatMayFocus.current) focusOverview();
    };
    chat.addEventListener("focusin", guard);
    const timer = setTimeout(() => chat.removeEventListener("focusin", guard), CHAT_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      chat.removeEventListener("focusin", guard);
    };
  }, [pane, focusOverview]);

  /** Open a thread's chat in the pane, or switch the pane to it. It never takes the keyboard. */
  const openChat = useCallback(
    (id: string | null) => {
      if (id === null || pane === id) return;
      setPane(id);
      setMessage("");
    },
    [pane],
  );
  /** Put the caret in the composer of the chat that is open: the one way into it. */
  const typeInChat = useCallback(() => {
    chatMayFocus.current = true;
    rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]")?.focus({ preventScroll: true });
    setFocusRequest((value) => value + 1);
  }, []);

  const closePane = useCallback(() => {
    setPane(null);
    focusOverview();
  }, [focusOverview]);

  const startSay = (id: string | null) => {
    if (id === null) return;
    setSayTo(id);
    setSayText("");
    setMessage("");
  };
  useEffect(() => {
    if (sayTo !== null) sayRef.current?.focus();
  }, [sayTo]);
  const endSay = () => {
    setSayTo(null);
    focusOverview();
  };
  const sendSay = () => {
    const text = sayText.trim();
    const target = sayTo;
    if (target === null || sending) return;
    if (!text) return endSay();
    setSending(true);
    sdk.threads
      .send({ threadId: target, mode: "auto", input: [{ type: "text", text, mentions: [] }] })
      .then(
        () => {
          setMessage(`said to ${titles.get(target) ?? "the thread"}`);
          // Answering it is having read it.
          const line = [main, ...listed(overview)].find((other) => other.thread.id === target);
          if (line?.derived.reply) verbs.markSeen(line, false);
          endSay();
        },
        (cause: unknown) =>
          setMessage(`not sent: ${cause instanceof Error ? cause.message : String(cause)}`),
      )
      .finally(() => setSending(false));
  };

  const toAsk = (index: number) => {
    const line = overview.queue[index];
    if (line) setCursor(line.thread.id);
    else setMessage(overview.queue.length ? "" : "nothing is waiting on you");
  };

  const selectedLine =
    [main, ...listed(overview)].find((line) => line.thread.id === selected) ?? null;
  const selectedTodo = rows.find((row): row is TodoRow => row.kind === "todo" && row.id === selected) ?? null;
  const sheetRef = useRef<BriefSheetControl | null>(null);
  const verbs = useVerbs({
    sdk,
    overview,
    main,
    selected: selectedLine,
    parks,
    raised,
    openBrief: (id) => sheetRef.current?.open(id),
    now,
    folded,
    under: (id) => descendantIds(threads, id),
    setCursor,
    say: setMessage,
    openChat,
    focusOverview,
  });

  const sheet = useBriefSheet({
    raised,
    titleOf: (id) => titles.get(id) ?? "a thread that is no longer listed",
    now,
    say: setMessage,
    startAsk: verbs.startAsk,
    askCard: (askId) => (verbs.card?.askId === askId ? verbs.card.node : null),
    onClose: (id) => {
      setCursor(id);
      focusOverview();
    },
  });
  sheetRef.current = sheet;

  // A reply showing in the pane has been seen. Each is marked once, so that
  // undoing a mark made with Space is not undone again by the open pane.
  const paneLine = pane === null ? null : ([main, ...listed(overview)].find((line) => line.thread.id === pane) ?? null);
  const paneReply = paneLine?.derived.reply?.seq ?? null;
  const autoSeen = useRef(new Set<string>());
  useEffect(() => {
    if (paneLine === null || paneReply === null) return;
    const key = `${paneLine.thread.id}:${paneReply}`;
    if (autoSeen.current.has(key)) return;
    autoSeen.current.add(key);
    verbs.markSeen(paneLine, false);
    // Only a new pane or a new reply marks anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, paneReply]);

  const toggleFold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const run = (command: Command) => {
    // An open brief covers the page, and the keys are its own.
    if (sheet.threadId !== null && sheet.onCommand(command)) return;
    if (moveInList({ order, cursor: selected, setCursor }, command)) return;
    switch (command.kind) {
      case "recheck":
        return setMessage("c runs a brief's check again from inside the brief: b opens one");
      case "close":
        return;
      case "open":
        // What is not started has no chat of its own; its thread's is the nearest thing.
        return openChat(selectedTodo ? selectedTodo.ownerId : selected);
      case "main-chat":
        return openChat(main.thread.id);
      case "back":
        if (pane !== null) closePane();
        else setMessage("");
        return;
      case "say":
        // With a chat open, i types into it, whichever line the cursor is on.
        if (command.to === "main" && pane !== null) return typeInChat();
        return startSay(command.to === "main" ? main.thread.id : selected);
      case "filter":
        return startFilter();
      case "ask": {
        const count = overview.queue.length;
        const at = overview.queue.findIndex((line) => line.thread.id === selected);
        if (at < 0) return toAsk(command.by > 0 ? 0 : count - 1);
        return toAsk((at + command.by + count) % count);
      }
      case "ask-number":
        return toAsk(command.number - 1);
      case "fold": {
        const move = foldMove(overview, folded, selected, command.key);
        if (move.kind === "fold") setFolded(move.folded);
        else if (move.kind === "cursor") setCursor(move.id);
        return;
      }
      case "seen":
        if (selectedTodo) return setMessage("that is work not started, not a reply");
        if (selectedLine === main && main.thread.parentThreadId === null) {
          return setMessage("Main's reply is read by opening its chat: press m");
        }
        return selectedLine ? verbs.markSeen(selectedLine, true) : undefined;
      case "reorder":
        if (!selectedTodo) return setMessage("J and K move a not-started item; select one first");
        return verbs.moveTodo(selectedTodo, command.by);
      case "verb":
        if (selectedTodo) {
          if (command.verb === "stop") return verbs.removeTodo(selectedTodo);
          return setMessage("that is work not started yet, not a thread: x removes it, J and K move it");
        }
        return verbs.start(command.verb);
      case "undo":
        return verbs.startUndo();
      case "help":
        return setHelp(true);
      case "choose-main":
        return onChooseMain();
      default:
        return;
    }
  };

  const { hint, startHints } = usePageKeys(
    rootRef,
    run,
    focusOverview,
    help
      ? (key) => {
          if (key === "Escape" || key === "?" || key === "q") setHelp(false);
          return true;
        }
      : verbs.onKey
        ? (key) => {
            // An ask's proof files are links: f still labels them while its card is open.
            if (key === "f" && verbs.mode === "ASK") return false;
            verbs.onKey?.(key);
            return true;
          }
        : sayTo !== null
          ? () => {
              // Focus was taken from the say input: give it back.
              sayRef.current?.focus();
              return true;
            }
          : filter !== null
            ? () => {
                filterRef.current?.focus();
                return true;
              }
            : sheet.onKey
              ? (key) => {
                  sheet.onKey?.(key);
                  return true;
                }
              : null,
    (element) => {
      // A hint on a field in the chat is the user asking for the caret there.
      if (takesCaret(element) && element.closest("[data-cow-chat]")) chatMayFocus.current = true;
    },
    (element) => {
      // Anything else in the chat was only pressed. bb may move focus into the
      // chat when it is, now or a moment later; the keyboard stays here, so
      // that the next key, f included, is still the overview's.
      if (takesCaret(element) || !element.closest("[data-cow-chat]")) return;
      const back = () => {
        if (document.activeElement?.closest("[data-cow-chat]")) focusOverview();
      };
      back();
      setTimeout(back, 60);
      setTimeout(back, 250);
    },
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    root?.querySelector(".cow-main .cow-cur")?.scrollIntoView({ block: "nearest" });
    root?.querySelector(".cow-queue .cow-cur")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const listedCount = listed(overview).length;
  // Main alone can still have listed what it has not started.
  const nothingListed = listedCount === 0 && overview.rows.length === 0;
  const returnedCount = overview.parked.filter((line) => line.derived.park?.due != null).length;
  const onHeading = selectedLine === main;
  const verbButton = (verb: VerbName) => {
    const why = verbBlocked(verb, selectedLine, onHeading);
    return (
      <Verb
        key={verb}
        name={verb}
        keys={VERB_KEYS[verb]}
        label={verbLabel(verb, selectedLine)}
        off={why !== null}
        why={why ?? undefined}
        onRun={() => verbs.start(verb)}
      />
    );
  };
  const paneTitle = pane === null ? "" : (titles.get(pane) ?? "a thread that is no longer listed");
  // A card opened for one ask from inside a brief is drawn there, not under the line.
  const card = (id: string) => (verbs.card?.threadId === id && verbs.card.askId === undefined ? verbs.card.node : null);
  const row = (line: Line, flat: boolean) => {
    // While filtering every group is drawn unfolded: what matches inside it is showing.
    const fold = flat || line.members === 0 ? null : !found && folded.has(line.thread.id) ? "folded" : "open";
    return (
    <Fragment key={line.thread.id}>
      <LineRow
        line={line}
        now={now}
        flat={flat}
        fold={fold}
        waitingInside={fold === "folded" ? waitingInside(overview, line.thread.id) : 0}
        open={line.thread.id === pane}
        context={hit !== null && !hit.has(line.thread.id)}
        onFold={toggleFold}
        parentTitle={
          line.thread.parentThreadId === main.thread.id
            ? null
            : (titles.get(line.thread.parentThreadId ?? "") ?? null)
        }
        current={line.thread.id === selected}
        flash={flashing.has(line.thread.id)}
        onSelect={setCursor}
        onOpen={openChat}
      />
      {card(line.thread.id)}
    </Fragment>
    );
  };

  return (
    <div
      className={pane === null ? "cow" : "cow cow-with-pane"}
      data-cow-root=""
      data-cow-screen="overview"
      data-cow-mode={
        hint
          ? "hint"
          : sayTo !== null
            ? "say"
            : help
              ? "help"
              : (verbs.mode?.toLowerCase() ?? (filter !== null ? "filter" : sheet.threadId !== null ? "brief" : "normal"))
      }
      tabIndex={-1}
      ref={rootRef}
    >
      <div className="cow-app">
        <header className="cow-head">
          <div
            className={["cow-mainline", onMain ? "cow-cur" : "", pane === main.thread.id ? "cow-open" : ""].join(" ").trim()}
            data-cow-line={main.thread.id}
            data-cow-open={pane === main.thread.id ? "" : undefined}
            data-cow-hint=""
            onClick={() => setCursor(main.thread.id)}
            onDoubleClick={() => openChat(main.thread.id)}
          >
            {main.queueNumber === null ? null : <span className="cow-qn">{main.queueNumber}</span>}
            <h1 className="cow-crumbs">
              <span className="cow-emoji">🐄</span>
              <b>{main.thread.title}</b>
            </h1>
            <span
              className={`cow-mainstate cow-s-${main.derived.state}`}
              data-cow-main-state={main.derived.state}
            >
              <Glyph state={main.derived.state} />
              {STATE_LABEL[main.derived.state]} <Age derived={main.derived} now={now} />
            </span>
            <span className="cow-maindoing">
              {main.derived.brief ? <BriefMarks mark={main.derived.brief} /> : null}
              {main.derived.doing}
              {main.note !== null ? (
                <span className="cow-own" data-cow-note="" title="what is next, in Main's own words">
                  {" "}
                  → “{main.note}”
                </span>
              ) : null}
            </span>
          </div>
          {message ? (
            <span className="cow-msg" data-cow-message="">
              {message}
            </span>
          ) : null}
          <span className="cow-sum">
            <b>{listedCount}</b> {listedCount === 1 ? "thread" : "threads"} · <b>{overview.queue.length}</b> waiting
            on you
          </span>
        </header>
        {card(main.thread.id)}

        <div className="cow-body">
          <main className="cow-main" data-cow-scroll="">
            {nothingListed ? (
              <Notice title="Main has not started any threads yet">
                <p>
                  When Main hands work to another thread, that thread appears here as a line, with the
                  threads it starts indented under it.
                </p>
                <p>
                  Press <kbd>i</kbd> to say something to Main, or <kbd>m</kbd> to open its chat.
                  {overview.olderDone > 0
                    ? ` ${overview.olderDone} finished more than 2 days ago and ${overview.olderDone === 1 ? "is" : "are"} not listed.`
                    : ""}
                </p>
              </Notice>
            ) : (
              <>
                <ColumnHead />
                {rows.map((item) =>
                  item.kind === "line" ? (
                    row(item.line, false)
                  ) : (
                    <TodoLine key={item.id} row={item} current={item.id === selected} onSelect={setCursor} />
                  ),
                )}
                <div className="cow-sec" data-cow-shelf="">
                  Parked
                  <span>
                    {overview.parked.length} on the shelf, set aside by you
                    {overview.parked.length > 0
                      ? ` · oldest ${formatAge(now - overview.parked[0]!.derived.since)}`
                      : ""}
                  </span>
                  {returnedCount > 0 ? (
                    <span className="cow-up">{returnedCount} asking to come back</span>
                  ) : null}
                </div>
                {overview.parked.length === 0 ? (
                  <p className="cow-shelf-empty">
                    Nothing is parked. Select a line and press <kbd>p</kbd> to set it aside without
                    losing it.
                  </p>
                ) : (
                  parkedShown.map((line) => row(line, true))
                )}
                <div className="cow-sec">
                  Done
                  <span>
                    {overview.done.length} finished or archived in the last 2 days, with everything under them
                    {overview.olderDone > 0 ? ` · ${overview.olderDone} older, not listed` : ""}
                  </span>
                </div>
                {doneShown.map((line) => row(line, true))}
              </>
            )}
            {truncated ? (
              <p className="cow-warn">bb has more threads than this page reads; some may be missing.</p>
            ) : null}
          </main>

          {pane === null ? (
            <aside className="cow-side">
              <h2>
                Waiting on you <b>{overview.queue.length}</b>
              </h2>
              <p className="cow-sub">
                Asks, questions, permission requests, refused permissions, failures, briefs with disputes,
                replies addressed to you and parked work that came back, oldest first.
              </p>
              <ol className="cow-queue" data-cow-scroll="">
                {overview.queue.length === 0 ? (
                  <li className="cow-q-empty">Nothing is waiting on you.</li>
                ) : (
                  overview.queue.map((line) => (
                    <li
                      key={line.thread.id}
                      className={line.thread.id === selected ? "cow-q cow-cur" : "cow-q"}
                      data-cow-queue={line.thread.id}
                      data-cow-hint=""
                      onClick={() => setCursor(line.thread.id)}
                    >
                      <span className="cow-qn">{line.queueNumber}</span>
                      <span className="cow-gl">
                        <Glyph state={line.derived.state} />
                      </span>
                      <div>
                        <p>{queueText(line, now)}</p>
                        <small>
                          {line.thread.title} · {formatAge(Math.max(0, now - waitingSince(line.derived)))}
                        </small>
                      </div>
                    </li>
                  ))
                )}
              </ol>
              <div className="cow-legend">
                {LEGEND.map((entry) => (
                  <div className="cow-lg" key={entry.state}>
                    <Glyph state={entry.state} />
                    <b>{entry.name ?? STATE_LABEL[entry.state]}</b>
                    <span className="cow-n">{overview.counts[entry.state]}</span>
                    <span>{entry.short}</span>
                  </div>
                ))}
              </div>
            </aside>
          ) : (
            <aside className="cow-pane" data-cow-pane={pane}>
              <div className="cow-panehead">
                <b data-cow-pane-title="">
                  {pane === main.thread.id ? "Main · " : ""}
                  {paneTitle}
                </b>
                <span>
                  <kbd>i</kbd> type here · <kbd>Esc</kbd> back
                </span>
                <button type="button" className="cow-vb" data-cow-hint="" tabIndex={-1} onClick={closePane}>
                  close
                </button>
              </div>
              <div className="cow-chat" data-cow-chat="" tabIndex={-1}>
                <ThreadChat
                  key={pane}
                  threadId={pane}
                  variant="compact"
                  layout="contained"
                  focusRequest={focusRequest}
                />
              </div>
            </aside>
          )}
        </div>

        <footer className="cow-foot">
          {sayTo !== null ? (
            <>
              <span className="cow-mode cow-m-prompt">SAY</span>
              <span className="cow-prompt">
                <label htmlFor="cow-say">
                  to {sayTo === main.thread.id ? "Main" : "thread"} · <b>{titles.get(sayTo) ?? sayTo}</b>
                </label>
                <input
                  id="cow-say"
                  ref={sayRef}
                  data-cow-say=""
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="a note, a nudge, a correction"
                  value={sayText}
                  disabled={sending}
                  onChange={(event) => setSayText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Enter") sendSay();
                      else endSay();
                    }
                  }}
                />
                <small>
                  <kbd>⏎</kbd> send · <kbd>Esc</kbd> cancel
                </small>
              </span>
            </>
          ) : verbs.footer ? (
            verbs.footer
          ) : filter !== null ? (
            <>
              <span className="cow-mode cow-m-prompt">FILTER</span>
              <span className="cow-prompt">
                <label htmlFor="cow-filter">/</label>
                <input
                  id="cow-filter"
                  ref={filterRef}
                  data-cow-filter=""
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="part of a name, or of what it is doing"
                  value={filter.text}
                  onChange={(event) => setFilter({ ...filter, text: event.target.value })}
                  onKeyDown={(event) => {
                    const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
                    const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
                    if (!down && !up && event.key !== "Enter" && event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (down || up) moveInFilter(down ? 1 : -1);
                    else endFilter(event.key === "Enter");
                  }}
                />
                <small data-cow-filter-count={order.length}>
                  {order.length} {order.length === 1 ? "match" : "matches"} · <kbd>Ctrl</kbd>
                  <kbd>n</kbd> <kbd>p</kbd> move · <kbd>⏎</kbd> keep · <kbd>Esc</kbd> cancel
                </small>
              </span>
            </>
          ) : (
            <>
              <span className={hint ? "cow-mode cow-m-hint" : "cow-mode"}>{hint ? "HINT" : "NORMAL"}</span>
              <span className="cow-noun">{selectedLine?.thread.title ?? selectedTodo?.item.title ?? ""}</span>
              <span className="cow-sep">▸</span>
              <span className="cow-verbs">
                <Verb keys="⏎" label="open chat" off={selected === null} onRun={() => openChat(selected)} />
                <Verb keys="I" label="say to it" off={selected === null} onRun={() => startSay(selected)} />
                {selectedTodo ? (
                  <>
                    <Verb keys="x" label="remove" name="todo-remove" onRun={() => verbs.removeTodo(selectedTodo)} />
                    <Verb keys="K" label="up" off={selectedTodo.number === 1} onRun={() => verbs.moveTodo(selectedTodo, -1)} />
                    <Verb keys="J" label="down" off={selectedTodo.number === selectedTodo.of} onRun={() => verbs.moveTodo(selectedTodo, 1)} />
                  </>
                ) : (
                  (["answer", "brief", "park", "resume", "stop", "archive"] as const).map(verbButton)
                )}
                {selectedLine?.derived.reply ? (
                  <Verb keys="␣" label="seen" name="seen" onRun={() => verbs.markSeen(selectedLine, true)} />
                ) : null}
              </span>
              <span className="cow-sep">·</span>
              <span className="cow-verbs">
                <Verb
                  name="undo"
                  keys="u"
                  label={verbs.undoable ? undoShort(verbs.undoable) : "undo"}
                  off={verbs.undoable === null}
                  why={verbs.undoable ? undefined : "nothing to undo"}
                  onRun={verbs.startUndo}
                />
                <Verb
                  keys="i"
                  label={pane === null ? "say to Main" : "type in the chat"}
                  onRun={() => run({ kind: "say", to: "main" })}
                />
                <Verb keys="/" label="filter" onRun={startFilter} />
                <Verb keys="m" label="Main's chat" onRun={() => openChat(main.thread.id)} />
                <Verb keys="⇥" label="next ask" off={overview.queue.length === 0} onRun={() => run({ kind: "ask", by: 1 })} />
                <Verb keys="f" label="hints" onRun={startHints} />
                <Verb keys="?" label="legend" onRun={() => setHelp(true)} />
              </span>
            </>
          )}
        </footer>
      </div>
      {sheet.node}
      {hint ? <HintLayer hint={hint} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

/** The whole page: decides between loading, an error, the picker and the overview. */
export function CowPage() {
  const sdk = useSdk();
  const context = useBbContext();
  const now = useNow();
  const { store, snapshot } = useThreadStore();
  // bb names a project when the page is opened inside one.
  const scopedProjectId = context.projectId ?? null;
  const mains = useMainState(scopedProjectId);
  const [picking, setPicking] = useState(false);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    pageSignal.mounted = true;
    pageSignal.chooseMain = () => setPicking(true);
    return () => {
      pageSignal.mounted = false;
      pageSignal.chooseMain = null;
    };
  }, []);

  const storedMainId = mains.mainId;
  // An archived or deleted Main is gone as far as the user is concerned.
  const mainGone =
    storedMainId !== null &&
    !snapshot.threads.some((thread) => thread.id === storedMainId && thread.archivedAt === null);
  const mainId = mainGone ? null : storedMainId;

  const underMain = useMemo(
    () =>
      mainId === null || snapshot.status !== "ready"
        ? null
        : // A note may be on any open thread, or on one archived recently enough to be listed.
          // Main's own are its note of what is next and what it has not started.
          [mainId, ...descendantIds(snapshot.threads, mainId, now - LIMITS.doneListedMs)],
    [snapshot.threads, snapshot.status, mainId, now],
  );
  const parks = useParks(underMain);
  const notes = parks.notes;
  const raised = useRaised(underMain);

  const heads = useMemo(() => headIds(snapshot.threads), [snapshot.threads]);
  const overview = useMemo(
    () =>
      mainId === null || notes === null
        ? null
        : buildOverview(
            snapshot.threads,
            mainId,
            // Main is the page's heading and is never parked.
            (thread) =>
              derive(
                thread,
                snapshot.activity.get(thread.id),
                now,
                thread.id === mainId ? null : notes.get(thread.id),
                parks.archives.get(thread.id)?.reason,
                parks.dismissals.get(thread.id)?.throughSeq,
                { head: heads.has(thread.id), seenSeq: parks.seen.get(thread.id)?.seq ?? null },
                { asks: raised.asks.get(thread.id) ?? [], brief: raised.briefs.get(thread.id) ?? null },
              ),
            now,
            {
              note: (id) => parks.nexts.get(id)?.text ?? null,
              todos: (id) => parks.todos.get(id) ?? [],
            },
          ),
    [snapshot, mainId, heads, notes, parks.archives, parks.dismissals, parks.seen, parks.nexts, parks.todos, raised.asks, raised.briefs, now],
  );

  useEffect(() => {
    if (!overview?.main) return store.watch([]);
    // When a thread with a parent finished shows only in its event log, so
    // every thread that is not archived is watched, listed or not.
    store.watch([overview.main.thread.id, ...overview.unarchived, ...listed(overview).map((line) => line.thread.id)]);
  }, [store, overview]);

  const loadingNotes = mainId !== null && notes === null;
  const needsPicker = !loadingNotes && (picking || mainId === null || overview?.main == null);
  useEffect(() => {
    if (!needsPicker || scopedProjectId !== null) return;
    let cancelled = false;
    // Project names only label the picker, so it works without them.
    sdk.projects.list().then(
      (projects) => {
        if (!cancelled) setProjectNames(new Map(projects.map((project) => [project.id, project.name])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, needsPicker, scopedProjectId]);

  const failure = snapshot.status === "error" ? snapshot.error : (mains.error ?? (notes === null ? parks.error : null));
  if (failure !== null) {
    return (
      <div className="cow" data-cow-root="" data-cow-screen="error">
        <div className="cow-app">
          <Notice title="🐄 cow could not load your threads">
            <p className="cow-warn">{failure}</p>
            <p>
              Check that bb is running and this window is connected, then{" "}
              <button
                type="button"
                className="cow-vb cow-link"
                onClick={() => {
                  mains.load();
                  parks.reload();
                  void store.reload();
                }}
              >
                try again
              </button>
              .
            </p>
          </Notice>
        </div>
      </div>
    );
  }
  if (snapshot.status === "loading" || !mains.loaded || loadingNotes) {
    return (
      <div className="cow" data-cow-root="" data-cow-screen="loading">
        <div className="cow-app">
          <p className="cow-lede">🐄 Loading your threads…</p>
        </div>
      </div>
    );
  }
  if (needsPicker || overview === null || overview.main === null) {
    const scoped = scopedProjectId !== null;
    return (
      <Picker
        threads={scoped ? snapshot.threads.filter((t) => t.projectId === scopedProjectId) : snapshot.threads}
        projectNames={projectNames}
        scopedToProject={scoped}
        currentMainId={overview?.main ? mainId : null}
        notice={mainGone ? "The thread that was Main has been archived or deleted." : null}
        canCancel={overview?.main != null}
        onChoose={(thread) => {
          // The window shows it at once; a failure to store it only affects new windows.
          void mains.choose(thread).catch(() => undefined);
          setPicking(false);
        }}
        onCancel={() => setPicking(false)}
        now={now}
      />
    );
  }
  return (
    <OverviewScreen
      key={overview.main.thread.id}
      overview={overview}
      main={overview.main}
      now={now}
      truncated={snapshot.truncated}
      parks={parks}
      raised={raised}
      threads={snapshot.threads}
      onChooseMain={() => setPicking(true)}
    />
  );
}
