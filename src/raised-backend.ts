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
import { failureOf } from "./briefs/provider.ts";
import type { DiffResult } from "./briefs/diff.ts";
import { firstMessageText } from "./briefs/task.ts";
import { cloneHostContract } from "./clone/contract.ts";
import { cloneProviderId } from "./clone/provider.ts";
import { RAISED_CHANGED } from "./raised.ts";
import { readActivity } from "./activity.ts";
import type { TraceInput } from "./traces.ts";

export { RAISED_CHANGED } from "./raised.ts";
export const CHECKER_TITLE = "cow check";
/** The largest brief file read from the machine the command ran on. */
const MAX_BRIEF_FILE = 400_000;
/** The largest evidence file read; the checker is given less (see BRIEF_LIMITS). */
const MAX_EVIDENCE_FILE = 1_000_000;
/** How long collecting a thread's diff may take on its machine. */
const DIFF_MS = 60_000;

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
  earlierContradicted: z.number().nullable().optional(),
  earlierTasks: z.number().nullable().optional(),
  rechecked: z.literal(true).optional(),
  tasks: z.number().optional(),
  flagged: z.number().optional(),
  failure: z.string().optional(),
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

/** Where an agent's taking an ask out of the person's queue is recorded: set once the capabilities are registered. */
export interface TraceSink {
  record: ((input: TraceInput) => Promise<void>) | null;
}

export function registerAttention(bb: BbPluginApi, traces: TraceSink = { record: null }): Attention {
  const settings = bb.settings.define({
    checkerModel: {
      type: "string",
      label: "Checker model",
      description: "The model that audits a brief, such as claude-haiku-5-5. Empty: the model of the thread that submitted the brief, when the checker runs on that thread's provider; otherwise the provider's default. A small model's \"supported\" is weaker than a large one's.",
      default: "",
    },
    checkerProvider: {
      type: "string",
      label: "Checker provider",
      description: "The provider the checker runs on, such as claude-code. Empty: the provider of the thread that submitted the brief.",
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
    checkerDiff: {
      type: "boolean",
      label: "Show the checker the diff",
      description:
        "Show the checker what the submitting thread changed: the changed files and their diff, from its git checkout, clipped. The diff is sent to the checker's model. Files that may hold secrets (.env, keys and the like) are named, never shown. Off: the checker sees the task, the claims and their evidence only.",
      default: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: cloneHostContract });

  const changed = () => bb.realtime.publish(RAISED_CHANGED, {});
  let personal: string | null = null;
  /** bb's personal project, where a checker's personal workspace is made. */
  const personalProject = async (): Promise<string> => {
    if (personal !== null) return personal;
    const found = (await bb.sdk.projects.list({ includePersonal: true })).find((project) => project.kind === "personal");
    if (!found) throw new Error("bb has no personal project to make a personal workspace in");
    personal = found.id;
    return personal;
  };
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
    spokeAt: async (threadId) => (await readActivity(bb.sdk.threads, threadId, { asking: false })).replies?.personSpokeAt ?? null,
    traced: async (input) => {
      if (traces.record === null) throw new Error("the log is not ready");
      await traces.record(input);
    },
    warn: (message) => bb.log.warn(message),
  });

  const look = async (threadId: string): Promise<CheckerSight> => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    if (!found || found.deletedAt != null) return { state: "gone", reply: null, tools: [] };
    if (found.status === "error") {
      // What bb recorded about the failed turn, so that the check can say why.
      const events = await bb.sdk.threads.events
        .list({ threadId, limit: "40", order: "desc", types: ["provider/error", "turn/completed"] as never })
        .catch(() => []);
      return { state: "error", reply: null, tools: [], failure: failureOf(events as readonly { type: string; data?: unknown }[]) };
    }
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
    machine: async (threadId) => {
      const found = await thread(threadId);
      if (!found?.environmentId) return null;
      return (await bb.sdk.environments.get({ environmentId: found.environmentId })).hostId ?? null;
    },
    execution: async (threadId) => {
      const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
      return { provider: found?.providerId ?? null, model: options?.model?.trim() ? options.model : null };
    },
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
      return { model: now.checkerModel.trim() || null, provider: now.checkerProvider.trim() || null, runs: now.checkerRuns, onSubmit: now.checkOnSubmit, diff: now.checkerDiff };
    },
    // cow reads the task itself: the first message the thread was started with, whatever the agent says it was.
    task: async (threadId) => {
      const events = await bb.sdk.threads.events.list({ threadId, limit: "5", order: "asc", types: ["client/turn/requested"] as never });
      return firstMessageText(events as readonly unknown[]);
    },
    // And collects the diff itself, in the thread's checkout, on the machine it is on.
    diff: async (threadId): Promise<DiffResult> => {
      const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
      if (!found?.environmentId) return { ok: false, why: "the agent's thread has no environment" };
      const environment = await bb.sdk.environments.get({ environmentId: found.environmentId }).catch(() => null);
      if (environment === null || environment.path === null || environment.status === "destroyed") return { ok: false, why: "the agent's thread has no checkout to read" };
      // A clone's workspace folder may be no git checkout and still bring repositories: the host entry reads those.
      if (!environment.isGitRepo && environment.environmentProviderId !== cloneProviderId(bb.pluginId)) return { ok: false, why: "the agent's thread's folder is not a git checkout" };
      const bases = [environment.mergeBaseBranch, environment.baseBranch, environment.defaultBranch].filter((name): name is string => typeof name === "string" && name.trim() !== "");
      const result = await host.call("brief_diff", { path: environment.path, bases }, { hostId: environment.hostId, timeoutMs: DIFF_MS });
      return result.status === "done" ? { ok: true, diff: result.diff } : { ok: false, why: result.why };
    },
    checker: {
      // The checker gets everything in its prompt and nothing else: a thread
      // of its own with no parent, so it shares no conversation and wakes
      // nobody, hidden, and in "accept-edits", the narrowest of bb's three
      // permission modes: edits in its workspace go ahead without asking,
      // and anything else (a command, a fetch, a path outside) is put to
      // the person for approval rather than run. bb has no mode that
      // refuses outright. It is told to use no tool, and its answer is
      // thrown away if it used one.
      // It reads nothing but its prompt, so it starts in a personal
      // workspace: an empty directory of its own in bb's personal project,
      // removed with the thread, with nothing in it to read or change. bb
      // makes one on its primary machine, and refuses when that machine is
      // not connected; then cow asks for one on the submitting thread's
      // machine (see `launch` in briefs/service.ts). It never starts in an
      // environment that holds someone's work.
      start: async ({ place, prompt, model, provider }) => {
        const spawned = await bb.sdk.threads.spawn({
          projectId: await personalProject(),
          environment: { type: "host" as const, ...(place.hostId === null ? {} : { hostId: place.hostId }), workspace: { type: "personal" as const } },
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
