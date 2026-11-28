// What happens when bb removes a clone: teardown, the unsaved-work check, and
// holding a clone back instead of deleting it.
//
//   <dataDir>/held/<id>/<name>   the clone, moved aside in one rename
//   <dataDir>/held/<id>.json     why it was held, and what its teardowns did
//
// A clone is removed when every approved teardown exited 0, and each
// repository without one holds nothing unsaved. Otherwise it is held: bb is
// told it was removed (its environment is gone from where bb put it), and the
// person decides, from the page, by signed actions only, whether to run
// teardown again or remove it for good.
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git, uncommitted as uncommittedPaths } from "./git.ts";
import { type Layout, type RemoveResult, checkPathKey, deleteTrash, donePath, killProcessesUnder, removeClone, resolveCloneFolder, resolveKeyFolder, restoreWrite } from "./remove.ts";
import { type Approved, type CommandDeps, type TeardownRun, approvedFile, runTeardowns } from "../workspace/ops.ts";
import { type WorkspaceFile, commandFor } from "../workspace/file.ts";
import { type HoldReason, type RepoAtRemoval, type Unsaved, judge } from "./judge.ts";

export { type HoldReason, type RepoAtRemoval, type Unsaved, judge, lossText, reasonText } from "./judge.ts";

const NOT_A_REPO: Unsaved = { repo: false, uncommitted: 0, branches: [], error: null };

/**
 * Whether the repository at `clone` holds work its source at `source` does
 * not: anything uncommitted or untracked, and any branch tip (or stash, or
 * detached HEAD) that is saved neither in the source nor on a remote. A tip is
 * saved in the source when the source has the commit (work fetched back into
 * it, or pushed and fetched through it); on a remote when one of the clone's
 * own remote-tracking refs (`refs/remotes/…`) contains it: the clone's record
 * of what it pushed or fetched, read locally, with no remote contacted. `skip`
 * names top-level folders that are other repositories of the clone (the
 * brought ones, inside the workspace folder's clone), which are judged on
 * their own.
 */
