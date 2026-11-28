// Running git from the host entry, in folders a thread can write: never
// through a shell, no prompts, and so that git starts no program the folder
// names.
//
// There are two ways git is run here.
//
// 1. In the repository itself (`git`), for commands that read or write refs
//    and objects and never read a working-tree file: rev-parse, for-each-ref,
//    symbolic-ref, update-ref, merge-base, rev-list, cat-file, config --list,
//    check-ref-format, version. These read the repository's own
//    configuration, which a thread may have written. Every one carries
//    `FIXED` and `gitEnv`, which turn off each way those commands could be
//    made to start a program: hooks, the fsmonitor program, a pager, a fetch
//    of a missing object (and every transport, for a git too old to know
//    GIT_NO_LAZY_FETCH), and background maintenance.
//
// 2. Detached from the repository (`openTree`), for every command that reads
//    working-tree files or merges contents: diff, ls-files, check-attr,
//    merge-tree. git's filters, diff drivers and merge drivers are named by
//    configuration under names the repository chooses, and git has no switch
//    that ignores a repository's configuration. So these commands are not
//    given the repository: GIT_DIR is an empty git folder that ships with
//    cow (`assets/no-repository`), and the working tree, the index and the
//    objects are named one by one. git then reads no configuration file from
//    the thread's folder at any level (the repository's, a worktree's, an
//    included file's), nor the person's own or the system's. Attributes are
//    still read, and can still say `filter=x`; with nothing configured under
//    that name, nothing runs. A few settings that only say how files are
//    compared (line endings, file modes, letter case, the ignore file) are
//    read from the repository and handed over by name: `KEPT`.
//
// What git cannot compare with filters off is found and said, not guessed:
// see `filteredOf`.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/** A git that runs in a directory and never through a shell. */
export type Run = (cwd: string, args: string[], options?: GitOptions) => Promise<GitResult>;

/**
 * What every git command cow runs starts with. On the command line these
 * outrank every configuration file. Hooks are looked for in /dev/null; no
 * fsmonitor program; no pager; no transport of any kind (a missing object in
 * a partial clone would otherwise be fetched, by a program the remote's
 * configuration names); no background maintenance; no recursing into
 * submodules; no optional lock.
 */
export const FIXED: readonly string[] = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** The environment git runs with: none of the caller's GIT_ variables, no prompt, no lazy fetch, no optional lock. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  return { ...env, ...extra };
}

