// Workspaces, wired to bb: the host entry calls, the page's RPC, and the
// `bb cow workspace` commands. Approving, dismissing, bringing back and
// reading output are the person's, and are reached only as signed calls
// (../signing/backend.ts) — except `back` from a terminal outside any thread.

import { type BbPluginApi, PluginCliError, cliCommand, defineRpcContract } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { z } from "zod";
import { cloneHostContract } from "../clone/contract.ts";
import { cloneProviderId } from "../clone/provider.ts";
import type { LogStore } from "../caps/logstore.ts";
import { Refusal } from "../kv.ts";
import { sha256Hex } from "../signing/backend.ts";
import { formatAge } from "../text.ts";
import { WORKSPACE_FILE } from "./file.ts";
import { type BackPlan, type HostPort, type WorkspaceView, type Workspaces, createWorkspaces } from "./service.ts";

export const WORKSPACES_CHANGED = "workspaces-changed";
const CALL_MS = 60_000;
/** Sync runs each repository for up to 5 minutes, one after another. */
const SYNC_MS = 60 * 60_000;

const viewSchema = z.custom<WorkspaceView>();
const backPlanSchema = z.custom<BackPlan>();

/** What anyone may read or do. Approving, dismissing, back and output are signed calls. */
export const workspaceRpcContract = defineRpcContract({
  workspace_state: { input: z.null(), output: z.object({ workspaces: z.array(viewSchema) }) },
  /** Run the approved sync commands: anyone may, as `bb cow workspace sync` does. */
  workspace_sync: {
    input: z.object({ folder: z.string().max(1024).nullable(), only: z.string().max(255).nullable() }),
    output: z.object({ synced: z.array(z.object({ folder: z.string(), results: z.array(z.custom<import("../clone/contract.ts").SyncResultWire>()), error: z.string().nullable() })) }),
  },
  /** What bringing a thread's work back would run; reads only. */
  workspace_back_plan: { input: z.object({ threadId: z.string().min(1).max(200) }), output: backPlanSchema },
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerWorkspaces(bb: BbPluginApi, log: LogStore): Workspaces {
  const host = bb.hosts.experimental_client({ contract: cloneHostContract });
  const primary = async (): Promise<string> => {
    const config = (await bb.sdk.system.config()) as { primaryHostId?: unknown };
    if (typeof config.primaryHostId !== "string") throw new Refusal("no_host", "bb did not say which machine this is");
    return config.primaryHostId;
  };
  const failed = <T extends { status: string }>(result: T | { status: "failed"; message: string }): T => {
    if (result.status === "failed") throw new Refusal("host_failed", (result as { message: string }).message);
    return result as T;
  };
  const port: HostPort = {
    inspect: async (items) => host.call("workspace_inspect", { items }, { hostId: await primary(), timeoutMs: CALL_MS }),
    sync: async (approved, only) => failed(await host.call("workspace_sync", { approved, only }, { hostId: await primary(), timeoutMs: SYNC_MS })).results,
    backPreview: async (hostId, clonePath, approved) => failed(await host.call("workspace_back_preview", { clonePath, approved }, { hostId, timeoutMs: CALL_MS })),
    back: async (hostId, clonePath, approved) => failed(await host.call("workspace_back", { clonePath, approved }, { hostId, timeoutMs: SYNC_MS })).results,
    output: async (approved, as, kind) => failed(await host.call("workspace_output", { approved, as, kind }, { hostId: await primary(), timeoutMs: CALL_MS })).run,
  };
  const workspaces = createWorkspaces({
    kv: bb.storage.kv,
    log,
    hash: sha256Hex,
    now: Date.now,
    host: port,
    changed: () => bb.realtime.publish(WORKSPACES_CHANGED, {}),
    threadClone: async (threadId) => {
      const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
      if (!thread || thread.deletedAt != null || !thread.environmentId) return null;
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.environmentProviderId !== cloneProviderId(bb.pluginId) || environment.path === null) return null;
      return { hostId: environment.hostId, clonePath: environment.path };
    },
  });
  bb.rpc.register(workspaceRpcContract, {
    workspace_state: async () => ({ workspaces: await workspaces.views() }),
    workspace_sync: async ({ folder, only }) => ({ synced: await workspaces.sync(folder, only) }),
    workspace_back_plan: async ({ threadId }) => {
      const { clone: _clone, approved: _approved, ...plan } = await workspaces.backPlan(threadId);
      return plan;
    },
  });
  return workspaces;
}

// ---- the CLI -----------------------------------------------------------------

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;

async function acting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new PluginCliError(cause.message, { code: cause.code, hint: cause.hint });
    throw cause;
  }
}

