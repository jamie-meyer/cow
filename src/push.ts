// The one route cow's notifications take: bb's push-notifications plugin.
// The usage notices and the worker notices both send through it.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PUSH_PLUGIN = "push-notifications";

/** Send the person a notification; rejects when it cannot. `what` names it in the log when no channel delivered it. */
export const pushNotify =
  (bb: BbPluginApi, what: string) =>
  async (title: string, body: string): Promise<void> => {
    const sent = await bb.sdk.plugins.callRpc({
      pluginId: PUSH_PLUGIN,
      method: "notifications.send",
      input: { title, body },
      outputSchema: z.object({ ok: z.literal(true), channels: z.array(z.string()) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (sent.channels.length === 0) bb.log.info(`a ${what} notification was sent, and no channel delivered it`);
  };
