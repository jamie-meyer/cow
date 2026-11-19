// Assembling a thread's workspace: the workspace folder cloned, each brought
// repository cloned inside it under its own name, the git copies made
// independent and put on the thread's branch, the read-only paths locked.
// All or nothing: when a step fails, what was made is removed and the error
// names the step.
import { execFile } from "node:child_process";
import { type Stats, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type CloneInputs, type CloneResource, cloneInputsSchema, cloneResourceSchema } from "./contract.ts";
import type { CloneCall } from "./helper.ts";
import { type Layout, checkPathKey, donePath, removeClone, resolveCloneFolder, strictlyInside } from "./remove.ts";
import { type CloneTreeResult, checkSameVolume, cloneTree } from "./tree.ts";

export class StepError extends Error {}

const MAX_EXAMPLES = 8;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Run git in `cwd` with hooks off; never through a shell. */
export function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(), maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

interface RepoFacts {
  path: string;
  isRepo: boolean;
  head: string | null;
  dirty: boolean | null;
}

/** Refuse a repository a clone could not be independent of; read its HEAD and whether it has changes. */
async function inspect(path: string, what: string): Promise<RepoFacts> {
  const dotGit = join(path, ".git");
  const stats = lstatSync(dotGit, { throwIfNoEntry: false });
  if (stats === undefined) return { path, isRepo: false, head: null, dirty: null };
  if (!stats.isDirectory()) {
    throw new StepError(
      `${what} ${path} is a linked git worktree or a submodule checkout (its .git is ${stats.isSymbolicLink() ? "a symlink" : "a file"} naming a repository elsewhere). ` +
        "A clone of it would share that repository: a commit in the clone would move the original's branch. Bring the main checkout instead.",
    );
  }
  if (existsSync(join(dotGit, "objects", "info", "alternates"))) {
    throw new StepError(
      `${what} ${path} borrows objects from another repository (.git/objects/info/alternates). ` +
        "A clone of it would depend on that repository and could lose objects when it is cleaned up. Run `git repack -a -d` there and remove the alternates file first.",
    );
  }
  const head = await git(path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const status = await git(path, ["status", "--porcelain", "--untracked-files=normal"]);
  return { path, isRepo: true, head: head.code === 0 ? head.stdout.trim() : null, dirty: status.code === 0 ? status.stdout.trim() !== "" : null };
}

function isDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Checks that need no cloning: run before anything is made. */
export async function preflight(inputs: CloneInputs, clonesFolder: string): Promise<{ source: string; bring: Array<{ path: string; as: string }>; facts: RepoFacts[] }> {
  if (!isAbsolute(inputs.source)) throw new StepError("source must be an absolute path");
  if (!isDirectory(inputs.source)) throw new StepError(`source ${inputs.source} is not a directory (a symlink is not followed)`);
  const source = realpathSync(inputs.source);
  if (source === "/" || source === realpathSync(process.env.HOME ?? "/")) throw new StepError(`source ${source} is too broad: give the workspace folder`);
  if (source === clonesFolder || strictlyInside(source, clonesFolder) || strictlyInside(clonesFolder, source)) {
    throw new StepError(`source ${source} overlaps the clones folder ${clonesFolder}`);
  }
  const bring: Array<{ path: string; as: string }> = [];
  for (const item of inputs.bring) {
    if (!isDirectory(item.path)) throw new StepError(`bring ${item.path} is not a directory (a symlink is not followed)`);
    const path = realpathSync(item.path);
    if (path === clonesFolder || strictlyInside(path, clonesFolder) || strictlyInside(clonesFolder, path)) throw new StepError(`bring ${path} overlaps the clones folder`);
    if (path === source || strictlyInside(path, source)) throw new StepError(`bring ${path} contains the workspace folder`);
    if (lstatSync(join(source, item.as), { throwIfNoEntry: false }) !== undefined) {
      throw new StepError(`bring "${item.as}": the workspace folder already has an entry named ${item.as}`);
    }
    bring.push({ path, as: item.as });
  }
  for (const rel of inputs.readOnly) {
    if (rel.split("/").some((part) => part === ".." || part === "")) throw new StepError(`readOnly "${rel}" must not contain '..'`);
  }
  for (const path of [source, ...bring.map((b) => b.path)]) checkSameVolume(path, clonesFolder);
  const facts = [await inspect(source, "the workspace folder")];
  for (const item of bring) facts.push(await inspect(item.path, `bring "${item.as}":`));
  return { source, bring, facts };
}

interface Notes {
  venvs: string[];
  symlinks: string[];
  symlinkCount: number;
  hardLinks: string[];
  hardLinkCount: number;
  nested: string[];
}

/** Looks at every entry about to be cloned, for the warnings and for nested repositories that would not be independent. */
function observer(notes: Notes, part: string, root: string, sources: string[]) {
  return (relative: string, stats: Stats, absolute: string) => {
    const shown = relative === "" ? part : `${part}/${relative}`;
    const name = basename(relative);
    if (stats.isFile() && name === "pyvenv.cfg") notes.venvs.push(dirname(shown));
    if (stats.isFile() && stats.nlink > 1) {
      notes.hardLinkCount += 1;
      if (notes.hardLinks.length < MAX_EXAMPLES) notes.hardLinks.push(shown);
    }
    if (stats.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(absolute);
      } catch {}
      if (isAbsolute(target) && sources.some((s) => target === s || target.startsWith(`${s}/`))) {
        notes.symlinkCount += 1;
        if (notes.symlinks.length < MAX_EXAMPLES) notes.symlinks.push(`${shown} -> ${target}`);
      }
    }
    // A nested repository inside the clone: a .git file is fine only when it
    // names a directory inside the same clone (a submodule), and alternates are refused.
    if (relative !== ".git" && name === ".git" && !stats.isDirectory()) {
      let gitdir = "";
      try {
        gitdir = /^gitdir:\s*(.*)$/m.exec(readFileSync(absolute, "utf8"))?.[1]?.trim() ?? "";
      } catch {}
      const resolved = gitdir === "" ? "" : resolve(dirname(absolute), gitdir);
      if (gitdir === "" || isAbsolute(gitdir) || !strictlyInside(root, resolved)) {
        throw new StepError(
          `${dirname(shown)} is a linked git worktree (its .git names ${gitdir || "nothing readable"}): a clone of it would move the original's branches. Exclude it or remove it from the source.`,
        );
      }
    }
    if (relative.endsWith(".git/objects/info/alternates") && relative !== ".git/objects/info/alternates") {
      throw new StepError(`${shown}: a repository inside the source borrows objects from another; a clone of it would not be independent. Exclude it.`);
    }
    if (relative !== "" && name === ".git") notes.nested.push(dirname(shown));
  };
}


