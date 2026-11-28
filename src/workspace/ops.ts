// What cow's host entry does with a workspace: read its file, report its
// repositories, and run the approved sync, setup, back and teardown commands.
//
// Every command text here comes from `Approved`, which cow's server passes
// from what the person approved with a signed action; nothing reads a
// command from the file on disk. The file on disk is read only to show it
// and to compare it with what was approved.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git, uncommitted } from "../clone/git.ts";
import { type Layout, checkPathKey, donePath, resolveCloneFolder } from "../clone/remove.ts";
import { type CommandKind, MAX_FILE_BYTES, WORKSPACE_FILE, type WorkspaceFile, KEPT_WHY, commandFor, keepsBranch, parseWorkspaceFile, resolveBringPath } from "./file.ts";

export { KEPT_WHY };
import { type RepoLocks, type RunRecord, type RunStore, type RunVars, TIME_LIMITS, runCommand } from "./run.ts";

/** Content the person approved, as cow's server keeps it. `folder` is the workspace folder's real path. */
export interface Approved {
  folder: string;
  text: string;
  hash: string;
}

export interface CommandDeps {
  store: RunStore;
  locks: RepoLocks;
  limits?: Partial<Record<CommandKind, number>>;
  now?: () => number;
}

/** The approved file, read; approved content that no longer reads (it always did when approved) is refused. */
export function approvedFile(approved: Approved): WorkspaceFile {
  const parsed = parseWorkspaceFile(approved.text);
  if (!parsed.ok) throw new Error(`the approved ${WORKSPACE_FILE} of ${approved.folder} cannot be read: ${parsed.problems.join("; ")}`);
  return parsed.file;
}

const isDirectory = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export interface FolderRead {
  /** The folder's real path, or null when it is not a directory. */
  folder: string | null;
  /** The file's text, or null when there is none. */
  text: string | null;
  error: string | null;
}

/** Resolve a workspace folder and read its file, for showing and comparing only. */
export function readFolder(asked: string): FolderRead {
  if (!asked.startsWith("/")) return { folder: null, text: null, error: `${asked} is not an absolute path` };
  if (!isDirectory(asked)) return { folder: null, text: null, error: `${asked} is not a directory (a symlink is not followed)` };
  const folder = realpathSync(asked);
  const path = join(folder, WORKSPACE_FILE);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return { folder, text: null, error: null };
  if (!stats.isFile()) return { folder, text: null, error: `${path} is not a regular file (a symlink is not followed)` };
  if (stats.size > MAX_FILE_BYTES) return { folder, text: null, error: `${path} is larger than ${MAX_FILE_BYTES / 1024} KB` };
  return { folder, text: readFileSync(path, "utf8"), error: null };
}

/** Whether a source may be synced: a git repository with no uncommitted or untracked changes, or any folder that is not one. */
export async function cleanState(path: string): Promise<{ clean: boolean; why: string | null }> {
  if (lstatSync(join(path, ".git"), { throwIfNoEntry: false }) === undefined) return { clean: true, why: null };
  const status = await uncommitted(path);
  if (status.code !== 0) return { clean: false, why: `git status failed: ${status.stderr.trim().slice(0, 200)}` };
  const changed = status.paths.length;
  return changed === 0 ? { clean: true, why: null } : { clean: false, why: `${changed} uncommitted or untracked change(s)` };
}

/** The repositories of a file: the workspace folder first (as null), then each brought one, with its real path when it exists. */
export function reposOf(folder: string, file: WorkspaceFile): Array<{ as: string | null; path: string; exists: boolean }> {
  return [
    { as: null, path: folder, exists: isDirectory(folder) },
    ...file.bring.map((item) => {
      const resolved = resolveBringPath(folder, item.path);
      const exists = isDirectory(resolved);
      return { as: item.as, path: exists ? realpathSync(resolved) : resolved, exists };
    }),
  ];
}

async function run(deps: CommandDeps, args: { kind: CommandKind; as: string | null; workspace: string; key: string; command: string; cwd: string; vars: RunVars }): Promise<RunRecord> {
  const result = await runCommand({ command: args.command, cwd: args.cwd, vars: args.vars, timeoutMs: deps.limits?.[args.kind] ?? TIME_LIMITS[args.kind], now: deps.now });
  const record: RunRecord = { ...result, kind: args.kind, as: args.as, workspace: args.workspace, cwd: args.cwd };
  deps.store.record(args.key, record);
  return record;
}

