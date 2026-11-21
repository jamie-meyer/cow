// cow's backend: remembers which thread is Main for each bb project, keeps
// cow's notes on a thread (why it is parked, why it was archived, which
// refused permissions were dismissed) in that thread's plugin metadata, and
// registers the `bb cow` CLI.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CowError, createActions } from "./src/actions.ts";
import { Refusal } from "./src/kv.ts";
import { judgementSchema, rowSchema, type LedgerSummary } from "./src/ledger.ts";
import { registerLedger } from "./src/ledger-backend.ts";
import type { Spend } from "./src/spend.ts";
import { type TraceSink, registerAttention } from "./src/raised-backend.ts";
import { registerAutomations } from "./src/automations-backend.ts";
import { registerCard } from "./src/card-backend.ts";
import { registerCaps } from "./src/caps/backend.ts";
import { registerCloneProvider } from "./src/clone/provider.ts";
import { registerWorkspaces, workspaceCommands } from "./src/workspace/backend.ts";
import { createLogStore } from "./src/caps/logstore.ts";
import { registerSigning, sha256Hex } from "./src/signing/backend.ts";
import { capCommands } from "./src/caps/cli.ts";
import { cowCli } from "./src/cli.ts";
import {
  archiveNoteSchema,
  dismissalSchema,
  keepNoteSchema,
  nextNoteSchema,
  parkRecordSchema,
  projectMarkSchema,
  seenSchema,
  todoListSchema,
  waitNoteSchema,
} from "./src/shared.ts";

const id = z.string().min(1).max(200);
const MAX_NOTE_LIST = 5000;

const mainStateSchema = z.object({
  /** Project id to that project's Main thread id. */
  mains: z.record(z.string(), z.string()),
  /** The project whose Main was chosen last: where a new window starts. */
  currentProjectId: z.string().nullable(),
});
export type MainState = z.infer<typeof mainStateSchema>;

/**
 * What the page reads, and the notes anyone may leave: an agent leaves the
 * same ones with `bb cow`. What takes a line out of the person's queue
 * (seen, dismissed, a brief read), and recording which thread is Main, are
 * not here: those are signed calls.
 */
export const rpcContract = defineRpcContract({
  main_state: { input: z.null(), output: mainStateSchema },
  /** cow's notes on these threads; threads without one are left out. */
  notes_list: {
    input: z.object({ threadIds: z.array(id).max(MAX_NOTE_LIST) }),
    output: z.object({
      parks: z.record(z.string(), parkRecordSchema),
      archives: z.record(z.string(), archiveNoteSchema),
      dismissals: z.record(z.string(), dismissalSchema),
      nexts: z.record(z.string(), nextNoteSchema),
      todos: z.record(z.string(), todoListSchema),
      seen: z.record(z.string(), seenSchema),
      projects: z.record(z.string(), projectMarkSchema),
      waits: z.record(z.string(), waitNoteSchema),
      keeps: z.record(z.string(), keepNoteSchema),
    }),
  },
  /** Keep a thread on the Kept shelf, or with null take it off. The page's z; there is no command for it. */
  keep_set: {
    input: z.object({ threadId: id, keep: keepNoteSchema.nullable() }),
    output: z.null(),
  },
  /** Say a thread waits on someone other than the person, or with null that it no longer does. */
  wait_set: {
    input: z.object({ threadId: id, wait: waitNoteSchema.nullable() }),
    output: z.null(),
  },
  /** Mark a thread as a project, or with null, take the mark off. */
  project_set: {
    input: z.object({ threadId: id, project: projectMarkSchema.nullable() }),
    output: z.null(),
  },
  /** Take an item off a thread's list of work not started, or move it one place. */
  todo_change: {
    input: z.object({ threadId: id, itemId: id, change: z.enum(["remove", "up", "down"]) }),
    output: z.null(),
  },
  /** Park a thread, or with a null note, resume it. */
  park_set: {
    input: z.object({ threadId: id, park: parkRecordSchema.nullable() }),
    output: z.null(),
  },
  /** Record why a thread was archived, or with a null note, forget it. */
  archive_note_set: {
    input: z.object({ threadId: id, note: archiveNoteSchema.nullable() }),
    output: z.null(),
  },
  /**
   * The ledger: rows of the workers archived in the last `days` days, newest
   * first, their summary, and the latest outcome of every worker that has
   * one. Only reads; an outcome is set from the page by a signed call.
   */
  ledger_read: {
    input: z.object({ days: z.number().int().min(1).max(3650) }),
    output: z.object({
      rows: z.array(rowSchema),
      summary: z.custom<LedgerSummary>(),
      outcomes: z.record(z.string(), judgementSchema),
      /** Each row's list-price dollars, worked out now; null when its usage is unknown or its model has no price. */
      costs: z.record(z.string(), z.number().nullable()),
      priceError: z.string().nullable(),
    }),
  },
  /** A month's (YYYY-MM; default this one) tokens and list-price dollars under a Main, archived threads included. Only reads. */
  spend_read: {
    input: z.object({ mainId: id, month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/).optional() }),
    output: z.custom<Spend & { priceError: string | null }>(),
  },
  /**
   * Archive a thread in bb with cow's reason for it; a null reason forgets an
   * earlier one. `dropped` stops its turn first. A worker gets its ledger row,
   * archived by the person.
   */
  thread_archive: {
    input: z.object({ threadId: id, reason: z.string().min(1).max(300).nullable(), dropped: z.boolean(), at: z.number() }),
    output: z.null(),
  },
});