const STATUS_TEXT: Record<WorkspaceView["status"], string> = {
  approved: "approved",
  changed: "changed since it was approved: waiting for the user on cow's page",
  new: "never approved: waiting for the user on cow's page",
  missing: "no workspace file",
  unreadable: "cannot be read",
};

export function viewText(view: WorkspaceView, now: number): string {
  const lines = [`${view.folder}`, `  ${WORKSPACE_FILE}: ${STATUS_TEXT[view.status]}${view.error ? ` (${view.error})` : ""}${view.approvedAt !== null && view.status !== "approved" ? ` · last approved ${formatAge(now - view.approvedAt)} ago` : ""}`];
  if (view.problems.length > 0) lines.push(`  problems: ${view.problems.join("; ")}`);
  for (const repo of view.repos) {
    const commands = (["sync", "setup", "back"] as const).filter((kind) => repo.commands[kind]);
    const sync = repo.sync === null ? "never synced" : `last sync ${formatAge(now - repo.sync.at)} ago, ${repo.sync.timedOut ? "stopped at its time limit" : `exit ${repo.sync.code}`}`;
    lines.push(
      `  ${(repo.as ?? ".").padEnd(14)} ${repo.exists ? (repo.dirty ? "dirty" : "clean") : "missing"} · ${sync} · commands: ${commands.length === 0 ? "none" : commands.join(", ")} · ${repo.path}`,
    );
  }
  return lines.join("\n");
}

const syncLine = (result: { as: string | null; status: string; code: number | null; ms: number | null; timedOut: boolean; why: string | null }) =>
  `  ${(result.as ?? ".").padEnd(14)} ${
    result.status === "ran" ? (result.timedOut ? "stopped at its time limit" : `exit ${result.code}`) + ` in ${((result.ms ?? 0) / 1000).toFixed(1)} s` : result.status === "dirty" ? `skipped: dirty (${result.why})` : result.status === "missing" ? `skipped: ${result.why}` : result.status === "no-command" ? "no sync command" : result.status
  }`;

