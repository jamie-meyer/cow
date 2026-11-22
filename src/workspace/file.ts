// The workspace file, `cow.workspace.json` at the top of a workspace folder:
// which repositories a thread brings, and the commands the person wrote to
// keep them in sync, set a clone up, bring a thread's work back, and tear a
// clone down before it is removed. Pure:
// the page, the server and the host entry all read it the same way.
//
// cow knows nothing about git or any other tool here: `sync`, `setup`,
// `back` and `teardown` are shell commands the person writes. They run with the person's
// full access, so cow runs them only from content the person approved (see
// ./store.ts), never from the file on disk.

import { z } from "zod";
import { checkPattern } from "../clone/glob.ts";
import { folderName, relativePath } from "../clone/names.ts";

export const WORKSPACE_FILE = "cow.workspace.json";
/** Published when a workspace is proposed, approved, dismissed, synced or brought back. */
export const WORKSPACES_CHANGED = "workspaces-changed";
/** A larger file is refused unread. */
export const MAX_FILE_BYTES = 256 * 1024;
export const COMMAND_KINDS = ["sync", "setup", "back", "teardown"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

const command = z
  .string()
  .min(1, "must not be empty")
  .max(4000)
  .refine((value) => !value.includes("\0"), "must not contain a NUL")
  .refine((value) => value.trim() !== "", "must not be only spaces");

const repoPath = z
  .string()
  .min(1, "must not be empty")
  .max(1024)
  .refine((value) => !value.includes("\n") && !value.includes("\0"), "must not contain a newline or a NUL");

export const workspaceFileSchema = z
  .object({
    /**
     * Repositories a thread brings: `path` relative to the workspace folder or absolute; `as` the folder name in the clone;
     * `branch` "thread" (the default) puts it on the thread's branch, "keep" leaves it on what it was copied on, with no branch made.
     */
    bring: z
      .array(
        z
          .object({ path: repoPath, as: folderName, branch: z.enum(["thread", "keep"]).optional(), sync: command.optional(), setup: command.optional(), back: command.optional(), teardown: command.optional() })
          .strict(),
      )
      .max(50)
      .default([]),
    /** The workspace folder's own commands. */
    sync: command.optional(),
    setup: command.optional(),
    back: command.optional(),
    /** Run when bb removes a clone, while it still exists: save leftover work, release what setup made. */
    teardown: command.optional(),
    readOnly: z.array(relativePath).max(200).default([]),
    exclude: z
      .array(
        z.string().superRefine((value, ctx) => {
          const problem = checkPattern(value);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        }),
      )
      .max(200)
      .default([]),
    includeSecrets: z.boolean().default(false),
    /** Sync a repository before cloning it when its last good sync is older than this. Off when absent. */
    syncBeforeClone: z.object({ olderThanMinutes: z.number().int().min(1).max(10080) }).strict().optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.bring.forEach((item, index) => {
      const key = item.as.normalize("NFC").toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["bring", index, "as"], message: `"${item.as}" is used twice (folder names on macOS ignore case)` });
      seen.add(key);
    });
  });
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** Where a field is, as the person wrote it: `bring[0].sync`. */
function fieldName(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) out += typeof part === "number" ? `[${part}]` : out === "" ? String(part) : `.${String(part)}`;
  return out;
}

export type Parsed = { ok: true; file: WorkspaceFile } | { ok: false; problems: string[] };

