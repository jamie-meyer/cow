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
  useBbNavigate,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { MainState, rpcContract } from "../server.ts";
import { type BriefSheetControl, useBriefSheet } from "./BriefSheet.tsx";
import { type BriefMark, disputeCount } from "./briefs/review.ts";
import { useCapSheet } from "./caps/CapSheet.tsx";
import { type StepsOrigin, useCapSteps } from "./caps/CapSteps.tsx";
import { HeldCard } from "./caps/HeldCard.tsx";
import { type Capability, ruleText, scopeText } from "./caps/cap.ts";
import { type CapsData, useCaps } from "./caps/data.ts";
import { covers } from "./caps/match.ts";
import { type Held, ancestorsOf, held as heldBy } from "./caps/scope.ts";
import type { Use } from "./caps/service.ts";
import type { Refusal } from "./refusal.ts";
import { type Signer, useSigner } from "./signing/page.ts";
import { type RaisedData, useRaised } from "./raisedData.ts";
import { Asides } from "./Asides.tsx";
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
  KEY_GROUPS,
  KeyReader,
  activate,
  attachKeys,
  takesCaret,
  collectHintTargets,
} from "./keys.ts";
import {
  type Derived,
  type Heat,
  LIMITS,
  type LineState,
  STATE_LABEL,
  type ThreadFacts,
  derive,
  settleHeat,
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
  KEPT_SECTION,
  AUTOMATIONS_SECTION,
  OUTSIDE_SECTION,
  automationFolded,
  SETTLE_SECTION,
  type Section,
  foldMove,
  isSection,
  keepFolds,
  asideText,
  leftBehind,
  listed,
  nextMove,
  projectIds,
  sectionFolded,
  sectionOf,
  settleHeadingHeat,
  unfoldAround,
  unread,
  visibleRows,
  waitingInside,
} from "./tree.ts";
import { OUTSIDE_STATE_TEXT, type OutsideLine, notListedText } from "./outside.ts";
import { type AutomationGroup, isAutomationRow, lastResultText, nextRunText, olderText, runThreadIds, scriptOutput } from "./automations.ts";
import { useAutomations } from "./automationsData.ts";
import { CHAT_STEP_PX, Glide, atEnd, attachWheelEscape, chatScroller, outputBelow } from "./chatScroll.ts";
import { useReader } from "./reader/Reader.tsx";
import type { FileRef } from "./reader/link.ts";
import { attachFileClicks, usePanelFiles } from "./reader/trigger.ts";
import { undoShort } from "./undo.ts";
import { useVerbs } from "./useVerbs.tsx";
import { type ActionRow, ActionsProbe, MoreCard, type MoreState, RowBadges, useSidebarIndex } from "./OtherPlugins.tsx";
import { pickAction, pickChoice } from "./plugins.ts";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
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
/** How long a line says which capability allowed its last request. */
const ALLOWED_SHOWN_MS = 10 * 60_000;
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
  // A house, ⌂: kept at home on purpose, to come back to when you choose.
  kept: <path d="M1.8 6.2 6 2l4.2 4.2v4.2H1.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  failed: (
    <path d="M2.4 2.4l7.2 7.2M9.6 2.4 2.4 9.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  ),
  idle: <circle cx="6" cy="6" r="3.7" fill="none" stroke="currentColor" strokeWidth="1.5" />,
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
    state: "waiting",
    // The side legend's column fits one word.
    name: "waiting",
    short: "on someone else, said",
    long: "Said by its agent with bb cow wait, or by you with w: its next move belongs to someone who is not you, a reviewer, CI, someone outside the team. The line says who or what, and for how long. It is not in the queue, unless you asked to be reminded and the day has come: then a keeps it waiting or takes it back. It clears when the thread starts a new turn, and when you park or archive it; w clears it too.",
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
    state: "kept",
    short: "kept by you, with z",
    long: "Chosen by you with z, with a few words or none: a thread you want around without it asking for anything. It is on the Kept shelf, folded by default, never in the queue and never coloured, and nothing reminds you of it. Only what truly needs you shows through, as on a parked line: its open ask. It comes off the shelf by itself when it starts a turn, as when you type to it; z on it takes it off too.",
  },
  {
    state: "failed",
    short: "its last turn failed",
    long: "Its last turn ended in an error. Open it to retry, or archive it with e. Listed in the queue.",
  },
  {
    state: "idle",
    short: "a project, quiet for now",
    long: "A project with nothing to say: not running, nothing waiting on you. Its reply to a turn you did not start, a report from a thread under it say, does not wait on you: unseen, it puts a small dot after its name, which opening its chat or Space clears. A project is Main, a thread with threads under it, or one marked with P or bb cow project. It is never done: it keeps its place, shows how long it has been quiet and what it says is next, and leaves only when you archive it with e.",
  },
  {
    state: "done",
    short: "finished, to settle",
    long: "Finished: its newest turn was not one you started, so its reply went to the thread that started it. It waits under To settle for one decision of yours: archive it (e), park it (p), keep it (z), or carry on with it (Enter, then i). Lines with a reply you have not seen come first, marked unread, then the oldest. Its age turns warm after 3 days and red after 7; that never puts it in the queue. A finished member stays in its group, dimmed, for 2 days first. An archived line is listed under Archived for 2 days. A project is never done unless you archive it.",
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

/**
 * Time in state: heavier the longer it has been, one square per full week.
 * A line to settle shows how long since it finished instead, plain, warm or
 * red by `heat`.
 */
function Age({ derived, now, finishedAt, heat }: { derived: Derived; now: number; finishedAt?: number; heat?: Heat }) {
  const ms = Math.max(0, now - (finishedAt ?? derived.since));
  const calm = derived.state === "done" || derived.state === "idle" || derived.state === "kept";
  const weight = calm || ms < HOUR ? 0 : ms < DAY ? 1 : ms < WEEK ? 2 : 3;
  return (
    <span
      className={`cow-ag cow-a${weight} cow-s-${derived.state}${heat ? ` cow-heat-${heat}` : ""}`}
      data-cow-heat={heat}
      title={heat ? "time since it finished" : derived.state === "kept" ? "how long it has been kept" : "time in this state"}
    >
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

/** The mark of a line whose thread holds a capability: a key. */
const CAP_GLYPH = (
  <svg className="cow-g" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="3.6" cy="6" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.9 6h4.9M9 6v2.2M10.8 6v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** What capabilities add to one line. */
interface LineCaps {
  /** The capabilities that apply to its thread. */
  held: readonly Held[];
  /** One of them is new: its notice has not been acknowledged. */
  fresh: boolean;
  /** What capabilities have allowed on it. */
  use: Use | null;
  /** When everything bb refused it is covered by capabilities: their names. */
  coveredBy: string | null;
}

function CapMark({ caps, now }: { caps: LineCaps; now: number }) {
  // The mark is for a thread that holds one now; what was allowed before stays in the log.
  if (caps.held.length === 0) return null;
  const names = caps.held.map((entry) => entry.capability.name).join(", ");
  const used = caps.use ? `capabilities have allowed ${caps.use.count} ${caps.use.count === 1 ? "request" : "requests"} here, the last ${formatAge(Math.max(0, now - caps.use.lastAt))} ago` : "none has been used here";
  return (
    <span
      className={caps.fresh ? "cow-capmark cow-capmark-new" : "cow-capmark"}
      data-cow-capmark={caps.held.length}
      data-cow-capmark-new={caps.fresh || undefined}
      data-cow-allowed-count={caps.use?.count ?? 0}
      title={`holds ${caps.held.length === 1 ? "a capability" : `${caps.held.length} capabilities`}: ${names}${caps.fresh ? " · one is new: C, then Space, acknowledges it" : ""} · ${used} · c shows them`}
    >
      {CAP_GLYPH}
      {caps.fresh ? <small>new</small> : null}
      {caps.use ? <small>{caps.use.count}×</small> : null}
    </span>
  );
}

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
function RollupMarks({ rollup }: { rollup: Rollup }) {
  const shown = ROLLUP_ORDER.filter((state) => rollup[state] > 0);
  if (shown.length === 0) return null;
  const words = shown.map((state) => `${rollup[state]} ${STATE_LABEL[state]}`).join(", ");
  return (
    <span
      className="cow-roll"
      data-cow-rollup={shown.map((state) => `${state}:${rollup[state]}`).join(" ")}
      title={`under it: ${words}`}
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
  caps,
  onSelect,
  onOpen,
  onFold,
  settle = false,
  sidebar,
}: {
  line: Line;
  /** bb's own copy of the thread, which other plugins' badges are drawn for; absent when bb's list does not hold it. */
  sidebar?: PluginSidebarThread;
  /** It is listed under To settle: its age is how long since it finished, warm then red, and it says what archiving it leaves behind. */
  settle?: boolean;
  /** What capabilities add to the line; null when there is nothing to add. */
  caps: LineCaps | null;
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
  // Covered by a capability: asking again is two keys, and the line says so.
  const covered = derived.state === "blocked" ? (caps?.coveredBy ?? null) : null;
  const next = covered !== null ? { text: "ask again: a, then Enter", own: false } : nextMove(line);
  // Said for a while, and only while the line has nothing to ask of the person: what waits on them comes first.
  const allowed = caps?.use && !derived.waitingOnYou && now - caps.use.lastAt <= ALLOWED_SHOWN_MS ? caps.use : null;
  const classes = ["cow-ln", `cow-d-${derived.state}`];
  if (returned) classes.push("cow-up");
  if (current) classes.push("cow-cur");
  if (flash) classes.push("cow-flash");
  if (open) classes.push("cow-open");
  if (context) classes.push("cow-context");
  if (line.stays) classes.push("cow-stays");
  // A run of an automation is plain unless it waits on the person: its failure shows on its automation's row.
  if (line.run !== undefined) classes.push(derived.waitingOnYou ? "cow-run-waits" : "cow-run");
  const isUnread = settle && unread(line);
  // A project's reply to a turn the person did not start: marked, quietly, where it is.
  const quietUnread = !settle && derived.state === "idle" && derived.unseen !== undefined;
  if (isUnread) classes.push("cow-unread");
  const behind = settle ? leftBehind(line) : [];
  if (fold !== null) classes.push("cow-grouphead");
  if (line.project && thread.archivedAt === null) classes.push("cow-project");
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
      data-cow-project={thread.archivedAt === null ? (line.project ?? undefined) : undefined}
      data-cow-asks={derived.asks?.length}
      data-cow-caps={caps && caps.held.length > 0 ? caps.held.length : undefined}
      data-cow-outside={derived.outside?.length}
      data-cow-open={open ? "" : undefined}
      data-cow-context={context ? "" : undefined}
      data-cow-stays={line.stays ? "" : undefined}
      data-cow-run={line.run}
      data-cow-settle={settle ? "" : undefined}
      data-cow-unread={isUnread ? "" : undefined}
      data-cow-kept={derived.keep ? "" : undefined}
      data-cow-wait={derived.wait ? (derived.wait.due ? "due" : "") : undefined}
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
      {settle ? <Age derived={derived} now={now} finishedAt={line.finishedAt} heat={settleHeat(line.finishedAt, now)} /> : <Age derived={derived} now={now} />}
      <span className="cow-nm">
        {flat ? null : <Rails depth={line.depth} />}
        {fold === null ? (
          // Where a head has its fold mark, so every title at one level starts at the same place.
          // A project with nothing under it has its own small mark there.
          line.project && thread.archivedAt === null ? (
            <i className="cow-fold cow-projectmark" title="a project: never done, idle when quiet · P unmarks it">
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="2.2" y="2.2" width="5.6" height="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </i>
          ) : (
            <i className="cow-fold" aria-hidden="true" />
          )
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
          {quietUnread ? <UnreadDot /> : null}
          {flat && parentTitle && !line.aside ? <small> · {parentTitle}</small> : null}
          {line.aside ? <small data-cow-aside={line.aside.id}> · under {line.aside.state} “{line.aside.title}”</small> : null}
          {open ? <small className="cow-openmark"> · chat open</small> : null}
          {line.stays ? (
            <small className="cow-staysmark" title="marked seen here: it moves to where its state puts it when the page is loaded again">
              {" "}
              · seen, stays here until reload
            </small>
          ) : null}
          {isUnread ? (
            <small className="cow-unreadmark" title="a reply you have not seen: Enter reads it, Space marks it seen">
              {" "}
              · unread
            </small>
          ) : null}
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
        {caps ? <CapMark caps={caps} now={now} /> : null}
        {derived.brief ? <BriefMarks mark={derived.brief} /> : null}
        {!flat && line.rollup ? <RollupMarks rollup={line.rollup} /> : null}
      </span>
      <span className="cow-wh">
        {allowed ? (
          <b className="cow-allowed" data-cow-allowed={allowed.name} title={`${formatAge(Math.max(0, now - allowed.lastAt))} ago cow answered bb “allow once” for: ${allowed.what}`}>
            allowed by {allowed.name}
            {" · "}
          </b>
        ) : null}
        {covered !== null ? (
          <b className="cow-allowed" data-cow-covered={covered}>
            covered by {covered}
            {" · "}
          </b>
        ) : null}
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
        {behind.length > 0 ? (
          <small className="cow-behind" data-cow-behind={behind.join(" · ")} title="what archiving it would leave behind">
            {" · archiving leaves "}
            {behind.join(", ")}
          </small>
        ) : null}
        {next.text ? <span className="cow-nx2"> → {nextNode}</span> : null}
      </span>
      <span className="cow-nx">
        {nextNode}
        {sidebar ? <RowBadges thread={sidebar} /> : null}
      </span>
    </div>
  );
}

/**
 * A line of Outside Main: an open thread with no parent, from bb's thread
 * list alone. Plain: nothing in it is in the queue or coloured for its age.
 */
function OutsideRow({
  line,
  now,
  project,
  current,
  open,
  onSelect,
  onOpen,
}: {
  line: OutsideLine;
  now: number;
  /** Its bb project's name, when that is not Main's. */
  project: string | null;
  current: boolean;
  open: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { thread } = line;
  return (
    <div
      className={["cow-ln", "cow-flat", "cow-outline", current ? "cow-cur" : ""].join(" ").trim()}
      data-cow-outside-line={thread.id}
      data-cow-outside-state={line.state}
      data-cow-open={open ? "" : undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      onClick={() => onSelect(thread.id)}
      onDoubleClick={() => onOpen(thread.id)}
    >
      <span className="cow-qn" />
      <span className="cow-gl" />
      <span className="cow-ag cow-a0" title="time since it last did anything">
        <b>{formatAge(Math.max(0, now - line.lastAt))}</b>
      </span>
      <span className="cow-nm">
        <i className="cow-fold" aria-hidden="true" />
        <span className="cow-title">
          {thread.title}
          {project !== null ? <small data-cow-outside-project=""> · {project}</small> : null}
          {thread.originKind === "fork" ? <small> · a fork</small> : null}
          {open ? <small className="cow-openmark"> · chat open</small> : null}
          {line.under > 0 ? (
            <small data-cow-under={line.under}>
              {" "}
              · with {line.under} {line.under === 1 ? "thread" : "threads"} under it
            </small>
          ) : null}
        </span>
      </span>
      <span className="cow-wh">{OUTSIDE_STATE_TEXT[line.state]}</span>
      <span className="cow-nx">A brings it under Main</span>
    </div>
  );
}

/**
 * An automation's row: its name, its project when that is not Main's,
 * when it runs next, and what its last run came to. Its runs fold under it.
 * Plain but for a failed last run, whose result alone takes the failed colour.
 */
function AutomationRow({
  group,
  now,
  folded,
  waiting,
  current,
  onSelect,
  onOpen,
  onFold,
}: {
  group: AutomationGroup;
  now: number;
  folded: boolean;
  /** How many of its runs wait on the person. */
  waiting: number;
  current: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onFold: (id: string) => void;
}) {
  const { automation, last } = group;
  const foldable = group.runs.length > 0;
  const older = olderText(group);
  return (
    <div
      className={["cow-ln", "cow-flat", "cow-automation", current ? "cow-cur" : ""].join(" ").trim()}
      data-cow-automation={automation.id}
      data-cow-automation-mode={automation.mode}
      data-cow-automation-paused={automation.enabled ? undefined : ""}
      data-cow-last={last.kind}
      data-cow-fold={foldable ? (folded ? "folded" : "open") : undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      aria-expanded={foldable ? !folded : undefined}
      onClick={() => onSelect(group.id)}
      onDoubleClick={() => onOpen(group.id)}
    >
      <span className="cow-qn" />
      <span className="cow-gl" />
      <span className="cow-ag cow-a0" title="since its last run">
        <b>{last.at === null ? "" : formatAge(Math.max(0, now - last.at))}</b>
      </span>
      <span className="cow-nm">
        {foldable ? (
          <i
            className="cow-fold cow-foldable"
            title={folded ? "unfold: l" : "fold: h"}
            onClick={(event) => {
              event.stopPropagation();
              onFold(group.id);
            }}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d={folded ? "M3 1.5 7.2 5 3 8.5z" : "M1.5 3 5 7.2 8.5 3z"} fill="currentColor" />
            </svg>
          </i>
        ) : (
          <i className="cow-fold" aria-hidden="true" />
        )}
        <span className="cow-title">
          {automation.name}
          {group.project !== null ? <small data-cow-automation-project=""> · {group.project}</small> : null}
          {automation.mode === "script" ? <small> · a script</small> : null}
          {group.intoTree ? <small> · runs in a thread under Main</small> : null}
          {folded && foldable ? (
            <small data-cow-folded={group.runs.length}>
              {" "}
              · {group.runs.length} {group.runs.length === 1 ? "run" : "runs"} folded{waiting > 0 ? `, ${waiting} waiting on you` : ""}
            </small>
          ) : null}
          {older && !folded ? <small> · {older}</small> : null}
        </span>
      </span>
      <span className="cow-wh" data-cow-next-run="">
        {nextRunText(automation, now)}
      </span>
      <span className={last.kind === "failed" ? "cow-nx cow-s-failed" : "cow-nx"} data-cow-last-result="">
        {lastResultText(last, now, formatAge)}
      </span>
    </div>
  );
}

/**
 * The heading of a section that folds, To settle, Kept, Automations or Outside Main: a cursor stop of
 * its own, where h and l fold and unfold it. Folded, it still shows its count.
 */
function SectionHead({
  id,
  title,
  count,
  words,
  folded,
  heat,
  current,
  onSelect,
  onFold,
}: {
  id: Section;
  title: string;
  count: number;
  words: string;
  folded: boolean;
  /** To settle's count takes the colour of its oldest line; Kept's is never coloured. */
  heat: Heat | null;
  current: boolean;
  onSelect: (id: string) => void;
  onFold: (id: string) => void;
}) {
  return (
    <div
      className={["cow-sec", "cow-secfold", current ? "cow-cur" : ""].join(" ").trim()}
      data-cow-section={id}
      data-cow-section-folded={folded ? "" : undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      aria-expanded={!folded}
      onClick={() => onSelect(id)}
    >
      <i
        className="cow-fold cow-foldable"
        title={folded ? "unfold: l" : "fold: h"}
        onClick={(event) => {
          event.stopPropagation();
          onFold(id);
        }}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d={folded ? "M3 1.5 7.2 5 3 8.5z" : "M1.5 3 5 7.2 8.5 3z"} fill="currentColor" />
        </svg>
      </i>
      {title}
      <b className={heat ? `cow-seccount cow-heat-${heat}` : "cow-seccount"} data-cow-section-count={count} data-cow-heat={heat ?? undefined}>
        {count}
      </b>
      <span>
        {words}
        {folded && count > 0 ? " · folded: l opens it" : ""}
      </span>
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
  return park?.due ? dueText(park.record, park.due, now) : `${line.derived.doing}${asideText(line)}`;
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
        <div className="cow-about" data-cow-about="">
          <h3>What this page is · j k scroll this legend, ? or Esc closes it</h3>
          <p>
            <b>Main</b> is the one long-lived thread you run your work through: the heading. Each line under it is a thread Main
            started, with the threads that one started indented under it. A line says what state its thread is in, for how long,
            what it is doing or waiting on, and what moves it next.
          </p>
          <p>
            <b>The queue</b> at the side holds only what waits on you, oldest first. <b>Parked</b> is work you set aside; it comes
            back by itself. <b>To settle</b> is what finished and is not archived: each waits for one decision of yours, archive,
            park, keep or carry on, and none is hidden by age. <b>Kept</b> is what you keep around on purpose; it asks for
            nothing. <b>Archived</b> is what was archived in the last 2 days. <b>Automations</b>, folded, has one row per bb
            automation, with when it runs next and what its last run came to, and its recent runs folded under it; a run that asks
            you something is in the queue, a finished one is not. <b>Outside Main</b>, last and folded, lists open
            threads with no parent, which are under no Main; <b>A</b> brings one under Main. Select a line, then press a verb: the bar at the bottom
            shows which apply, and a greyed-out one says why when pressed.
          </p>
          <p>
            What only you may do here (answering, granting, sending as you, capabilities) is signed with a key this browser holds, so
            an agent cannot do it through cow. The first page to open cow is enrolled; any other browser asks, and an enrolled page
            approves it. <kbd>C</kbd> lists the keys. Agents use the <code>bb cow</code> commands instead: asks, briefs, notes.
          </p>
        </div>
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
            <span>
              <i className="cow-fold cow-projectmark">
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="2.2" y="2.2" width="5.6" height="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </i>
            </span>
            <span>
              <b>a project.</b> A thread you talk to over days, marked with <kbd>P</kbd> or bb cow project. A group's head is
              one without the mark. It is never done: quiet, it reads idle.
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
            <span>{CAP_GLYPH} 3×</span>
            <span>
              <b>a capability.</b> The thread holds a grant you made: to write under one directory, or to run one command. When bb
              asks and the capability covers all of it, cow answers “allow once” and logs it; the number is how many times. The line says
              “allowed by …” for a while. <kbd>c</kbd> shows what a line holds; <kbd>C</kbd> opens them all, with the log. “new” means
              one you have not acknowledged: cow cannot tell who made it, so every new one is shown to you.
            </span>
          </div>
          <div className="cow-row">
            <span>not cow</span>
            <span>
              <b>approved, or denied, outside cow.</b> A permission request of the thread was decided, and not on this page or by a
              capability: in bb's own view, or by another thread. <kbd>Space</kbd> on the line acknowledges it.
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
          {KEY_GROUPS.map((group) => (
            <Fragment key={group.title}>
              <h3 data-cow-keygroup="">Keys: {group.title.toLowerCase()}</h3>
              {group.keys.map((entry) => (
                <div className="cow-row" key={entry.keys}>
                  <span>{entry.keys}</span>
                  <span>{entry.does}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The legend's own keys: it closes, and it scrolls when it is taller than the window. Every other key does nothing. */
function helpKey(key: string, close: () => void): true {
  if (key === "Escape" || key === "?" || key === "q") close();
  const card = document.querySelector<HTMLElement>("[data-cow-help] .cow-card");
  if (card) {
    if (key === "j" || key === "ArrowDown") card.scrollBy({ top: 60 });
    else if (key === "k" || key === "ArrowUp") card.scrollBy({ top: -60 });
    else if (key === "G") card.scrollTo({ top: card.scrollHeight });
    else if (key === "g") card.scrollTo({ top: 0 });
    else if (key === " ") card.scrollBy({ top: card.clientHeight * 0.8 });
  }
  return true;
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
function useMainState(scopedProjectId: string | null, signer: Signer) {
  const rpc = useRpc<typeof rpcContract>();
  const sign = signer.call;
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
      // Remembered on the server as where a new window starts: that is signed, so a page that is
      // not enrolled changes only its own window.
      return sign("main_choose", { projectId: thread.projectId, threadId: thread.id }).then(setStored);
    },
    [sign],
  );
  // The Mains recorded for other projects, here or in this window: never listed outside this one.
  const otherMains = useMemo(
    () => new Set([...Object.values(stored?.mains ?? {}), ...Object.values(own.mains)].filter((id) => id !== resolved.mainId)),
    [stored, own, resolved.mainId],
  );
  return { loaded: stored !== null, projectId: resolved.projectId, mainId: resolved.mainId, otherMains, error, load, choose };
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
  /** A key pressed with Ctrl alone; true when something on the page took it. */
  onCtrl?: (key: string) => boolean,
) {
  const [hint, setHint] = useState<HintState | null>(null);
  const reader = useRef(new KeyReader());
  const live = useRef({ onCommand, onLeaveChat, blocked, hint, beforeActivate, afterActivate, onCtrl });
  live.current = { onCommand, onLeaveChat, blocked, hint, beforeActivate, afterActivate, onCtrl };

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
        onCtrl: (key) => live.current.hint === null && (live.current.onCtrl?.(key) ?? false),
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
    help ? (key) => helpKey(key, () => setHelp(false)) : null,
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
        <Asides />
        <div className="cow-main cow-picker" data-cow-scroll="">
          {canCancel ? null : (
            <div className="cow-intro" data-cow-intro="">
              <p>
                <b>cow shows all the work you have handed to agents on one page, and lets you deal with it from the keyboard.</b>
              </p>
              <p>
                A <b>Main</b> is the one long-lived thread you talk to. It hands jobs to other threads; cow then lists every thread
                Main has started, and every thread those have started, each with its state and what it is waiting for, and
                collects what waits on you in one queue.
              </p>
              <p>
                <b>Now:</b> choose the thread that is your Main with <kbd>j</kbd> <kbd>k</kbd> and <kbd>Enter</kbd>. You can change
                it later with <kbd>M</kbd>, and <kbd>?</kbd> explains every mark and key.
              </p>
            </div>
          )}
          <p className="cow-lede">
            {notice ? <b>{notice} </b> : null}
            {canCancel ? "Main is the one long-lived thread you run your work through. This page then shows every thread Main has started, and every thread those have started." : ""}
            {scopedToProject ? " Listed: this project's threads, most recent first." : " Listed: all threads, most recent first."}
          </p>
          {candidates.length === 0 ? (
            <Notice title="There are no threads to choose from">
              <p>
                {scopedToProject ? "This project has no open thread. " : "bb has no open thread. "}
                Start one in bb (it will be your Main: the thread you ask to do things and to hand work to others), then come back
                here and choose it.
              </p>
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
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>?</kbd> what this is
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
  caps,
  signer,
  threads,
  onChooseMain,
  stay,
  projectNames,
  onAutomationsOpen,
  chat,
}: {
  /** The thread whose chat the page's address says is open beside the list, or null. */
  chat: string | null;
  /** bb's projects by id, for a line outside Main in another project. */
  projectNames: ReadonlyMap<string, string>;
  /** Says whether the Automations section is unfolded: while it is, the automations are read again now and then. */
  onAutomationsOpen: (open: boolean) => void;
  /** Keep a line the person marked seen in its place on this page, or let it go. */
  stay: (id: string, stays: boolean) => void;
  overview: Overview;
  main: Line;
  now: number;
  truncated: boolean;
  parks: Parks;
  raised: RaisedData;
  caps: CapsData;
  signer: Signer;
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
  const asideShown = hit ? overview.asideAsks.filter((line) => hit.has(line.thread.id)) : overview.asideAsks;
  // While filtering, a folded section shows what matches in it.
  const settleFolded = !hit && sectionFolded(folded, SETTLE_SECTION);
  const keptFolded = !hit && sectionFolded(folded, KEPT_SECTION);
  const outsideFolded = !hit && sectionFolded(folded, OUTSIDE_SECTION);
  const automationsOpen = !sectionFolded(folded, AUTOMATIONS_SECTION);
  useEffect(() => onAutomationsOpen(automationsOpen), [automationsOpen, onAutomationsOpen]);
  const automationsFolded = !hit && !automationsOpen;
  const groupsShown = hit
    ? overview.automations.groups.filter((group) => hit.has(group.id) || group.runs.some((line) => hit.has(line.thread.id)))
    : automationsFolded
      ? []
      : overview.automations.groups;
  const runsShown = (group: AutomationGroup): Line[] =>
    hit ? group.runs.filter((line) => hit.has(line.thread.id)) : automationFolded(folded, group.id) ? [] : group.runs;
  const outsideShown = hit ? overview.outside.lines.filter((line) => hit.has(line.thread.id)) : outsideFolded ? [] : overview.outside.lines;
  const settleShown = hit ? overview.settle.filter((line) => hit.has(line.thread.id)) : settleFolded ? [] : overview.settle;
  const keptShown = hit ? overview.kept.filter((line) => hit.has(line.thread.id)) : keptFolded ? [] : overview.kept;
  const archivedShown = hit ? overview.archived.filter((line) => hit.has(line.thread.id)) : overview.archived;
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
  // Undo's cursor: the line it brings back is followed to its new place,
  // and whatever folds it away there is unfolded once the page shows it.
  const following = useRef<{ id: string; away?: Section | "tree" } | null>(null);
  const follow = useCallback((id: string, away?: Section | "tree") => {
    following.current = { id, away };
    setCursorRaw(id);
  }, []);
  useEffect(() => {
    if (following.current === null) return;
    const { id, away } = following.current;
    const section = sectionOf(overview, id);
    const inTree = overview.rows.some((row) => row.id === id);
    // Still where it is leaving from: bb has not said it moved yet.
    if (away !== undefined && (away === "tree" ? inTree : section === away)) return;
    const placed = section !== null || inTree || listed(overview).some((line) => line.thread.id === id);
    if (!placed) return;
    following.current = null;
    setFolded((current) => unfoldAround(overview, current, id));
  }, [overview]);
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

  // The open chat lives in the page's address, so bb's back and forward move between chats.
  const bbNavigate = useBbNavigate();
  /** Whether the address names a thread this page knows: Main, or one bb has told it about, archived or not. */
  const knows = chat === null || chat === main.thread.id || threads.some((thread) => thread.id === chat);
  const pane = knows ? chat : null;
  /** The chat this page last asked for; any other is history moving under it. */
  const asked = useRef(pane);
  /**
   * Whether the person opened the chat that is open. A chat the page reopens
   * by itself (on a reload, or by back and forward) marks no reply seen: the
   * person may have taken that mark back. Opening it with Enter does.
   */
  const chosen = useRef(false);
  /** Bumped when the person opens the chat that is already open, so that its reply is marked seen. */
  const [chose, setChose] = useState(0);
  const setPane = useCallback(
    (id: string | null, replace = false) => {
      asked.current = id;
      chosen.current = id !== null;
      bbNavigate.toPluginPanel("main", { subPath: id === null ? undefined : encodeURIComponent(id), replace });
    },
    [bbNavigate],
  );
  const [focusRequest, setFocusRequest] = useState(0);
  const [sayTo, setSayTo] = useState<string | null>(null);
  const [sayText, setSayText] = useState("");
  const [sending, setSending] = useState(false);
  const [help, setHelp] = useState(false);
  const [message, setMessage] = useState("");
  const sidebarIndex = useSidebarIndex();
  /** What other plugins offer for the selected line, as its probe last reported. */
  const [otherRows, setOtherRows] = useState<{ threadId: string; rows: ActionRow[] }>({ threadId: "", rows: [] });
  const reportRows = useCallback((threadId: string, rows: ActionRow[]) => setOtherRows({ threadId, rows }), []);
  /** The menu of what other plugins offer, open under the selected line. */
  const [more, setMore] = useState<MoreState | null>(null);

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

  // The chats a link in the pane was followed from, newest last: Escape goes back through them before it closes the pane.
  const [paneBack, setPaneBack] = useState<readonly string[]>([]);
  // Back or forward brought another chat: the way back by Escape no longer applies, and the cursor follows the chat.
  useEffect(() => {
    if (pane === asked.current) return;
    asked.current = pane;
    chosen.current = false;
    setPaneBack([]);
    if (pane !== null) setCursor(pane);
  }, [pane]);
  // An address naming no thread this page knows (deleted, mistyped, another
  // machine's link) opens nothing: it is said, and the entry is replaced by
  // the page with no chat, so back does not come to it again.
  useEffect(() => {
    if (knows || chat === null) return;
    asked.current = null;
    chosen.current = false;
    setMessage(`no chat opened: the address names ${chat}, which is not a thread this page knows`);
    bbNavigate.toPluginPanel("main", { replace: true });
  }, [knows, chat, bbNavigate]);
  /** Open a thread's chat in the pane, or switch the pane to it. It never takes the keyboard, and starts the way back afresh. */
  const openChat = useCallback(
    (id: string | null) => {
      if (id === null) return;
      if (pane === id) {
        // The page reopened it by itself: the person opening it now reads its reply.
        if (!chosen.current) {
          chosen.current = true;
          setChose((value) => value + 1);
        }
        return;
      }
      setPane(id);
      setPaneBack([]);
      setMessage("");
    },
    [pane, setPane],
  );
  /** Put the caret in the composer of the chat that is open: the one way into it. */
  const typeInChat = useCallback(() => {
    chatMayFocus.current = true;
    rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]")?.focus({ preventScroll: true });
    setFocusRequest((value) => value + 1);
  }, []);

  const closePane = useCallback(() => {
    setPane(null);
    setPaneBack([]);
    focusOverview();
  }, [focusOverview, setPane]);

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
    signer
      .call("send", { threadId: target, text })
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
  const selectedOutside = overview.outside.lines.find((line) => line.thread.id === selected) ?? null;
  const selectedAutomation = isAutomationRow(selected) ? (overview.automations.groups.find((group) => group.id === selected) ?? null) : null;
  const sheetRef = useRef<BriefSheetControl | null>(null);

  // Capabilities: what each thread holds, which are new, and what they would cover.
  const parents = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.parentThreadId])), [threads]);
  const freshCaps = useMemo(() => new Set(caps.notices.flatMap((notice) => (notice.kind === "capability" && notice.capabilityId ? [notice.capabilityId] : []))), [caps.notices]);
  const heldOf = useCallback((id: string): Held[] => heldBy(caps.capabilities, id, ancestorsOf((thread) => parents.get(thread), id)), [caps.capabilities, parents]);
  /** For each refusal: the capability that would cover it when the thread is asked again. Judged on the paths as written; the backend looks again, links included, when the request comes. */
  const coverage = useCallback(
    (threadId: string, refusals: readonly Refusal[]): (string | null)[] => {
      const mine = heldOf(threadId);
      return refusals.map((refusal) => {
        const request = refusal.kind === "command" ? ({ kind: "command", command: refusal.what } as const) : ({ kind: "file_change", paths: [refusal.what] } as const);
        return mine.find((entry) => covers(entry.capability.rule, request).covered)?.capability.name ?? null;
      });
    },
    [heldOf],
  );
  const lineCaps = (line: Line): LineCaps | null => {
    const mine = heldOf(line.thread.id);
    const use = caps.uses.get(line.thread.id) ?? null;
    const refusals = line.derived.blocked?.refusals ?? [];
    const covered = refusals.length === 0 ? [] : coverage(line.thread.id, refusals);
    const coveredBy = covered.length > 0 && covered.every((name) => name !== null) ? [...new Set(covered)].join(", ") : null;
    if (mine.length === 0 && use === null) return null;
    return { held: mine, fresh: mine.some((entry) => freshCaps.has(entry.capability.id)), use, coveredBy };
  };
  const capSteps = useCapSteps({
    caps,
    mainId: main.thread.id,
    titleOf: (id) => titles.get(id) ?? threads.find((thread) => thread.id === id)?.title ?? id,
    say: (text) => setMessage(text),
    focusOverview: () => focusOverview(),
    after: async (origin: StepsOrigin, made: Capability) => {
      const name = `“${made.name}”`;
      if (origin.interactionId) {
        return caps.decide(origin.threadId, origin.interactionId, { decision: "allow_once", grantedPermissions: null }).then(
          () => `saved ${name}, and allowed this request once · it is marked new until you acknowledge it: C, then Space`,
          (cause: unknown) => `saved ${name}, but this request was not allowed: ${cause instanceof Error ? cause.message : String(cause)} · press a`,
        );
      }
      if (origin.askId) {
        const said = `granted as the capability ${name}: ${ruleText(made.rule)} for ${scopeText(made.scope, (id) => titles.get(id) ?? id)}`;
        return raised.answer(origin.askId, 1, said).then(
          () => `saved ${name}, and told the thread · it is marked new until you acknowledge it: C, then Space`,
          (cause: unknown) => `saved ${name}, but the thread was not told: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (origin.via === "blocked") return `saved ${name}: press a, then Enter, to ask again as you · it is marked new until you acknowledge it`;
      return `saved ${name}: it is marked new until you acknowledge it with Space`;
    },
    cancelled: (origin) => (origin.interactionId ? "nothing saved: the request is still waiting" : origin.askId ? "nothing saved: the ask is still open" : "nothing saved"),
  });
  /** Main and every thread under it, archived ones included. */
  const underMainIds = useMemo(() => new Set([main.thread.id, ...descendantIds(threads, main.thread.id, 0)]), [threads, main.thread.id]);
  const capSheet = useCapSheet({
    caps,
    signer,
    underMain: underMainIds,
    threads,
    titleOf: (id) => titles.get(id) ?? threads.find((thread) => thread.id === id)?.title ?? id,
    now,
    // From scratch, who it applies to is offered around the line the cursor is on.
    startNew: () => capSteps.start({ via: "sheet", threadId: selectedTodo?.ownerId ?? selectedLine?.thread.id ?? main.thread.id, where: "sheet" }, null),
    steps: capSteps.origin?.where === "sheet" ? capSteps.node : null,
    onClose: () => focusOverview(),
  });
  /** The line whose capabilities are shown under it, with c. */
  const [capsFor, setCapsFor] = useState<string | null>(null);
  useEffect(() => setCapsFor(null), [selected]);
  const acknowledgeOutside = (line: Line) => {
    const flags = line.derived.outside ?? [];
    Promise.all(flags.map((flag) => caps.acknowledge(flag.id))).then(
      () => setMessage(`acknowledged: ${flags.length === 1 ? "it is" : "they are"} in the log`),
      (cause: unknown) => setMessage(`not acknowledged: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  };

  const verbs = useVerbs({
    sdk,
    overview,
    main,
    selected: selectedLine,
    parks,
    raised,
    caps,
    coverage,
    sendAs: async (threadId, text) => {
      await signer.call("send", { threadId, text });
    },
    startCap: (origin, proposal) => capSteps.start(origin, proposal),
    openBrief: (id) => sheetRef.current?.open(id),
    now,
    folded,
    under: (id) => descendantIds(threads, id),
    setCursor,
    follow,
    say: setMessage,
    openChat,
    focusOverview,
    stay,
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

  // The reader: a file over the page. It opens from a click or a hint on
  // anything on the page that names a file, and from a file tab bb opens here.
  const navigate = useBbNavigate();
  const hintsRef = useRef<() => void>(() => undefined);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const panelFiles = usePanelFiles((file) => {
    const threadId = file.source?.threadId ?? paneRef.current;
    if (file.source?.kind === "host" || file.path.startsWith("/")) reader.open({ kind: "path", threadId, path: file.path, lines: null });
    else reader.open({ kind: "rooted", threadId, environmentId: file.source?.environmentId ?? null, root: file.source?.kind === "storage" ? "storage" : "workspace", relPath: file.path, lines: null });
  });
  const reader = useReader({
    sdk,
    titleOf: (id) => titles.get(id) ?? "a thread that is not on this page",
    startHints: () => hintsRef.current(),
    onClose: focusOverview,
    openInPanel: (file: FileRef, line) => {
      const target =
        file.root === "workspace" && file.environmentId
          ? ({ kind: "workspace", environmentId: file.environmentId, path: file.relPath } as const)
          : file.root === "storage" && file.threadId
            ? ({ kind: "thread-storage", threadId: file.threadId, path: file.relPath } as const)
            : file.hostId
              ? ({ kind: "host", hostId: file.hostId, path: file.absPath } as const)
              : null;
      if (target === null) return false;
      panelFiles.allowNext();
      return navigate.experimental_openFilePreview({ target, location: line === null ? null : { kind: "line", line, column: null } });
    },
  });
  const readerRef = useRef(reader);
  readerRef.current = reader;
  /** Enter on an automation's row: a script's last output in the reader, or an agent's latest run in the pane. */
  const openAutomation = (group: AutomationGroup) => {
    const { automation } = group;
    if (automation.mode === "script") {
      const content = scriptOutput(group);
      if (content === null) return setMessage(group.latest ? "its last run printed nothing" : automation.enabled ? "it has not run yet" : "it is paused, and its runs are not read");
      return reader.open({ kind: "text", threadId: null, title: `${automation.name}: last run's output`, content });
    }
    const latest = group.runs[0];
    if (latest) return openChat(latest.thread.id);
    return setMessage(group.intoTree ? "it runs in a thread under Main: that thread is in the tree" : "it has no run thread open to show");
  };
  const openById = (id: string | null) => {
    const group = isAutomationRow(id) ? overview.automations.groups.find((other) => other.id === id) : undefined;
    if (group) return openAutomation(group);
    return openChat(id);
  };
  // A click on a link leaves focus on the link, which may be in the chat; the reader's keys are the page's.
  useEffect(() => {
    if (reader.depth > 0) focusOverview();
  }, [reader.depth, focusOverview]);
  // A link to a thread in the chat switches the pane to it, as Enter on its line would.
  const followRef = useRef<(id: string) => boolean>(() => false);
  followRef.current = (id: string) => {
    // A thread bb has not told this page about is left to bb.
    if (id !== main.thread.id && !threads.some((thread) => thread.id === id)) return false;
    if (pane !== id) {
      if (pane !== null) setPaneBack((current) => [...current, pane]);
      setPane(id);
    }
    // Its line takes the cursor, unfolding what hides it; a thread not under this Main has none.
    const onPage = id === main.thread.id || listed(overview).some((line) => line.thread.id === id);
    if (onPage) setCursor(id);
    // As with Enter, the keyboard stays with the overview: the click may have left focus on the link.
    focusOverview();
    setMessage(onPage ? (pane !== null ? "Esc goes back to the chat before" : "") : `that thread is not under this Main${pane !== null ? " · Esc goes back to the chat before" : ""}`);
    return true;
  };
  useEffect(
    () =>
      attachFileClicks({
        root: () => rootRef.current,
        paneThread: () => paneRef.current,
        open: (target) => readerRef.current.open(target),
        openLink: (href) => readerRef.current.openLink(href),
        openThread: (id) => followRef.current(id),
      }),
    [],
  );

  // The chat in the pane is scrolled from here, without taking the keyboard.
  const glide = useRef(new Glide());
  useEffect(() => () => glide.current.stop(), []);
  // A mouse or trackpad is helped off bb's pin to the newest message while text arrives.
  useEffect(() => attachWheelEscape(() => rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]") ?? null), []);
  // Scrolled away from the newest message, the pane says when more has arrived below.
  const [below, setBelow] = useState(false);
  useEffect(() => {
    setBelow(false);
    if (pane === null) return;
    /** The chat's height when the person left its end; null while they are at it. */
    let left: number | null = null;
    const timer = setInterval(() => {
      const chat = rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]");
      const scroller = chat ? chatScroller(chat) : null;
      if (!scroller || atEnd(scroller)) left = null;
      else left ??= scroller.scrollHeight;
      setBelow(scroller !== null && outputBelow(left, scroller.scrollHeight));
    }, 400);
    return () => clearInterval(timer);
  }, [pane]);
  const scrollChat = (delta: (viewHeight: number) => number | "end") => {
    const chat = rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]");
    const scroller = chat ? chatScroller(chat) : null;
    if (scroller) glide.current.push(scroller, delta(scroller.clientHeight));
  };

  // A reply showing in a pane the person opened has been seen. Each is marked
  // once, so that undoing a mark made with Space is not undone again by the
  // open pane; a pane the page reopened by itself marks nothing.
  const paneLine = pane === null ? null : ([main, ...listed(overview)].find((line) => line.thread.id === pane) ?? null);
  const paneReply = paneLine?.derived.reply?.seq ?? paneLine?.derived.unseen?.seq ?? null;
  const autoSeen = useRef(new Set<string>());
  // Marking is signed, so it waits for this page's key to be read; a page that
  // is not enrolled tries once, and says why the reply still waits.
  const signing = signer.status;
  useEffect(() => {
    if (paneLine === null || paneReply === null || signing === "loading" || !chosen.current) return;
    const key = `${paneLine.thread.id}:${paneReply}:${signing === "enrolled"}`;
    if (autoSeen.current.has(key)) return;
    autoSeen.current.add(key);
    verbs.markSeen(paneLine, false);
    // Only a new pane, a new reply, this page becoming enrolled, or the person opening the pane the page reopened marks anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, paneReply, signing, chose]);

  const toggleFold = (id: string) =>
    setFolded((current) => {
      // A section's fold is recorded against how it starts: see `sectionFolded`.
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** What other plugins offer for the selected line; empty until its probe has reported. */
  const lineRows = selectedLine && otherRows.threadId === selectedLine.thread.id ? otherRows.rows : [];
  const moreOpen = more !== null && selectedLine !== null && more.threadId === selectedLine.thread.id ? more : null;
  const moreKey = (key: string) => {
    if (moreOpen === null) return;
    if (key === "Escape" || key === "q") return setMore(moreOpen.choicesOf !== null && key === "Escape" ? { ...moreOpen, choicesOf: null } : null);
    const opened = moreOpen.choicesOf === null ? null : (lineRows.find((row) => row.pick === moreOpen.choicesOf) ?? null);
    if (moreOpen.choicesOf !== null && opened === null) {
      setMore(null);
      return setMessage("that action is no longer offered");
    }
    const picked = opened === null ? pickAction(lineRows, key) : pickChoice(opened.entry, key);
    if (picked.kind === "miss") return setMessage(key.length === 1 ? `nothing is on ${key}: pick a key from the list, or Esc` : "");
    if (picked.kind === "disabled") return setMessage(`“${picked.label}” is not available now: its plugin has turned it off`);
    if (picked.kind === "choices") return setMore({ ...moreOpen, choicesOf: key });
    const { entry, value } = picked;
    const label = entry.action.label;
    setMore(null);
    setMessage(`${entry.pluginId} is running “${label}”…`);
    entry.action.run(value).then(
      () => setMessage(`${entry.pluginId} ran “${label}”${value === undefined ? "" : `: ${entry.action.choices?.items.find((choice) => choice.id === value)?.label ?? value}`}`),
      (cause: unknown) => setMessage(`${entry.pluginId} could not run “${label}”: ${cause instanceof Error ? cause.message : String(cause)}`),
    );
  };

  const run = (command: Command) => {
    // An open brief covers the page, and the keys are its own.
    if (sheet.threadId !== null && sheet.onCommand(command)) return;
    if (moveInList({ order, cursor: selected, setCursor }, command)) return;
    switch (command.kind) {
      case "recheck":
        // On a line, c shows the capabilities its thread holds; inside a brief it runs the check again.
        if (selectedTodo || !selectedLine) return setMessage("c shows a thread's capabilities: select a thread's line first");
        setMessage("");
        return setCapsFor(capsFor === selectedLine.thread.id ? null : selectedLine.thread.id);
      case "caps":
        setMessage("");
        return capSheet.show();
      case "close":
        // A file bb is showing beside the page, after o in the reader: q puts it away.
        panelFiles.closeShown();
        return;
      case "chat-scroll":
        if (pane !== null) scrollChat((height) => command.by * (command.half ? Math.max(CHAT_STEP_PX, Math.round(height / 2)) : CHAT_STEP_PX));
        return;
      case "chat-end":
        if (pane !== null) scrollChat(() => "end");
        return;
      case "open":
        if (selectedAutomation) return openAutomation(selectedAutomation);
        // What is not started has no chat of its own; its thread's is the nearest thing.
        return openChat(selectedTodo ? selectedTodo.ownerId : selected);
      case "main-chat":
        return openChat(main.thread.id);
      case "back": {
        if (capsFor !== null) return setCapsFor(null);
        if (panelFiles.closeShown()) return;
        // After following a link, back to the chat it was followed from, then closed.
        const previous = paneBack[paneBack.length - 1];
        if (pane !== null && previous !== undefined) {
          setPaneBack(paneBack.slice(0, -1));
          setPane(previous, true);
          return setMessage(`back to ${previous === main.thread.id ? "Main" : `“${titles.get(previous) ?? threads.find((thread) => thread.id === previous)?.title ?? previous}”`}${paneBack.length > 1 ? " · Esc goes back again" : " · Esc closes the chat"}`);
        }
        if (pane !== null) closePane();
        else setMessage("");
        return;
      }
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
        // A decision made outside cow is acknowledged first: it is the newer thing to know.
        if (selectedLine?.derived.outside) return acknowledgeOutside(selectedLine);
        return selectedLine ? verbs.markSeen(selectedLine, true) : undefined;
      case "project":
        if (selectedTodo) return setMessage("that is work not started, not a thread");
        return selectedLine ? verbs.toggleProject(selectedLine) : undefined;
      case "wait":
        if (selectedTodo) return setMessage("that is work not started, not a thread");
        return verbs.startWait(selectedLine);
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
      case "bring":
        if (!selectedOutside) return setMessage("A brings a thread from Outside Main under Main: select a line there first");
        return verbs.startBring(selectedOutside);
      case "more":
        if (!selectedLine) return setMessage(". lists what other plugins offer for a thread: select a thread's line first");
        if (lineRows.length === 0) return setMessage("no other plugin offers anything for this thread");
        setMessage("");
        return setMore({ threadId: selectedLine.thread.id, choicesOf: null });
      default:
        return;
    }
  };

  const { hint, startHints } = usePageKeys(
    rootRef,
    run,
    focusOverview,
    reader.onKey
      ? (key) => {
          // A file is open over the page: every key is the reader's.
          reader.onKey?.(key, false);
          return true;
        }
      : help
      ? (key) => helpKey(key, () => setHelp(false))
      : capSteps.onKey
        ? (key) => {
            // The steps that make a capability hold the keyboard until they are saved or left.
            capSteps.onKey?.(key);
            return true;
          }
      : verbs.onKey
        ? (key) => {
            // An ask's proof files are links: f still labels them while its card is open.
            if (key === "f" && verbs.mode === "ASK") return false;
            verbs.onKey?.(key);
            return true;
          }
        : moreOpen !== null
          ? (key) => {
              // The menu's rows take hints like any other.
              if (key === "f") return false;
              moreKey(key);
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
            : capSheet.open
              ? (key) => capSheet.onKey(key)
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
    (key) => {
      if (!reader.onKey) return false;
      reader.onKey(key, true);
      return true;
    },
  );
  hintsRef.current = startHints;

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
  // A thread opened from a link may not be under this Main: its header says so.
  const paneOutside = pane !== null && !underMainIds.has(pane);
  const paneTitle = pane === null ? "" : (titles.get(pane) ?? threads.find((thread) => thread.id === pane)?.title ?? "a thread that is no longer listed");
  // A card opened for one ask from inside a brief is drawn there, not under the line.
  const allLines = [main, ...listed(overview)];
  const card = (id: string) => {
    if (moreOpen !== null && moreOpen.threadId === id) return <MoreCard state={moreOpen} rows={lineRows} onPick={moreKey} />;
    if (capSteps.origin?.where === "line" && capSteps.origin.threadId === id) return capSteps.node;
    if (verbs.card?.threadId === id && verbs.card.askId === undefined) return verbs.card.node;
    if (capsFor !== id) return null;
    const line = allLines.find((other) => other.thread.id === id);
    return <HeldCard threadId={id} held={heldOf(id)} fresh={freshCaps} use={caps.uses.get(id) ?? null} outside={caps.outside.get(id) ?? []} titleOf={(thread) => titles.get(thread) ?? threads.find((other) => other.id === thread)?.title ?? thread} now={now} key={line?.thread.id} />;
  };
  const capNotices = caps.notices.filter((notice) => notice.kind === "capability");
  // Always in sight: a capability nobody remembers making shows as a number that went up.
  const inForce = caps.capabilities.filter((capability) => capability.deletedAt === null).length;
  // What waits on the person: the lines in the queue, and the capabilities they have not acknowledged.
  // A page that asks for its key to be enrolled waits on the person too, on a page that can approve it.
  const keyRequests = signer.status === "enrolled" ? (signer.keys?.requests ?? []).filter((request) => request.status === "pending") : [];
  const waiting = overview.queue.length + capNotices.length + keyRequests.length;
  const row = (line: Line, flat: boolean, settle = false) => {
    // While filtering every group is drawn unfolded: what matches inside it is showing.
    const fold = flat || line.members === 0 ? null : !found && folded.has(line.thread.id) ? "folded" : "open";
    return (
    <Fragment key={line.thread.id}>
      <LineRow
        line={line}
        now={now}
        flat={flat}
        settle={settle}
        fold={fold}
        waitingInside={fold === "folded" ? waitingInside(overview, line.thread.id) : 0}
        open={line.thread.id === pane}
        context={hit !== null && !hit.has(line.thread.id)}
        caps={lineCaps(line)}
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
        sidebar={sidebarIndex.get(line.thread.id)}
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
          : reader.mode !== null
            ? reader.mode
            : sayTo !== null
            ? "say"
            : help
              ? "help"
              : capSteps.origin !== null
                ? "cap"
                : (verbs.mode?.toLowerCase() ?? (moreOpen !== null ? "more" : filter !== null ? "filter" : capSheet.open ? "caps" : sheet.threadId !== null ? "brief" : "normal"))
      }
      tabIndex={-1}
      ref={rootRef}
    >
      {selectedLine ? <ActionsProbe key={selectedLine.thread.id} facts={selectedLine.thread} sidebar={sidebarIndex.get(selectedLine.thread.id)} onRows={reportRows} /> : null}
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
              {main.derived.state === "idle" && main.derived.unseen !== undefined ? <UnreadDot /> : null}
            </h1>
            <span
              className={`cow-mainstate cow-s-${main.derived.state}`}
              data-cow-main-state={main.derived.state}
            >
              <Glyph state={main.derived.state} />
              {STATE_LABEL[main.derived.state]} <Age derived={main.derived} now={now} />
            </span>
            <span className="cow-maindoing">
              {(() => {
                const mine = lineCaps(main);
                return mine ? <CapMark caps={mine} now={now} /> : null;
              })()}
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
            <b>{listedCount}</b> {listedCount === 1 ? "thread" : "threads"} · <b>{waiting}</b> waiting
            on you
          </span>
        </header>
        <Asides />
        {signer.status !== "enrolled" && signer.status !== "loading" ? (
          <p className="cow-keybanner cow-keybanner-off" data-cow-key-status={signer.status} data-cow-key-fingerprint={signer.fingerprint ?? ""} role="alert">
            <b>
              {signer.status === "unavailable"
                ? "This page can only read."
                : (signer.keys?.keys.length ?? 0) > 0
                  ? "cow's person-only actions are held by a key that is not this page's."
                  : "This page's key is not enrolled."}
            </b>{" "}
            {signer.why[0]?.toUpperCase()}
            {signer.why.slice(1)}
            {signer.status === "pending" ? " If you never enrolled a page, something else did: that is what the reset is for." : ""}
          </p>
        ) : signer.firstUse ? (
          <p className="cow-keybanner" data-cow-key-status="first" data-cow-key-fingerprint={signer.fingerprint ?? ""} role="status">
            <b>This page's key {signer.fingerprint} is now enrolled, by first use.</b> It signs what only you may do here, so an agent
            cannot do those things through cow; any other browser has to be approved from this one. <kbd>C</kbd> lists the keys
            later, and <kbd>?</kbd> says more.{" "}
            <button type="button" className="cow-vb" data-cow-hint="" data-cow-key-dismiss="" tabIndex={-1} onClick={signer.dismissFirstUse}>
              understood
            </button>
          </p>
        ) : null}
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
                {asideShown.length > 0 ? (
                  <p className="cow-shelf-empty" data-cow-aside-asks={asideShown.length}>
                    Asks of threads set aside under a parked or kept thread: answering one resumes nothing.
                  </p>
                ) : null}
                {asideShown.map((line) => row(line, true))}
                <SectionHead
                  id={SETTLE_SECTION}
                  title="To settle"
                  count={overview.settle.length}
                  words={
                    overview.settle.length === 0
                      ? "nothing finished waits for a decision"
                      : `finished, not archived: archive, park, keep or carry on with each · ${overview.settle.filter(unread).length} unread · oldest ${formatAge(Math.max(0, now - Math.min(...overview.settle.map((line) => line.finishedAt))))}`
                  }
                  folded={settleFolded}
                  heat={settleHeadingHeat(overview.settle, now)}
                  current={selected === SETTLE_SECTION}
                  onSelect={setCursor}
                  onFold={toggleFold}
                />
                {settleShown.map((line) => row(line, true, true))}
                <SectionHead
                  id={KEPT_SECTION}
                  title="Kept"
                  count={overview.kept.length}
                  words={overview.kept.length === 0 ? "nothing kept: z on a line keeps it around, asking for nothing" : "around on purpose, asking for nothing, newest kept first"}
                  folded={keptFolded}
                  heat={null}
                  current={selected === KEPT_SECTION}
                  onSelect={setCursor}
                  onFold={toggleFold}
                />
                {keptShown.map((line) => row(line, true))}
                {overview.archived.length > 0 ? (
                  <div className="cow-sec" data-cow-archived="">
                    Archived
                    <span>{overview.archived.length} in the last 2 days, with their reasons · u takes back an archive made here</span>
                  </div>
                ) : null}
                {archivedShown.map((line) => row(line, true))}
              </>
            )}
            {/* Only when the automations plugin answered: without it there is no section, and nothing to say. */}
            {overview.automations.available ? (
              <>
                <SectionHead
                  id={AUTOMATIONS_SECTION}
                  title="Automations"
                  count={overview.automations.groups.length}
                  words={overview.automations.groups.length === 0 ? "bb has no automations" : "bb's scheduled runs: when each runs next and what its last run came to · l shows an automation's runs"}
                  folded={automationsFolded}
                  heat={null}
                  current={selected === AUTOMATIONS_SECTION}
                  onSelect={setCursor}
                  onFold={toggleFold}
                />
                {groupsShown.map((group) => (
                  <Fragment key={group.id}>
                    <AutomationRow
                      group={group}
                      now={now}
                      folded={!hit && automationFolded(folded, group.id)}
                      waiting={group.runs.filter((line) => line.derived.waitingOnYou).length}
                      current={selected === group.id}
                      onSelect={setCursor}
                      onOpen={openById}
                      onFold={toggleFold}
                    />
                    {runsShown(group).map((line) => row(line, false))}
                  </Fragment>
                ))}
              </>
            ) : null}
            {/* Outside Main shows even when Main has nothing under it: that is when it matters most. */}
            <SectionHead
              id={OUTSIDE_SECTION}
              title="Outside Main"
              count={overview.outside.lines.length}
              words={[
                overview.outside.lines.length === 0 ? "every open thread is under a Main" : "open, with no parent, not under this Main: A brings one under it",
                notListedText(overview.outside),
              ]
                .filter(Boolean)
                .join(" · ")}
              folded={outsideFolded}
              heat={null}
              current={selected === OUTSIDE_SECTION}
              onSelect={setCursor}
              onFold={toggleFold}
            />
            {outsideShown.map((line) => (
              <OutsideRow
                key={line.thread.id}
                line={line}
                now={now}
                project={line.thread.projectId === main.thread.projectId ? null : (projectNames.get(line.thread.projectId) ?? null)}
                current={line.thread.id === selected}
                open={line.thread.id === pane}
                onSelect={setCursor}
                onOpen={openChat}
              />
            ))}
            {truncated ? (
              <p className="cow-warn">bb has more threads than this page reads; some may be missing.</p>
            ) : null}
          </main>

          {pane === null ? (
            <aside className="cow-side">
              <h2>
                Waiting on you <b>{waiting}</b>
              </h2>
              <p className="cow-sub">
                Asks, questions, permission requests, refused permissions, failures, briefs with disputes,
                replies addressed to you, parked work that came back, reminders of work waiting on someone else, new capabilities and decisions made outside cow, oldest first.
              </p>
              {capNotices.length + keyRequests.length > 0 ? (
                <ul className="cow-queue cow-notices" data-cow-notices={capNotices.length + keyRequests.length}>
                  {keyRequests.map((request) => (
                    <li key={request.fingerprint} className="cow-q cow-q-notice" data-cow-key-waiting={request.fingerprint} data-cow-hint="" onClick={() => capSheet.show()}>
                      <span className="cow-qn">{CAP_GLYPH}</span>
                      <span className="cow-gl" />
                      <div>
                        <p>
                          a page asks to act as you: key {request.fingerprint} ({request.label})
                        </p>
                        <small>
                          {formatAge(Math.max(0, now - request.requestedAt))} · <kbd>C</kbd>, then <kbd>⏎</kbd> approves or <kbd>x</kbd> refuses
                        </small>
                      </div>
                    </li>
                  ))}
                  {capNotices.map((notice) => (
                    <li key={notice.id} className="cow-q cow-q-notice" data-cow-notice={notice.id} data-cow-notice-capability={notice.capabilityId ?? undefined} data-cow-hint="" onClick={() => capSheet.show()}>
                      <span className="cow-qn">{CAP_GLYPH}</span>
                      <span className="cow-gl" />
                      <div>
                        <p>{notice.text}</p>
                        <small>
                          new · {formatAge(Math.max(0, now - notice.at))} · <kbd>C</kbd> then <kbd>␣</kbd> acknowledges
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ol className="cow-queue" data-cow-scroll="">
                {overview.queue.length === 0 ? (
                  <li className="cow-q-empty">{capNotices.length + keyRequests.length === 0 ? "Nothing is waiting on you." : "No thread is waiting on you."}</li>
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
                {paneOutside ? (
                  <small className="cow-outside-main" data-cow-pane-outside="">
                    not under this Main
                  </small>
                ) : null}
                {below ? (
                  <button type="button" className="cow-vb cow-below" data-cow-chat-below="" data-cow-hint="" tabIndex={-1} title="more has arrived since you scrolled up" onClick={() => scrollChat(() => "end")}>
                    new output below · <kbd>\</kbd>
                  </button>
                ) : null}
                <span>
                  <kbd>;</kbd> <kbd>'</kbd> scroll · <kbd>i</kbd> type here · <kbd>Esc</kbd> {paneBack.length > 0 ? "previous chat" : "back"}
                </span>
                <button type="button" className="cow-vb" data-cow-hint="" tabIndex={-1} onClick={closePane}>
                  close
                </button>
              </div>
              <div className="cow-chat" data-cow-chat="" data-cow-pane-back={paneBack.length || undefined} tabIndex={-1}>
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
          ) : capSteps.origin !== null ? (
            <>
              <span className="cow-mode cow-m-prompt">CAP</span>
              <span className="cow-noun">{titles.get(capSteps.origin.threadId) ?? ""}</span>
              <span className="cow-sep">▸</span>
              <span>{capSteps.origin.where === "sheet" ? "a new capability, in the sheet" : "a new capability is being set up under its line"} · nothing is saved until the last step</span>
            </>
          ) : verbs.footer ? (
            verbs.footer
          ) : moreOpen !== null ? (
            <>
              <span className="cow-mode cow-m-prompt">MORE</span>
              <span className="cow-noun">{selectedLine?.thread.title ?? ""}</span>
              <span className="cow-sep">▸</span>
              <span>
                {moreOpen.choicesOf === null ? "what other plugins offer: pick one to run it there" : "pick a choice"} · <kbd>f</kbd> hints · <kbd>Esc</kbd> {moreOpen.choicesOf === null ? "close" : "back"}
              </span>
            </>
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
              <span className="cow-noun">{selectedLine?.thread.title ?? selectedTodo?.item.title ?? selectedOutside?.thread.title ?? selectedAutomation?.automation.name ?? (selected === SETTLE_SECTION ? "To settle" : selected === KEPT_SECTION ? "Kept" : selected === AUTOMATIONS_SECTION ? "Automations" : selected === OUTSIDE_SECTION ? "Outside Main" : "")}</span>
              <span className="cow-sep">▸</span>
              <span className="cow-verbs">
                <Verb keys="⏎" label="open chat" off={selected === null} onRun={() => openChat(selected)} />
                <Verb keys="I" label="say to it" off={selected === null} onRun={() => startSay(selected)} />
                {isSection(selected) ? (
                  <>
                    <Verb keys="h" label="fold" name="section-fold" off={sectionFolded(folded, selected)} onRun={() => run({ kind: "fold", key: "h" })} />
                    <Verb keys="l" label="unfold" name="section-unfold" off={!sectionFolded(folded, selected)} onRun={() => run({ kind: "fold", key: "l" })} />
                  </>
                ) : selectedTodo ? (
                  <>
                    <Verb keys="x" label="remove" name="todo-remove" onRun={() => verbs.removeTodo(selectedTodo)} />
                    <Verb keys="K" label="up" off={selectedTodo.number === 1} onRun={() => verbs.moveTodo(selectedTodo, -1)} />
                    <Verb keys="J" label="down" off={selectedTodo.number === selectedTodo.of} onRun={() => verbs.moveTodo(selectedTodo, 1)} />
                  </>
                ) : selectedOutside ? (
                  <Verb keys="A" label="bring under Main" name="bring" onRun={() => verbs.startBring(selectedOutside)} />
                ) : selectedAutomation ? (
                  <Verb keys="l" label={selectedAutomation.runs.length === 0 ? "no runs to show" : "its runs"} off={selectedAutomation.runs.length === 0} onRun={() => run({ kind: "fold", key: "l" })} />
                ) : (
                  (["answer", "brief", "park", "resume", "stop", "archive"] as const).map(verbButton)
                )}
                {selectedLine && !selectedTodo && selectedLine !== main && selectedLine.run === undefined ? verbButton("keep") : null}
                {selectedLine?.derived.reply || selectedLine?.derived.unseen ? (
                  <Verb keys="␣" label="seen" name="seen" onRun={() => verbs.markSeen(selectedLine, true)} />
                ) : null}
                {selectedLine && !selectedTodo && selectedLine.run === undefined && selectedLine.thread.archivedAt === null && selectedLine.derived.state !== "parked" && selectedLine.derived.state !== "kept" ? (
                  <Verb keys="w" label={selectedLine.derived.wait ? "clear wait" : "waiting on…"} name="wait" onRun={() => verbs.startWait(selectedLine)} />
                ) : null}
                {lineRows.length > 0 ? (
                  <Verb keys="." label="more" name="more" why="what other plugins offer for this thread, run by them" onRun={() => run({ kind: "more" })} />
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
                <Verb keys="⇥" label="next in queue" off={overview.queue.length === 0} onRun={() => run({ kind: "ask", by: 1 })} />
                <Verb name="caps" keys="C" why="how many capabilities are in force, and how many notices wait: C opens them" label={`capabilities ${inForce}${caps.notices.length > 0 ? ` · ${caps.notices.length} to acknowledge` : ""}`} onRun={() => run({ kind: "caps" })} />
                <Verb keys="f" label="hints" onRun={startHints} />
                <Verb keys="?" label="legend" onRun={() => setHelp(true)} />
              </span>
            </>
          )}
        </footer>
      </div>
      {sheet.node}
      {capSheet.node}
      {reader.node}
      {hint ? <HintLayer hint={hint} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

/**
 * A project's or Main's newest reply, to a turn the person did not start, not
 * yet seen: a small mark on its line, never a wait. Opening the chat or Space
 * clears it; u brings it back.
 */
function UnreadDot() {
  return (
    <i
      className="cow-unreaddot"
      data-cow-unseen=""
      role="img"
      aria-label="unread"
      title="unread: a reply to a turn you did not start · Enter reads it, Space marks it seen"
    />
  );
}

/** The thread whose chat the page's address names, or null; a part that does not decode is kept as it is, and is then no thread. */
function chatOf(subPath: string): string | null {
  const part = subPath.split("/")[0] ?? "";
  if (part === "") return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The whole page: decides between loading, an error, the picker and the overview. */
export function CowPage({ subPath }: PluginNavPanelProps) {
  const sdk = useSdk();
  const context = useBbContext();
  const now = useNow();
  const { store, snapshot } = useThreadStore();
  // bb names a project when the page is opened inside one.
  const scopedProjectId = context.projectId ?? null;
  const signer = useSigner();
  const mains = useMainState(scopedProjectId, signer);
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
  // bb's automations: read once, then again as their threads change and while their section is open.
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const automations = useAutomations(snapshot.threads, automationsOpen);
  const runIds = useMemo(() => runThreadIds(automations), [automations]);

  const underMain = useMemo(
    () =>
      mainId === null || snapshot.status !== "ready"
        ? null
        : // A note may be on any open thread, or on one archived recently enough to be listed.
          // Main's own are its note of what is next and what it has not started.
          // An automation's runs are read as the threads under Main are: an open ask of one's is the person's.
          [...new Set([mainId, ...descendantIds(snapshot.threads, mainId, now - LIMITS.archivedListedMs), ...runIds])],
    [snapshot.threads, snapshot.status, mainId, now, runIds],
  );
  const parks = useParks(underMain, signer);
  const notes = parks.notes;
  const raised = useRaised(underMain, signer);
  const caps = useCaps(signer);

  const projects = useMemo(() => projectIds(snapshot.threads, parks.projects.keys(), mainId), [snapshot.threads, parks.projects, mainId]);
  // Lines the person marked seen here stay in their place until the page is loaded again.
  const [staying, setStaying] = useState<ReadonlySet<string>>(new Set());
  const stay = useCallback((id: string, on: boolean) => {
    setStaying((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
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
                { project: projects.has(thread.id), main: thread.id === mainId, seenSeq: parks.seen.get(thread.id)?.seq ?? null },
                { asks: raised.asks.get(thread.id) ?? [], brief: raised.briefs.get(thread.id) ?? null, delivered: raised.delivered.get(thread.id), outside: caps.outside.get(thread.id) },
                parks.waits.get(thread.id),
                thread.id === mainId ? null : parks.keeps.get(thread.id),
              ),
            now,
            {
              note: (id) => parks.nexts.get(id)?.text ?? null,
              todos: (id) => parks.todos.get(id) ?? [],
              marked: (id) => parks.projects.has(id),
              stays: (id) => staying.has(id),
              otherMains: mains.otherMains,
              automations,
            },
          ),
    [snapshot, mainId, projects, notes, parks.archives, parks.dismissals, parks.seen, parks.nexts, parks.todos, parks.waits, parks.keeps, staying, raised.asks, raised.briefs, raised.delivered, caps.outside, mains.otherMains, automations, now],
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
      caps={caps}
      signer={signer}
      threads={snapshot.threads}
      onChooseMain={() => setPicking(true)}
      stay={stay}
      projectNames={projectNames}
      onAutomationsOpen={setAutomationsOpen}
      chat={chatOf(subPath)}
    />
  );
}
