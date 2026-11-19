// Exclusion patterns for a clone, matched against paths relative to the
// source. The rules are the familiar ones from ignore files, kept small:
//
// - A pattern with no slash matches an entry's name at any depth: `.env`,
//   `*.pem`, `id_rsa*`.
// - A pattern with a slash matches the whole relative path from the source:
//   `notes/private`, `build/*.log`. A leading slash is allowed and ignored.
// - `*` matches within one name, `?` one character, `**` any number of
//   whole names.
// - A trailing slash matches directories only.
//
// A directory that matches is left out with everything under it.

/** Left out unless the caller passes `includeSecrets: true`. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".aws",
  ".ssh",
  "*.sock",
  "*.socket",
  "*.pid",
];

export interface Matcher {
  /** `relative` uses `/` and has no leading slash. */
  matches(relative: string, isDirectory: boolean): boolean;
  readonly patterns: readonly string[];
}

interface Compiled {
  regex: RegExp;
  anyDepth: boolean;
  directoryOnly: boolean;
}

function escape(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function compile(pattern: string): Compiled {
  let body = pattern.trim();
  const directoryOnly = body.endsWith("/");
  if (directoryOnly) body = body.replace(/\/+$/, "");
  const anyDepth = !body.includes("/");
  body = body.replace(/^\/+/, "");
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === "*") {
      if (body[i + 1] === "*") {
        // `**/` is any number of whole names; a bare `**` is anything.
        if (body[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escape(char);
    }
  }
  return { regex: new RegExp(`^${out}$`), anyDepth, directoryOnly };
}

export function checkPattern(pattern: string): string | null {
  if (pattern.trim() === "" || pattern.trim() === "/") return "an exclude pattern is empty";
  if (pattern.includes("\0") || pattern.includes("\n")) return "an exclude pattern contains a NUL or a newline";
  if (pattern.length > 500) return "an exclude pattern is longer than 500 characters";
  return null;
}

export function createMatcher(patterns: readonly string[]): Matcher {
  const compiled = patterns.map(compile);
  return {
    patterns,
    matches(relative, isDirectory) {
      const name = relative.slice(relative.lastIndexOf("/") + 1);
      for (const rule of compiled) {
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.regex.test(rule.anyDepth ? name : relative)) return true;
      }
      return false;
    },
  };
}