/** Read the file's text, strictly. Each problem names the field; an unknown field is refused, so a typo is never ignored. */
export function parseWorkspaceFile(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { ok: false, problems: [`${WORKSPACE_FILE} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problems: [`${WORKSPACE_FILE} must hold one JSON object`] };
  const parsed = workspaceFileSchema.safeParse(raw);
  if (parsed.success) return { ok: true, file: parsed.data };
  const problems = parsed.error.issues.map((issue) => {
    const where = fieldName(issue.path);
    if (issue.code === "unrecognized_keys") {
      const keys = (issue as { keys: string[] }).keys.map((key) => `"${key}"`).join(", ");
      return `${where === "" ? "" : `${where}: `}unknown field${(issue as { keys: string[] }).keys.length === 1 ? "" : "s"} ${keys}`;
    }
    return `${where === "" ? WORKSPACE_FILE : where}: ${issue.message}`;
  });
  return { ok: false, problems };
}

/** One command in a file: whose it is, which kind, and its text. `as` is null for the workspace folder's own. */
export interface CommandEntry {
  as: string | null;
  kind: CommandKind;
  text: string;
}

export function commandsOf(file: WorkspaceFile): CommandEntry[] {
  const found: CommandEntry[] = [];
  for (const kind of COMMAND_KINDS) if (file[kind] !== undefined) found.push({ as: null, kind, text: file[kind]! });
  for (const item of file.bring) for (const kind of COMMAND_KINDS) if (item[kind] !== undefined) found.push({ as: item.as, kind, text: item[kind]! });
  return found;
}

/** The commands `current` would run that `approved` does not run, for the same repository and kind, word for word. */
export function newCommands(approved: WorkspaceFile | null, current: WorkspaceFile): CommandEntry[] {
  const before = new Set((approved ? commandsOf(approved) : []).map((entry) => JSON.stringify([entry.as, entry.kind, entry.text])));
  return commandsOf(current).filter((entry) => !before.has(JSON.stringify([entry.as, entry.kind, entry.text])));
}

export const commandWhere = (entry: Pick<CommandEntry, "as" | "kind">): string => `${entry.as === null ? "the workspace folder" : entry.as}: ${entry.kind}`;

/** The command of one kind for a repository (`as`), or for the workspace folder (null). */
export function commandFor(file: WorkspaceFile, as: string | null, kind: CommandKind): string | null {
  if (as === null) return file[kind] ?? null;
  return file.bring.find((item) => item.as === as)?.[kind] ?? null;
}

/** Whether a brought repository is left on its own branch (`"branch": "keep"`): no thread branch is made in it. The workspace folder (null) never is. */
export function keepsBranch(file: WorkspaceFile, as: string | null): boolean {
  return as !== null && file.bring.find((item) => item.as === as)?.branch === "keep";
}

/** Why back skips a repository the workspace file left on its own branch. */
export const KEPT_WHY = 'left on its own branch ("branch": "keep"), so there is no thread branch to bring back; bring its commits back by hand, from the clone';

/** A brought path resolved against the workspace folder (both POSIX). */
export function resolveBringPath(folder: string, path: string): string {
  const joined = path.startsWith("/") ? path : `${folder.replace(/\/+$/, "")}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * A line diff of `before` against `after`, in unified form with the whole
 * file as context: the reader shows it as text. Files here are small, so a
 * plain longest-common-subsequence table does.
 */
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i * cols + j + 1]! > table[(i + 1) * cols + j]!)) {
      out.push(`+ ${b[j]}`);
      j += 1;
    } else {
      out.push(`- ${a[i]}`);
      i += 1;
    }
  }
  return out.join("\n");
}

/** What the reader shows for a change waiting on the person: the commands that would newly run first, then the diff. */
export function reviewText(args: { folder: string; approvedText: string | null; currentText: string; problems: readonly string[]; fresh: readonly CommandEntry[] }): string {
  const lines: string[] = [];
  lines.push(args.approvedText === null ? `${WORKSPACE_FILE} of ${args.folder}: never approved. The whole file:` : `${WORKSPACE_FILE} of ${args.folder}: approved against current.`);
  lines.push("");
  if (args.problems.length > 0) {
    lines.push("It cannot be approved as it is:");
    for (const problem of args.problems) lines.push(`  ${problem}`);
    lines.push("");
  }
  if (args.fresh.length === 0) lines.push("No command would newly run.");
  else {
    lines.push("Commands that would newly run, with your full access, outside any sandbox:");
    for (const entry of args.fresh) {
      lines.push(`  ${commandWhere(entry)}`);
      for (const line of entry.text.split("\n")) lines.push(`    ${line}`);
    }
  }
  lines.push("");
  lines.push(args.approvedText === null ? "The file:" : "The change (- approved, + current):");
  lines.push(lineDiff(args.approvedText ?? "", args.currentText));
  return `${lines.join("\n")}\n`;
}