/** Make a cloned repository independent, and put it on the thread's branch from the source's HEAD; changes stay. */
async function fixGit(repo: string, branch: string): Promise<boolean> {
  const dotGit = join(repo, ".git");
  if (!isDirectory(dotGit)) return false;
  for (const name of readdirSync(dotGit)) if (name.endsWith(".lock")) unlinkSync(join(dotGit, name));
  const refs = join(dotGit, "refs");
  const dropLocks = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) dropLocks(path);
      else if (name.endsWith(".lock")) unlinkSync(path);
    }
  };
  if (isDirectory(refs)) dropLocks(refs);
  // The source's list of linked worktrees: stale here, and `git worktree remove` in the clone could delete a real one.
  if (lstatSync(join(dotGit, "worktrees"), { throwIfNoEntry: false }) !== undefined) rmSync(join(dotGit, "worktrees"), { recursive: true, force: true });
  const checkout = await git(repo, ["checkout", "--quiet", "-b", branch]);
  if (checkout.code !== 0) throw new StepError(`git checkout -b ${branch} failed: ${checkout.stderr.trim().slice(0, 500)}`);
  return true;
}

/** Remove write permission for everyone, recursively, never through a symlink. */
export function makeReadOnly(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) for (const name of readdirSync(path)) makeReadOnly(join(path, name));
  chmodSync(path, stats.mode & 0o7777 & ~0o222);
}

function folderNameFor(source: string): string {
  const name = basename(source);
  return /^[A-Za-z0-9._ -]+$/.test(name) && !/^\.+$/.test(name) ? name : "workspace";
}

function counts(result: CloneTreeResult) {
  return { entries: result.entries, chunks: result.chunks, files: result.files, excluded: result.excluded, skipped: result.skipped, ms: Math.round(result.totalMs) };
}

export interface CreateResult {
  path: string;
  resource: CloneResource;
  reused: boolean;
}

/**
 * Create the clone for `pathKey`, or return the one already made for it.
 * Throws a StepError naming the step; whatever was made is removed first.
 */