const STATE_KEY = "main-state";

export default async function plugin(bb: BbPluginApi) {
  async function readState(): Promise<MainState> {
    const stored = mainStateSchema.safeParse(await bb.storage.kv.get(STATE_KEY));
    return stored.success ? stored.data : { mains: {}, currentProjectId: null };
  }

  // What an agent takes out of the person's queue is traced in the log, once the log's owner is registered.
  const traces: TraceSink = { record: null };
  const attention = registerAttention(bb, traces);
  // A read-through of the automations plugin's own methods: never more than a few seconds, never an error.
  const automations = registerAutomations(bb);
  // The context card: bb's own git and pull-request plugins, and every plugin that offers `cow_card`. Only reads.
  registerCard(bb);
  // One log for capabilities and keys: one numbering, one chain.
  const log = createLogStore({ kv: bb.storage.kv, now: Date.now, hash: sha256Hex });
  // Workspace files: approved on the page, their commands run by the host entry from the approved content only.
  const workspaces = registerWorkspaces(bb, log);
  // A copy-on-write workspace a thread can be started in (macOS): `bb thread spawn --environment-provider <plugin id>-clone`.
  registerCloneProvider(bb, workspaces);
  const caps = registerCaps(bb, log);
  traces.record = async (input) => {
    await caps.trace(input);
  };
  // The ledger, the usage read from bb's events, the list prices and the month's spend. Its project marks are cow's notes.
  // (Called only once the actions below exist.)
  const ledgers = registerLedger(bb, async (ids) => Object.keys((await actions.notes(ids)).projects));
  const ledger = ledgers.ledger;
  const actions = createActions(bb, readState, {
    outside: async () => {
      const found = new Map<string, { id: string; text: string; at: number }[]>();
      for (const notice of (await caps.state()).notices) {
        if (notice.kind === "outside" && notice.threadId !== null) found.set(notice.threadId, [...(found.get(notice.threadId) ?? []), { id: notice.id, text: notice.text, at: notice.at }]);
      }
      return found;
    },
    openAsks: () => attention.asks.list(),
    automations,
    trace: async (input) => {
      await caps.trace(input);
    },
    traces: async () =>
      (await caps.state()).notices.flatMap((notice) =>
        notice.kind === "trace" && notice.trace !== null && notice.threadId !== null
          ? [{ id: notice.id, threadId: notice.threadId, actorThreadId: notice.trace.actorThreadId, action: notice.trace.action, text: notice.text, at: notice.at }]
          : [],
      ),
    marks: (ids) => attention.briefs.marks(ids),
    delivered: async () => {
      const found = new Map<string, number[]>();
      for (const ask of await attention.asks.list({ all: true })) {
        if (ask.deliveredAt !== null) found.set(ask.threadId, [...(found.get(ask.threadId) ?? []), ask.deliveredAt]);
      }
      return found;
    },
  }, ledger, ledgers.costing);

  const chooseMain = async (projectId: string, threadId: string | null): Promise<MainState> => {
      const state = await readState();
      const { [projectId]: _previous, ...others } = state.mains;
      const next: MainState =
        threadId === null
          ? {
              mains: others,
              currentProjectId: state.currentProjectId === projectId ? null : state.currentProjectId,
            }
          : { mains: { ...others, [projectId]: threadId }, currentProjectId: projectId };
      // Nothing is published: each window keeps the Main chosen in it.
      await bb.storage.kv.set(STATE_KEY, next);
      return next;
  };

  // Which Main a new window starts on decides whose queue it shows, so recording it is the person's too.
  // Marking a reply as seen, dismissing a refusal and marking a brief as read take a line out of the
  // person's queue, so they are the person's: reached only as signed calls, never as methods here.
  registerSigning(bb, log, caps, attention.asks, {
    setSeen: actions.setSeen,
    setDismissal: actions.setDismissal,
    readBrief: (threadId, version, read) => attention.briefs.read(threadId, version, read),
    chooseMain,
  }, async (threadId, outcome) => {
    try {
      return await actions.outcomeChecked({ callerId: null, threadId, outcome });
    } catch (cause) {
      // The signed call's refusals are the signing module's kind.
      if (cause instanceof CowError) throw new Refusal(cause.code, cause.message, cause.hint);
      throw cause;
    }
  }, workspaces);

  bb.rpc.register(rpcContract, {
    main_state: () => readState(),
    ledger_read: ({ days }) => actions.ledger(days),
    spend_read: ({ mainId, month }) => ledgers.spend(mainId, month),
    notes_list: ({ threadIds }) => actions.notes(threadIds),
    park_set: async ({ threadId, park }) => {
      await actions.setPark(threadId, park);
      return null;
    },
    archive_note_set: async ({ threadId, note }) => {
      await actions.setArchiveNote(threadId, note);
      return null;
    },
    wait_set: async ({ threadId, wait }) => {
      await actions.setWait(threadId, wait);
      return null;
    },
    keep_set: async ({ threadId, keep }) => {
      await actions.setKeep(threadId, keep);
      return null;
    },
    project_set: async ({ threadId, project }) => {
      await actions.setProject(threadId, project);
      return null;
    },
    todo_change: async ({ threadId, itemId, change }) => {
      await actions.todo(threadId, change === "remove" ? { kind: "take-id", id: itemId } : { kind: "move", id: itemId, by: change === "up" ? -1 : 1 });
      return null;
    },
    thread_archive: async (args) => {
      await actions.archive(args);
      return null;
    },
  });

  const titleOf = async (threadId: string) => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    return (typeof found?.title === "string" && found.title.trim()) || threadId;
  };
  const capabilityNames = async (threadIds: readonly string[]) => {
    const found = new Map<string, string[]>();
    // Nothing to look up when no capability is in force, which is the usual case.
    if (!(await caps.state()).capabilities.some((capability) => capability.deletedAt === null)) return found;
    for (const threadId of threadIds) {
      const names = (await caps.heldBy(threadId)).map((entry) => entry.capability.name);
      if (names.length > 0) found.set(threadId, names);
    }
    return found;
  };
  bb.cli.register(
    cowCli({ ...actions, spend: async (mainId, projectId, month) => {
      const main = await actions.mainFor(mainId, projectId);
      return { ...(await ledgers.spend(main, month)), mainTitle: await titleOf(main) };
    } }, attention, { ...capCommands(caps, attention.asks, titleOf), ...workspaceCommands(workspaces) }, capabilityNames, bb.pluginId),
  );

  // What cow keeps about a thread goes when bb deletes the thread; what was
  // deleted while cow was not running is found when it loads.
  bb.events.on("thread.deleted", ({ thread }) => {
    void actions.forget(thread.id).catch((cause: unknown) => bb.log.warn(`could not forget the deleted thread ${thread.id}: ${String(cause)}`));
  });
  const sweep = setTimeout(() => {
    void actions.sweep().catch((cause: unknown) => bb.log.warn(`could not clear records of deleted threads: ${String(cause)}`));
  }, 5000);
  bb.onDispose(() => clearTimeout(sweep));
}
