// Asks and briefs, wired to bb: where they are stored, how an answer reaches
// a thread, how a checker's thread is started, watched and put away, and the
// RPC the page will use. `registerAttention` is everything the server entry
// needs to call.

import { type BbPluginApi, defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { askSchema } from "./asks/ask.ts";
import { createAsks } from "./asks/service.ts";
import type { Attention } from "./raised-cli.ts";
import { type CheckerSight, type CheckerSettings, MAX_RUNS, briefRecordSchema, createBriefs } from "./briefs/service.ts";
import { Refusal } from "./kv.ts";
import { RAISED_CHANGED } from "./raised.ts";

export { RAISED_CHANGED } from "./raised.ts";
export const CHECKER_TITLE = "cow check";
/** The largest brief file read from the machine the command ran on. */
const MAX_BRIEF_FILE = 400_000;
/** The largest evidence file read; the checker is given less (see BRIEF_LIMITS). */
const MAX_EVIDENCE_FILE = 1_000_000;

const id = z.string().min(1).max(200);
const markSchema = z.object({
  version: z.number(),
  state: z.enum(["unchecked", "running", "checked", "failed"]),
  contradicted: z.number(),
  notEstablished: z.number(),
  judgementCalls: z.number(),
  at: z.number(),
  read: z.boolean(),
  earlierDisputes: z.number().optional(),
  rechecked: z.literal(true).optional(),
});

/** What the page reads, and what anyone may do. Answering an ask, closing one as answered in chat, and marking a brief as read are the person's: they are signed calls (see signing/backend.ts). */
export const attentionRpcContract = defineRpcContract({
  /** Asks, oldest first: the open ones, or with `all`, every one. */
  asks_list: {
    input: z.object({ threadId: id.optional(), all: z.boolean().optional() }),
    output: z.object({
      asks: z.array(askSchema),
      /** For each thread with an open ask: when cow delivered the person's answers to its other asks. */
      delivered: z.record(z.string(), z.array(z.number())),
    }),
  },
  /** A thread's brief with its evidence and its check, or null when it has none. Read it with `review()`. */
  brief_get: {
    input: z.object({ threadId: id, version: z.number().int().min(1).optional() }),
    output: z.object({ record: briefRecordSchema.nullable(), versions: z.array(z.number()) }),
  },
  /** What each thread's latest brief says; threads without a brief are left out. */
  brief_marks: {
    input: z.object({ threadIds: z.array(id).max(5000) }),
    output: z.object({ marks: z.record(z.string(), markSchema) }),
  },
  /** Start a new check of a thread's latest brief. */
  brief_check: {
    input: z.object({ threadId: id, model: z.string().max(200).nullable().optional(), provider: z.string().max(200).nullable().optional(), runs: z.number().int().min(1).max(MAX_RUNS).optional() }),
    output: z.object({ record: briefRecordSchema }),
  },
});

const REFUSAL_CODES: Record<string, "conflict" | "invalid" | "not_found"> = {
  ask_not_found: "not_found",
  brief_not_found: "not_found",
  thread_not_found: "not_found",
  cannot_answer: "conflict",
  cannot_close: "conflict",
  check_running: "conflict",
};

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: REFUSAL_CODES[cause.code] ?? "invalid", message: cause.message });
    throw cause;
  }
}

/** Every tool a thread used, read from its timeline. */
export function toolsUsed(rows: readonly unknown[]): string[] {
  const used: string[] = [];
  const walk = (row: unknown) => {
    if (typeof row !== "object" || row === null) return;
    const r = row as Record<string, unknown>;
    if (r.kind === "work") used.push(String(r.toolName ?? r.workKind ?? "tool"));
    if (Array.isArray(r.children)) r.children.forEach(walk);
    if (Array.isArray(r.childRows)) r.childRows.forEach(walk);
  };
  rows.forEach(walk);
  return used;
}

