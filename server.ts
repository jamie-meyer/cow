// cow's backend: remembers which thread is Main for each bb project, and
// keeps the note on each parked thread in that thread's plugin metadata.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAIN_CHANGED, PARKS_CHANGED, PARK_KEY, type ParkRecord, parkRecordSchema } from "./src/shared.ts";

const id = z.string().min(1).max(200);
const MAX_PARK_LIST = 5000;
/** bb reads plugin metadata for at most this many threads per request. */
const METADATA_PAGE = 200;

const mainStateSchema = z.object({
  /** Project id to that project's Main thread id. */
  mains: z.record(z.string(), z.string()),
  /** The project whose Main was chosen last; shown when bb names no project. */
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
  /** The park notes on these threads; threads without one are left out. */
  park_list: {
    input: z.object({ threadIds: z.array(id).max(MAX_PARK_LIST) }),
    output: z.object({ parks: z.record(z.string(), parkRecordSchema) }),
  },
  /** Park a thread, or with a null note, resume it. */
  park_set: {
    input: z.object({ threadId: id, park: parkRecordSchema.nullable() }),
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
      await bb.storage.kv.set(STATE_KEY, next);
      bb.realtime.publish(MAIN_CHANGED, {});
      return next;
    },
    park_list: async ({ threadIds }) => {
      const parks: Record<string, ParkRecord> = {};
      for (let offset = 0; offset < threadIds.length; offset += METADATA_PAGE) {
        const page = await bb.sdk.threads.experimental_listPluginMetadata({
          threadIds: threadIds.slice(offset, offset + METADATA_PAGE),
        });
        for (const { threadId, metadata } of page.threads) {
          const park = parkRecordSchema.safeParse(metadata[PARK_KEY]);
          if (park.success) parks[threadId] = park.data;
        }
      }
      return { parks };
    },
    park_set: async ({ threadId, park }) => {
      await bb.sdk.threads.updatePluginMetadata(
        park === null ? { threadId, remove: [PARK_KEY] } : { threadId, set: { [PARK_KEY]: park } },
      );
      bb.realtime.publish(PARKS_CHANGED, {});
      return null;
    },
  });
}