export function workspaceCommands(workspaces: Workspaces, clonesFolder: string) {
  return {
    workspace: cliCommand({
      summary: "The workspace folders cow knows: whether each file is approved, and each repository's last sync",
      description:
        `Lists each workspace folder cow knows: whether its ${WORKSPACE_FILE} is approved, changed since, or missing; and each repository it brings, ` +
        "with its last sync (when, exit code), whether it has uncommitted changes now, and which commands it has (never their text). " +
        "A command's output is shown only to the user, on cow's page.",
      positionals: [{ name: "folder", description: "One workspace folder. Default: all", required: false }],
      options: { json },
      async run(input) {
        const folder = input.positionals.folder;
        const views = await acting(async () => (folder ? workspaces.views(await workspaces.folderOf(folder)) : workspaces.views()));
        if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, workspaces: views.map(({ review: _review, ...view }) => view) })}\n` };
        const now = Date.now();
        return { exitCode: 0, stdout: `${views.length === 0 ? "cow knows no workspace yet: `bb cow workspace add <folder>` proposes one" : views.map((view) => viewText(view, now)).join("\n\n")}\n` };
      },
    }),
    "workspace add": cliCommand({
      summary: "Propose a workspace folder: its file waits for the user's approval on cow's page",
      description:
        `Makes the folder known to cow, so a notice for its ${WORKSPACE_FILE} appears in the user's queue. This approves nothing and runs nothing: ` +
        "the commands in the file run only after the user approves its content on cow's page, and each later change waits for them again.",
      positionals: [{ name: "folder", description: "The workspace folder", required: true }],
      options: { json },
      async run(input) {
        const view = await acting(() => workspaces.propose(input.positionals.folder));
        const text = `${view.folder}: ${STATUS_TEXT[view.status]}${view.status === "approved" ? "" : view.status === "missing" ? ` · add ${WORKSPACE_FILE} there, then the user approves it` : " · nothing runs until the user approves it"}`;
        return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify({ ok: true, folder: view.folder, status: view.status, problems: view.problems })}\n` : `${text}\n` };
      },
    }),
    "workspace sync": cliCommand({
      summary: "Run the approved sync commands: each repository's, then the workspace folder's",
      description:
        "Runs each repository's approved sync command in the repository, then the workspace folder's own, one at a time, from the content the user " +
        "approved (never the file on disk). A git repository with uncommitted or untracked changes is skipped and reported, never touched. Anyone may " +
        "run it, so an automation can schedule it. Exits 1 when a command failed.",
      positionals: [{ name: "folder", description: "The workspace folder. Default: every approved one", required: false }],
      options: { only: { type: "string", description: "One repository, by its `as` (or . for the workspace folder)" }, json },
      async run(input) {
        const synced = await acting(() => workspaces.sync(input.positionals.folder ?? null, input.options.only ?? null));
        const failedAny = synced.some((entry) => entry.error !== null || entry.results.some((result) => result.status === "ran" && result.code !== 0));
        if (input.options.json) return { exitCode: failedAny ? 1 : 0, stdout: `${JSON.stringify({ ok: !failedAny, synced })}\n` };
        const text = synced.map((entry) => [entry.folder, ...(entry.error ? [`  failed: ${entry.error}`] : entry.results.map(syncLine))].join("\n")).join("\n\n");
        return { exitCode: failedAny ? 1 : 0, stdout: `${text}\n` };
      },
    }),
    "workspace back": cliCommand({
      summary: "Bring a thread's commits back: run the approved back command of each repository with new commits (the user's only)",
      description:
        "For each repository in the thread's copy-on-write workspace whose branch has commits its source does not have (against the commit recorded " +
        "when the clone was made), runs the approved back command in the source. This writes outside the thread's sandbox, so it is the user's alone: " +
        "from cow's page, or from a terminal outside any thread. A thread that runs it is refused: ask the user with `bb cow ask`.",
      positionals: [{ name: "thread", description: "The thread whose work to bring back", required: true }],
      options: { json },
      async run(input, ctx) {
        const inClone = typeof ctx.cwd === "string" && (ctx.cwd === clonesFolder || ctx.cwd.startsWith(`${clonesFolder}/`));
        if (ctx.threadId || inClone) {
          throw new PluginCliError("only the user brings a thread's work back: it runs commands outside the sandbox", {
            code: "person_only",
            hint: "Ask the user with `bb cow ask`: they bring it back from cow's page (B on the thread's line) or from their own terminal.",
          });
        }
        const id = input.positionals.thread.trim().replace(/^@?thread:/, "");
        const done = await acting(() => workspaces.back(id, null));
        if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...done })}\n` };
        const lines = done.results.map(
          (result) =>
            `  ${(result.as ?? ".").padEnd(14)} ${
              result.status === "ran" ? `${result.ahead} commit(s): ${result.timedOut ? "stopped at its time limit" : `exit ${result.code}`}` : result.status === "nothing-new" ? "nothing new" : `${result.status}${result.why ? `: ${result.why}` : ""}`
            }`,
        );
        return { exitCode: done.results.some((result) => result.status === "ran" && result.code !== 0) ? 1 : 0, stdout: `${[`${id} with the approved file of ${done.workspace}`, ...lines].join("\n")}\n` };
      },
    }),
  };
}

/** Where a thread's copy-on-write workspace lives, as the server can name it: under cow's host data folder. */
export const clonesFolderOf = (dataDir: string, pluginId: string) => join(dataDir, "plugins", pluginId, "host-data", "clones");
export { message as errorText };
