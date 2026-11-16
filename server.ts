// cow's backend: remembers which thread is Main for each bb project.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAIN_CHANGED } from "./src/shared.ts";

const id = z.string().min(1).max(200);

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
  });
}