export interface SyncResult {
  as: string | null;
  path: string;
  status: "ran" | "dirty" | "no-command" | "missing";
  code: number | null;
  ms: number | null;
  timedOut: boolean;
  why: string | null;
}

/**
 * Sync: each brought repository's `sync`, then the workspace folder's own,
 * each in its source, one at a time per repository. A source with changes is
 * skipped and never touched. `only` picks one `as`, or "." for the workspace folder.
 */
export async function syncWorkspace(deps: CommandDeps, approved: Approved, only: string | null = null): Promise<SyncResult[]> {
  const file = approvedFile(approved);
  const repos = reposOf(approved.folder, file);
  const ordered = [...repos.slice(1), repos[0]!];
  const picked = only === null ? ordered : ordered.filter((repo) => (only === "." ? repo.as === null : repo.as === only));
  if (only !== null && picked.length === 0) throw new Error(`the approved ${WORKSPACE_FILE} brings nothing as "${only}"`);
  const results: SyncResult[] = [];
  for (const repo of picked) {
    results.push(await syncOne(deps, approved, file, repo));
  }
  return results;
}

async function syncOne(deps: CommandDeps, approved: Approved, file: WorkspaceFile, repo: { as: string | null; path: string; exists: boolean }): Promise<SyncResult> {
  const base = { as: repo.as, path: repo.path, code: null, ms: null, timedOut: false };
  const command = commandFor(file, repo.as, "sync");
  if (command === null) return { ...base, status: "no-command", why: null };
  if (!repo.exists) return { ...base, status: "missing", why: `${repo.path} is not a directory` };
  return deps.locks.run(repo.path, async () => {
    const state = await cleanState(repo.path);
    if (!state.clean) return { ...base, status: "dirty" as const, why: state.why };
    const record = await run(deps, {
      kind: "sync",
      as: repo.as,
      workspace: approved.folder,
      key: repo.path,
      command,
      cwd: repo.path,
      vars: { COW_SOURCE: repo.path, COW_AS: repo.as ?? ".", COW_WORKSPACE: approved.folder },
    });
    return { ...base, status: "ran" as const, code: record.code, ms: record.ms, timedOut: record.timedOut, why: null };
  });
}

/**
 * Before cloning, with `syncBeforeClone`: sync each picked repository whose
 * last good sync is older than the age. A failure is a warning, never an
 * error: the clone is made from what is there.
 */
export async function syncBeforeClone(deps: CommandDeps, approved: Approved, file: WorkspaceFile, picked: ReadonlySet<string>): Promise<string[]> {
  const age = file.syncBeforeClone?.olderThanMinutes;
  if (age === undefined) return [];
  const now = (deps.now ?? Date.now)();
  const warnings: string[] = [];
  for (const repo of reposOf(approved.folder, file)) {
    if (repo.as !== null && !picked.has(repo.as)) continue;
    if (commandFor(file, repo.as, "sync") === null || !repo.exists) continue;
    const last = deps.store.get(repo.path).lastOkSyncAt;
    if (last !== undefined && now - last < age * 60_000) continue;
    const result = await syncOne(deps, approved, file, repo);
    const name = repo.as ?? "the workspace folder";
    if (result.status === "dirty") warnings.push(`sync before clone skipped ${name}: ${result.why}; it was cloned as it is`);
    else if (result.status === "ran" && result.code !== 0) warnings.push(`sync before clone of ${name} failed (${result.timedOut ? "time limit" : `exit ${result.code}`}); it was cloned as it is`);
  }
  return warnings;
}

/** Setup, once per repository that has one, after a clone is assembled. Throws with the output's last lines on a failure. */
export async function runSetups(deps: CommandDeps, approved: Approved, file: WorkspaceFile, args: { clone: string; branch: string; repos: Array<{ as: string | null; source: string }> }): Promise<number> {
  let ran = 0;
  for (const repo of args.repos) {
    const command = commandFor(file, repo.as, "setup");
    if (command === null) continue;
    const cwd = repo.as === null ? args.clone : join(args.clone, repo.as);
    const record = await deps.locks.run(repo.source, () =>
      run(deps, {
        kind: "setup",
        as: repo.as,
        workspace: approved.folder,
        key: repo.source,
        command,
        cwd,
        vars: { COW_SOURCE: repo.source, COW_CLONE: cwd, COW_BRANCH: args.branch, COW_AS: repo.as ?? ".", COW_WORKSPACE: approved.folder },
      }),
    );
    ran += 1;
    if (record.code !== 0) {
      throw new Error(`setup of ${repo.as ?? "the workspace folder"} ${record.timedOut ? "ran past its time limit" : `exited ${record.code}`}; its last lines:\n${record.tail.join("\n")}`);
    }
  }
  return ran;
}

