// The reader: a file, read-only, as a sheet over the whole page. It is
// cow's own, so every key in it is cow's: movement in the manner of vim, a
// search, hints on its links, and `q` to go back. Files opened from inside
// it stack, and `q` returns through them to the page as it was.
//
// bb's own components draw the file (source with highlighting, Markdown, a
// diff); the reader owns the scrolling, the cursor line and the marks, which
// it lays over whatever was drawn.

import { type ReactNode, type RefObject, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown, experimental_Diff as Diff, experimental_SourceCode as SourceCode, experimental_copyToClipboard as copyToClipboard, type useSdk } from "@get-bb/plugin-sdk/app";
import { FileSource, type Loaded, type OpenTarget } from "./files.ts";
import { PLAIN_ABOVE, fileKind, formatSize, textLines } from "./kind.ts";
import { type FileRef, type LineRange, ROOT_LABEL, copyText, parseDocLink } from "./link.ts";
import { type Motion, ReaderKeys, moveCursor, scrollToShow } from "./move.ts";
import { type Box, type Row, collectRows, matchBoxes, rowBox, rowLineNumber } from "./rows.ts";
import { findMatches, firstMatch, stepMatch } from "./search.ts";

type Sdk = ReturnType<typeof useSdk>;

/** How often an open file is read again to see whether it changed. */
const POLL_MS = 4000;
const POLL_IMAGE_MS = 15_000;
/** Matches drawn at once, nearest the cursor first. */
const DRAWN_MATCHES = 400;

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface ReaderHost {
  sdk: Sdk;
  /** The title of a thread on the page. */
  titleOf: (threadId: string) => string;
  /** Put hints on what the reader shows. */
  startHints: () => void;
  /** The reader closed: the keyboard goes back to the page. */
  onClose: () => void;
  /** Show the same file in bb's own panel instead. */
  openInPanel: (file: FileRef, line: number | null) => boolean;
}

export interface ReaderControl {
  /** How many files are open, one over another. */
  depth: number;
  /** "search" while the search field is open. */
  mode: "read" | "search" | null;
  /** Show a file over whatever is showing. */
  open: (target: OpenTarget) => void;
  /** A link inside the file that is showing was used. False when it is not a link to a file. */
  openLink: (href: string) => boolean;
  /** Every key while the reader is open; null when it is closed. */
  onKey: ((key: string, ctrl: boolean) => void) | null;
  node: ReactNode;
}

/** What is remembered of a file while another is open over it. */
interface View {
  cursor: number;
  scrollTop: number;
  raw: boolean | null;
  split: boolean;
  query: string;
}

interface Entry {
  id: number;
  target: OpenTarget;
  view: View | null;
}

interface SheetHandle {
  key: (key: string, ctrl: boolean) => void;
  view: () => View;
  docLink: (href: string) => OpenTarget | null;
}

type Mode = "loading" | "error" | "source" | "plain" | "markdown" | "diff" | "image" | "binary";

interface Marks {
  cursor: Box | null;
  marked: Box[];
  matches: Box[];
  current: Box[];
}

const NO_MARKS: Marks = { cursor: null, marked: [], matches: [], current: [] };