export function registerAttention(bb: BbPluginApi): Attention {
  const settings = bb.settings.define({
    checkerModel: {
      type: "string",
      label: "Checker model",
      description: "The model that audits a brief, such as claude-haiku-5-5. Empty: bb's default for the project. A small model's \"supported\" is weaker than a large one's.",
      default: "",
    },
    checkerProvider: {
      type: "string",
      label: "Checker provider",
      description: "The provider the checker runs on, such as claude-code. Empty: bb's default for the project.",
      default: "",
    },
    checkerRuns: {
      type: "number",
      label: "Checker runs",
      description: `How many independent checkers audit each brief, 1 to ${MAX_RUNS}. With more than one, disagreement between them is shown per claim.`,
      experimental_schema: z.number().int().min(1).max(MAX_RUNS),
      default: 1,
    },
    checkOnSubmit: {
      type: "boolean",
      label: "Check a brief when it is submitted",
      default: true,
    },
  });

  const changed = () => bb.realtime.publish(RAISED_CHANGED, {});
  const thread = async (threadId: string) => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    return found ? { projectId: found.projectId, environmentId: found.environmentId ?? null } : null;
  };
  const ancestors = async (threadId: string) =>
    (await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId] })).threads.find((entry) => entry.threadId === threadId)?.ancestorIds ?? [];
  const storage = (threadId: string) => bb.sdk.threads.storageLocation({ threadId });
  const storageRoot = (threadId: string) =>
    storage(threadId).then(
      (location) => location.storageRootPath,
      () => null,
    );
  const readText = async (args: { hostId?: string; path: string; rootPath?: string }, max: number): Promise<string> => {
    const file = await bb.sdk.files.read(args);
    if (file.contentEncoding !== "utf8") throw new Error("it is not a text file");
    if (file.content.length > max) throw new Error(`it is over ${max} characters`);
    return file.content;
  };

  const asks = createAsks({
    kv: bb.storage.kv,
    now: Date.now,
    newId: () => randomUUID().replace(/-/g, "").slice(0, 8),
    thread,
    ancestors,
    storageRoot,
    send: async (threadId, text) => {
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    },
    changed,
  });

  const look = async (threadId: string): Promise<CheckerSight> => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    if (!found || found.deletedAt != null) return { state: "gone", reply: null, tools: [] };
    if (found.status === "error") return { state: "error", reply: null, tools: [] };
    if (found.status !== "idle") return { state: "running", reply: null, tools: [] };
    const [output, timeline] = await Promise.all([bb.sdk.threads.output({ threadId }), bb.sdk.threads.timeline({ threadId })]);
    const reply = typeof output.output === "string" && output.output.trim() !== "" ? output.output : null;
    return { state: "idle", reply, tools: toolsUsed(timeline.rows) };
  };

  const briefs = createBriefs({
    kv: bb.storage.kv,
    now: Date.now,
    newId: () => randomUUID().replace(/-/g, "").slice(0, 12),
    thread,
    ancestors,
    storageRoot,
    readEvidence: async (threadId, path) => {
      const location = await storage(threadId);
      return readText({ hostId: location.hostId, rootPath: location.storageRootPath, path: `${location.storageRootPath.replace(/\/+$/, "")}/${path}` }, MAX_EVIDENCE_FILE);
    },
    hasAsk: (askId, threadId) =>
      asks.get(askId).then(
        (ask) => ask.threadId === threadId,
        () => false,
      ),
    settings: async (): Promise<CheckerSettings> => {
      const now = await settings.get();
      return { model: now.checkerModel.trim() || null, provider: now.checkerProvider.trim() || null, runs: now.checkerRuns, onSubmit: now.checkOnSubmit };
    },
    checker: {
      // The checker gets the brief in its prompt and nothing else: a thread
      // of its own with no parent, so it shares no conversation and wakes
      // nobody, hidden, and in the mode where bb refuses whatever would
      // need the user's permission. It is told to use no tool, and its
      // answer is thrown away if it used one.
      start: async ({ projectId, environmentId, prompt, model, provider }) => {
        const spawned = await bb.sdk.threads.spawn({
          projectId,
          environment: environmentId === null ? { type: "project-default" } : { type: "reuse", environmentId },
          prompt,
          title: CHECKER_TITLE,
          visibility: "hidden",
          parentNotifications: "off",
          permissionMode: "accept-edits",
          pluginMetadata: { checker: true },
          ...(model === null ? {} : { model }),
          ...(provider === null ? {} : { providerId: provider }),
        });
        return spawned.id;
      },
      look,
      discard: async (threadId) => {
        await bb.sdk.threads.archive({ threadId }).catch(() => undefined);
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      },
    },
    changed,
  });

  bb.rpc.register(attentionRpcContract, {
    asks_list: async (filter) => {
      const every = await asks.list({ ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }), all: true });
      const open = new Set(every.filter((ask) => ask.status === "open").map((ask) => ask.threadId));
      const delivered: Record<string, number[]> = {};
      for (const ask of every) {
        if (ask.deliveredAt !== null && open.has(ask.threadId)) (delivered[ask.threadId] ??= []).push(ask.deliveredAt);
      }
      return { asks: filter.all === true ? every : every.filter((ask) => ask.status === "open"), delivered };
    },
    brief_get: async ({ threadId, version }) => {
      const versions = await briefs.versions(threadId);
      if (versions.length === 0) return { record: null, versions };
      return { record: await refusing(() => briefs.get(threadId, version)), versions };
    },
    brief_marks: async ({ threadIds }) => ({ marks: Object.fromEntries(await briefs.marks(threadIds)) }),
    brief_check: async ({ threadId, ...overrides }) => ({
      record: await refusing(() => briefs.check({ caller: null, threadId, ...overrides })),
    }),
  });

  // A checker's thread stopping is what moves its check along; so does the
  // plugin loading, for checks that finished while it was not running.
  bb.events.on("thread.idle", ({ thread: stopped }) => void briefs.checkerStopped(stopped.id));
  bb.events.on("thread.failed", ({ thread: stopped }) => void briefs.checkerStopped(stopped.id));
  const catchUp = setTimeout(() => {
    void briefs.settleAll().catch((cause: unknown) => bb.log.warn(`could not catch up on running checks: ${String(cause)}`));
    void asks.redeliver().catch((cause: unknown) => bb.log.warn(`could not deliver recorded answers: ${String(cause)}`));
  }, 2000);
  bb.onDispose(() => clearTimeout(catchUp));

  return {
    asks,
    briefs,
    readFile: async (threadId, path) => {
      // The file is on the machine the command ran on, which is the thread's machine.
      let hostId: string | undefined;
      if (threadId !== null) {
        const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
        if (found?.environmentId) hostId = (await bb.sdk.environments.get({ environmentId: found.environmentId })).hostId;
      }
      return readText({ ...(hostId === undefined ? {} : { hostId }), path }, MAX_BRIEF_FILE);
    },
  };
}
