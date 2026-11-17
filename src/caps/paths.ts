// Directory rules: how a path is read, when one path is under another, and
// which directories are never granted. Everything here is pure.
//
// A path is compared by whole segments, never by characters, so `/a/bc` is
// not under `/a/b`. Nothing is resolved against the filesystem here: a path
// with `..` in it is refused rather than worked out, because what `..` means
// depends on symbolic links this code cannot see.

/** The longest path read; longer is refused, not truncated. */
export const MAX_PATH = 1024;

export type PathRead = { ok: true; path: string; segments: string[] } | { ok: false; why: string };

/** Characters no path here may hold: control characters, and the delete character. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Read an absolute path. Repeated slashes, a trailing slash and `.` segments
 * are dropped; nothing else is changed. Refused: anything that is not text,
 * an empty or over-long path, a control character, a relative path (`~`
 * included, which only a shell expands), and any `..` segment.
 */
export function readPath(raw: unknown): PathRead {
  if (typeof raw !== "string") return { ok: false, why: "it is not text" };
  if (raw === "") return { ok: false, why: "it is empty" };
  if (raw.length > MAX_PATH) return { ok: false, why: `it is over ${MAX_PATH} characters` };
  if (CONTROL.test(raw)) return { ok: false, why: "it has a control character in it" };
  if (!raw.startsWith("/")) {
    return { ok: false, why: raw.startsWith("~") ? "it starts with ~, which only a shell expands: write the whole path from /" : "it is relative: write the whole path from /" };
  }
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return { ok: false, why: "it has a .. in it" };
  return { ok: true, path: `/${segments.join("/")}`, segments };
}

/** Whether `path` is inside `dir`: more segments, and every one of `dir`'s equal, exactly. */
export function isInside(dir: readonly string[], path: readonly string[]): boolean {
  return path.length > dir.length && dir.every((segment, index) => path[index] === segment);
}

/**
 * How the refusals compare a segment. macOS file systems fold case and
 * Unicode forms, so `~/.SSH` is `~/.ssh` on disk; folding both here can only
 * refuse more. Covering a request never folds: see `covers`.
 */
const fold = (segment: string): string => segment.normalize("NFC").toLowerCase();
const sameFolded = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((segment, index) => fold(segment) === fold(b[index]!));
const insideFolded = (dir: readonly string[], path: readonly string[]): boolean => path.length > dir.length && dir.every((segment, index) => fold(segment) === fold(path[index]!));

/** What this machine tells the refusals: where home is, and where bb keeps its data. Either may be unknown. */
export interface Places {
  home: string | null;
  dataDir: string | null;
}

/**
 * THE LIST. Directories under the home directory that hold agent
 * configuration or credentials. A capability may not be one of them, be
 * inside one, or contain one. bb's data directory (which holds this plugin's
 * own storage and every thread's storage) is added to them from `Places`.
 * The home directory itself and the filesystem root are refused separately.
 */
export const PROTECTED_IN_HOME: readonly { path: string; what: string }[] = [
  { path: ".bb", what: "bb's data and cow's own storage" },
  { path: ".claude", what: "agent configuration" },
  { path: ".codex", what: "agent configuration" },
  { path: ".ssh", what: "SSH keys" },
  { path: ".aws", what: "cloud credentials" },
  { path: ".azure", what: "cloud credentials" },
  { path: ".kube", what: "cluster credentials" },
  { path: ".docker", what: "registry credentials" },
  { path: ".config", what: "configuration and credentials of many tools" },
  { path: ".gnupg", what: "GPG keys" },
  { path: ".password-store", what: "a password store" },
  { path: ".local/share/keyrings", what: "a keyring" },
  { path: "Library/Keychains", what: "the keychain" },
];

export interface ProtectedPlace {
  segments: string[];
  /** The path as shown. */
  path: string;
  what: string;
}

/** Every protected directory on this machine, as far as `places` says where things are. */
export function protectedPlaces(places: Places): ProtectedPlace[] {
  const found: ProtectedPlace[] = [];
  const home = places.home === null ? null : readPath(places.home);
  if (home?.ok) {
    for (const entry of PROTECTED_IN_HOME) {
      const segments = [...home.segments, ...entry.path.split("/")];
      found.push({ segments, path: `/${segments.join("/")}`, what: entry.what });
    }
  }
  const data = places.dataDir === null ? null : readPath(places.dataDir);
  if (data?.ok && data.segments.length > 0) found.push({ segments: data.segments, path: data.path, what: "bb's data and cow's own storage" });
  return found;
}

/**
 * Why a directory may not be granted, or null when it may. `segments` is a
 * path already read with `readPath`.
 */
export function directoryRefusal(segments: readonly string[], places: Places): string | null {
  if (segments.length === 0) return "it is the root of the filesystem: that is everything";
  const home = places.home === null ? null : readPath(places.home);
  if (home?.ok) {
    if (sameFolded(segments, home.segments)) return "it is your home directory: shell start-up files, keys and every tool's configuration are in it";
    if (insideFolded(segments, home.segments)) return `it contains your home directory (${home.path})`;
  }
  for (const place of protectedPlaces(places)) {
    if (sameFolded(segments, place.segments)) return `it is ${place.path}: ${place.what}`;
    if (insideFolded(place.segments, segments)) return `it is inside ${place.path}: ${place.what}`;
    if (insideFolded(segments, place.segments)) return `it contains ${place.path}: ${place.what}`;
  }
  return null;
}

/**
 * Read a directory as a person typed it for a rule: outer spaces are theirs
 * to lose, and the rest is read strictly and checked against the refusals.
 */
export function readDirectoryRule(raw: string, places: Places): { ok: true; dir: string } | { ok: false; why: string } {
  const read = readPath(typeof raw === "string" ? raw.trim() : raw);
  if (!read.ok) return { ok: false, why: `that directory cannot be used: ${read.why}` };
  const refused = directoryRefusal(read.segments, places);
  if (refused !== null) return { ok: false, why: `that directory is refused: ${refused}` };
  return { ok: true, dir: read.path };
}

/** The directory a file is in, for proposing a rule; null when the path cannot be read or has no parent. */
export function parentDirectory(file: string): string | null {
  const read = readPath(file);
  if (!read.ok || read.segments.length < 2) return null;
  return `/${read.segments.slice(0, -1).join("/")}`;
}
