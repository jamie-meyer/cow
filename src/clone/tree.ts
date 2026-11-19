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
import { execFileSync } from "node:child_process";
import { type Stats, chmodSync, lstatSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneCall } from "./helper.ts";
import { DEFAULT_EXCLUDES, type Matcher, createMatcher } from "./glob.ts";

export const EXDEV = 18;
export const ENOTSUP = 45;
export const EEXIST = 17;

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

function walk(source: string, matcher: Matcher, signal: AbortSignal | undefined): { root: Node; excluded: number; skipped: number } {
  let excluded = 0;
  let skipped = 0;
  const visit = (absolute: string, relative: string, name: string, stats: Stats): Node => {
    const node: Node = { name, relative, stats, count: 1, clean: true };
    if (!stats.isDirectory()) return node;
    signal?.throwIfAborted();
    node.children = [];
    for (const entry of readdirSync(absolute).sort()) {
      const childAbsolute = join(absolute, entry);
      const childRelative = relative === "" ? entry : `${relative}/${entry}`;
      const childStats = lstatSync(childAbsolute);
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
      node.children.push(child);
      node.count += child.count;
      if (!child.clean) node.clean = false;
    }
    return node;
  };
  const stats = lstatSync(source);
  if (!stats.isDirectory()) throw new CloneError(`${source} is not a directory`);
  return { root: visit(source, "", "", stats), excluded, skipped };
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

  const { root, excluded, skipped } = walk(source, matcher, options.signal);
  const walked = performance.now();
  const result: CloneTreeResult = {
    entries: root.count, chunks: 0, files: 0, recreated: 0, excluded, skipped, largestChunk: 0, walkMs: walked - started, cloneMs: 0, totalMs: 0,
  };

  const call = async (from: string, to: string, entries: number): Promise<void> => {
    options.signal?.throwIfAborted();
    const errno = await helper.clone(from, to);
    if (errno === EXDEV || errno === ENOTSUP) throw volumeError(from, to, errno);
    if (errno !== 0) throw new CloneError(`clonefile ${from} -> ${to} failed: ${errnoText(errno)}`, errno);
    result.largestChunk = Math.max(result.largestChunk, entries);
  };

  const observeAll = (node: Node, absolute: string) => {
    if (!options.observe) return;
    options.observe(node.relative, node.stats, absolute);
    for (const child of node.children ?? []) observeAll(child, join(absolute, child.name));
  };

  const place = async (node: Node, from: string, to: string): Promise<void> => {
    if (node.children === undefined) {
      await call(from, to, 1);
      result.files += 1;
      return;
    }
    if (node.clean && node.count <= chunk) {
      await call(from, to, node.count);
      result.chunks += 1;
      return;
    }
    mkdirSync(to, { mode: 0o700 });
    result.recreated += 1;
    for (const child of node.children) await place(child, join(from, child.name), join(to, child.name));
    // Mode and times last: adding the children changed the times, and a
    // directory without write permission could not have taken them.
    chmodSync(to, node.stats.mode & 0o7777);
    utimesSync(to, node.stats.atime, node.stats.mtime);
  };

  observeAll(root, source);
  await place(root, source, destination);
  const ended = performance.now();
  result.cloneMs = ended - walked;
  result.totalMs = ended - started;
  return result;
}