/** Run git in `cwd` with `FIXED` and `gitEnv`; never through a shell. */
export const git: Run = (cwd, args, options = {}) =>
  new Promise((done) => {
    execFile("git", [...FIXED, ...args], { cwd, env: gitEnv(options.env), maxBuffer: 32 * 1024 * 1024, ...(options.signal ? { signal: options.signal, killSignal: "SIGKILL" as const } : {}) }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export type ObjectFormat = "sha1" | "sha256";

/** git's empty tree: what a repository with no commits is compared against. */
export const EMPTY_TREES: Record<ObjectFormat, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** What cow's empty git folder holds, to the byte: a HEAD on a branch that does not exist, no refs, no objects, and a configuration that names nothing. */
export const NO_REPOSITORY: Record<ObjectFormat, { folder: string; files: Record<string, string> }> = {
  sha1: { folder: "no-repository", files: { HEAD: "ref: refs/heads/none\n", config: "[core]\n\trepositoryformatversion = 0\n\tbare = false\n" } },
  sha256: { folder: "no-repository-sha256", files: { HEAD: "ref: refs/heads/none\n", config: "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n" } },
};

/** Whether `dir` is cow's empty git folder and nothing more: exactly HEAD, config and an empty refs. */
function isNoRepository(dir: string, format: ObjectFormat): boolean {
  try {
    if (readdirSync(dir).sort().join(" ") !== "HEAD config refs") return false;
    if (readdirSync(join(dir, "refs")).some((name) => name !== ".keep")) return false;
    return Object.entries(NO_REPOSITORY[format].files).every(([name, text]) => lstatSync(join(dir, name)).isFile() && readFileSync(join(dir, name), "utf8") === text);
  } catch {
    return false;
  }
}

/**
 * The empty git folder that ships with cow, in `assets/`. It is looked for
 * beside cow's own code, wherever bb runs that from, and used only when it
 * holds exactly what it shipped with. Null when it is not found.
 */
export function noRepository(format: ObjectFormat): string | null {
  for (const up of ["../../assets", "../assets", "./assets"]) {
    const dir = decodeURIComponent(new URL(`${up}/${NO_REPOSITORY[format].folder}`, import.meta.url).pathname);
    if (isNoRepository(dir, format)) return dir;
  }
  return null;
}

/**
 * The environment of a git detached from the repository: its git folder is
 * cow's empty one, and neither the person's configuration nor the system's
 * is read. Null when cow's empty folder is not there: nothing is run then.
 */
export function detachedEnv(format: ObjectFormat): Record<string, string> | null {
  const dir = noRepository(format);
  return dir === null ? null : { GIT_DIR: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

/**
 * The settings of the repository (or of the person) that a detached git is
 * still given, by name. Each only says how a file is compared or which files
 * are ignored; none can name a program. Everything else in every
 * configuration file is left unread.
 */
export const KEPT: readonly string[] = [
  "core.autocrlf",
  "core.eol",
  "core.filemode",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.trustctime",
  "core.checkstat",
  "core.excludesfile",
  "core.attributesfile",
];

/** A working tree read by a git detached from its repository. */
export interface Tree {
  /** The top of the working tree. */
  top: string;
  /** The commit HEAD is on; null when there is none yet. */
  head: string | null;
  format: ObjectFormat;
  /** The repository's own ignore file (`info/exclude`), when it has one: a detached git must be told of it. */
  exclude: string | null;
  /** Run a detached git at the top. `config` are more `-c` settings; `before` are options that go before the command. */
  run(args: string[], config?: string[], before?: string[]): Promise<GitResult>;
}

const failed = (stderr: string): GitResult => ({ code: -1, stdout: "", stderr });

/** The oldest git a detached read works on: GIT_CONFIG_GLOBAL is 2.32's. */
export function tooOldToDetach(versionText: string): string | null {
  const match = /git version (\d+)\.(\d+)/.exec(versionText);
  if (!match) return "cannot tell git's version";
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 32) ? null : `git ${major}.${minor} is older than 2.32, which cow needs to read a working tree without the repository's configuration`;
}
const versions = new WeakMap<Run, Promise<string | null>>();

/**
 * Open the working tree `cwd` is in for detached reading. Three commands run
 * in the repository itself, none of which reads a working-tree file: where
 * its index, objects and ignore file are, the commit HEAD is on, and the
 * settings in `KEPT`.
 */
export async function openTree(cwd: string, run: Run = git, options: GitOptions = {}): Promise<{ ok: true; tree: Tree } | { ok: false; result: GitResult }> {
  let version = versions.get(run);
  if (version === undefined) {
    version = run(cwd, ["version"], options).then((result) => (result.code === 0 ? tooOldToDetach(result.stdout) : "retry"));
    versions.set(run, version);
  }
  const old = await version;
  if (old === "retry") versions.delete(run);
  else if (old !== null) return { ok: false, result: failed(old) };

  const where = await run(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-path", "index", "--git-path", "objects", "--git-path", "info/exclude", "--show-object-format"], options);
  if (where.code !== 0) return { ok: false, result: where };
  const [top, index, objects, exclude, formatText] = where.stdout.replace(/\n$/, "").split("\n");
  if (!top || !index || !objects || !exclude || (formatText !== "sha1" && formatText !== "sha256")) return { ok: false, result: failed("git rev-parse said something else") };
  const format: ObjectFormat = formatText;
  const detached = detachedEnv(format);
  if (detached === null) return { ok: false, result: failed("cow's empty git folder is missing from its install, so git was not run") };

  const headOut = await run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  const head = headOut.code === 0 && /^[0-9a-f]{40,64}$/.test(headOut.stdout.trim()) ? headOut.stdout.trim() : null;

  const listed = await run(cwd, ["config", "--null", "--list"], options);
  if (listed.code !== 0) return { ok: false, result: listed };
  const kept = new Map<string, string>();
  for (const entry of listed.stdout.split("\0")) {
    const cut = entry.indexOf("\n");
    if (cut < 0) continue;
    const key = entry.slice(0, cut).toLowerCase();
    if (KEPT.includes(key)) kept.set(key, entry.slice(cut + 1));
  }
  const keptArgs = [...kept].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const env = { ...options.env, ...detached, GIT_WORK_TREE: top, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects };
  const tree: Tree = {
    top,
    head,
    format,
    exclude: existsSync(exclude) ? exclude : null,
    run: (args, config = [], before = []) => run(top, [...keptArgs, ...config.flatMap((setting) => ["-c", setting]), ...before, ...args], { ...options, env }),
  };
  return { ok: true, tree };
}

/** What every detached diff carries: no external diff program, no textconv program, and no git started inside a submodule to ask whether it is dirty. */
export const DIFF_SAFE: readonly string[] = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"];

export interface RawChange {
  /** git's status letter: A, M, D, R, C, T, U. */
  letter: string;
  path: string;
  /** For a rename or copy, the path it had. */
  from: string | null;
}

/** `git diff --name-status -z` output: status, path, and a second path for renames and copies. */
export function parseRaw(out: string): RawChange[] {
  const parts = out.split("\0");
  const changes: RawChange[] = [];
  for (let at = 0; at < parts.length; ) {
    const code = parts[at] ?? "";
    if (code === "") {
      at += 1;
      continue;
    }
    const letter = code[0] ?? "";
    if (letter === "R" || letter === "C") {
      changes.push({ letter, from: parts[at + 1] ?? "", path: parts[at + 2] ?? "" });
      at += 3;
    } else {
      changes.push({ letter, from: null, path: parts[at + 1] ?? "" });
      at += 2;
    }
  }
  return changes.filter((change) => change.path !== "");
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};
/** Paths handed to one git command: under any limit on a command line's length. */
const PATHS_AT_ONCE = 200;

/**
 * Which of `paths` (reported changed against `base`) pass through a git
 * filter: their attributes name one. cow runs no filter, so git compared
 * what is on disk with what the filter would have stored, and the two differ
 * whether or not the file changed. Each such file is asked about once more,
 * by its size and modification time alone as the index recorded them:
 *
 * - `unchanged`: the size and time are as recorded, and what is recorded is
 *   what `base` has. It did not change; leave it out.
 * - `filtered`: it changed, or it cannot be told. Count it as changed, and
 *   show no diff of it: a diff would compare the wrong things.
 */
export async function filteredOf(tree: Tree, base: string, paths: readonly string[]): Promise<{ ok: true; filtered: Set<string>; unchanged: Set<string> } | { ok: false; result: GitResult }> {
  const named = new Set<string>();
  for (const some of chunks(paths, PATHS_AT_ONCE)) {
    const attrs = await tree.run(["check-attr", "-z", "filter", "--", ...some]);
    if (attrs.code !== 0) return { ok: false, result: attrs };
    const parts = attrs.stdout.split("\0");
    for (let at = 0; at + 2 < parts.length; at += 3) {
      const value = parts[at + 2] ?? "";
      if (value !== "unspecified" && value !== "unset" && value !== "set" && value !== "") named.add(parts[at] ?? "");
    }
  }
  const still = new Set<string>();
  for (const some of chunks([...named], PATHS_AT_ONCE)) {
    const again = await tree.run(["diff", ...DIFF_SAFE, "--name-only", "-z", "--no-renames", base, "--", ...some], ["core.checkStat=minimal", "core.trustctime=false"], ["--literal-pathspecs"]);
    if (again.code !== 0) return { ok: false, result: again };
    for (const path of again.stdout.split("\0")) if (path !== "") still.add(path);
  }
  const filtered = new Set<string>();
  const unchanged = new Set<string>();
  for (const path of named) (still.has(path) ? filtered : unchanged).add(path);
  return { ok: true, filtered, unchanged };
}

/** How deep cow looks into submodules of submodules. */
const SUBMODULE_DEPTH = 3;

/**
 * The submodules of `tree` (not in `skip`) that hold uncommitted or
 * untracked changes of their own. git would start another git inside each
 * submodule to ask, with that submodule's configuration; cow asks itself,
 * the detached way. Only where the working tree has a `.gitmodules`.
 */
export async function dirtySubmodules(tree: Tree, skip: ReadonlySet<string>, run: Run = git, options: GitOptions = {}, depth = 0): Promise<string[]> {
  if (depth >= SUBMODULE_DEPTH || lstatSync(join(tree.top, ".gitmodules"), { throwIfNoEntry: false }) === undefined) return [];
  const staged = await tree.run(["ls-files", "--stage", "-z"]);
  if (staged.code !== 0) return [];
  let real: string;
  try {
    real = realpathSync(tree.top);
  } catch {
    return [];
  }
  const dirty: string[] = [];
  for (const entry of staged.stdout.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    if (path === "" || skip.has(path)) continue;
    const dir = join(tree.top, path);
    if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) === undefined) continue;
    try {
      // Never through a link that leaves the working tree.
      if (!realpathSync(dir).startsWith(`${real}/`)) continue;
    } catch {
      continue;
    }
    const inside = await uncommitted(dir, run, options, depth + 1);
    // What cannot be read counts as changed: cow does not call work saved that it could not look at.
    if (inside.code !== 0 || inside.paths.length > 0) dirty.push(path);
  }
  return dirty;
}

export interface Uncommitted {
  /** 0 when it was read. */
  code: number;
  stderr: string;
  /** Every path with an uncommitted change, staged or not, and every untracked file or folder (a folder ends with `/`): what `git status` lists. */
  paths: string[];
  /** Those of `paths` that pass through a git filter and were counted as changed without being compared: cow runs no filter. */
  unverified: string[];
}

/**
 * What `git status --porcelain --untracked-files=normal` answers, worked out
 * with a detached git: what the index has that HEAD does not, what the
 * working tree has that the index does not, untracked files, and submodules
 * with changes inside (unless `submodules` is false).
 */
export async function uncommitted(cwd: string, run: Run = git, options: GitOptions = {}, depth = 0, submodules = true): Promise<Uncommitted> {
  const no = (result: GitResult): Uncommitted => ({ code: result.code === 0 ? -1 : result.code, stderr: result.stderr, paths: [], unverified: [] });
  const opened = await openTree(cwd, run, options);
  if (!opened.ok) return no(opened.result);
  const { tree } = opened;
  const base = tree.head ?? EMPTY_TREES[tree.format];
  const staged = await tree.run(["diff", "--cached", ...DIFF_SAFE, "--name-status", "-z", "-M", base, "--"]);
  if (staged.code !== 0) return no(staged);
  const worktree = await tree.run(["diff", ...DIFF_SAFE, "--name-status", "-z", "-M", base, "--"]);
  if (worktree.code !== 0) return no(worktree);
  const others = await tree.run(["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z", ...(tree.exclude ? ["-X", tree.exclude] : [])]);
  if (others.code !== 0) return no(others);

  const inIndex = new Set(parseRaw(staged.stdout).map((change) => change.path));
  const inTree = parseRaw(worktree.stdout).map((change) => change.path);
  const judged = await filteredOf(tree, base, inTree);
  if (!judged.ok) return no(judged.result);
  const paths = new Set<string>(inIndex);
  for (const path of inTree) if (!judged.unchanged.has(path)) paths.add(path);
  for (const path of others.stdout.split("\0")) if (path !== "") paths.add(path);
  if (submodules) for (const path of await dirtySubmodules(tree, paths, run, options, depth)) paths.add(path);
  return { code: 0, stderr: "", paths: [...paths].sort(), unverified: [...judged.filtered].filter((path) => paths.has(path)).sort() };
}