export interface TeardownRun {
  as: string | null;
  at: number;
  ms: number;
  code: number | null;
  timedOut: boolean;
  tail: string[];
}

/** The teardown order: the brought repositories in the reverse of setup's order, then the workspace folder's own. */
export function teardownOrder<T extends { as: string | null }>(repos: readonly T[]): T[] {
  return [...repos.filter((repo) => repo.as !== null).reverse(), ...repos.filter((repo) => repo.as === null)];
}

/**
 * Teardown, once per repository that has one, while the clone still exists:
 * `repos` in setup's order (workspace folder first), run in teardownOrder. A
 * failure does not stop the others: each releases what its own setup made.
 */
export async function runTeardowns(deps: CommandDeps, approved: Approved, file: WorkspaceFile, args: { clone: string; branch: string; repos: Array<{ as: string | null; source: string }> }): Promise<TeardownRun[]> {
  const runs: TeardownRun[] = [];
  for (const repo of teardownOrder(args.repos)) {
    const command = commandFor(file, repo.as, "teardown");
    if (command === null) continue;
    const cwd = repo.as === null ? args.clone : join(args.clone, repo.as);
    const record = await deps.locks.run(repo.source, () =>
      run(deps, {
        kind: "teardown",
        as: repo.as,
        workspace: approved.folder,
        key: repo.source,
        command,
        cwd,
        vars: { COW_SOURCE: repo.source, COW_CLONE: cwd, COW_BRANCH: args.branch, COW_AS: repo.as ?? ".", COW_WORKSPACE: approved.folder },
      }),
    );
    runs.push({ as: repo.as, at: record.at, ms: record.ms, code: record.code, timedOut: record.timedOut, tail: record.tail });
  }
  return runs;
}

interface CloneRecord {
  path: string;
  resource: {
    branch: string;
    source: { path: string; head: string | null; branched: boolean };
    bring: Array<{ path: string; as: string | null; head: string | null; branched: boolean }>;
    workspace?: { folder: string; hash: string } | null;
  };
}

/**
 * The record of the clone at `clonePath`, checked: the path must be exactly
 * `<clones>/<key>/<name>` and match what was written when that clone was made.
 */
export function cloneRecord(paths: Layout, clonePath: string): CloneRecord {
  const keyFolder = dirname(clonePath);
  if (dirname(keyFolder) !== paths.clones) throw new Error(`${clonePath} is not a copy-on-write workspace of cow's`);
  const key = basename(keyFolder);
  checkPathKey(key);
  if (resolveCloneFolder(paths, key) === null || !existsSync(donePath(paths, key))) throw new Error(`there is no complete clone at ${clonePath}`);
  const record = JSON.parse(readFileSync(donePath(paths, key), "utf8")) as CloneRecord;
  if (record.path !== clonePath) throw new Error(`${clonePath} is not the clone recorded for ${key}`);
  return record;
}

export interface BackCandidate {
  as: string | null;
  source: string;
  clone: string;
  /** Commits on the thread's branch since the clone was made; null when it cannot be told. */
  ahead: number | null;
  hasCommand: boolean;
  why: string | null;
}

/** Which repositories of a clone have commits their source does not: the branch against the HEAD recorded at clone time. */
export async function backCandidates(paths: Layout, clonePath: string, file: WorkspaceFile | null): Promise<{ branch: string; workspace: string | null; repos: BackCandidate[] }> {
  const record = cloneRecord(paths, clonePath);
  const branch = record.resource.branch;
  const repos: BackCandidate[] = [];
  const all = [{ ...record.resource.source, as: null as string | null }, ...record.resource.bring];
  for (const repo of all) {
    const clone = repo.as === null ? clonePath : join(clonePath, repo.as);
    const hasCommand = file !== null && commandFor(file, repo.as, "back") !== null;
    if (!repo.branched && repo.head !== null && repo.as !== null) {
      // "branch": "keep": its work, if any, is on a branch of its own, which back does not look for.
      repos.push({ as: repo.as, source: repo.path, clone, ahead: null, hasCommand, why: KEPT_WHY });
      continue;
    }
    if (!repo.branched || repo.head === null) {
      repos.push({ as: repo.as, source: repo.path, clone, ahead: null, hasCommand, why: "not a git repository on the thread's branch" });
      continue;
    }
    const count = await git(clone, ["rev-list", "--count", `${repo.head}..refs/heads/${branch}`]);
    const ahead = count.code === 0 ? Number(count.stdout.trim()) : null;
    repos.push({ as: repo.as, source: repo.path, clone, ahead, hasCommand, why: ahead === null ? `cannot compare: ${count.stderr.trim().slice(0, 200)}` : null });
  }
  return { branch, workspace: record.resource.workspace?.folder ?? null, repos };
}

