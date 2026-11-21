// What a brief's thread changed, as the checker is shown it: the base it was
// compared against, every changed file with its status (uncommitted and
// untracked files included), and the diff text, clipped to a budget. cow
// collects it itself, in the thread's checkout, on the machine it is on (see
// the host entry); the submitting agent has no say in it.

import { lstat, open } from "node:fs/promises";
import { DEFAULT_EXCLUDES, createMatcher } from "../clone/glob.ts";
import { type ChangedFile, type FileStatus, isLockFile } from "./paths.ts";

export type NameOnly = "lock file" | "binary" | "secret";
const secrets = createMatcher(DEFAULT_EXCLUDES);
/** A path cow never shows the contents of: one that is, or is under, what a clone leaves out as a secret (.env, keys, .ssh, …). */
export function isSecretPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, n) => secrets.matches(parts.slice(0, n + 1).join("/"), n < parts.length - 1));
}

export const DIFF_LIMITS = {
  /** Characters of diff text the checker is shown, in all. */
  total: 60_000,
  /** Characters of one file's diff. */
  perFile: 12_000,
  /** No file's share is cut below this while there is room: past it, later files are left out instead. */
  minPerFile: 1_500,
  /** Files listed; past this many the list is cut, and the prompt says so. */
  files: 5_000,
  /** Characters of an untracked file read to show it as added. */
  untrackedFile: 200_000,
} as const;

/** A git that runs in a directory and never through a shell. */
export type Git = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DiffCollected {
  /** The commit compared against. */
  base: string;
  /** What it is: "the merge base of HEAD and origin/main", "HEAD (no base branch resolved)". */
  baseText: string;
  /** Every changed file, up to `DIFF_LIMITS.files`. */
  files: ChangedFile[];
  /** How many files changed, listed or not. */
  filesTotal: number;
  /** The diff, clipped. */
  text: string;
  /** Characters of diff before clipping. */
  chars: number;
  /** Files whose diff was cut short. */
  clipped: string[];
  /** Files whose diff was left out for want of room. */
  omitted: string[];
  /** Files shown by name only, and why. */
  namesOnly: { path: string; why: NameOnly }[];
}

export type DiffResult = { ok: true; diff: DiffCollected } | { ok: false; why: string };

/** git's empty tree: the base of a repository with no commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

/** `git diff --name-status -z` output: status, path, and a second path for renames and copies. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let at = 0; at < parts.length; ) {
    const code = parts[at] ?? "";
    if (code === "") {
      at += 1;
      continue;
    }
    const letter = code[0] ?? "";
    if (letter === "R" || letter === "C") {
      const from = parts[at + 1] ?? "";
      const path = parts[at + 2] ?? "";
      files.push(letter === "R" ? { path, status: "renamed", from, untracked: false } : { path, status: "added", from: null, untracked: false });
      at += 3;
    } else {
      files.push({ path: parts[at + 1] ?? "", status: STATUS[letter] ?? "modified", from: null, untracked: false });
      at += 2;
    }
  }
  return files.filter((file) => file.path !== "");
}

/** Split a whole `git diff` into each file's part, keyed by the path it has now (b/…), or had (a/…) when deleted. */
export function splitDiff(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  starts.forEach((start, n) => {
    const part = text.slice(start, starts[n + 1] ?? text.length);
    const header = part.slice(0, part.indexOf("\n") >= 0 ? part.indexOf("\n") : part.length);
    const plus = /^\+\+\+ b\/(.*)$/m.exec(part)?.[1];
    const minus = /^--- a\/(.*)$/m.exec(part)?.[1];
    const renamed = /^rename to (.*)$/m.exec(part)?.[1];
    const named = / b\/(.*)$/.exec(header)?.[1];
    const path = plus ?? renamed ?? named ?? minus;
    if (path !== undefined) out.set(unquote(path.replace(/\t$/, "")), part);
  });
  return out;
}

/** git quotes a path with unusual characters as a C string. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path.replace(/\\([0-7]{3})/g, (_, oct: string) => `\\u00${parseInt(oct, 8).toString(16).padStart(2, "0")}`)) as string;
  } catch {
    return path.slice(1, -1);
  }
}

const isBinary = (part: string): boolean => /^Binary files .* differ$/m.test(part) || /^GIT binary patch$/m.test(part);

/**
 * Clip each file's diff so that every file gets an even share of the budget
 * before any file gets more: the largest share `cap` with the total under
 * `total`, at most `perFile`. When even `minPerFile` each does not fit, files
 * in list order get it until the budget is spent, and the rest are left out.
 */
export function clipParts(parts: readonly { path: string; text: string }[], limits: { total: number; perFile: number; minPerFile: number } = DIFF_LIMITS): {
  text: string;
  clipped: string[];
  omitted: string[];
} {
  const fits = (cap: number) => parts.reduce((sum, part) => sum + Math.min(part.text.length, cap), 0) <= limits.total;
  let cap = limits.perFile;
  if (!fits(cap)) {
    let low = 0;
    let high = limits.perFile;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    cap = Math.max(low, Math.min(limits.minPerFile, limits.perFile));
  }
  const clipped: string[] = [];
  const omitted: string[] = [];
  const out: string[] = [];
  let left = limits.total;
  for (const part of parts) {
    const room = Math.min(cap, left);
    if (room <= 0 || (room < part.text.length && room < Math.min(limits.minPerFile, cap))) {
      omitted.push(part.path);
      continue;
    }
    if (part.text.length > room) {
      clipped.push(part.path);
      const cut = part.text.slice(0, room);
      out.push(`${cut}${cut.endsWith("\n") ? "" : "\n"}[cow: this file's diff is cut here, after ${room} of ${part.text.length} characters]\n`);
      left -= room;
    } else {
      out.push(part.text);
      left -= part.text.length;
    }
  }
  return { text: out.join(""), clipped, omitted };
}

