// Whether a thread's branch still fits the branch it will be merged into:
// how many commits it is ahead and behind, and whether a trial merge is
// clean or which files conflict. The host entry works it out, on the machine
// the checkout is on.
//
// Every git command here only reads. The trial merge is `git merge-tree
// --write-tree`, which touches no working tree, index or ref; the objects it
// makes go to a temporary folder of cow's own (GIT_OBJECT_DIRECTORY), with
// the repository's objects borrowed read-only as alternates, so nothing is
// written into the repository either. Nothing fetches: there is no network
// access, lazy fetches of a partial clone included. On a git older than 2.38
// it is not known.
//
// git starts no program the checkout names (see ../clone/git.ts). The trial
// merge and the look for uncommitted changes run detached from the
// repository, so that no merge driver or filter its configuration names can
// run: a file whose attributes name a merge driver is merged as plain text.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { FIXED, detachedEnv, gitEnv, uncommitted } from "../clone/git.ts";
import type { MergeFacts } from "./text.ts";

export type { MergeFacts };

/** How many conflicting files are kept; the count says how many there are. */
export const CONFLICTS_KEPT = 50;
/** How long the whole of one repository's work may take. */
export const REPO_MS = 15_000;

export interface MergeInput {
  /** The thread's checkout. */
  path: string;
  /** What bb says: the branch the worktree was made from, and the repository's default branch. */
  baseBranch: string | null;
  defaultBranch: string | null;
  /** For one of cow's clones: the source folder's repository, where the base is. */
  sourcePath: string | null;
  /** Set when it cannot be worked out at all, and why. */
  notKnown?: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRun {
  (cwd: string, args: readonly string[], options: { signal: AbortSignal; env?: Record<string, string> }): Promise<GitResult>;
}

export interface FactsDeps {
  git: GitRun;
  now: () => number;
  /** Where the trial merge's objects go; removed after. */
  scratch: () => string;
  removeScratch: (dir: string) => void;
  /** Whether a path exists. */
  exists: (path: string) => boolean;
}

export { gitEnv };

/** Run git: never through a shell, killed when the signal aborts. */
export function runGit(binary = "git"): GitRun {
  return (cwd, args, { signal, env }) =>
    new Promise((done) => {
      if (signal.aborted) return done({ code: -1, stdout: "", stderr: "timed out" });
      execFile(binary, [...FIXED, ...args], { cwd, env: gitEnv(env), maxBuffer: 8 * 1024 * 1024, signal, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (signal.aborted) return done({ code: -1, stdout: "", stderr: "timed out" });
        const raw = error ? (error as { code?: unknown }).code : 0;
        const code = typeof raw === "number" ? raw : error ? -1 : 0;
        done({ code, stdout: String(stdout), stderr: error && code === -1 ? `${String(stderr)}${(error as Error).message}`.trim() : String(stderr) });
      });
    });
}

export const defaultDeps = (binary = "git"): FactsDeps => ({
  git: runGit(binary),
  now: Date.now,
  scratch: () => mkdtempSync(join(tmpdir(), "cow-merge-")),
  removeScratch: (dir) => rmSync(dir, { recursive: true, force: true }),
  exists: existsSync,
});

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

/** What a repository's lock is keyed by: its common git folder, found from files alone so that no git process is needed to know it. */
export function repoKey(path: string): string {
  try {
    const dotGit = join(path, ".git");
    const stats = statSync(dotGit, { throwIfNoEntry: false });
    if (stats === undefined) return resolve(path);
    if (stats.isDirectory()) return resolve(dotGit);
    const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!named) return resolve(path);
    const gitDir = isAbsolute(named) ? named : resolve(path, named);
    const common = join(gitDir, "commondir");
    if (!existsSync(common)) return resolve(gitDir);
    const target = readFileSync(common, "utf8").trim();
    return isAbsolute(target) ? resolve(target) : resolve(gitDir, target);
  } catch {
    return resolve(path);
  }
}

/** One git process per repository at a time: work on a repository waits for the work before it. */
export class RepoLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `work` holding every one of `keys`, taken in one order so that two jobs never wait on each other. */
  async run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const before = sorted.map((key) => this.tails.get(key) ?? Promise.resolve());
    const job = Promise.all(before.map((tail) => tail.catch(() => undefined))).then(work);
    const settled = job.catch(() => undefined);
    for (const key of sorted) this.tails.set(key, settled);
    try {
      return await job;
    } finally {
      for (const key of sorted) if (this.tails.get(key) === settled) this.tails.delete(key);
    }
  }
}