export interface BackResult {
  as: string | null;
  source: string;
  status: "ran" | "nothing-new" | "no-command" | "skipped";
  ahead: number | null;
  code: number | null;
  ms: number | null;
  timedOut: boolean;
  why: string | null;
}

/** Back: the approved `back` of each repository whose clone has commits its source does not, in the source. */
export async function backFromClone(deps: CommandDeps, paths: Layout, clonePath: string, approved: Approved): Promise<BackResult[]> {
  const file = approvedFile(approved);
  const found = await backCandidates(paths, clonePath, file);
  const results: BackResult[] = [];
  for (const repo of found.repos) {
    const base = { as: repo.as, source: repo.source, ahead: repo.ahead, code: null, ms: null, timedOut: false };
    if (repo.ahead === null) {
      results.push({ ...base, status: "skipped", why: repo.why });
      continue;
    }
    if (repo.ahead === 0) {
      results.push({ ...base, status: "nothing-new", why: null });
      continue;
    }
    const command = commandFor(file, repo.as, "back");
    if (command === null) {
      results.push({ ...base, status: "no-command", why: `${repo.ahead} commit(s), and the approved file has no back command for it` });
      continue;
    }
    if (!isDirectory(repo.source)) {
      results.push({ ...base, status: "skipped", why: `${repo.source} is no longer a directory` });
      continue;
    }
    const record = await deps.locks.run(repo.source, () =>
      run(deps, {
        kind: "back",
        as: repo.as,
        workspace: approved.folder,
        key: repo.source,
        command,
        cwd: repo.source,
        vars: { COW_SOURCE: repo.source, COW_CLONE: repo.clone, COW_BRANCH: found.branch, COW_AS: repo.as ?? ".", COW_WORKSPACE: approved.folder },
      }),
    );
    results.push({ ...base, status: "ran", code: record.code, ms: record.ms, timedOut: record.timedOut, why: null });
  }
  return results;
}

/** What `bb cow workspace` shows of one repository: never a command's text, never its output. */
export interface RepoStatus {
  as: string | null;
  path: string;
  exists: boolean;
  dirty: boolean | null;
  commands: Record<CommandKind, boolean>;
  sync: { at: number; ms: number; code: number | null; timedOut: boolean } | null;
  lastOkSyncAt: number | null;
  /** Left on its own branch by the file (`"branch": "keep"`). */
  keep: boolean;
}

export async function repoStatuses(store: RunStore, folder: string, file: WorkspaceFile): Promise<RepoStatus[]> {
  const out: RepoStatus[] = [];
  for (const repo of reposOf(folder, file)) {
    const runs = store.get(repo.path);
    out.push({
      as: repo.as,
      path: repo.path,
      exists: repo.exists,
      dirty: repo.exists ? !(await cleanState(repo.path)).clean : null,
      commands: { sync: commandFor(file, repo.as, "sync") !== null, setup: commandFor(file, repo.as, "setup") !== null, back: commandFor(file, repo.as, "back") !== null, teardown: commandFor(file, repo.as, "teardown") !== null },
      sync: runs.sync ? { at: runs.sync.at, ms: runs.sync.ms, code: runs.sync.code, timedOut: runs.sync.timedOut } : null,
      lastOkSyncAt: runs.lastOkSyncAt ?? null,
      keep: keepsBranch(file, repo.as),
    });
  }
  return out;
}

/** The kept record of a repository's last run of one kind, output included: for the person only. */
export function lastRun(store: RunStore, approved: Approved, as: string | null, kind: CommandKind): RunRecord | null {
  const file = approvedFile(approved);
  const repo = reposOf(approved.folder, file).find((entry) => entry.as === as);
  if (!repo) throw new Error(`the approved ${WORKSPACE_FILE} brings nothing as "${as}"`);
  return store.get(repo.path)[kind] ?? null;
}
