// Whether a capability's rule covers a request. Pure, and strict: a request
// is covered only when cow can read all of it with certainty. Anything else
// is not covered, and the person is asked as usual.

import type { Rule } from "./cap.ts";
import { splitWords } from "./command.ts";
import { type Places, type ProtectedPlace, isInside, protectedPlaces, readPath } from "./paths.ts";

/** What a request asks for, as far as a rule can cover it. */
export type Request =
  /** Run this command line. */
  | { kind: "command"; command: string }
  /** Create or change these files. */
  | { kind: "file_change"; paths: readonly string[] };

export type Covered = { covered: true } | { covered: false; why: string };
const no = (why: string): Covered => ({ covered: false, why });

/**
 * Whether `rule` covers the whole of `request`.
 *
 * - A directory rule covers a file change when there is at least one path,
 *   every path is absolute with no `..` in it, and every path is inside the
 *   directory by whole segments, compared exactly (case and Unicode form
 *   included). It never covers a command, whatever the command writes.
 * - An exact command rule covers a command line equal to it character for
 *   character.
 * - A prefix rule covers a command line that reads as plain words (see
 *   `splitWords`) whose first words are the rule's, word for word.
 */
export function covers(rule: Rule, request: Request): Covered {
  if (rule.kind === "dir") {
    if (request.kind !== "file_change") return no("a directory rule covers file changes, not commands");
    if (request.paths.length === 0) return no("bb did not say which files");
    const dir = readPath(rule.dir);
    if (!dir.ok || dir.segments.length === 0) return no("the rule's directory cannot be read");
    for (const raw of request.paths) {
      const path = readPath(raw);
      if (!path.ok) return no(`a path cannot be read with certainty: ${path.why}`);
      if (!isInside(dir.segments, path.segments)) return no(`${path.path} is not under ${dir.path}`);
    }
    return { covered: true };
  }
  if (request.kind !== "command") return no("a command rule covers commands, not file changes");
  if (typeof request.command !== "string" || request.command === "") return no("bb did not say which command");
  if (rule.mode === "exact") {
    return request.command === rule.text ? { covered: true } : no("the command line is not exactly the rule's");
  }
  const split = splitWords(request.command);
  if (!split.ok) return no(`the command is not plain words: ${split.why}`);
  if (rule.words.length < 2) return no("the rule's prefix is too short");
  if (split.words.length < rule.words.length) return no("the command is shorter than the rule's prefix");
  for (let index = 0; index < rule.words.length; index += 1) {
    if (split.words[index] !== rule.words[index]) return no("the command does not begin with the rule's words");
  }
  return { covered: true };
}

/**
 * Where paths really are, when that can be found out: each path with the
 * symbolic links in it followed. `null` means it could not be found out.
 */
export type Resolved = ReadonlyMap<string, string> | null;

/**
 * The second look at a directory rule, after `covers` has passed: with
 * symbolic links followed, is every file still inside the directory, and
 * outside every protected place? Not covered when a link takes a file
 * somewhere else. When `resolved` is null nothing could be found out, and
 * the answer stands on the paths as written.
 */
export function coversResolved(dir: string, paths: readonly string[], resolved: Resolved, places: Places): Covered {
  if (resolved === null) return { covered: true };
  const realDir = readPath(resolved.get(dir) ?? "");
  if (!realDir.ok || realDir.segments.length === 0) return no("where the rule's directory really is could not be read");
  const guarded: ProtectedPlace[] = protectedPlaces(places);
  for (const path of paths) {
    const real = readPath(resolved.get(path) ?? "");
    if (!real.ok) return no(`where ${path} really is could not be read`);
    if (!isInside(realDir.segments, real.segments)) return no(`${path} resolves through a symbolic link to ${real.path}, outside ${realDir.path}`);
    const place = guarded.find((entry) => isInside(entry.segments, real.segments) || entry.path === real.path);
    if (place) return no(`${path} resolves to ${real.path}, inside ${place.path}`);
  }
  return { covered: true };
}

/** A request in a few words, for the log and a line: "run: echo cow", "change /tmp/a.txt". */
export function requestText(request: Request): string {
  if (request.kind === "command") return `run: ${request.command.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  const [first, ...rest] = request.paths;
  return `change ${first ?? "a file"}${rest.length > 0 ? ` (and ${rest.length} more)` : ""}`;
}
