// What the copy-on-write provider takes, and the calls between cow's server
// and its host entry (the process on the machine that does the cloning).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkPattern } from "./glob.ts";
import { folderName, relativePath } from "./names.ts";

export { folderName };

const absolute = z
  .string()
  .min(2)
  .max(1024)
  .refine((value) => value.startsWith("/"), "must be an absolute path")
  .refine((value) => !value.includes("\n") && !value.includes("\0"), "must not contain a newline or a NUL");

export const cloneInputsSchema = z
  .object({
    /** The workspace folder: rules and notes, no projects. */
    source: absolute,
    /** Repositories to clone into the workspace, each under its own folder name. */
    bring: z.array(z.object({ path: absolute, as: folderName }).strict()).max(50).default([]),
    /** Paths in the clone made read-only for everyone after cloning. */
    readOnly: z.array(relativePath).max(200).default([]),
    /** Glob patterns, relative to each cloned folder, never cloned. */
    exclude: z
      .array(z.string().superRefine((value, ctx) => {
        const problem = checkPattern(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }))
      .max(200)
      .default([]),
    /** Drop the default exclusions (.env, keys, .ssh, sockets…). */
    includeSecrets: z.boolean().default(false),
  })
  .strict()
  .superRefine((inputs, ctx) => {
    const seen = new Set<string>();
    inputs.bring.forEach((item, index) => {
      const key = item.as.normalize("NFC").toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["bring", index, "as"], message: `"${item.as}" is used twice (folder names on macOS ignore case)` });
      seen.add(key);
    });
  });

export type CloneInputs = z.infer<typeof cloneInputsSchema>;

/** Starting from a workspace file: the repositories, read-only paths and excludes come from its approved content. */
export const workspaceInputsSchema = z
  .object({
    /** The workspace folder, whose cow.workspace.json the person approved. */
    workspace: absolute,
    /** Which repositories to bring, by `as`. Default: all of them. */
    bring: z.array(folderName).max(50).optional(),
  })
  .strict();
export type WorkspaceInputs = z.infer<typeof workspaceInputsSchema>;

/** What the provider takes: explicit inputs, or a workspace folder with an approved file. */
export const providerInputsSchema = z.union([workspaceInputsSchema, cloneInputsSchema]);

const repoRecord = z.object({
  path: z.string(),
  as: z.string().nullable(),
  /** HEAD when cloned; null for a folder that is not a git repository or has no commit. */
  head: z.string().nullable(),
  /** Whether it had uncommitted, staged or untracked changes (they came along). */
  dirty: z.boolean().nullable(),
  /** Whether the clone's copy is on the thread's branch. */
  branched: z.boolean(),
});

const countsRecord = z.object({
  entries: z.number(),
  chunks: z.number(),
  files: z.number(),
  excluded: z.number(),
  skipped: z.number(),
  ms: z.number(),
});

export const cloneResourceSchema = z.object({
  kind: z.literal("cow-clone"),
  version: z.literal(1),
  path: z.string(),
  branch: z.string(),
  source: repoRecord,
  bring: z.array(repoRecord),
  counts: z.object({ total: countsRecord, parts: z.array(countsRecord.extend({ as: z.string().nullable() })) }),
  helper: z.string(),
  totalMs: z.number(),
  warnings: z.array(z.string()),
  /** The approved workspace file it was made from, by its hash; null for explicit inputs. */
  workspace: z.object({ folder: z.string(), hash: z.string() }).nullable().default(null),
  /** How many setup commands ran. */
  setups: z.number().default(0),
});
export type CloneResource = z.infer<typeof cloneResourceSchema>;

const failed = z.object({ status: z.literal("failed"), message: z.string() });

/** Content the person approved, passed from cow's server: the only place a command is ever read from. */
export const approvedSchema = z.object({ folder: absolute, text: z.string().max(256 * 1024), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const commandKind = z.enum(["sync", "setup", "back"]);
const runSummary = z.object({ at: z.number(), ms: z.number(), code: z.number().nullable(), timedOut: z.boolean() });
const repoStatus = z.object({
  as: z.string().nullable(),
  path: z.string(),
  exists: z.boolean(),
  dirty: z.boolean().nullable(),
  commands: z.object({ sync: z.boolean(), setup: z.boolean(), back: z.boolean() }),
  sync: runSummary.nullable(),
  lastOkSyncAt: z.number().nullable(),
});
export type RepoStatusWire = z.infer<typeof repoStatus>;
const syncResult = z.object({
  as: z.string().nullable(),
  path: z.string(),
  status: z.enum(["ran", "dirty", "no-command", "missing"]),
  code: z.number().nullable(),
  ms: z.number().nullable(),
  timedOut: z.boolean(),
  why: z.string().nullable(),
});
export type SyncResultWire = z.infer<typeof syncResult>;
const backResult = z.object({
  as: z.string().nullable(),
  source: z.string(),
  status: z.enum(["ran", "nothing-new", "no-command", "skipped"]),
  ahead: z.number().nullable(),
  code: z.number().nullable(),
  ms: z.number().nullable(),
  timedOut: z.boolean(),
  why: z.string().nullable(),
});
export type BackResultWire = z.infer<typeof backResult>;
const backCandidate = z.object({ as: z.string().nullable(), source: z.string(), clone: z.string(), ahead: z.number().nullable(), hasCommand: z.boolean(), why: z.string().nullable() });
export type BackCandidateWire = z.infer<typeof backCandidate>;

export const cloneHostContract = defineRpcContract({
  clone_create: {
    input: z.object({
      pathKey: z.string(),
      branch: z.string(),
      /** Explicit inputs; or, with `workspace`, null. */
      inputs: cloneInputsSchema.nullable(),
      /** The approved workspace file, and which of its repositories to bring (null: all). */
      workspace: z.object({ approved: approvedSchema, pick: z.array(folderName).nullable() }).nullable().default(null),
    }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("created"), path: z.string(), resource: cloneResourceSchema, reused: z.boolean() }), failed]),
  },
  /** Resolve workspace folders and read their files, with each repository's state by the given file's list. Shows no command text. */
  workspace_inspect: {
    input: z.object({ items: z.array(z.object({ folder: z.string(), listText: z.string().nullable() })).max(100) }),
    output: z.array(z.object({ folder: z.string().nullable(), text: z.string().nullable(), error: z.string().nullable(), repos: z.array(repoStatus) })),
  },
  workspace_sync: {
    input: z.object({ approved: approvedSchema, only: z.string().nullable() }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("done"), results: z.array(syncResult) }), failed]),
  },
  /** Which repositories of a clone have new commits; reads only. */
  workspace_back_preview: {
    input: z.object({ clonePath: z.string(), approved: approvedSchema.nullable() }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("done"), branch: z.string(), workspace: z.string().nullable(), repos: z.array(backCandidate) }), failed]),
  },
  workspace_back: {
    input: z.object({ clonePath: z.string(), approved: approvedSchema }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("done"), results: z.array(backResult) }), failed]),
  },
  /** A repository's last run of one kind, its output included. cow's server asks only for a signed call. */
  workspace_output: {
    input: z.object({ approved: approvedSchema, as: z.string().nullable(), kind: commandKind }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("done"), run: z.object({ at: z.number(), ms: z.number(), code: z.number().nullable(), timedOut: z.boolean(), tail: z.array(z.string()), cwd: z.string() }).nullable() }),
      failed,
    ]),
  },
  clone_remove: {
    input: z.object({ pathKey: z.string() }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("removed"), existed: z.boolean(), killed: z.number() }), failed]),
  },
});
