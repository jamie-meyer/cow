// The token counts Claude Code writes while a turn runs, read from its
// transcript on the thread's machine by cow's host entry. Only for a running
// worker, and only with the `liveUsage` setting on: cow's server asks; this
// reads.
//
// Where: `<home>/.claude/projects/<folder>/<session>.jsonl`, where <folder> is
// the environment's path with every character that is not a letter or a
// digit replaced by "-" (Claude Code names it from the real path, so
// /var/folders/… is found under -private-var-folders-…). The path is built
// here from the two inputs; a session id that is not a plain id is refused;
// no link is followed, neither for the folder nor for the file; nothing
// outside that projects folder is opened.
//
// What: each line is a JSON entry. An assistant entry has `message.usage`;
// there is one entry per content block and the usage repeats across them,
// so each `message.id` counts once (the largest of each count, should they
// differ). Taken from an entry: `message.id` (hashed before it leaves),
// `message.model`, the four usage counts, `timestamp` and `isSidechain`.
// Nothing else leaves this file: no text, no tool input, no file names.
//
// Sub-agents: Claude Code writes a sub-agent's entries (isSidechain true) in
// files of their own, `<session>/subagents/agent-*.jsonl`, which are never
// read, and bb's own end-of-turn figure leaves them out too. A sidechain entry
// in the main file is skipped, and counted as skipped.
//
// A compaction appends to the same file under the same session id, and its
// summarizing call writes no usage entry (bb does not count it either).

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { hashText } from "../progress.ts";

/** A call reads at most this much. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A plain session id: letters, digits, "-" and "_"; never a dot or a slash. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Claude Code shortens a folder name longer than this with a hash cow does not compute: such an environment has no usage known. */
const MAX_FOLDER_NAME = 200;
const MODEL_PATTERN = /^[A-Za-z0-9._:@\-[\]]{1,100}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export interface UsageMessage {
  /** A hash of `message.id`: tells repeats apart, and says nothing else. */
  key: string;
  model: string;
  /** Its first entry's `timestamp`, in ms; null when it had none. */
  at: number | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type TranscriptRead =
  | { status: "none"; why: string }
  | {
      status: "read";
      /** Where the next read starts. */
      offset: number;
      /** The next read starts in the middle of a line too long for one read: it drops up to the next line's start. */
      partial: boolean;
      /** The file was shorter than the offset asked for, so it was read from the start: what was kept from it is to be dropped. */
      reset: boolean;
      size: number;
      messages: UsageMessage[];
      /** Sidechain entries in the main file, skipped. */
      sidechain: number;
    };

export interface TranscriptAsk {
  /** The environment's path, absolute. */
  path: string;
  session: string;
  offset: number;
  partial: boolean;
  maxBytes?: number;
}

/** Claude Code's folder name for a path. */
export const folderNameOf = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The folders it may be in: from the path as given, and from its real path. Never one with a "/" in it. */
function folderNames(path: string): string[] {
  const names = new Set<string>();
  names.add(folderNameOf(path.replace(/\/+$/, "")));
  try {
    names.add(folderNameOf(realpathSync(path)));
  } catch {
    // An environment folder that is gone: the name from the path as given.
  }
  return [...names].filter((name) => name.length > 1 && name.length <= MAX_FOLDER_NAME && !name.includes("/"));
}

/**
 * Usage of complete lines in `text`: each message id once, sidechain
 * entries skipped. Pure, for the reader and the tests.
 */
export function usageOfLines(text: string): { messages: UsageMessage[]; sidechain: number } {
  const byKey = new Map<string, UsageMessage>();
  let sidechain = 0;
  for (const line of text.split("\n")) {
    // Most lines are not usage: they are not parsed at all.
    if (!line.includes('"usage"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record(parsed);
    const message = record(entry?.message);
    const usage = record(message?.usage);
    if (!entry || !message || !usage) continue;
    const id = typeof message.id === "string" && MESSAGE_ID_PATTERN.test(message.id) ? message.id : null;
    if (id === null) continue;
    if (entry.isSidechain === true) {
      sidechain += 1;
      continue;
    }
    const model = typeof message.model === "string" && MODEL_PATTERN.test(message.model) ? message.model : "unknown";
    const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const key = hashText(id);
    const got: UsageMessage = {
      key,
      model,
      at: Number.isFinite(stamp) ? stamp : null,
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      output: count(usage.output_tokens),
    };
    const before = byKey.get(key);
    byKey.set(
      key,
      before === undefined
        ? got
        : {
            ...before,
            input: Math.max(before.input, got.input),
            cacheRead: Math.max(before.cacheRead, got.cacheRead),
            cacheWrite: Math.max(before.cacheWrite, got.cacheWrite),
            output: Math.max(before.output, got.output),
          },
    );
  }
  return { messages: [...byKey.values()], sidechain };
}

/**
 * Read a transcript's usage since `offset`. A missing file, folder or
 * projects folder is "none": no usage known, not an error. Only complete
 * lines are read: a half-written last line is left for the next read.
 */
export function readTranscriptUsage(ask: TranscriptAsk, home: string = homedir()): TranscriptRead {
  if (!SESSION_ID_PATTERN.test(ask.session)) return { status: "none", why: "the session id is not a plain id" };
  if (!ask.path.startsWith("/") || ask.path.includes("\0")) return { status: "none", why: "the environment path is not absolute" };
  if (!Number.isInteger(ask.offset) || ask.offset < 0) return { status: "none", why: "the offset is not a whole number" };
  const maxBytes = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(ask.maxBytes ?? MAX_READ_BYTES)));
  const root = join(home, ".claude", "projects");
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { status: "none", why: "there is no Claude Code projects folder" };
  }
  for (const name of folderNames(ask.path)) {
    const folder = join(root, name);
    try {
      const st = lstatSync(folder);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      // The folder itself, and no further: its real path is directly in the projects folder.
      if (realpathSync(folder) !== join(realRoot, name) || !realpathSync(folder).startsWith(realRoot + sep)) continue;
    } catch {
      continue;
    }
    const file = join(folder, `${ask.session}.jsonl`);
    let fd: number;
    try {
      const st = lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile()) return { status: "none", why: "the transcript is not a plain file" };
      // O_NOFOLLOW: a link put in its place between the look and the open is not followed either.
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { status: "none", why: "the transcript is not a plain file" };
      const size = st.size;
      const reset = ask.offset > size;
      const from = reset ? 0 : ask.offset;
      const length = Math.min(maxBytes, size - from);
      const buffer = Buffer.alloc(Math.max(0, length));
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buffer, got, length - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      let start = 0;
      if (ask.partial && !reset) {
        const first = buffer.indexOf(0x0a, 0);
        if (first < 0 || first >= got) return { status: "read", offset: from + got, partial: got > 0 ? true : ask.partial, reset, size, messages: [], sidechain: 0 };
        start = first + 1;
      }
      const last = buffer.lastIndexOf(0x0a, got - 1);
      if (last < start) {
        // No complete line yet. A line longer than one read is passed over: its usage is not known.
        const tooLong = got === maxBytes && got > 0;
        return { status: "read", offset: tooLong ? from + got : from + start, partial: tooLong, reset, size, messages: [], sidechain: 0 };
      }
      const found = usageOfLines(buffer.subarray(start, last + 1).toString("utf8"));
      return { status: "read", offset: from + last + 1, partial: false, reset, size, ...found };
    } finally {
      closeSync(fd);
    }
  }
  return { status: "none", why: "there is no transcript for this session" };
}
