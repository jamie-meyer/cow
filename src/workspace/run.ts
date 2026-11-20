// Running one of the person's approved commands, in cow's host entry: with
// `/bin/sh -c`, in a fixed working directory, under a time limit, with the
// values it needs only as environment variables. cow never builds a command
// string: the text is the approved text, unchanged, and every path, branch
// and name reaches it as COW_SOURCE, COW_CLONE, COW_BRANCH, COW_AS and
// COW_WORKSPACE.
//
// What is kept of each run (when, how long, the exit code, the last lines of
// output) is written to the plugin's host data folder only: output may hold
// secrets, so it never goes to bb's database or to cow's log.

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandKind } from "./file.ts";

/** How long each kind may run. */
export const TIME_LIMITS: Record<CommandKind, number> = { sync: 5 * 60_000, setup: 15 * 60_000, back: 5 * 60_000, teardown: 15 * 60_000 };
export const TAIL_LINES = 20;
const MAX_LINE = 500;
const KEEP_BYTES = 64 * 1024;
/** After SIGTERM at the time limit, SIGKILL this long later. */
const KILL_GRACE_MS = 2000;

export interface RunVars {
  COW_SOURCE: string;
  COW_CLONE?: string;
  COW_BRANCH?: string;
  /** The repository's `as`, or "." for the workspace folder. */
  COW_AS: string;
  COW_WORKSPACE: string;
}

export interface RunResult {
  at: number;
  ms: number;
  /** Null when it was stopped by a signal (at the time limit, say). */
  code: number | null;
  timedOut: boolean;
  /** The last lines of what it printed, stdout and stderr together. */
  tail: string[];
}

/** Variables that would point git somewhere else than the working directory; never passed on. */
const DROPPED = /^(COW_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_COMMON_DIR$|GIT_NAMESPACE$)/;

export function commandEnv(vars: RunVars, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !DROPPED.test(key)) env[key] = value;
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function lastLines(text: string, count = TAIL_LINES): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-count).map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line));
}

/** Run approved command text with /bin/sh -c in `cwd`. Never rejects: a failure to start is exit code 127 with the reason in the tail. */
export function runCommand(args: { command: string; cwd: string; vars: RunVars; timeoutMs: number; now?: () => number }): Promise<RunResult> {
  const now = args.now ?? Date.now;
  const at = now();
  const started = performance.now();
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let finished = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > KEEP_BYTES * 2) output = output.slice(-KEEP_BYTES);
    };
    const child = spawn("/bin/sh", ["-c", args.command], { cwd: args.cwd, env: commandEnv(args.vars), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, args.timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const finish = (code: number | null, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const tail = lastLines(output + extra);
      if (timedOut) tail.push(`(stopped: it ran longer than ${Math.round(args.timeoutMs / 1000)} s)`);
      done({ at, ms: Math.round(performance.now() - started), code: timedOut ? null : code, timedOut, tail: tail.slice(-TAIL_LINES) });
    };
    child.on("error", (error) => finish(127, `\n${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** One run, as kept. */
export interface RunRecord extends RunResult {
  kind: CommandKind;
  /** The repository's `as`, or null for the workspace folder. */
  as: string | null;
  workspace: string;
  cwd: string;
}

export interface RepoRuns {
  sync?: RunRecord;
  setup?: RunRecord;
  back?: RunRecord;
  teardown?: RunRecord;
  /** When its sync last exited 0. */
  lastOkSyncAt?: number;
}

/** The kept runs, by the real path of each source repository (or workspace folder). */
export class RunStore {
  private readonly file: string;
  constructor(dataDir: string) {
    const dir = join(dataDir, "workspace");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink; refusing to use it`);
    this.file = join(dir, "runs.json");
  }

  private read(): Record<string, RepoRuns> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { repos?: Record<string, RepoRuns> };
      return parsed.repos ?? {};
    } catch {
      return {};
    }
  }

  get(path: string): RepoRuns {
    return this.read()[path] ?? {};
  }

  record(path: string, run: RunRecord): void {
    const repos = this.read();
    const entry: RepoRuns = { ...(repos[path] ?? {}), [run.kind]: run };
    if (run.kind === "sync" && run.code === 0) entry.lastOkSyncAt = run.at;
    repos[path] = entry;
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ repos })}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/** One run at a time per repository: work for the same path waits its turn. */
export class RepoLocks {
  private readonly chains = new Map<string, Promise<unknown>>();
  run<T>(path: string, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(path) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.catch(() => {});
    this.chains.set(path, settled);
    void settled.then(() => {
      if (this.chains.get(path) === settled) this.chains.delete(path);
    });
    return next;
  }
}