export async function createClone(args: { paths: Layout; pathKey: string; branch: string; inputs: unknown; helper: CloneCall; chunk?: number; signal?: AbortSignal }): Promise<CreateResult> {
  const started = performance.now();
  const { paths, pathKey, branch, helper } = args;
  checkPathKey(pathKey);
  const parsed = cloneInputsSchema.safeParse(args.inputs);
  if (!parsed.success) throw new StepError(`inputs: ${parsed.error.issues.map((i) => `${i.path.join(".") || "inputs"}: ${i.message}`).join("; ")}`);
  const inputs = parsed.data;
  const branchCheck = await git(paths.clones, ["check-ref-format", "--branch", branch]);
  if (branchCheck.code !== 0 || branch.startsWith("-")) throw new StepError(`inputs: "${branch}" is not a valid branch name`);

  // Idempotent per pathKey: a complete clone is returned as it is; a partial one is removed and made again.
  const existing = resolveCloneFolder(paths, pathKey);
  const done = donePath(paths, pathKey);
  if (existing !== null && existsSync(done)) {
    const record = JSON.parse(readFileSync(done, "utf8")) as { path: string; resource: unknown };
    const resource = cloneResourceSchema.parse(record.resource);
    if (strictlyInside(existing, record.path) && isDirectory(record.path)) return { path: record.path, resource, reused: true };
  }
  if (existing !== null || existsSync(done)) await removeClone(paths, pathKey);

  let step = "check the inputs";
  let made = false;
  try {
    const { source, bring, facts } = await preflight(inputs, paths.clones);
    const folder = join(paths.clones, pathKey);
    step = "make the clone folder";
    mkdirSync(folder, { mode: 0o755 });
    made = true;
    const workspace = join(folder, folderNameFor(source));
    const notes: Notes = { venvs: [], symlinks: [], symlinkCount: 0, hardLinks: [], hardLinkCount: 0, nested: [] };
    const sources = [...new Set([source, inputs.source, ...bring.map((b) => b.path), ...inputs.bring.map((b) => b.path)])];
    const options = { chunk: args.chunk, exclude: inputs.exclude, includeSecrets: inputs.includeSecrets, signal: args.signal };

    step = `clone the workspace folder ${source}`;
    const parts = [{ as: null as string | null, ...counts(await cloneTree(helper, source, workspace, { ...options, observe: observer(notes, ".", workspace, sources) })) }];
    for (const item of bring) {
      step = `clone ${item.path} as ${item.as}`;
      const target = join(workspace, item.as);
      if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) throw new StepError(`${item.as} already exists in the clone`);
      parts.push({ as: item.as, ...counts(await cloneTree(helper, item.path, target, { ...options, observe: observer(notes, item.as, target, sources) })) });
    }

    const branched: boolean[] = [];
    step = "put the workspace folder's repository on the thread's branch";
    branched.push(facts[0]!.isRepo ? await fixGit(workspace, branch) : false);
    for (const item of bring) {
      step = `put ${item.as} on the thread's branch`;
      branched.push(facts[bring.indexOf(item) + 1]!.isRepo ? await fixGit(join(workspace, item.as), branch) : false);
    }

    for (const rel of inputs.readOnly) {
      step = `make ${rel} read-only`;
      const target = join(workspace, rel);
      const stats = lstatSync(target, { throwIfNoEntry: false });
      if (stats === undefined) throw new StepError(`${rel} is not in the clone`);
      if (stats.isSymbolicLink()) throw new StepError(`${rel} is a symlink; give the path it points to`);
      const real = realpathSync(target);
      if (!strictlyInside(realpathSync(workspace), real)) throw new StepError(`${rel} resolves outside the clone`);
      makeReadOnly(real);
    }

    step = "write the record";
    const warnings: string[] = [];
    for (const venv of notes.venvs.slice(0, MAX_EXAMPLES)) {
      warnings.push(`Python virtualenv at ${venv}: its scripts name the source's absolute paths, so pip there would install into the source. Recreate it in the clone before using it.`);
    }
    if (notes.venvs.length > MAX_EXAMPLES) warnings.push(`… and ${notes.venvs.length - MAX_EXAMPLES} more virtualenvs`);
    if (notes.symlinkCount > 0) warnings.push(`${notes.symlinkCount} absolute symlink(s) still point into a source: ${notes.symlinks.join(", ")}`);
    if (notes.hardLinkCount > 0) warnings.push(`${notes.hardLinkCount} hard-linked file(s) became separate files in the clone, e.g. ${notes.hardLinks.join(", ")}`);
    const record = (fact: RepoFacts, as: string | null, isBranched: boolean) => ({ path: fact.path, as, head: fact.head, dirty: fact.dirty, branched: isBranched });
    const total = parts.reduce((sum, p) => ({
      entries: sum.entries + p.entries, chunks: sum.chunks + p.chunks, files: sum.files + p.files, excluded: sum.excluded + p.excluded, skipped: sum.skipped + p.skipped, ms: sum.ms + p.ms,
    }), { entries: 0, chunks: 0, files: 0, excluded: 0, skipped: 0, ms: 0 });
    const resource: CloneResource = cloneResourceSchema.parse({
      kind: "cow-clone",
      version: 1,
      path: workspace,
      branch,
      source: record(facts[0]!, null, branched[0]!),
      bring: bring.map((item, index) => record(facts[index + 1]!, item.as, branched[index + 1]!)),
      counts: { total, parts },
      helper: helper.kind,
      totalMs: Math.round(performance.now() - started),
      warnings,
    });
    writeFileSync(done, `${JSON.stringify({ path: workspace, resource })}\n`, { mode: 0o600 });
    return { path: workspace, resource, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let cleanup = "";
    if (made) {
      try {
        const removed = await removeClone(args.paths, pathKey, { kill: false });
        await removed.deleting;
      } catch (removeError) {
        cleanup = ` (and removing what was made failed: ${removeError instanceof Error ? removeError.message : String(removeError)})`;
      }
    }
    throw new StepError(`${step}: ${message}${cleanup}`);
  }
}