function Sheet({
  entry,
  depth,
  source,
  host,
  handle,
  onClose,
  onMode,
}: {
  entry: Entry;
  depth: number;
  source: FileSource;
  host: ReaderHost;
  handle: RefObject<SheetHandle | null>;
  onClose: () => void;
  onMode: (searching: boolean) => void;
}) {
  const { target } = entry;
  const lines: LineRange | null = target.kind === "change" || target.kind === "text" ? null : target.lines;
  const [file, setFile] = useState<FileRef | null>(null);
  const [load, setLoad] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [raw, setRaw] = useState<boolean | null>(entry.view?.raw ?? null);
  const [split, setSplit] = useState(entry.view?.split ?? false);
  const [cursor, setCursor] = useState(entry.view?.cursor ?? 0);
  const [query, setQuery] = useState(entry.view?.query ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const [matchAt, setMatchAt] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState("");
  const [typed, setTyped] = useState("");
  const [version, setVersion] = useState(0);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rows = useRef<Row[]>([]);
  const keys = useRef(new ReaderKeys());
  /** The cursor and scroll position are set once, when the first rows are drawn. */
  const placed = useRef(false);
  /** After a motion: how the window follows the cursor. */
  /** Where the window was when the file changed on disk: put back once the new text is drawn. */
  const keepScroll = useRef<number | null>(null);
  const follow = useRef<{ from: number; to: number; carry: boolean; centre: boolean } | null>(null);

  // ---- reading ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const placedFile = await source.place(target);
      if (cancelled) return;
      setFile(placedFile);
      // Text cow holds is shown as it is: there is no file to read, or to read again.
      if (target.kind === "text") return setLoad({ type: "text", content: target.content, sha: "", size: target.content.length, cut: false });
      if (target.kind === "change") {
        const change = await source.change(target.threadId, target.rowId, placedFile.relPath).catch(() => null);
        if (cancelled) return;
        if (change) return setLoad(change);
        setNote("that change is no longer in the timeline cow can read: this is the file as it is now");
      }
      const loaded = await source.read(placedFile);
      if (!cancelled) setLoad(loaded);
    })().catch((cause: unknown) => {
      if (!cancelled) setError(errorText(cause));
    });
    return () => {
      cancelled = true;
    };
    // One entry shows one target for as long as it lives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The file as it is on disk now: read again while it is open, and shown when it differs.
  const sha = load && load.type !== "diff" && target.kind !== "text" ? load.sha : null;
  const pollMs = load?.type === "image" || load?.type === "binary" ? POLL_IMAGE_MS : POLL_MS;
  useEffect(() => {
    if (file === null || sha === null) return;
    let reading = false;
    const timer = setInterval(() => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      source
        .read(file)
        .then(
          (next) => {
            if (next.type === "diff" || next.sha === sha) return;
            // What is drawn is drawn again; the window stays where it was.
            keepScroll.current = scrollRef.current?.scrollTop ?? null;
            setLoad(next);
            setChanged(true);
          },
          // A file that cannot be read for a moment keeps what is showing.
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    }, pollMs);
    return () => clearInterval(timer);
  }, [file, sha, pollMs, source]);

  // ---- what is drawn ------------------------------------------------------

  const kind = file ? fileKind(file.absPath) : "source";
  const text = load?.type === "text" ? load.content : null;
  const lineCount = useMemo(() => (text === null ? 0 : textLines(text).length), [text]);
  // A link to lines of a Markdown file wants the lines, so it opens raw.
  const isRaw = raw ?? lines !== null;
  const mode: Mode = error
    ? "error"
    : load === null
      ? "loading"
      : load.type === "diff"
        ? "diff"
        : load.type === "image"
          ? "image"
          : load.type === "binary"
            ? "binary"
            : kind === "markdown" && !isRaw
              ? "markdown"
              : lineCount > PLAIN_ABOVE.lines || load.content.length > PLAIN_ABOVE.chars || target.kind === "text"
                ? "plain"
                : "source";
  const lineBased = mode === "source" || mode === "plain";
  const marked = lineBased ? lines : null;

  // Rows are read from what was drawn; bb's viewers draw a moment after they are given the text.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let last = -1;
    const collect = () => {
      const found = collectRows(content);
      rows.current = found;
      const scroller = scrollRef.current;
      if (keepScroll.current !== null && found.length > 0 && scroller && mode !== "loading") {
        scroller.scrollTop = keepScroll.current;
        if (scroller.scrollHeight - scroller.clientHeight >= keepScroll.current) keepScroll.current = null;
      }
      const height = Math.round(content.getBoundingClientRect().height);
      // A new count, or a new height, is a new layout to mark.
      const stamp = found.length * 1_000_003 + height;
      if (stamp !== last) {
        last = stamp;
        setVersion((value) => value + 1);
      }
    };
    collect();
    const observer = new ResizeObserver(collect);
    observer.observe(content);
    const timers = [60, 200, 500, 1000, 2000].map((ms) => setTimeout(collect, ms));
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [mode, text, split, load]);

  const total = rows.current.length;
  const at = Math.max(0, Math.min(total - 1, cursor));

  // The first rows of a file: go to the lines asked for, or back to where it was left.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (placed.current || total === 0 || !scroller || mode === "loading" || mode === "error") return;
    placed.current = true;
    if (entry.view) {
      scroller.scrollTop = entry.view.scrollTop;
      return;
    }
    if (marked) {
      const to = Math.min(total - 1, marked.start - 1);
      follow.current = { from: 0, to, carry: false, centre: true };
      setCursor(to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // ---- searching ----------------------------------------------------------

  const active = draft ?? query;
  const found = useMemo(
    () => findMatches(rows.current.map((row) => row.text), active),
    // The rows are read from the page; `version` says when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, version],
  );
  const current = matchAt !== null && found.matches[matchAt] ? matchAt : null;

  useEffect(() => {
    if (draft !== null) searchRef.current?.focus();
    onMode(draft !== null);
  }, [draft !== null]);

  const toMatch = (index: number | null) => {
    setMatchAt(index);
    const match = index === null ? null : found.matches[index];
    if (!match) return;
    follow.current = { from: at, to: match.line, carry: false, centre: true };
    setCursor(match.line);
  };

  // ---- the marks: cursor line, lines asked for, matches --------------------

  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    let origin = content.getBoundingClientRect();
    const all = rows.current;
    const row = all[at];
    const box = row ? rowBox(row, origin) : null;
    // The window follows the cursor.
    // A motion is followed once its line is the cursor's.
    const moved = follow.current?.to === at ? follow.current : null;
    if (moved) follow.current = null;
    if (box && moved) {
      const before = all[moved.from];
      const beforeBox = before ? rowBox(before, origin) : null;
      if (moved.carry && beforeBox) scroller.scrollTop += box.top - beforeBox.top;
      const view = scroller.clientHeight;
      scroller.scrollTop += scrollToShow(box.top, box.height, scroller.scrollTop, view, moved.centre ? view / 3 : Math.min(40, view / 4));
    }
    // Scrolling moved what the boxes below are measured from.
    origin = content.getBoundingClientRect();
    const markedBoxes: Box[] = [];
    if (marked) {
      for (let line = marked.start; line <= Math.min(marked.end, all.length); line += 1) {
        const lineBox = rowBox(all[line - 1]!, origin);
        if (lineBox) markedBoxes.push(lineBox);
      }
    }
    // Matches near the cursor are drawn; far ones are drawn when the cursor gets there.
    const near = found.matches.findIndex((match) => match.line >= at);
    const centre = near < 0 ? found.matches.length : near;
    const from = Math.max(0, centre - DRAWN_MATCHES / 2);
    const matches: Box[] = [];
    const currentBoxes: Box[] = [];
    found.matches.slice(from, from + DRAWN_MATCHES).forEach((match, offset) => {
      const matchRow = all[match.line];
      if (!matchRow) return;
      const boxes = matchBoxes(matchRow, match, origin);
      if (from + offset === current) currentBoxes.push(...boxes);
      else matches.push(...boxes);
    });
    setMarks({ cursor: box, marked: markedBoxes, matches, current: currentBoxes });
  }, [version, at, found, current, marked]);

  // ---- keys ---------------------------------------------------------------

  const move = (motion: Motion) => {
    const scroller = scrollRef.current;
    const all = rows.current;
    if (!scroller || all.length === 0) return;
    const origin = contentRef.current!.getBoundingClientRect();
    const height = rowBox(all[at]!, origin)?.height || 18;
    const page = Math.max(2, Math.floor(scroller.clientHeight / Math.max(12, height)));
    // Blocks are told apart by blank lines, which only a file's own lines have.
    const blank = lineBased ? all.map((row) => row.text.trim() === "") : undefined;
    const next = moveCursor(at, motion, all.length, page, blank);
    follow.current = { from: at, to: next, carry: motion.kind === "half" || motion.kind === "page", centre: motion.kind === "goto" || motion.kind === "block" };
    if (next === at) {
      // At an end already: the window still goes all the way.
      if (motion.kind === "top" || (next === 0 && (motion.kind === "half" || motion.kind === "page"))) scroller.scrollTop = 0;
      if (motion.kind === "bottom" || (next === all.length - 1 && (motion.kind === "half" || motion.kind === "page"))) scroller.scrollTop = scroller.scrollHeight;
      follow.current = null;
      return;
    }
    setCursor(next);
  };

  /** The file's line under the cursor, when what is drawn has lines. */
  const cursorLine = (): number | null => {
    if (lineBased) return at + 1;
    const row = rows.current[at];
    return mode === "diff" && row ? rowLineNumber(row) : null;
  };

  const onKey = (key: string, ctrl: boolean) => {
    if (draft !== null) {
      // Focus was taken from the search field: give it back.
      searchRef.current?.focus();
      return;
    }
    const read = keys.current.read(key, ctrl, Date.now());
    setTyped(keys.current.typed);
    if (read.kind === "pending" || read.kind === "none") return;
    setNote("");
    switch (read.kind) {
      case "motion":
        return move(read.motion);
      case "search":
        return setDraft("");
      case "match": {
        if (query === "") return setNote("nothing has been searched for: / searches");
        const step = stepMatch(found.matches, at, read.by, current);
        if (!step) return setNote(`no match for “${query}”`);
        if (step.wrapped) setNote(read.by > 0 ? "search went past the end, and continues at the top" : "search went past the top, and continues at the end");
        return toMatch(step.index);
      }
      case "hints":
        return host.startHints();
      case "raw":
        if (load?.type !== "text" || kind !== "markdown") return setNote("r switches a Markdown file between rendered and raw");
        placed.current = true;
        setRaw(!isRaw);
        setCursor(0);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        return;
      case "split":
        if (mode !== "diff") return setNote("u switches a diff between unified and split");
        return setSplit((value) => !value);
      case "copy": {
        if (!file) return;
        const line = read.withLine ? cursorLine() : null;
        if (read.withLine && line === null) return setNote("this view has no line numbers: y copies the path alone");
        const value = copyText(file, line);
        setCopied(value);
        void copyToClipboard({ text: value }).then(
          (ok) => setNote(ok ? `copied: ${value}` : `could not copy: ${value}`),
          () => setNote(`could not copy: ${value}`),
        );
        return;
      }
      case "panel":
        if (!file) return;
        if (target.kind === "text") return setNote("this is not a file: there is nothing to open in bb's panel");
        if (!host.openInPanel(file, cursorLine())) setNote("bb did not open it in its panel");
        return;
      case "close":
        return onClose();
    }
  };

  const view = (): View => ({ cursor: at, scrollTop: scrollRef.current?.scrollTop ?? 0, raw, split, query });
  const docLink = (href: string): OpenTarget | null => {
    if (!file) return null;
    const link = parseDocLink(href, file.absPath);
    return link ? { kind: "path", threadId: file.threadId ?? target.threadId, path: link.path, lines: link.lines } : null;
  };
  useImperativeHandle(handle, () => ({ key: onKey, view, docLink }));

  const endSearch = (keep: boolean) => {
    const value = draft ?? "";
    setDraft(null);
    scrollRef.current?.closest<HTMLElement>("[data-cow-root]")?.focus({ preventScroll: true });
    if (!keep) return setNote("");
    setQuery(value);
    if (value === "") return setMatchAt(null);
    const first = firstMatch(found.matches, at);
    if (first === null) {
      setMatchAt(null);
      return setNote(`no match for “${value}”`);
    }
    toMatch(first);
  };

  // ---- drawing ------------------------------------------------------------

  const threadId = file?.threadId ?? target.threadId;
  const shownPath = file ? file.relPath : target.kind === "rooted" ? target.relPath : target.kind === "text" ? target.title : target.path;
  let body: ReactNode;
  if (mode === "error") {
    body = (
      <p className="cow-rd-msg cow-err" data-cow-rd-row="">
        cow could not read this file: {error}
      </p>
    );
  } else if (mode === "loading" || load === null) {
    body = (
      <p className="cow-rd-msg" data-cow-rd-row="">
        Reading…
      </p>
    );
  } else if (load.type === "diff") {
    body = <Diff patch={load.patch.text} path={shownPath} view={split ? "split" : "unified"} overflow="wrap" />;
  } else if (load.type === "image") {
    body = (
      <p className="cow-rd-image">
        <img src={load.url} alt={shownPath} data-cow-rd-image="" />
      </p>
    );
  } else if (load.type === "binary") {
    body = (
      <p className="cow-rd-msg" data-cow-rd-row="">
        This is not a text file ({formatSize(load.size)}), and cow reads only text and images. <kbd>o</kbd> opens it in bb's own panel; <kbd>y</kbd> copies its
        path.
      </p>
    );
  } else if (mode === "markdown") {
    body = <Markdown content={load.content} className="cow-rd-md" />;
  } else if (mode === "plain") {
    body = (
      <pre className="cow-rd-plain">
        {textLines(load.content).map((line, index) => (
          <div key={index} data-cow-rd-line={index + 1}>
            <i>{index + 1}</i>
            <span>{line === "" ? "\n" : line}</span>
          </div>
        ))}
      </pre>
    );
  } else {
    // bb's viewer keeps what it drew for a path; a new key makes it draw the file as it is now.
    body = <SourceCode key={load.sha} content={load.content} path={shownPath} overflow="wrap" />;
  }

  const shown = mode === "markdown" ? "rendered" : mode === "source" && kind === "markdown" ? "raw" : mode;
  const unit = lineBased ? "line" : mode === "diff" ? "row" : "block";
  const percent = total <= 1 ? 100 : Math.round((at / (total - 1)) * 100);
  const band = (box: Box, className: string, key: string | number) => <i key={key} className={className} style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />;

  return (
    <div
      className="cow-sheet cow-rd"
      data-cow-reader={shownPath}
      data-cow-reader-root={file?.root}
      data-cow-reader-kind={shown}
      data-cow-reader-line={total === 0 ? undefined : at + 1}
      data-cow-reader-lines={total}
      data-cow-reader-depth={depth}
      data-cow-reader-marked={marked ? `${marked.start}-${marked.end}` : undefined}
      data-cow-reader-query={query || undefined}
      data-cow-reader-matches={active === "" ? undefined : found.matches.length}
      data-cow-reader-match={current === null ? undefined : current + 1}
      data-cow-reader-changed={changed || undefined}
      data-cow-reader-copied={copied || undefined}
      data-cow-reader-view={mode === "diff" ? (split ? "split" : "unified") : undefined}
      data-cow-reader-searching={draft !== null || undefined}
      role="dialog"
      aria-label={`file ${shownPath}`}
    >
      <div className="cow-sheet-head cow-rd-head">
        <b data-cow-reader-path="">{shownPath}</b>
        {file ? <span data-cow-reader-rootname="">{ROOT_LABEL[file.root]}</span> : null}
        {threadId ? <span data-cow-reader-thread="">of {host.titleOf(threadId)}</span> : null}
        {load && load.type !== "diff" ? <span>{formatSize(load.size)}</span> : null}
        {load?.type === "text" ? (
          <span>
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>
        ) : null}
        {load?.type === "diff" ? (
          <span data-cow-reader-sides="">
            {load.change} · {load.patch.before} → {load.patch.after} · <span className="cow-rd-add">+{load.patch.added}</span>{" "}
            <span className="cow-rd-del">−{load.patch.removed}</span>
          </span>
        ) : null}
        {kind === "markdown" && load?.type === "text" ? <span>{isRaw ? "raw" : "rendered"}</span> : null}
        {mode === "plain" ? <span>plain text: too long to highlight</span> : null}
        {load?.type === "text" && load.cut ? <span className="cow-err">only its start is shown: it is too long</span> : null}
        {changed ? (
          <span className="cow-rd-changed" title="the file changed on disk while it was open; this is how it is now">
            changed
          </span>
        ) : null}
        {depth > 1 ? <span className="cow-sheet-what">{depth} files open · q goes back one</span> : null}
      </div>
      <div className="cow-rd-scroll" data-cow-scroll="" data-cow-reader-scroll="" ref={scrollRef}>
        <div className={`cow-rd-content cow-rd-${mode}`} ref={contentRef}>
          {body}
          <div className="cow-rd-layer" data-cow-rd-layer="" aria-hidden="true">
            {marks.marked.map((box, index) => band(box, "cow-rd-marked", `m${index}`))}
            {marks.cursor ? band(marks.cursor, "cow-rd-cursor", "cursor") : null}
            {marks.matches.map((box, index) => band(box, "cow-rd-match", `f${index}`))}
            {marks.current.map((box, index) => band(box, "cow-rd-match cow-rd-current", `c${index}`))}
          </div>
        </div>
      </div>
      <div className="cow-sheet-foot cow-rd-foot">
        <span className="cow-mode">{draft !== null ? "SEARCH" : "READ"}</span>
        <span data-cow-reader-position="">
          {total === 0 ? "nothing to move over" : `${unit} ${at + 1} of ${total} · ${percent}%`}
          {typed ? <b> · {typed}</b> : null}
        </span>
        {draft !== null ? (
          <span className="cow-prompt">
            <label htmlFor="cow-reader-search">/</label>
            <input
              id="cow-reader-search"
              ref={searchRef}
              data-cow-reader-search=""
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                endSearch(event.key === "Enter");
              }}
            />
            <small>
              {found.matches.length}
              {found.more ? "+" : ""} {found.matches.length === 1 ? "match" : "matches"} · <kbd>⏎</kbd> go · <kbd>Esc</kbd> cancel
            </small>
          </span>
        ) : query ? (
          <span data-cow-reader-search-state="">
            /{query} · {found.matches.length === 0 ? "no match" : `${current === null ? "–" : current + 1} of ${found.matches.length}${found.more ? "+" : ""}`} · <kbd>n</kbd>{" "}
            <kbd>N</kbd>
          </span>
        ) : null}
        {note ? (
          <span data-cow-reader-note="">{note}</span>
        ) : draft === null ? (
          <span className="cow-rd-help">
            <kbd>j</kbd> <kbd>k</kbd> · <kbd>^d</kbd> <kbd>^u</kbd> · <kbd>^f</kbd> <kbd>^b</kbd> · <kbd>gg</kbd> <kbd>G</kbd> <kbd>12G</kbd> · <kbd>{"{"}</kbd>{" "}
            <kbd>{"}"}</kbd> · <kbd>/</kbd> search · <kbd>f</kbd> hints · {kind === "markdown" ? (<><kbd>r</kbd> raw · </>) : null}
            {mode === "diff" ? (<><kbd>u</kbd> split · </>) : null}
            <kbd>y</kbd> <kbd>Y</kbd> copy path · <kbd>o</kbd> bb's panel · <kbd>q</kbd> back
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The reader's stack of open files and its keys. The page draws `node` over itself while a file is open. */
export function useReader(host: ReaderHost): ReaderControl {
  const [stack, setStack] = useState<readonly Entry[]>([]);
  const [searching, setSearching] = useState(false);
  const source = useMemo(() => new FileSource(host.sdk), [host.sdk]);
  const handle = useRef<SheetHandle | null>(null);
  const nextId = useRef(1);
  const live = useRef(host);
  live.current = host;

  const open = useCallback((target: OpenTarget) => {
    // The file underneath keeps its place for when this one is closed.
    const view = handle.current?.view() ?? null;
    const entry: Entry = { id: nextId.current++, target, view: null };
    setStack((current) => {
      const under = current.length > 0 && view ? [...current.slice(0, -1), { ...current[current.length - 1]!, view }] : current;
      return [...under, entry];
    });
  }, []);

  const close = useCallback(() => setStack((current) => current.slice(0, -1)), []);

  const top = stack[stack.length - 1] ?? null;
  // The last file closed: the keyboard goes back to the page.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (top === null) {
      setSearching(false);
      if (wasOpen.current) live.current.onClose();
    }
    wasOpen.current = top !== null;
  }, [top]);

  const sheetHost = useMemo<ReaderHost>(
    () => ({
      sdk: host.sdk,
      titleOf: (id) => live.current.titleOf(id),
      startHints: () => live.current.startHints(),
      onClose: () => live.current.onClose(),
      openInPanel: (file, line) => {
        const opened = live.current.openInPanel(file, line);
        // bb's view takes its place: the reader steps aside entirely.
        if (opened) setStack([]);
        return opened;
      },
    }),
    [host.sdk],
  );

  return {
    depth: stack.length,
    mode: top === null ? null : searching ? "search" : "read",
    open,
    openLink: (href) => {
      const target = handle.current?.docLink(href) ?? null;
      if (target) open(target);
      return target !== null;
    },
    onKey: top === null ? null : (key, ctrl) => handle.current?.key(key, ctrl),
    node: top ? <Sheet key={top.id} entry={top} depth={stack.length} source={source} host={sheetHost} handle={handle} onClose={close} onMode={setSearching} /> : null,
  };
}