export async function unsavedWork(clone: string, source: string, skip: readonly string[] = []): Promise<Unsaved> {
  const dotGit = lstatSync(join(clone, ".git"), { throwIfNoEntry: false });
  if (dotGit === undefined || !dotGit.isDirectory()) return NOT_A_REPO;
  const status = await uncommittedPaths(clone);
  if (status.code !== 0) return { repo: true, uncommitted: 0, branches: [], error: `git status failed: ${status.stderr.trim().slice(0, 200)}` };
  const skipped = new Set(skip);
  const uncommitted = status.paths.filter((path) => !skipped.has(path.replace(/\/$/, "").split("/")[0]!)).length;
  const refs = await git(clone, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/stash"]);
  if (refs.code !== 0) return { repo: true, uncommitted, branches: [], error: `git for-each-ref failed: ${refs.stderr.trim().slice(0, 200)}` };
  const tips: Array<{ sha: string; name: string }> = [];
  for (const line of refs.stdout.split("\n")) {
    const [sha, ref] = line.split(" ");
    if (sha && ref) tips.push({ sha, name: ref.replace(/^refs\/heads\//, "").replace(/^refs\/stash$/, "the stash") });
  }
  if ((await git(clone, ["symbolic-ref", "-q", "HEAD"])).code !== 0) {
    const head = await git(clone, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    if (head.code === 0) tips.push({ sha: head.stdout.trim(), name: "a detached HEAD" });
  }
  if (tips.length === 0) return { repo: true, uncommitted, branches: [], error: null };
  const sourceGit = lstatSync(join(source, ".git"), { throwIfNoEntry: false });
  const branches: string[] = [];
  for (const tip of tips) {
    // The source has a commit when it has the object: a commit's history comes with it.
    if (sourceGit !== undefined && (await git(source, ["cat-file", "-e", `${tip.sha}^{commit}`])).code === 0) continue;
    const onRemote = await git(clone, ["for-each-ref", "--count=1", `--contains=${tip.sha}`, "--format=%(refname)", "refs/remotes"]);
    if (onRemote.code !== 0) return { repo: true, uncommitted, branches: [], error: `git for-each-ref --contains failed: ${onRemote.stderr.trim().slice(0, 200)}` };
    if (onRemote.stdout.trim() === "") branches.push(tip.name);
  }
  return { repo: true, uncommitted, branches: [...new Set(branches)], error: null };
}

interface DoneRecord {
  path: string;
  resource: {
    branch: string;
    source: { path: string };
    bring: Array<{ path: string; as: string | null }>;
    workspace?: { folder: string; hash: string } | null;
  };
}

export interface HeldRecord {
  id: string;
  pathKey: string;
  heldAt: number;
  /** The clone's workspace, where it is now: inside the held folder. */
  path: string;
  threadId: string | null;
  title: string | null;
  branch: string;
  /** The workspace folder whose approved file's teardowns ran, if any did. */
  workspace: string | null;
  hash: string | null;
  reasons: HoldReason[];
  /** What each repository holds, as last looked at. */
  unsaved: Array<{ as: string | null; unsaved: Unsaved }>;
  /** The last teardown of each repository that has one, output included: only the person reads it. */
  teardowns: TeardownRun[];
  /** Its repositories in setup's order, with their sources. */
  repos: Array<{ as: string | null; source: string }>;
  /** Whether the clone was made from a workspace file, so that teardown applies. */
  fromFile: boolean;
}

/** What anyone may see of a held clone: never a command's output. */
export type HeldSummary = Omit<HeldRecord, "teardowns"> & { teardowns: Array<Omit<TeardownRun, "tail">>; missing: boolean };

export interface Label {
  threadId: string | null;
  title: string | null;
}

const recordPath = (paths: Layout, id: string) => {
  checkPathKey(id);
  return join(paths.held, `${id}.json`);
};

function readDone(paths: Layout, pathKey: string, folder: string): DoneRecord | null {
  try {
    const record = JSON.parse(readFileSync(donePath(paths, pathKey), "utf8")) as DoneRecord;
    // The recorded workspace must be the one folder directly inside this key's folder.
    if (typeof record.path !== "string" || dirname(record.path) !== folder) return null;
    return record;
  } catch {
    return null;
  }
}

/** Look at a clone's repositories: run teardowns where approved, see what each without one holds, and judge. */
async function assess(args: { commands: CommandDeps; approved: Approved | null; file: WorkspaceFile | null; clone: string; branch: string; repos: Array<{ as: string | null; source: string }> }) {
  const teardowns = args.approved !== null && args.file !== null ? await runTeardowns(args.commands, args.approved, args.file, { clone: args.clone, branch: args.branch, repos: args.repos }) : [];
  const brought = args.repos.filter((repo) => repo.as !== null).map((repo) => repo.as!);
  const unsaved: HeldRecord["unsaved"] = [];
  for (const repo of args.repos) {
    unsaved.push({ as: repo.as, unsaved: await unsavedWork(repo.as === null ? args.clone : join(args.clone, repo.as), repo.source, repo.as === null ? brought : []) });
  }
  const atRemoval: RepoAtRemoval[] = args.repos.map((repo) => {
    const run = teardowns.find((entry) => entry.as === repo.as);
    return { as: repo.as, teardown: run ? { code: run.code, timedOut: run.timedOut } : null, unsaved: unsaved.find((entry) => entry.as === repo.as)!.unsaved };
  });
  return { teardowns, unsaved, reasons: judge(atRemoval) };
}

export type RemoveOutcome = { kind: "removed"; removed: RemoveResult; teardowns: TeardownRun[] } | { kind: "held"; held: HeldRecord; killed: number[]; teardowns: TeardownRun[] };

/**
 * bb's removal of a clone. Its processes are stopped, its approved teardowns
 * run while it still exists, and it is removed, or held: moved aside into the
 * held folder in one rename, with the reasons written beside it.
 * `approved` is the content approved now for the workspace the clone was made
 * from; teardown runs only for a clone made from a workspace file.
 */
export async function removeOrHold(paths: Layout, commands: CommandDeps, args: { pathKey: string; approved: Approved | null; label: Label; now?: () => number }): Promise<RemoveOutcome> {
  const folder = resolveCloneFolder(paths, args.pathKey);
  const done = folder === null ? null : readDone(paths, args.pathKey, folder);
  // No folder, or a clone that was never complete: nothing to judge.
  if (folder === null || done === null) return { kind: "removed", removed: await removeClone(paths, args.pathKey), teardowns: [] };
  const killed = await killProcessesUnder(folder);
  const fromFile = done.resource.workspace != null;
  const file = fromFile && args.approved !== null ? approvedFile(args.approved) : null;
  const repos = [{ as: null as string | null, source: done.resource.source.path }, ...done.resource.bring.map((item) => ({ as: item.as, source: item.path }))];
  const looked = await assess({ commands, approved: fromFile ? args.approved : null, file, clone: done.path, branch: done.resource.branch, repos });
  if (looked.reasons.length === 0) {
    const removed = await removeClone(paths, args.pathKey);
    return { kind: "removed", removed: { ...removed, killed: [...new Set([...killed, ...removed.killed])] }, teardowns: looked.teardowns };
  }
  // Teardown may have left something running in it.
  const again = await killProcessesUnder(folder);
  if (resolveCloneFolder(paths, args.pathKey) !== folder) throw new Error(`the clone folder for ${args.pathKey} changed while it was being removed`);
  const id = freeId(paths, args.pathKey);
  const target = join(paths.held, id);
  const record: HeldRecord = {
    id,
    pathKey: args.pathKey,
    heldAt: (args.now ?? Date.now)(),
    path: join(target, basename(done.path)),
    threadId: args.label.threadId,
    title: args.label.title,
    branch: done.resource.branch,
    workspace: file !== null ? args.approved!.folder : (done.resource.workspace?.folder ?? null),
    hash: file !== null ? args.approved!.hash : null,
    reasons: looked.reasons,
    unsaved: looked.unsaved,
    teardowns: looked.teardowns,
    repos,
    fromFile,
  };
  // The record first, so a held folder always says why; then the one rename.
  writeRecord(paths, record);
  try {
    renameSync(folder, target);
  } catch (error) {
    rmSync(recordPath(paths, id), { force: true });
    throw error;
  }
  rmSync(donePath(paths, args.pathKey), { force: true });
  return { kind: "held", held: record, killed: [...new Set([...killed, ...again])], teardowns: looked.teardowns };
}

function freeId(paths: Layout, pathKey: string): string {
  const taken = (id: string) => lstatSync(join(paths.held, id), { throwIfNoEntry: false }) !== undefined || lstatSync(recordPath(paths, id), { throwIfNoEntry: false }) !== undefined;
  if (!taken(pathKey)) return pathKey;
  for (let n = 2; ; n += 1) {
    const id = `${pathKey.slice(0, 180)}-${n}`;
    if (!taken(id)) return id;
  }
}

function writeRecord(paths: Layout, record: HeldRecord): void {
  const path = recordPath(paths, record.id);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readRecord(paths: Layout, id: string): HeldRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(paths, id), "utf8")) as HeldRecord;
  } catch {
    return null;
  }
}

const summary = (record: HeldRecord, missing: boolean): HeldSummary => ({ ...record, teardowns: record.teardowns.map(({ tail: _tail, ...run }) => run), missing });

/** Every held clone, newest first, without any command's output. A folder whose record is lost is still listed. */
export function listHeld(paths: Layout): HeldSummary[] {
  const out: HeldSummary[] = [];
  const names = readdirSync(paths.held);
  const ids = new Set<string>();
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : name.endsWith(".tmp") ? null : name;
    if (id === null) continue;
    try {
      checkPathKey(id);
    } catch {
      continue;
    }
    ids.add(id);
  }
  for (const id of ids) {
    let folder: string | null;
    try {
      folder = resolveKeyFolder(paths.held, id, "held clone");
    } catch {
      folder = null;
    }
    const record = readRecord(paths, id);
    if (record === null && folder === null) continue;
    out.push(
      record === null
        ? summary({ id, pathKey: id, heldAt: lstatSync(folder!).mtimeMs, path: folder!, threadId: null, title: null, branch: "", workspace: null, hash: null, reasons: [], unsaved: [], teardowns: [], repos: [], fromFile: false }, false)
        : summary(record, folder === null),
    );
  }
  return out.sort((a, b) => b.heldAt - a.heldAt);
}

/** A held clone's record with its teardowns' output: for the person only. */
export function heldOutput(paths: Layout, id: string): HeldRecord {
  const record = readRecord(paths, id);
  if (record === null) throw new Error(`there is no held clone ${id}`);
  return record;
}

function heldFolder(paths: Layout, id: string): string {
  const folder = resolveKeyFolder(paths.held, id, "held clone");
  if (folder === null) throw new Error(`there is no held clone ${id}`);
  return folder;
}

/**
 * Run a held clone's approved teardowns again, where it is now, and judge it
 * as bb's removal would: with nothing left to hold it, it is removed.
 */
export async function teardownHeld(paths: Layout, commands: CommandDeps, args: { id: string; approved: Approved }): Promise<{ removed: boolean; record: HeldRecord }> {
  const folder = heldFolder(paths, args.id);
  const record = readRecord(paths, args.id);
  if (record === null) throw new Error(`the held clone ${args.id} has no record of what it brings, so its teardown cannot run`);
  if (!record.fromFile) throw new Error("this clone was not made from a workspace file, so no teardown applies to it");
  if (dirname(record.path) !== folder) throw new Error(`the record of ${args.id} does not name a folder inside it`);
  const file = approvedFile(args.approved);
  if (!record.repos.some((repo) => commandFor(file, repo.as, "teardown") !== null)) throw new Error(`the approved file of ${args.approved.folder} has no teardown for this clone's repositories`);
  await killProcessesUnder(folder);
  const looked = await assess({ commands, approved: args.approved, file, clone: record.path, branch: record.branch, repos: record.repos });
  const next: HeldRecord = { ...record, workspace: args.approved.folder, hash: args.approved.hash, reasons: looked.reasons, unsaved: looked.unsaved, teardowns: looked.teardowns };
  if (looked.reasons.length > 0) {
    writeRecord(paths, next);
    return { removed: false, record: next };
  }
  const removed = await removeHeld(paths, args.id);
  await removed.deleting.catch(() => {});
  return { removed: true, record: next };
}

/**
 * Remove a held clone for good, with the exact-path rules of removal: the id
 * is one plain segment, its folder resolves to exactly `<held>/<id>`, a
 * symlink is refused, and it is renamed into the trash before it is deleted.
 */
export async function removeHeld(paths: Layout, id: string): Promise<{ trash: string | null; killed: number[]; deleting: Promise<void> }> {
  const folder = resolveKeyFolder(paths.held, id, "held clone");
  if (folder === null) {
    if (readRecord(paths, id) === null) throw new Error(`there is no held clone ${id}`);
    rmSync(recordPath(paths, id), { force: true });
    return { trash: null, killed: [], deleting: Promise.resolve() };
  }
  const killed = await killProcessesUnder(folder);
  if (resolveKeyFolder(paths.held, id, "held clone") !== folder) throw new Error(`the held clone ${id} changed while it was being removed`);
  restoreWrite(folder);
  const trash = join(paths.trash, `held-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  renameSync(folder, trash);
  rmSync(recordPath(paths, id), { force: true });
  return { trash, killed, deleting: deleteTrash(paths, trash) };
}
