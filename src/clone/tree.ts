// cloneTree: a copy-on-write clone of a directory tree on APFS.
//
// One clonefile(2) call clones a whole directory, but while it runs every
// rename() on the volume waits for it, so a large tree is cloned in chunks:
// each subtree of at most `chunk` entries is one call, the directories above
// the chunks are recreated with their modes and times, and the files that sit
// directly in a recreated directory are cloned one by one. Excluded entries
// split chunks the same way, so nothing excluded exists in the destination
// even for a moment. Symlinks are cloned as links, never followed. Sockets,
// FIFOs and devices cannot be cloned and are left out.
//
// Cloning across volumes fails (EXDEV); it is reported and never replaced by
// a copy.
//
// The source is live: git, an editor or a build may create and delete files
// in it while it is walked and cloned (`.git/index.lock` above all). An entry
// that is gone by the time it is looked at, listed or cloned (ENOENT, or
// ENOTDIR for a directory replaced by a file) is left out, at any depth, and
// the clone goes on. Every other error, and a source that is gone altogether,
// still fails the clone.
import { execFileSync } from "node:child_process";
import { type Stats, chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneCall } from "./helper.ts";
import { DEFAULT_EXCLUDES, type Matcher, createMatcher } from "./glob.ts";

export const EXDEV = 18;
export const ENOTSUP = 45;
export const EEXIST = 17;
export const ENOENT = 2;
export const ENOTDIR = 20;

export interface CloneTreeOptions {
  /** Most entries one clonefile call may clone. */
  chunk?: number;
  /** Patterns added to the defaults (or used alone with includeSecrets). */
  exclude?: readonly string[];
  /** Drop the default list of secrets and sockets. */
  includeSecrets?: boolean;
  /** Called once for every entry that will be cloned (not for excluded ones). */
  observe?: (relative: string, stats: Stats, absolute: string) => void;
  signal?: AbortSignal;
}

export interface CloneTreeResult {
  /** Entries in the destination, the top directory included. */
  entries: number;
  /** clonefile calls that cloned a directory. */
  chunks: number;
  /** clonefile calls that cloned one file or symlink in a recreated directory. */
  files: number;
  /** Directories recreated above the chunks. */
  recreated: number;
  /** Entries left out by a pattern (a directory counts once). */
  excluded: number;
  /** Sockets, FIFOs and devices left out. */
  skipped: number;
  /** Entries that disappeared from the source between being listed and being looked at or cloned, left out. */
  vanished: number;
  /** Largest number of entries in one call. */
  largestChunk: number;
  walkMs: number;
  cloneMs: number;
  totalMs: number;
}

export class CloneError extends Error {
  readonly errno: number | null;
  constructor(message: string, errno: number | null = null) {
    super(message);
    this.errno = errno;
  }
}

interface Node {
  name: string;
  /** "/"-joined path from the source; "" for the top. */
  relative: string;
  stats: Stats;
  /** Present for directories. */
  children?: Node[];
  /** Entries in this subtree, itself included, that will be cloned. */
  count: number;
  /** True when nothing under it is excluded or skipped. */
  clean: boolean;
}

function mountOf(path: string): string {
  try {
    const out = execFileSync("/bin/df", ["-P", path], { encoding: "utf8" }).trim().split("\n");
    // Filesystem, 512-blocks, Used, Available, Capacity, then the mount point (which may hold spaces).
    return (out[out.length - 1] ?? "").split(/\s+/).slice(5).join(" ") || "(unknown volume)";
  } catch {
    return "(unknown volume)";
  }
}

/** The error for a call that failed because the two paths are not on one APFS volume. */
export function volumeError(source: string, destination: string, errno: number): CloneError {
  const why = errno === EXDEV ? "they are on different volumes" : "the volume does not support cloning (it is not APFS)";
  return new CloneError(
    `cannot clone ${source} (volume ${mountOf(source)}) to ${destination} (volume ${mountOf(dirname(destination))}): ${why}. ` +
      "Copy-on-write clones need both on the same APFS volume; nothing is copied instead.",
    errno,
  );
}

/** Refuse before starting when the source and the destination's folder are on different devices. */
export function checkSameVolume(source: string, destinationParent: string): void {
  const a = statSync(source);
  const b = statSync(destinationParent);
  if (a.dev !== b.dev) throw volumeError(source, join(destinationParent, "(clone)"), EXDEV);
}

export function errnoText(errno: number): string {
  const names: Record<number, string> = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 28: "ENOSPC", 30: "EROFS", 45: "ENOTSUP", 63: "ENAMETOOLONG" };
  return names[errno] ?? `errno ${errno}`;
}

