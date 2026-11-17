// What kind of thing a file is to the reader, and what it does with a diff
// as bb's timeline gives it. Pure.

export type FileKind = "markdown" | "image" | "source";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

export function fileKind(path: string): FileKind {
  if (IMAGE.test(path)) return "image";
  return MARKDOWN.test(path) ? "markdown" : "source";
}

/** Above this many lines, or characters, a file is shown as plain text: bb's viewer draws every line at once. */
export const PLAIN_ABOVE = { lines: 6000, chars: 600_000 } as const;
/** Above this many characters only the start of a file is shown. */
export const CUT_ABOVE = 3_000_000;

/** A size for people: 812 B, 14 KB, 2.3 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The lines of a text, without the empty one a final newline leaves. */
export function textLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface Patch {
  /** A unified patch for one file, with a header for every hunk. */
  text: string;
  /** The two sides, as the patch names them. */
  before: string;
  after: string;
  added: number;
  removed: number;
}

/**
 * Make a patch bb's diff viewer can draw from what a timeline row holds.
 * bb records a new file's change without a hunk header, which its viewer
 * shows as plain text; a header is worked out here from the lines. `path`
 * names both sides, except one that is `/dev/null`.
 */
export function toPatch(diff: string, path: string): Patch {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let before = path;
  let after = path;
  const head: string[] = [];
  let at = 0;
  for (; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith("--- ")) before = line.slice(4).trim();
    else if (line.startsWith("+++ ")) after = line.slice(4).trim();
    else if (!/^(diff --git |index |new file mode |deleted file mode |similarity index |rename (from|to) |old mode |new mode )/.test(line)) break;
    head.push(line);
  }
  const body = lines.slice(at);
  let added = 0;
  let removed = 0;
  let kept = 0;
  for (const line of body) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
    else kept += 1;
  }
  // bb names a side by its absolute path without the leading slash; the reader names it as it names the file.
  const side = (name: string) => (name === "/dev/null" ? name : path);
  const named = [`--- ${before === "/dev/null" ? before : `a/${path}`}`, `+++ ${after === "/dev/null" ? after : `b/${path}`}`];
  const hunked = body.some((line) => line.startsWith("@@"));
  const header = `@@ -${removed + kept === 0 ? "0,0" : `1,${removed + kept}`} +${added + kept === 0 ? "0,0" : `1,${added + kept}`} @@`;
  const text = [...named, ...(hunked || body.length === 0 ? [] : [header]), ...body].join("\n") + "\n";
  return { text, before: side(before), after: side(after), added, removed };
}
