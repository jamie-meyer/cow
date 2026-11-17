// What a click on cow's page points at when it points at a file: a file
// link in a chat, a file row in a chat's timeline, a file tab bb opened, or
// a link inside a file the reader is showing. Pure, so the rules can be
// tested: the reader's trigger reads the page and asks here.
//
// How bb marks these, established against bb 0.49:
// - a Markdown link to a local file is an anchor whose `href` is a `file://`
//   URL of the absolute path, with `#L12` or `#L12-L20` for lines;
// - a file change in a timeline is inside an element whose
//   `data-timeline-row-id` is `<thread>:file-edit:<call>:<absolute path>:file-change:<n>`;
// - a file tab is a panel tab whose detail is `{ kind: "file", path }`, or,
//   when a plugin's file opener took it, `{ kind: "plugin", tab.id:
//   "file-opener:…", params: { path, source } }`.

/** One-based, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** A place in a file: its absolute path, and the lines asked for. */
export interface PathRef {
  path: string;
  lines: LineRange | null;
}

function lineNumber(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function range(start: string | undefined, end: string | undefined): LineRange | null {
  const from = lineNumber(start);
  if (from === null) return null;
  const to = end === undefined ? from : lineNumber(end);
  if (to === null) return null;
  return { start: Math.min(from, to), end: Math.max(from, to) };
}

/**
 * Split the lines off the end of a path, in the forms bb reads: `#L12`,
 * `#L12-L20`, `#L12C3-L20C1`, `:12`, `:12:3` and `:12-20`. A path with
 * nothing of the kind is returned whole.
 */
export function splitLines(text: string): PathRef {
  const hash = /#L([0-9]+)(?:C[0-9]+)?(?:-L?([0-9]+)(?:C[0-9]+)?)?$/.exec(text);
  if (hash) {
    const lines = range(hash[1], hash[2]);
    return { path: text.slice(0, hash.index), lines };
  }
  const span = /:([0-9]+)-([0-9]+)$/.exec(text);
  if (span) {
    const lines = range(span[1], span[2]);
    if (lines) return { path: text.slice(0, span.index), lines };
  }
  const point = /:([0-9]+)(?::[0-9]+)?$/.exec(text);
  if (point) {
    const lines = range(point[1], undefined);
    if (lines) return { path: text.slice(0, point.index), lines };
  }
  return { path: text, lines: null };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve `.` and `..`, and repeated slashes, in an absolute path. Null when it climbs above the root. */
export function normalise(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The file a `file://` href names, or null when the href is anything else. */
export function parseFileHref(href: string): PathRef | null {
  if (!/^file:\/\/\//i.test(href)) return null;
  const rest = href.slice("file://".length);
  const at = rest.indexOf("#");
  const path = normalise(decode(at < 0 ? rest : rest.slice(0, at)));
  if (path === null || path === "/") return null;
  const { lines } = at < 0 ? { lines: null } : splitLines(rest.slice(at));
  return { path, lines };
}

/**
 * The file a link inside a document names: a `file://` href, an absolute
 * path, or a path relative to the folder of the document it is in. Null for
 * a web address, a fragment, or anything else that is not a file.
 */
export function parseDocLink(href: string, documentPath: string): PathRef | null {
  const text = href.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("?") || text.startsWith("//")) return null;
  if (/^file:/i.test(text)) return parseFileHref(text);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return null;
  const { path: raw, lines } = splitLines(decode(text));
  if (raw === "" || raw.startsWith("~") || raw.endsWith("/")) return null;
  const folder = documentPath.slice(0, documentPath.lastIndexOf("/") + 1);
  const path = normalise(raw.startsWith("/") ? raw : `${folder}${raw}`);
  if (path === null || path === "/" || path.endsWith("/")) return null;
  return { path, lines };
}

/** A file change in a thread's timeline, as its row's id names it. */
export interface TimelineFile {
  threadId: string;
  /** The tool call that made the change. */
  callId: string;
  /** The file's absolute path. */
  path: string;
  /** The row's whole id: how to find the change in the thread's timeline. */
  rowId: string;
}

/** Read a timeline row's id; null unless it is a file change. */
export function parseTimelineRow(rowId: string): TimelineFile | null {
  const found = /^([A-Za-z0-9_-]+):file-edit:([^:]+):(\/.*):file-change:[0-9]+$/.exec(rowId);
  if (!found) return null;
  const path = normalise(found[3]!);
  if (path === null || path === "/") return null;
  return { threadId: found[1]!, callId: found[2]!, path, rowId };
}

/** Where a file is kept: what its path is relative to, and who reads it. */
export type RootKind = "workspace" | "storage" | "host";

/** The places a thread's files can be. Any may be unknown. */
export interface Roots {
  hostId: string | null;
  workspace: { environmentId: string; rootPath: string } | null;
  storage: { threadId: string; rootPath: string } | null;
}

/** A file the reader can read: where it is, and the thread it was opened from. */
export interface FileRef {
  root: RootKind;
  /** The root's absolute path; null for a host file. */
  rootPath: string | null;
  /** The path under its root; for a host file, the absolute path again. */
  relPath: string;
  absPath: string;
  hostId: string | null;
  environmentId: string | null;
  /** The thread it belongs to, or was opened from. */
  threadId: string | null;
}

function under(path: string, root: string): string | null {
  const base = normalise(root);
  if (base === null) return null;
  if (base === "/") return path.slice(1) || null;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/**
 * Place an absolute path: in the thread's workspace when it is under it,
 * else in the thread's storage, else on the thread's machine. The order is
 * bb's own.
 */
export function placeFile(absPath: string, roots: Roots, threadId: string | null): FileRef {
  const inWorkspace = roots.workspace ? under(absPath, roots.workspace.rootPath) : null;
  if (roots.workspace && inWorkspace !== null) {
    return { root: "workspace", rootPath: normalise(roots.workspace.rootPath), relPath: inWorkspace, absPath, hostId: roots.hostId, environmentId: roots.workspace.environmentId, threadId };
  }
  const inStorage = roots.storage ? under(absPath, roots.storage.rootPath) : null;
  if (roots.storage && inStorage !== null) {
    return { root: "storage", rootPath: normalise(roots.storage.rootPath), relPath: inStorage, absPath, hostId: roots.hostId, environmentId: null, threadId: roots.storage.threadId };
  }
  return { root: "host", rootPath: null, relPath: absPath, absPath, hostId: roots.hostId, environmentId: null, threadId };
}

/** The absolute path of a file named relative to one of a thread's roots; null when that root is unknown or the path leaves it. */
export function absoluteIn(kind: "workspace" | "storage", relPath: string, roots: Roots): string | null {
  const root = kind === "workspace" ? roots.workspace?.rootPath : roots.storage?.rootPath;
  if (!root) return null;
  const path = normalise(`${root}/${relPath}`);
  return path !== null && under(path, root) !== null ? path : null;
}

/** A file tab bb opened: the path it shows and, when bb said, where that path is. */
export interface TabFile {
  path: string;
  source: { kind: RootKind; threadId: string | null; environmentId: string | null } | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Read a panel tab's detail; null unless the tab shows a file. */
export function tabFile(detail: unknown): TabFile | null {
  const d = record(detail);
  if (!d) return null;
  if (d.kind === "file") {
    const path = text(d.path);
    return path === null ? null : { path, source: null };
  }
  if (d.kind !== "plugin") return null;
  const id = text(record(d.tab)?.id);
  const params = record(d.params);
  const path = text(params?.path);
  if (id === null || !id.startsWith("file-opener:") || path === null) return null;
  const source = record(params?.source);
  const kind = source?.kind === "workspace" ? "workspace" : source?.kind === "thread-storage" ? "storage" : source?.kind === "host" ? "host" : null;
  return { path, source: kind === null ? null : { kind, threadId: text(source?.threadId), environmentId: text(source?.environmentId) } };
}

/** The label for a root, as the reader's heading names it. */
export const ROOT_LABEL: Record<RootKind, string> = { workspace: "workspace", storage: "thread storage", host: "host" };

/** The path `y` copies, and with a line, what `Y` copies: under the workspace for a workspace file, absolute otherwise. */
export function copyText(file: Pick<FileRef, "root" | "relPath" | "absPath">, line: number | null): string {
  const path = file.root === "workspace" ? file.relPath : file.absPath;
  return line === null ? path : `${path}:${line}`;
}
