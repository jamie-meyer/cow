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
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { MainState, rpcContract } from "../server.ts";
import { pinnedProjectId, useNow } from "./clock.ts";
import { ThreadStore } from "./data.ts";
import { hintLabels, matchHint } from "./hints.ts";
import { dueText } from "./park.ts";
import { type Parks, useParks } from "./parks.ts";
import { MAIN_CHANGED } from "./shared.ts";
import {
  type Command,
  type HintTarget,
  KEY_MAP,
  KeyReader,
  attachKeys,
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
import { type Line, type Overview, buildOverview, cursorOrder, descendantIds, listed } from "./tree.ts";
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

/** Whether the page is open: the "choose Main" command is offered only then. */
export const pageSignal = {
  mounted: false,
  chooseMain: null as (() => void) | null,
};

const GLYPH_PATH: Record<LineState, ReactNode> = {
  wants: <circle cx="6" cy="6" r="4.3" fill="currentColor" />,
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
const LEGEND: readonly { state: LineState; short: string; long: string }[] = [
  {
    state: "wants",
    short: "it asked; or Main replied",
    long: "It asked you something, or Main finished with a reply you have not read. Listed in the queue.",
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
    long: "Finished and reported to the thread that started it, or archived, in the last 2 days. Older ones are counted, not listed.",
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

function LineRow({
  line,
  now,
  flat,
  parentTitle,
  current,
  flash,
  onSelect,
  onOpen,
}: {
  line: Line;
  now: number;
  flat: boolean;
  parentTitle: string | null;
  current: boolean;
  flash: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { thread, derived } = line;
  const returned = derived.park?.due != null;
  const classes = ["cow-ln", `cow-d-${derived.state}`];
  if (returned) classes.push("cow-up");
  if (current) classes.push("cow-cur");
  if (flash) classes.push("cow-flash");
  return (
    <div
      className={classes.join(" ")}
      data-cow-line={thread.id}
      data-cow-state={derived.state}
      data-cow-returned={returned || undefined}
      data-cow-hint=""
      aria-current={current || undefined}
      onClick={() => onSelect(thread.id)}
      onDoubleClick={() => onOpen(thread.id)}
    >
      <span className="cow-qn">{line.queueNumber ?? ""}</span>
      <span className="cow-gl">
        <Glyph state={derived.state} />
      </span>
      <Age derived={derived} now={now} />
      <span className="cow-nm" style={flat ? undefined : { paddingLeft: line.depth * 15 }}>
        {thread.title}
        {flat && parentTitle ? <small> · {parentTitle}</small> : null}
        {line.under > 0 ? (
          <small data-cow-under={line.under}>
            {" "}
            · with {line.under} {line.under === 1 ? "thread" : "threads"} under it
          </small>
        ) : null}
      </span>
      <span className="cow-wh">
        {derived.doing}
        {derived.next ? <span className="cow-nx2"> → {derived.next}</span> : null}
      </span>
      <span className="cow-nx">{derived.next}</span>
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
            <span>indent</span>
            <span>
              <b>started by the line above.</b> An indented line is a thread the one above it started.
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

function HintLayer({ hint }: { hint: HintState }) {
  return (
    <div className="cow-hints" data-cow-hints="">
      {hint.targets.map((target, index) => {
        const label = hint.labels[index]!;
        return (
          <span
            key={label}
            className={label.startsWith(hint.typed) ? "cow-ht" : "cow-ht cow-dim"}
            data-cow-hint-label={label}
            style={{ left: target.left, top: target.top }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
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

/** Which thread is Main, per project, kept on the bb server. */
function useMainState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<MainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("main_state").then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(MAIN_CHANGED, load);
  const choose = useCallback(
    (thread: ThreadFacts) =>
      rpc.call("main_choose", { projectId: thread.projectId, threadId: thread.id }).then(setState),
    [rpc],
  );
  return { state, error, load, choose };
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
) {
  const [hint, setHint] = useState<HintState | null>(null);
  const reader = useRef(new KeyReader());
  const live = useRef({ onCommand, onLeaveChat, blocked, hint });
  live.current = { onCommand, onLeaveChat, blocked, hint };

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
        onKey(key, shift) {
          const { hint: active, blocked: isBlocked } = live.current;
          if (isBlocked?.(key)) return;
          if (active) {
            if (key === "Escape") return setHint(null);
            if (key.length !== 1) return;
            const typed = active.typed + key.toLowerCase();
            const match = matchHint(active.labels, typed);
            if (match.kind === "partial") return setHint({ ...active, typed });
            setHint(null);
            if (match.kind === "hit") active.targets[match.index]!.element.click();
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
                    {thread.title}
                    {thread.id === currentMainId ? <small> · Main now</small> : null}
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
  threads,
  onChooseMain,
}: {
  overview: Overview;
  main: Line;
  now: number;
  truncated: boolean;
  parks: Parks;
  threads: readonly ThreadFacts[];
  onChooseMain: () => void;
}) {
  const sdk = useSdk();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sayRef = useRef<HTMLInputElement | null>(null);
  const order = useMemo(() => cursorOrder(overview), [overview]);
  const titles = useMemo(() => {
    const map = new Map<string, string>([[main.thread.id, main.thread.title]]);
    for (const line of listed(overview)) map.set(line.thread.id, line.thread.title);
    return map;
  }, [overview, main]);

  // The cursor is a thread id, so live updates never move it. If its line
  // leaves the page, it lands on the line that took its place: the next one
  // down. The verbs that move a line say where the cursor goes themselves.
  const [cursor, setCursor] = useState<string | null>(null);
  const lastIndex = useRef(0);
  // The heading is not in the line order, but the queue can put the cursor on it.
  const onMain = cursor === main.thread.id;
  const cursorIndex = cursor === null ? -1 : order.indexOf(cursor);
  const selected =
    onMain || cursorIndex >= 0
      ? cursor
      : (order[Math.min(lastIndex.current, order.length - 1)] ?? null);
  useEffect(() => {
    if (selected !== null && !onMain) lastIndex.current = order.indexOf(selected);
  }, [selected, onMain, order]);

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

  /** Open a thread's chat in the pane; a second time, put the caret in it. */
  const openChat = useCallback(
    (id: string | null) => {
      if (id === null) return;
      if (pane === id) {
        chatMayFocus.current = true;
        rootRef.current?.querySelector<HTMLElement>("[data-cow-chat]")?.focus({ preventScroll: true });
        setFocusRequest((value) => value + 1);
        return;
      }
      setPane(id);
      setMessage("");
    },
    [pane],
  );

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
  const verbs = useVerbs({
    sdk,
    overview,
    main,
    selected: selectedLine,
    parks,
    under: (id) => descendantIds(threads, id),
    setCursor,
    say: setMessage,
    openChat,
    focusOverview,
  });

  const run = (command: Command) => {
    // Nothing is above the heading.
    if (onMain && command.kind === "move" && command.by < 0) return;
    if (moveInList({ order, cursor: selected, setCursor }, command)) return;
    switch (command.kind) {
      case "open":
        return openChat(selected);
      case "main-chat":
        return openChat(main.thread.id);
      case "back":
        if (pane !== null) closePane();
        else setMessage("");
        return;
      case "say":
        return startSay(command.to === "main" ? main.thread.id : selected);
      case "ask": {
        const count = overview.queue.length;
        const at = overview.queue.findIndex((line) => line.thread.id === selected);
        if (at < 0) return toAsk(command.by > 0 ? 0 : count - 1);
        return toAsk((at + command.by + count) % count);
      }
      case "ask-number":
        return toAsk(command.number - 1);
      case "verb":
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
            verbs.onKey?.(key);
            return true;
          }
        : sayTo !== null
          ? () => {
              // Focus was taken from the say input: give it back.
              sayRef.current?.focus();
              return true;
            }
          : null,
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    root?.querySelector(".cow-main .cow-cur")?.scrollIntoView({ block: "nearest" });
    root?.querySelector(".cow-queue .cow-cur")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const listedCount = listed(overview).length;
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
  const card = (id: string) => (verbs.card?.threadId === id ? verbs.card.node : null);
  const row = (line: Line, flat: boolean) => (
    <Fragment key={line.thread.id}>
      <LineRow
        line={line}
        now={now}
        flat={flat}
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

  return (
    <div
      className={pane === null ? "cow" : "cow cow-with-pane"}
      data-cow-root=""
      data-cow-screen="overview"
      data-cow-mode={
        hint ? "hint" : sayTo !== null ? "say" : help ? "help" : (verbs.mode?.toLowerCase() ?? "normal")
      }
      tabIndex={-1}
      ref={rootRef}
    >
      <div className="cow-app">
        <header className="cow-head">
          <div
            className={onMain ? "cow-mainline cow-cur" : "cow-mainline"}
            data-cow-line={main.thread.id}
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
            <span className="cow-maindoing">{main.derived.doing}</span>
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
            {listedCount === 0 ? (
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
                {overview.lines.map((line) => row(line, false))}
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
                  overview.parked.map((line) => row(line, true))
                )}
                <div className="cow-sec">
                  Done
                  <span>
                    {overview.done.length} finished in the last 2 days with nothing open under them
                    {overview.olderDone > 0 ? ` · ${overview.olderDone} older, not listed` : ""}
                  </span>
                </div>
                {overview.done.map((line) => row(line, true))}
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
                Questions, failures, Main's unread replies and parked work that came back, oldest first.
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
                    <b>{STATE_LABEL[entry.state]}</b>
                    <span className="cow-n">{overview.counts[entry.state]}</span>
                    <span>{entry.short}</span>
                  </div>
                ))}
              </div>
            </aside>
          ) : (
            <aside className="cow-pane" data-cow-pane={pane}>
              <div className="cow-panehead">
                <b>{paneTitle}</b>
                <span>
                  <kbd>⏎</kbd> type here · <kbd>Esc</kbd> back
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
          ) : (
            <>
              <span className={hint ? "cow-mode cow-m-hint" : "cow-mode"}>{hint ? "HINT" : "NORMAL"}</span>
              <span className="cow-noun">{selectedLine?.thread.title ?? ""}</span>
              <span className="cow-sep">▸</span>
              <span className="cow-verbs">
                <Verb keys="⏎" label="open chat" off={selected === null} onRun={() => openChat(selected)} />
                <Verb keys="I" label="say to it" off={selected === null} onRun={() => startSay(selected)} />
                {(["answer", "park", "resume", "stop", "archive"] as const).map(verbButton)}
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
                <Verb keys="i" label="say to Main" onRun={() => startSay(main.thread.id)} />
                <Verb keys="m" label="Main's chat" onRun={() => openChat(main.thread.id)} />
                <Verb keys="⇥" label="next ask" off={overview.queue.length === 0} onRun={() => run({ kind: "ask", by: 1 })} />
                <Verb keys="f" label="hints" onRun={startHints} />
                <Verb keys="?" label="legend" onRun={() => setHelp(true)} />
              </span>
            </>
          )}
        </footer>
      </div>
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
  const mains = useMainState();
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

  // bb names a project when the page is opened inside one; otherwise the
  // page shows the project whose Main was chosen last.
  const scopedProjectId = pinnedProjectId() ?? context.projectId;
  const projectId = scopedProjectId ?? mains.state?.currentProjectId ?? null;
  const storedMainId = projectId === null ? null : (mains.state?.mains[projectId] ?? null);
  // An archived or deleted Main is gone as far as the user is concerned.
  const mainGone =
    storedMainId !== null &&
    !snapshot.threads.some((thread) => thread.id === storedMainId && thread.archivedAt === null);
  const mainId = mainGone ? null : storedMainId;

  const underMain = useMemo(
    () => (mainId === null || snapshot.status !== "ready" ? null : descendantIds(snapshot.threads, mainId)),
    [snapshot.threads, snapshot.status, mainId],
  );
  const parks = useParks(underMain);
  const notes = parks.notes;

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
              ),
            now,
          ),
    [snapshot, mainId, notes, now],
  );

  useEffect(() => {
    if (!overview?.main) return store.watch([]);
    // When a thread with a parent finished shows only in its event log, so
    // every thread that is not archived is watched, listed or not.
    store.watch([overview.main.thread.id, ...overview.unarchived, ...cursorOrder(overview)]);
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
  if (snapshot.status === "loading" || mains.state === null || loadingNotes) {
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
          void mains.choose(thread).then(() => setPicking(false), () => mains.load());
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
      threads={snapshot.threads}
      onChooseMain={() => setPicking(true)}
    />
  );
}
