// The copy-on-write workspace as a bb environment provider. The server side
// only relays: the cloning and removing happen in cow's host entry, on the
// machine the thread runs on.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Refusal } from "../kv.ts";
import type { Workspaces } from "../workspace/service.ts";
import { cloneHostContract, cloneResourceSchema, providerInputsSchema } from "./contract.ts";

/** Clones can be large; a call may run this long before bb gives up on it. */
const CREATE_TIMEOUT_MS = 30 * 60 * 1000;
/** Removal runs each repository's teardown first, up to 15 minutes each. */
const REMOVE_TIMEOUT_MS = 60 * 60 * 1000;

/** The provider's id, derived from the plugin's, so a copy installed for checks registers its own. */
export const cloneProviderId = (pluginId: string) => `${pluginId}-clone`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The thread a clone's path key is for (bb's keys start with its id), and its title, for the held notice. */
async function threadLabel(bb: BbPluginApi, pathKey: string): Promise<{ threadId: string | null; title: string | null }> {
  const threadId = /^(thr_[A-Za-z0-9]+)(?:-\d+)?$/.exec(pathKey)?.[1] ?? null;
  if (threadId === null) return { threadId, title: null };
  try {
    const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    const title = (thread as { title?: unknown } | undefined)?.title;
    return { threadId, title: typeof title === "string" && title !== "" ? title.slice(0, 400) : null };
  } catch {
    return { threadId, title: null };
  }
}

export function registerCloneProvider(bb: BbPluginApi, workspaces: Pick<Workspaces, "folderOf" | "approvedFor" | "forRemoval" | "noteHeld">): void {
  const host = bb.hosts.experimental_client({ contract: cloneHostContract });
  bb.experimental_environments.register({
    id: cloneProviderId(bb.pluginId),
    displayName: "Copy-on-write workspace",
    description: "Clone a workspace folder and the repositories it needs with APFS copy-on-write (macOS only).",
    icon: "Copy",
    inputs: providerInputsSchema,
    async create(context) {
      context.report.step("Cloning the workspace (copy-on-write)");
      try {
        const parsed = providerInputsSchema.parse(context.inputs);
        let call;
        if ("workspace" in parsed) {
          // Only what the person approved: the repositories, read-only paths, excludes and commands come from cow's storage, not from the inputs.
          let approved;
          try {
            approved = await workspaces.approvedFor(await workspaces.folderOf(parsed.workspace));
          } catch (cause) {
            if (cause instanceof Refusal) return { status: "failed", message: `${cause.message}${cause.hint ? ` ${cause.hint}` : ""}` };
            throw cause;
          }
          context.report.log(`From the approved workspace file of ${approved.folder} (${approved.hash.slice(0, 12)}).`);
          call = { pathKey: context.pathKey, branch: context.suggestedBranchName, inputs: null, workspace: { approved, pick: parsed.bring ?? null } };
        } else {
          call = { pathKey: context.pathKey, branch: context.suggestedBranchName, inputs: parsed, workspace: null };
        }
        const result = await host.call(
          "clone_create",
          call,
          { hostId: context.host.id, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
        );
        if (result.status === "failed") return { status: "failed", message: result.message };
        const resource = cloneResourceSchema.parse(result.resource);
        const total = resource.counts.total;
        context.report.log(
          `${result.reused ? "Reused" : "Cloned"} ${total.entries} entries in ${total.chunks} chunk(s) and ${total.files} single file(s), ${total.excluded} excluded, in ${resource.totalMs} ms; branch ${resource.branch}.`,
        );
        for (const warning of resource.warnings) context.report.log(`Warning: ${warning}`);
        if (resource.setups > 0) context.report.log(`Ran ${resource.setups} setup command(s).`);
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
        // Teardown runs from what the person approved now for the workspace the clone was made from, never from a file or the record.
        const resource = cloneResourceSchema.safeParse(context.resource);
        const approved = await workspaces.forRemoval(resource.success ? (resource.data.workspace?.folder ?? null) : null);
        const label = await threadLabel(bb, context.pathKey);
        // Only the path key goes to the host: the folder to delete is derived there, never taken from a path.
        const result = await host.call(
          "clone_remove",
          { pathKey: context.pathKey, approved, label },
          { hostId: context.hostId, signal: context.signal, timeoutMs: REMOVE_TIMEOUT_MS },
        );
        if (result.status === "failed") return result;
        if (result.killed > 0) context.report.log(`Stopped ${result.killed} process(es) working in the clone.`);
        for (const run of result.teardowns) {
          context.report.log(`Teardown of ${run.as ?? "the workspace folder"}: ${run.timedOut ? "stopped at its time limit" : `exit ${run.code}`} in ${(run.ms / 1000).toFixed(1)} s.`);
        }
        if (result.held !== null) {
          // Held, not deleted. bb is told it was removed: its environment is gone from where bb put it, and a failure would only have bb run teardown again and again.
          context.report.log(`Held, not deleted: ${result.held.reasons.join("; ")}. It is at ${result.held.path}; the user decides on cow's page (W).`);
          await workspaces.noteHeld({ id: result.held.id, threadId: label.threadId, reasons: result.held.reasons }).catch(() => {});
        }
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: message(error) };
      }
    },
  });
}