/** True for the errors that mean an entry is no longer there: it was deleted, or a directory on its path was replaced. */
export function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** lstat, or null when the entry is gone. */
function lstatIfThere(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

function walk(source: string, matcher: Matcher, signal: AbortSignal | undefined): { root: Node; excluded: number; skipped: number; vanished: number } {
  let excluded = 0;
  let skipped = 0;
  let vanished = 0;
  /** A node, or null when the directory disappeared before it could be listed. */
  const visit = (absolute: string, relative: string, name: string, stats: Stats): Node | null => {
    const node: Node = { name, relative, stats, count: 1, clean: true };
    if (!stats.isDirectory()) return node;
    signal?.throwIfAborted();
    node.children = [];
    let names: string[];
    try {
      names = readdirSync(absolute).sort();
    } catch (error) {
      if (relative !== "" && isGone(error)) return null;
      throw error;
    }
    for (const entry of names) {
      const childAbsolute = join(absolute, entry);
      const childRelative = relative === "" ? entry : `${relative}/${entry}`;
      const childStats = lstatIfThere(childAbsolute);
      if (childStats === null) {
        vanished += 1;
        continue;
      }
      if (matcher.matches(childRelative, childStats.isDirectory())) {
        excluded += 1;
        node.clean = false;
        continue;
      }
      if (!childStats.isDirectory() && !childStats.isFile() && !childStats.isSymbolicLink()) {
        skipped += 1;
        node.clean = false;
        continue;
      }
      const child = visit(childAbsolute, childRelative, entry, childStats);
      if (child === null) {
        vanished += 1;
        continue;
      }
      node.children.push(child);
      node.count += child.count;
      if (!child.clean) node.clean = false;
    }
    return node;
  };
  const stats = lstatSync(source);
  if (!stats.isDirectory()) throw new CloneError(`${source} is not a directory`);
  return { root: visit(source, "", "", stats)!, excluded, skipped, vanished };
}

/** Clone `source` to `destination`, which must not exist yet; its folder must. */
export async function cloneTree(helper: CloneCall, source: string, destination: string, options: CloneTreeOptions = {}): Promise<CloneTreeResult> {
  const started = performance.now();
  const chunk = options.chunk ?? 5000;
  if (!Number.isInteger(chunk) || chunk < 1) throw new CloneError("chunk must be a positive whole number");
  const patterns = [...(options.includeSecrets ? [] : DEFAULT_EXCLUDES), ...(options.exclude ?? [])];
  const matcher = createMatcher(patterns);
  try {
    lstatSync(destination);
    throw new CloneError(`${destination} already exists`, EEXIST);
  } catch (error) {
    if (error instanceof CloneError) throw error;
  }
  checkSameVolume(source, dirname(destination));

  const { root, excluded, skipped, vanished } = walk(source, matcher, options.signal);
  const walked = performance.now();
  const result: CloneTreeResult = {
    entries: root.count, chunks: 0, files: 0, recreated: 0, excluded, skipped, vanished, largestChunk: 0, walkMs: walked - started, cloneMs: 0, totalMs: 0,
  };

  /** Clone one entry; false when it disappeared from the source after it was listed (it is left out). */
  const call = async (from: string, to: string, entries: number, top: boolean): Promise<boolean> => {
    options.signal?.throwIfAborted();
    const errno = await helper.clone(from, to);
    if (errno === EXDEV || errno === ENOTSUP) throw volumeError(from, to, errno);
    // ENOENT names the source or the destination's folder; cow made the folder, so it is the source only when the source is gone now.
    if (!top && (errno === ENOENT || errno === ENOTDIR) && lstatIfThere(from) === null && lstatIfThere(dirname(to)) !== null) {
      result.vanished += 1;
      return false;
    }
    if (errno !== 0) throw new CloneError(`clonefile ${from} -> ${to} failed: ${errnoText(errno)}`, errno);
    result.largestChunk = Math.max(result.largestChunk, entries);
    return true;
  };

  const observeAll = (node: Node, absolute: string) => {
    if (!options.observe) return;
    options.observe(node.relative, node.stats, absolute);
    for (const child of node.children ?? []) observeAll(child, join(absolute, child.name));
  };

  /** Place one node; the number of entries it put in the destination. */
  const place = async (node: Node, from: string, to: string): Promise<number> => {
    const top = node.relative === "";
    if (node.children === undefined) {
      if (!(await call(from, to, 1, top))) return 0;
      result.files += 1;
      return 1;
    }
    if (node.clean && node.count <= chunk) {
      if (!(await call(from, to, node.count, top))) return 0;
      result.chunks += 1;
      return node.count;
    }
    const gone = () => !top && lstatIfThere(from)?.isDirectory() !== true;
    if (gone()) {
      // The directory went away after it was listed: none of it is cloned.
      result.vanished += 1;
      return 0;
    }
    mkdirSync(to, { mode: 0o700 });
    result.recreated += 1;
    let placed = 1;
    for (const child of node.children) placed += await place(child, join(from, child.name), join(to, child.name));
    if (gone()) {
      // It went away while its entries were being cloned: what was cloned of it goes too.
      rmSync(to, { recursive: true, force: true });
      result.recreated -= 1;
      result.vanished += 1;
      return 0;
    }
    // Mode and times last: adding the children changed the times, and a
    // directory without write permission could not have taken them.
    chmodSync(to, node.stats.mode & 0o7777);
    utimesSync(to, node.stats.atime, node.stats.mtime);
    return placed;
  };

  observeAll(root, source);
  result.entries = await place(root, source, destination);
  const ended = performance.now();
  result.cloneMs = ended - walked;
  result.totalMs = ended - started;
  return result;
}