/** Which git version is here, asked once; null when it is too old for the trial merge, with the reason. */
let versionChecked: Promise<string | null> | null = null;
export function resetVersionCheck(): void {
  versionChecked = null;
}
export function tooOld(versionText: string): string | null {
  const match = /git version (\d+)\.(\d+)/.exec(versionText);
  if (!match) return `cannot tell git's version from “${firstLine(versionText)}”`;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 38) ? null : `git ${major}.${minor} is older than 2.38, which the trial merge needs`;
}

const blank = (now: number, clone: boolean): MergeFacts => ({
  state: "none",
  why: null,
  base: null,
  branch: null,
  ahead: null,
  behind: null,
  conflicts: [],
  conflictCount: 0,
  dirty: null,
  head: null,
  baseTip: null,
  at: now,
  checkedAt: now,
  clone,
});

/** The local branch to merge into: bb's base branch when it is there, else the default branch, as found locally. */
export function chooseBase(input: { baseBranch: string | null; defaultBranch: string | null }, heads: ReadonlyMap<string, string>, originHead: string | null): string | null {
  const local = (name: string | null): string | null => {
    if (!name) return null;
    const plainName = name.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "").replace(/^origin\//, "");
    return heads.has(plainName) ? plainName : null;
  };
  const fromOrigin = originHead ? originHead.replace(/^refs\/remotes\/origin\//, "") : null;
  for (const candidate of [input.baseBranch, input.defaultBranch, fromOrigin, "main", "master"]) {
    const found = local(candidate);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The facts for one checkout. `known` is the last answer for it: when
 * neither tip has moved it is given back as it was, with only whether there
 * are uncommitted changes read again. Never throws: what fails reads as not
 * known, with the reason.
 */
export async function workOut(input: MergeInput, known: MergeFacts | null, deps: FactsDeps, signal: AbortSignal): Promise<MergeFacts> {
  const now = deps.now();
  const clone = input.sourcePath !== null;
  const out = blank(now, clone);
  const unknown = (why: string, more: Partial<MergeFacts> = {}): MergeFacts => ({ ...out, ...more, state: "unknown", why: signal.aborted ? "timed out" : why });
  const none = (why: string, more: Partial<MergeFacts> = {}): MergeFacts => ({ ...out, ...more, state: "none", why });
  try {
    if (input.notKnown) return unknown(input.notKnown);
    if (!deps.exists(input.path)) return unknown("the checkout is no longer there");
    if (clone && !deps.exists(input.sourcePath!)) return unknown("the clone's source folder is no longer there");
    versionChecked ??= deps.git(input.path, ["version"], { signal }).then((result) => (result.code === 0 ? tooOld(result.stdout) : `git did not run: ${firstLine(result.stderr) || `exit ${result.code}`}`));
    const old = await versionChecked;
    if (old !== null) {
      if (/did not run/.test(old)) versionChecked = null;
      return unknown(old);
    }
    const git = (cwd: string, args: string[], env?: Record<string, string>) => deps.git(cwd, args, { signal, ...(env ? { env } : {}) });

    // The thread's tip and branch, and where its objects are.
    const here = await git(input.path, ["rev-parse", "--path-format=absolute", "--git-common-dir", "HEAD", "--symbolic-full-name", "HEAD"]);
    if (here.code !== 0) return unknown(/unknown revision|ambiguous argument 'HEAD'/.test(here.stderr) ? "the branch has no commits" : `git rev-parse failed: ${firstLine(here.stderr) || `exit ${here.code}`}`);
    const [commonDir, head, ref] = here.stdout.trim().split("\n");
    if (!commonDir || !head || !ref) return unknown("git rev-parse said nothing");
    if (!ref.startsWith("refs/heads/")) return none("a detached head: there is no branch to merge", { head });
    const branch = ref.slice("refs/heads/".length);

    // The base's tip, in the repository the branch will go back to.
    const baseRepo = clone ? input.sourcePath! : input.path;
    const refs = await git(baseRepo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads", "refs/remotes/origin/HEAD"]);
    if (refs.code !== 0) return unknown(`git for-each-ref failed: ${firstLine(refs.stderr) || `exit ${refs.code}`}`, { branch, head });
    const heads = new Map<string, string>();
    let originHead: string | null = null;
    for (const line of refs.stdout.split("\n")) {
      const [name, oid, symref] = line.split("\0");
      if (!name || !oid) continue;
      if (name.startsWith("refs/heads/")) heads.set(name.slice("refs/heads/".length), oid);
      else if (name === "refs/remotes/origin/HEAD" && symref) originHead = symref;
    }
    const base = chooseBase(input, heads, originHead);
    if (base === null) return unknown("no base branch was found locally", { branch, head });
    // Its own base: in a project's checkout on the default branch there is nothing to merge.
    if (!clone && base === branch) return none("it is on the base branch itself", { branch, head, base });
    const baseTip = heads.get(base)!;
    const tips = { branch, head, base, baseTip };

    // A clone's base is in another repository: its objects are borrowed, read-only, for every command after this one.
    let sourceObjects: string | null = null;
    if (clone) {
      const source = await git(baseRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (source.code !== 0) return unknown(`git rev-parse failed in the source folder: ${firstLine(source.stderr)}`, tips);
      sourceObjects = join(source.stdout.trim(), "objects");
    }
    const alternates = [join(commonDir, "objects"), ...(sourceObjects ? [sourceObjects] : [])].join(process.platform === "win32" ? ";" : ":");
    const borrowed = clone ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates } : undefined;

    // Read detached from the repository: no filter its configuration names runs. A submodule counts when its commit moved.
    const detachedRun = (cwd: string, args: string[], options?: { env?: Record<string, string> }) => deps.git(cwd, args, { signal, ...(options?.env ? { env: options.env } : {}) });
    const dirty = async (): Promise<boolean | null> => {
      const status = await uncommitted(input.path, detachedRun, {}, 0, false);
      return status.code === 0 ? status.paths.length > 0 : null;
    };

    // Neither tip has moved: the answer stands.
    if (known && known.state !== "unknown" && known.head === head && known.baseTip === baseTip && known.base === base && known.branch === branch) {
      const reused: MergeFacts = { ...known, checkedAt: now };
      if (known.state === "clean" || known.state === "conflict") reused.dirty = await dirty();
      if (signal.aborted) return unknown("timed out", tips);
      return reused;
    }

    const counts = await git(input.path, ["rev-list", "--left-right", "--count", `${baseTip}...${head}`], borrowed);
    if (counts.code !== 0) return unknown(`git rev-list failed: ${firstLine(counts.stderr) || `exit ${counts.code}`}`, tips);
    const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
    const behind = Number(behindText);
    const ahead = Number(aheadText);
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return unknown("git rev-list said something else", tips);
    const counted = { ...tips, ahead, behind };
    if (ahead === 0) return none(behind === 0 ? `no commits of its own: it is where ${base} is` : `no commits of its own that ${base} does not have`, counted);

    // The trial merge, its objects in a folder of cow's own.
    const scratch = deps.scratch();
    try {
      // Detached from the repository: its configuration is not read, so no merge driver it names can run.
      const detached = detachedEnv(head.length === 64 ? "sha256" : "sha1");
      if (detached === null) return unknown("cow's empty git folder is missing from its install, so the trial merge was not run", counted);
      const env = { ...detached, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates };
      const merged = await git(input.path, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", baseTip, head], env);
      if (merged.code !== 0 && merged.code !== 1) return unknown(`git merge-tree failed: ${firstLine(merged.stderr) || `exit ${merged.code}`}`, counted);
      const [tree, ...rest] = merged.stdout.split("\0");
      if (!tree || !/^[0-9a-f]{40,64}$/.test(tree.trim())) return unknown("git merge-tree said something else", counted);
      if (merged.code === 0) {
        // Its changes are in the base already, by another way than these commits (a squash, say): nothing to merge.
        const baseTree = await git(input.path, ["rev-parse", `${baseTip}^{tree}`], env);
        if (baseTree.code === 0 && baseTree.stdout.trim() === tree.trim()) return none(`already merged: its changes are all in ${base}`, counted);
        if (signal.aborted) return unknown("timed out", counted);
        return { ...out, ...counted, state: "clean", why: null, dirty: await dirty() };
      }
      const files = [...new Set(rest.filter((name) => name !== ""))];
      return { ...out, ...counted, state: "conflict", why: null, conflicts: files.slice(0, CONFLICTS_KEPT), conflictCount: files.length, dirty: await dirty() };
    } finally {
      deps.removeScratch(scratch);
    }
  } catch (cause) {
    return unknown(cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200));
  }
}

/** The repositories one input's work reads, for its locks. */
export function inputRepos(input: MergeInput): string[] {
  return [repoKey(input.path), ...(input.sourcePath ? [repoKey(input.sourcePath)] : [])];
}

/** Work it out holding the repositories' locks, within the time limit. */
export async function workOutBounded(locks: RepoLocks, input: MergeInput, known: MergeFacts | null, deps: FactsDeps, ms = REPO_MS): Promise<MergeFacts> {
  return locks.run(inputRepos(input), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const facts = await workOut(input, known, deps, controller.signal);
      return facts.state === "unknown" && facts.why === "timed out" ? { ...facts, why: `timed out after ${Math.round(ms / 1000)} s` } : facts;
    } finally {
      clearTimeout(timer);
    }
  });
}