/** Try each candidate base branch in turn: the merge base of HEAD and the first that resolves. */
async function findBase(git: Git, cwd: string, bases: readonly string[]): Promise<{ base: string; baseText: string }> {
  const head = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0) return { base: EMPTY_TREE, baseText: "the empty tree (the repository has no commits yet)" };
  const tried = new Set<string>();
  const candidates: string[] = [];
  for (const name of bases) {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.startsWith("-")) continue;
    candidates.push(trimmed);
    if (!trimmed.startsWith("origin/") && !/^[0-9a-f]{40}$/.test(trimmed)) candidates.push(`origin/${trimmed}`);
  }
  const remoteHead = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim() !== "") candidates.push(remoteHead.stdout.trim());
  candidates.push("main", "master", "origin/main", "origin/master");
  for (const ref of candidates) {
    if (tried.has(ref)) continue;
    tried.add(ref);
    const found = await git(cwd, ["merge-base", "HEAD", `${ref}^{commit}`]);
    const sha = found.stdout.trim();
    if (found.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return { base: sha, baseText: `the merge base of HEAD and ${ref}` };
  }
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { base: sha, baseText: "HEAD: no base branch resolved, so only uncommitted and untracked changes are shown" };
}

/**
 * Collect what a checkout changed since its base: `bases` are the branch
 * names to try, the environment's own first. Fails, saying why, when `cwd`
 * is not a git checkout or git fails.
 */
export async function collectDiff(
  git: Git,
  cwd: string,
  bases: readonly string[],
  /** An untracked file's text, by its absolute path; null when it is not a readable text file. */
  readUntracked: (path: string) => Promise<string | null>,
  limits: typeof DIFF_LIMITS = DIFF_LIMITS,
): Promise<DiffResult> {
  const inside = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (inside.code !== 0) return { ok: false, why: "the thread's folder is not a git checkout" };
  const top = inside.stdout.trim();
  const { base, baseText } = await findBase(git, top, bases);
  const listed = await git(top, ["diff", "--name-status", "-z", "-M", base, "--"]);
  if (listed.code !== 0) return { ok: false, why: `git could not list the changed files: ${listed.stderr.trim().slice(0, 300) || `exit ${listed.code}`}` };
  const tracked = parseNameStatus(listed.stdout);
  const others = await git(top, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (others.code !== 0) return { ok: false, why: `git could not list the untracked files: ${others.stderr.trim().slice(0, 300) || `exit ${others.code}`}` };
  const untracked: ChangedFile[] = others.stdout
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => ({ path, status: "added", from: null, untracked: true }));
  const all = [...tracked, ...untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = all.slice(0, limits.files);

  const whole = await git(top, ["diff", ...DIFF_FLAGS, base, "--"]);
  if (whole.code !== 0) return { ok: false, why: `git could not make the diff: ${whole.stderr.trim().slice(0, 300) || `exit ${whole.code}`}` };
  const byPath = splitDiff(whole.stdout);
  let chars = 0;
  const namesOnly: DiffCollected["namesOnly"] = [];
  const parts: { path: string; text: string }[] = [];
  for (const file of files) {
    if (isSecretPath(file.path) || (file.from !== null && isSecretPath(file.from))) {
      namesOnly.push({ path: file.path, why: "secret" });
      continue;
    }
    if (isLockFile(file.path)) {
      namesOnly.push({ path: file.path, why: "lock file" });
      continue;
    }
    let part = byPath.get(file.path) ?? null;
    if (file.untracked) part = await untrackedPart(file.path, () => readUntracked(`${top}/${file.path}`), limits.untrackedFile);
    if (part === null) continue;
    chars += part.length;
    if (isBinary(part)) {
      namesOnly.push({ path: file.path, why: "binary" });
      continue;
    }
    parts.push({ path: file.path, text: part });
  }
  const clipped = clipParts(parts, limits);
  return { ok: true, diff: { base, baseText, files, filesTotal: all.length, text: clipped.text, chars, clipped: clipped.clipped, omitted: clipped.omitted, namesOnly } };
}

/** An untracked file as an added one in a diff. */
async function untrackedPart(path: string, read: () => Promise<string | null>, max: number): Promise<string | null> {
  const text = await read().catch(() => null);
  if (text === null) return `diff --git a/${path} b/${path}\nnew file (untracked)\nBinary files /dev/null and b/${path} differ\n`;
  const body = text.length > max ? text.slice(0, max) : text;
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return `diff --git a/${path} b/${path}\nnew file (untracked)\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

/** A file's status as the prompt and the sheet say it. */
export function fileLine(file: ChangedFile): string {
  const status = file.status.padEnd(8);
  if (file.status === "renamed" && file.from !== null) return `${status}  ${file.from} → ${file.path}`;
  return `${status}  ${file.path}${file.untracked ? "  (untracked)" : ""}`;
}

/**
 * Read an untracked file for the diff, on the machine it is on: a regular
 * file only (a link is never followed, so it cannot show a file from outside
 * the checkout), its first `DIFF_LIMITS.untrackedFile` bytes, and null when
 * it looks binary.
 */
export async function readTextFile(path: string): Promise<string | null> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return null;
  if (!info.isFile()) return null;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, DIFF_LIMITS.untrackedFile));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
