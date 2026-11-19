// The copy-on-write workspace as a bb environment provider. The server side
// only relays: the cloning and removing happen in cow's host entry, on the
// machine the thread runs on.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { cloneHostContract, cloneInputsSchema, cloneResourceSchema } from "./contract.ts";

/** Clones can be large; a call may run this long before bb gives up on it. */
const CREATE_TIMEOUT_MS = 30 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

/** The provider's id, derived from the plugin's, so a copy installed for checks registers its own. */
export const cloneProviderId = (pluginId: string) => `${pluginId}-clone`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerCloneProvider(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: cloneHostContract });
  bb.experimental_environments.register({
    id: cloneProviderId(bb.pluginId),
    displayName: "Copy-on-write workspace",
    description: "Clone a workspace folder and the repositories it needs with APFS copy-on-write (macOS only).",
    icon: "Copy",
    inputs: cloneInputsSchema,
    async create(context) {
      context.report.step("Cloning the workspace (copy-on-write)");
      try {
        const result = await host.call(
          "clone_create",
          { pathKey: context.pathKey, branch: context.suggestedBranchName, inputs: context.inputs },
          { hostId: context.host.id, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
        );
        if (result.status === "failed") return { status: "failed", message: result.message };
        const resource = cloneResourceSchema.parse(result.resource);
        const total = resource.counts.total;
        context.report.log(
          `${result.reused ? "Reused" : "Cloned"} ${total.entries} entries in ${total.chunks} chunk(s) and ${total.files} single file(s), ${total.excluded} excluded, in ${resource.totalMs} ms; branch ${resource.branch}.`,
        );
        for (const warning of resource.warnings) context.report.log(`Warning: ${warning}`);
        if (!(await context.experimental_claimPath(result.path))) {
          return { status: "failed", message: `${result.path} is already in use by another environment.` };
        }
        return {
          status: "created",
          path: result.path,
          ownsPath: true,
          ...(resource.source.head !== null && resource.source.branched ? { mergeBaseBranch: resource.source.head } : {}),
          resource,
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: message(error) };
      }
    },
    async remove(context) {
      if (context.hostId === null) return { status: "failed", message: "The machine that holds this clone is unknown." };
      context.report.step("Removing the copy-on-write workspace");
      try {
        // Only the path key goes to the host: the folder to delete is derived there, never taken from a path.
        const result = await host.call("clone_remove", { pathKey: context.pathKey }, { hostId: context.hostId, signal: context.signal, timeoutMs: REMOVE_TIMEOUT_MS });
        if (result.status === "failed") return result;
        if (result.killed > 0) context.report.log(`Stopped ${result.killed} process(es) working in the clone.`);
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: message(error) };
      }
    },
  });
}
