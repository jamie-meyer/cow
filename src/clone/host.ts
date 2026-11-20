// cow's host entry: the process bb runs on the machine, with no sandbox,
// that makes and removes copy-on-write workspaces. cow's server calls it.
import { type ExperimentalHostRpcContext, experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { cloneHostContract } from "./contract.ts";
import { type CloneCall, startHelper } from "./helper.ts";
import { layout, removeClone, sweepTrash } from "./remove.ts";
import { createClone } from "./workspace.ts";
import { parseWorkspaceFile } from "../workspace/file.ts";
import { type CommandDeps, backCandidates, backFromClone, approvedFile, lastRun, readFolder, repoStatuses, syncWorkspace } from "../workspace/ops.ts";
import { RepoLocks, RunStore } from "../workspace/run.ts";

const locks = new RepoLocks();
const commandDeps = (dataDir: string): CommandDeps => ({ store: new RunStore(dataDir), locks });
const macOnly = () => {
  if (process.platform !== "darwin") throw new Error("cow's workspaces need macOS");
};

let helper: CloneCall | null = null;
let queue: Promise<unknown> = Promise.resolve();
let swept = false;

/** One clone or removal at a time: each holds renames on the volume briefly, and two would only take turns anyway. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

async function getHelper(): Promise<CloneCall> {
  helper ??= await startHelper();
  return helper;
}


/** Empty leftover trash once per worker, in the background, holding the worker until done. */
function sweepOnce(context: ExperimentalHostRpcContext): void {
  if (swept) return;
  swept = true;
  const lease = context.experimental_retainWorker();
  sweepTrash(layout(context.experimental_paths.dataDir))
    .catch(() => {})
    .finally(() => void lease.dispose());
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default experimental_defineHostEntry({
  contract: cloneHostContract,
  handlers: {
    clone_create: (input, context) =>
      serial(async () => {
        sweepOnce(context);
        try {
          const paths = layout(context.experimental_paths.dataDir);
          let call: CloneCall;
          try {
            call = await getHelper();
          } catch (error) {
            return { status: "failed" as const, message: message(error) };
          }
          const made = await createClone({
            paths,
            pathKey: input.pathKey,
            branch: input.branch,
            inputs: input.inputs,
            workspace: input.workspace,
            commands: commandDeps(context.experimental_paths.dataDir),
            helper: call,
            signal: context.signal,
          });
          return { status: "created" as const, path: made.path, resource: made.resource, reused: made.reused };
        } catch (error) {
          // A helper that died is started again on the next call.
          if (/clone helper/.test(message(error))) {
            helper?.close();
            helper = null;
          }
          return { status: "failed" as const, message: message(error) };
        }
      }),
    workspace_inspect: async (input, context) => {
      const store = new RunStore(context.experimental_paths.dataDir);
      const out = [];
      for (const item of input.items) {
        try {
          macOnly();
          const read = readFolder(item.folder);
          const listed = item.listText === null ? null : parseWorkspaceFile(item.listText);
          const current = read.text === null ? null : parseWorkspaceFile(read.text);
          const file = listed?.ok ? listed.file : current?.ok ? current.file : null;
          const repos = read.folder !== null && file !== null ? await repoStatuses(store, read.folder, file) : [];
          out.push({ folder: read.folder, text: read.text, error: read.error, repos });
        } catch (error) {
          out.push({ folder: null, text: null, error: message(error), repos: [] });
        }
      }
      return out;
    },
    workspace_sync: async (input, context) => {
      try {
        macOnly();
        return { status: "done" as const, results: await syncWorkspace(commandDeps(context.experimental_paths.dataDir), input.approved, input.only) };
      } catch (error) {
        return { status: "failed" as const, message: message(error) };
      }
    },
    workspace_back_preview: async (input, context) => {
      try {
        macOnly();
        const found = await backCandidates(layout(context.experimental_paths.dataDir), input.clonePath, input.approved ? approvedFile(input.approved) : null);
        return { status: "done" as const, ...found };
      } catch (error) {
        return { status: "failed" as const, message: message(error) };
      }
    },
    workspace_back: async (input, context) => {
      try {
        macOnly();
        const results = await backFromClone(commandDeps(context.experimental_paths.dataDir), layout(context.experimental_paths.dataDir), input.clonePath, input.approved);
        return { status: "done" as const, results };
      } catch (error) {
        return { status: "failed" as const, message: message(error) };
      }
    },
    workspace_output: async (input, context) => {
      try {
        const run = lastRun(new RunStore(context.experimental_paths.dataDir), input.approved, input.as, input.kind);
        return { status: "done" as const, run: run ? { at: run.at, ms: run.ms, code: run.code, timedOut: run.timedOut, tail: run.tail, cwd: run.cwd } : null };
      } catch (error) {
        return { status: "failed" as const, message: message(error) };
      }
    },
    clone_remove: (input, context) =>
      serial(async () => {
        sweepOnce(context);
        try {
          const removed = await removeClone(layout(context.experimental_paths.dataDir), input.pathKey);
          const lease = context.experimental_retainWorker();
          removed.deleting.catch(() => {}).finally(() => void lease.dispose());
          return { status: "removed" as const, existed: removed.removed, killed: removed.killed.length };
        } catch (error) {
          return { status: "failed" as const, message: message(error) };
        }
      }),
  },
  dispose: () => {
    helper?.close();
    helper = null;
  },
});
