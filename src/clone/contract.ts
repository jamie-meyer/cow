// What the copy-on-write provider takes, and the calls between cow's server
// and its host entry (the process on the machine that does the cloning).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkPattern } from "./glob.ts";

const absolute = z
  .string()
  .min(2)
  .max(1024)
  .refine((value) => value.startsWith("/"), "must be an absolute path")
  .refine((value) => !value.includes("\n") && !value.includes("\0"), "must not contain a newline or a NUL");

/** One plain folder name: no slash, not only dots, nothing hidden in it. */
export const folderName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "must be one folder name, without slashes")
  .refine((value) => !/^\.+$/.test(value), "must not be only dots")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
  .refine((value) => value.trim() === value, "must not start or end with a space");

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/"), "must be relative to the workspace")
  .refine((value) => !value.split("/").some((part) => part === ".." || part === ""), "must not contain '..' or empty parts")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

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
});
export type CloneResource = z.infer<typeof cloneResourceSchema>;

const failed = z.object({ status: z.literal("failed"), message: z.string() });

export const cloneHostContract = defineRpcContract({
  clone_create: {
    input: z.object({ pathKey: z.string(), branch: z.string(), inputs: cloneInputsSchema }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("created"), path: z.string(), resource: cloneResourceSchema, reused: z.boolean() }), failed]),
  },
  clone_remove: {
    input: z.object({ pathKey: z.string() }),
    output: z.discriminatedUnion("status", [z.object({ status: z.literal("removed"), existed: z.boolean(), killed: z.number() }), failed]),
  },
});
