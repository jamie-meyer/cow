// cow's backend: remembers which thread is Main for each bb project, keeps
// cow's notes on a thread (why it is parked, why it was archived, which
// refused permissions were dismissed) in that thread's plugin metadata, and
// registers the `bb cow` CLI.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createActions } from "./src/actions.ts";
import { registerAttention } from "./src/raised-backend.ts";
import { registerCaps } from "./src/caps/backend.ts";
import { capCommands } from "./src/caps/cli.ts";
import { cowCli } from "./src/cli.ts";
import {
  archiveNoteSchema,
  dismissalSchema,
  nextNoteSchema,
  parkRecordSchema,
  projectMarkSchema,
  seenSchema,
  todoListSchema,
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

export const rpcContract = defineRpcContract({
  main_state: { input: z.null(), output: mainStateSchema },
  /** Make a thread its project's Main; a null thread forgets that project's Main. */
  main_choose: {
    input: z.object({ projectId: id, threadId: id.nullable() }),
    output: mainStateSchema,
  },
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
    }),
  },
  /** Mark a thread as a project, or with null, take the mark off. */
  project_set: {
    input: z.object({ threadId: id, project: projectMarkSchema.nullable() }),
    output: z.null(),
  },
  /** Record the reply of a thread the person has seen, or with null, forget it. */
  seen_set: {
    input: z.object({ threadId: id, seen: seenSchema.nullable() }),
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
  /** Dismiss a thread's refused permissions up to a place in its event log, or with null, show them again. */
  dismissal_set: {
    input: z.object({ threadId: id, dismissal: dismissalSchema.nullable() }),
    output: z.null(),
  },
  /**
   * Archive a thread in bb with cow's reason for it; a null reason forgets an
   * earlier one. `dropped` stops its turn first.
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

  const attention = registerAttention(bb);
  const actions = createActions(bb, readState, {
    openAsks: () => attention.asks.list(),
    marks: (ids) => attention.briefs.marks(ids),
    delivered: async () => {
      const found = new Map<string, number[]>();
      for (const ask of await attention.asks.list({ all: true })) {
        if (ask.deliveredAt !== null) found.set(ask.threadId, [...(found.get(ask.threadId) ?? []), ask.deliveredAt]);
      }
      return found;
    },
  });

  bb.rpc.register(rpcContract, {
    main_state: () => readState(),
    main_choose: async ({ projectId, threadId }) => {
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
    },
    notes_list: ({ threadIds }) => actions.notes(threadIds),
    park_set: async ({ threadId, park }) => {
      await actions.setPark(threadId, park);
      return null;
    },
    archive_note_set: async ({ threadId, note }) => {
      await actions.setArchiveNote(threadId, note);
      return null;
    },
    dismissal_set: async ({ threadId, dismissal }) => {
      await actions.setDismissal(threadId, dismissal);
      return null;
    },
    project_set: async ({ threadId, project }) => {
      await actions.setProject(threadId, project);
      return null;
    },
    seen_set: async ({ threadId, seen }) => {
      await actions.setSeen(threadId, seen);
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

  const caps = registerCaps(bb);
  const titleOf = async (threadId: string) => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    return (typeof found?.title === "string" && found.title.trim()) || threadId;
  };
  bb.cli.register(cowCli(actions, attention, capCommands(caps, attention.asks, titleOf)));

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
