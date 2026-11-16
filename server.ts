// cow's backend: remembers which thread is Main for each bb project, keeps
// cow's notes on a thread (why it is parked, why it was archived, which
// refused permissions were dismissed) in that thread's plugin metadata, and
// registers the `bb cow` CLI.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createActions } from "./src/actions.ts";
import { cowCli } from "./src/cli.ts";
import {
  archiveNoteSchema,
  dismissalSchema,
  nextNoteSchema,
  parkRecordSchema,
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
    }),
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

  const actions = createActions(bb, readState);

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

  bb.cli.register(cowCli(actions));
}
