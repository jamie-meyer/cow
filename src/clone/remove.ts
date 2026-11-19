// Where clones live under the plugin's host data folder, and removing one.
//
//   <dataDir>/clones/<pathKey>/<name>   a thread's workspace
//   <dataDir>/done/<pathKey>.json       written when a clone is complete
//   <dataDir>/trash/<pathKey>-<time>-…  a removed clone, deleted in the background
//
// Removing deletes a directory tree from a process with no sandbox, so it is
// exact: the only thing it is ever told is a pathKey, which must be one plain
// path segment; the folder is that key's folder under the clones folder,
// resolved through realpath on both sides and refused unless the one is
// strictly inside the other at exactly that name; symlinks are never followed.
import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

const PATH_KEY = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export function checkPathKey(pathKey: string): void {
  if (pathKey === "." || pathKey === ".." || pathKey.length > 200 || !PATH_KEY.test(pathKey)) {
    throw new Error(`refused the path key ${JSON.stringify(pathKey)}: it must be one plain path segment`);
  }
}

export interface Layout {
  clones: string;
  trash: string;
  done: string;
}

/** The three folders, created if missing, each resolved to its real path. */
export function layout(dataDir: string): Layout {
  const make = (name: string) => {
    const path = join(dataDir, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to use it`);
    return realpathSync(path);
  };
  return { clones: make("clones"), trash: make("trash"), done: make("done") };
}

export function donePath(paths: Layout, pathKey: string): string {
  checkPathKey(pathKey);
  return join(paths.done, `${pathKey}.json`);
}

/** True when `inner` is strictly inside `outer` (both already real paths). */
export function strictlyInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * The folder of `pathKey`, checked: it exists, it is a real directory (not a
 * symlink), and its real path is exactly `<real clones folder>/<pathKey>`.
 * Null when there is no such folder. Throws when something is wrong.
 */
export function resolveCloneFolder(paths: Layout, pathKey: string): string | null {
  checkPathKey(pathKey);
  const expected = join(paths.clones, pathKey);
  let stats;
  try {
    stats = lstatSync(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`refused to remove ${expected}: it is a symlink, not the clone folder`);
  if (!stats.isDirectory()) throw new Error(`refused to remove ${expected}: it is not a directory`);
  const real = realpathSync(expected);
  if (real !== expected || !strictlyInside(paths.clones, real) || basename(real) !== pathKey || dirname(real) !== paths.clones) {
    throw new Error(`refused to remove ${expected}: it resolves to ${real}, which is not the clone folder for ${pathKey}`);
  }
  return real;
}

/** Give back the owner's write permission on every directory under `root`, never through a symlink. */
export function restoreWrite(root: string): void {
  const visit = (path: string) => {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return;
    if ((stats.mode & 0o200) === 0) chmodSync(path, (stats.mode & 0o7777) | 0o700);
    for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
}

/** Pids of processes whose working directory is at or under `root` (a real path). */
export function processesUnder(root: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-w", "-n", "-d", "cwd", "-F", "pn"], { maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => {
      // lsof exits 1 when some process could not be read; what it printed still counts.
      const pids: number[] = [];
      let pid = 0;
      for (const line of String(stdout ?? "").split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid > 0 && pid !== process.pid) {
          const cwd = line.slice(1);
          if (cwd === root || strictlyInside(root, cwd)) pids.push(pid);
        }
      }
      resolve([...new Set(pids)]);
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM what works under `root`, then SIGKILL what is left after the grace. */
export async function killProcessesUnder(root: string, graceMs = 2000): Promise<number[]> {
  const killed = new Set<number>();
  for (let round = 0; round < 3; round += 1) {
    const pids = await processesUnder(root);
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        killed.add(pid);
      } catch {}
    }
    const until = Date.now() + graceMs;
    while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 50));
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  return [...killed];
}

export interface RemoveResult {
  /** False when the path key had no folder. */
  removed: boolean;
  /** The trash folder it went to; deleting it is `deleting`. */
  trash: string | null;
  killed: number[];
  deleting: Promise<void>;
}

/**
 * Remove the clone of `pathKey`: kill what runs in it, give back write
 * permission, rename it into the trash, and delete the trash in the
 * background. A key with no folder succeeds with `removed: false`.
 */
export async function removeClone(paths: Layout, pathKey: string, options: { kill?: boolean } = {}): Promise<RemoveResult> {
  const folder = resolveCloneFolder(paths, pathKey);
  rmSync(donePath(paths, pathKey), { force: true });
  if (folder === null) return { removed: false, trash: null, killed: [], deleting: Promise.resolve() };
  const killed = options.kill === false ? [] : await killProcessesUnder(folder);
  // Checked again: the folder must still be the same real directory after the wait.
  if (resolveCloneFolder(paths, pathKey) !== folder) throw new Error(`the clone folder for ${pathKey} changed while it was being removed`);
  restoreWrite(folder);
  const trash = join(paths.trash, `${pathKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  renameSync(folder, trash);
  return { removed: true, trash, killed, deleting: deleteTrash(paths, trash) };
}

/** Delete one item in the trash (already renamed there). */
export async function deleteTrash(paths: Layout, item: string): Promise<void> {
  if (dirname(item) !== paths.trash || !strictlyInside(paths.trash, item)) throw new Error(`refused to delete ${item}: not in the trash folder`);
  const stats = lstatSync(item, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (stats.isDirectory()) restoreWrite(item);
  // fs.rm unlinks symlinks and never follows them.
  await rm(item, { recursive: true, force: true, maxRetries: 3 });
}

/** Empty the trash of anything a stopped worker left behind. */
export async function sweepTrash(paths: Layout): Promise<number> {
  const items = readdirSync(paths.trash);
  for (const name of items) await deleteTrash(paths, join(paths.trash, name));
  return items.length;
}
