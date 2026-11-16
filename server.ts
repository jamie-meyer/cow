// cow's backend: remembers which thread is Main for each bb project, and
// keeps cow's notes on a thread (why it is parked, why it was archived) in
// that thread's plugin metadata.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ARCHIVE_KEY,
  type ArchiveNote,
  NOTES_CHANGED,
  PARK_KEY,
  type ParkRecord,
  archiveNoteSchema,
  parkRecordSchema,
} from "./src/shared.ts";

const id = z.string().min(1).max(200);
const MAX_NOTE_LIST = 5000;
/** bb reads plugin metadata for at most this many threads per request. */
const METADATA_PAGE = 200;

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
    }),
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
});

const STATE_KEY = "main-state";

export default async function plugin(bb: BbPluginApi) {
  async function readState(): Promise<MainState> {
    const stored = mainStateSchema.safeParse(await bb.storage.kv.get(STATE_KEY));
    return stored.success ? stored.data : { mains: {}, currentProjectId: null };
  }

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
    notes_list: async ({ threadIds }) => {
      const parks: Record<string, ParkRecord> = {};
      const archives: Record<string, ArchiveNote> = {};
      for (let offset = 0; offset < threadIds.length; offset += METADATA_PAGE) {
        const page = await bb.sdk.threads.experimental_listPluginMetadata({
          threadIds: threadIds.slice(offset, offset + METADATA_PAGE),
        });
        for (const { threadId, metadata } of page.threads) {
          const park = parkRecordSchema.safeParse(metadata[PARK_KEY]);
          if (park.success) parks[threadId] = park.data;
          const archive = archiveNoteSchema.safeParse(metadata[ARCHIVE_KEY]);
          if (archive.success) archives[threadId] = archive.data;
        }
      }
      return { parks, archives };
    },
    park_set: async ({ threadId, park }) => {
      await bb.sdk.threads.updatePluginMetadata(
        park === null ? { threadId, remove: [PARK_KEY] } : { threadId, set: { [PARK_KEY]: park } },
      );
      bb.realtime.publish(NOTES_CHANGED, {});
      return null;
    },
    archive_note_set: async ({ threadId, note }) => {
      await bb.sdk.threads.updatePluginMetadata(
        note === null ? { threadId, remove: [ARCHIVE_KEY] } : { threadId, set: { [ARCHIVE_KEY]: note } },
      );
      bb.realtime.publish(NOTES_CHANGED, {});
      return null;
    },
  });
}
