// Workspaces on the page: the notices of workspace files waiting for the
// person, the review of one in the reader (approve with a, dismiss with x),
// and W's sheet listing each workspace and its repositories with their last
// sync, where s syncs the selected repository and S all of them. Approving,
// dismissing, reading a command's output and bringing work back are signed.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { OpenTarget } from "../reader/files.ts";
import type { Signer } from "../signing/page.ts";
import { formatAge } from "../text.ts";
import type { workspaceRpcContract } from "./backend.ts";
import { WORKSPACES_CHANGED, WORKSPACE_FILE } from "./file.ts";
import type { BackPlan, WorkspaceView } from "./service.ts";
import type { HeldWire } from "../clone/contract.ts";
import { type HoldReason, lossText, reasonText } from "../clone/judge.ts";

/** A file changed on disk says nothing to cow: the page looks again this often. */
const LOOK_EVERY_MS = 10_000;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export interface WorkspacesData {
  views: readonly WorkspaceView[];
  error: string | null;
  reload: () => void;
  sync: (folder: string | null, only: string | null) => Promise<string>;
  approve: (view: WorkspaceView) => Promise<string>;
  dismiss: (view: WorkspaceView) => Promise<string>;
  output: (folder: string, as: string | null) => Promise<string>;
  backPlan: (threadId: string) => Promise<BackPlan>;
  back: (threadId: string) => Promise<string>;
  /** Clones bb removed that cow held back, since work might be lost with them. */
  held: readonly HeldWire[];
  heldError: string | null;
  heldOutput: (entry: HeldWire) => Promise<string>;
  teardownHeld: (entry: HeldWire) => Promise<string>;
  removeHeld: (entry: HeldWire) => Promise<string>;
}

export function useWorkspaces(signer: Signer): WorkspacesData {
  const rpc = useRpc<typeof workspaceRpcContract>();
  const [views, setViews] = useState<readonly WorkspaceView[]>([]);
  const [held, setHeld] = useState<readonly HeldWire[]>([]);
  const [heldError, setHeldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    rpc.call("workspace_state", null).then(
      (state) => {
        if (seq !== request.current) return;
        setViews(state.workspaces);
        setHeld(state.held);
        setHeldError(state.heldError);
        setError(null);
      },
      (cause: unknown) => {
        if (seq === request.current) setError(errorText(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, LOOK_EVERY_MS);
    return () => clearInterval(timer);
  }, [reload]);
  useRealtime(WORKSPACES_CHANGED, reload);

  return useMemo(
    () => ({
      views,
      error,
      reload,
      sync: async (folder, only) => {
        const { synced } = await rpc.call("workspace_sync", { folder, only });
        reload();
        const results = synced.flatMap((entry) => entry.results);
        const ran = results.filter((result) => result.status === "ran");
        const failed = ran.filter((result) => result.code !== 0).length + synced.filter((entry) => entry.error !== null).length;
        const dirty = results.filter((result) => result.status === "dirty").map((result) => result.as ?? ".");
        return `synced ${ran.length} ${ran.length === 1 ? "repository" : "repositories"}${failed > 0 ? `, ${failed} failed` : ""}${dirty.length > 0 ? ` · skipped, dirty: ${dirty.join(", ")}` : ""}`;
      },
      approve: async (view) => {
        if (view.currentHash === null) throw new Error("there is no file to approve");
        const done = await signer.call("workspace_approve", { folder: view.folder, hash: view.currentHash });
        reload();
        return `approved the workspace file of ${view.folder}: ${done.newCommands === 0 ? "no new command" : `${done.newCommands} new or changed ${done.newCommands === 1 ? "command" : "commands"} will run from now on`}`;
      },
      dismiss: async (view) => {
        if (view.currentHash === null) throw new Error("there is no file to dismiss");
        await signer.call("workspace_dismiss", { folder: view.folder, hash: view.currentHash });
        reload();
        return `dismissed without approving: the approved content still runs, until you approve a change`;
      },
      output: async (folder, as) => {
        const run = await signer.call("workspace_output", { folder, as, kind: "sync" });
        if (run === null) return "never synced: there is no output to show";
        return [`last sync of ${as ?? "the workspace folder"} in ${run.cwd}`, `${new Date(run.at).toLocaleString()} · ${(run.ms / 1000).toFixed(1)} s · ${run.timedOut ? "stopped at its time limit" : `exit ${run.code}`}`, "", ...run.tail, ""].join("\n");
      },
      backPlan: (threadId) => rpc.call("workspace_back_plan", { threadId }),
      back: async (threadId) => {
        const done = await signer.call("workspace_back", { threadId });
        const ran = done.results.filter((result) => result.status === "ran");
        if (ran.length === 0) return "nothing was brought back: no repository has new commits with a back command";
        return `brought back: ${ran.map((result) => `${result.as ?? "the workspace folder"} ${result.timedOut ? "stopped at its time limit" : `exit ${result.code}`}`).join(", ")}`;
      },
      held,
      heldError,
      heldOutput: async (entry) => {
        const done = await signer.call("workspace_held_output", { id: entry.id });
        if (done.teardowns.length === 0) return `no teardown ran for the held clone at ${done.path}: there is no output to show\n`;
        return done.teardowns
          .flatMap((run) => [`teardown of ${run.as ?? "the workspace folder"} · ${new Date(run.at).toLocaleString()} · ${(run.ms / 1000).toFixed(1)} s · ${run.timedOut ? "stopped at its time limit" : `exit ${run.code}`}`, "", ...run.tail, ""])
          .join("\n");
      },
      teardownHeld: async (entry) => {
        const done = await signer.call("workspace_held_teardown", { id: entry.id });
        reload();
        return done.removed ? `teardown exited 0: the held clone ${entry.id} is removed` : `still held: ${done.reasons.join("; ")}`;
      },
      removeHeld: async (entry) => {
        await signer.call("workspace_held_remove", { id: entry.id });
        reload();
        return `removed the held clone ${entry.id} for good`;
      },
    }),
    [views, error, held, heldError, reload, rpc, signer],
  );
}

/** The reader's view of a file waiting on the person: a approves exactly what is shown, x dismisses it. */
export function reviewTarget(data: WorkspacesData, view: WorkspaceView): OpenTarget {
  const actions = [
    ...(view.problems.length === 0 && view.currentHash !== null ? [{ key: "a", label: "approve exactly this", run: async () => ({ note: await data.approve(view), close: true }) }] : []),
    { key: "x", label: "dismiss without approving", run: async () => ({ note: await data.dismiss(view), close: true }) },
  ];
  return { kind: "text", threadId: null, title: `${WORKSPACE_FILE} of ${view.folder}`, content: view.review ?? "", actions };
}

export function backConfirmText(plan: BackPlan): string {
  const lines = plan.repos.filter((repo) => (repo.ahead ?? 0) > 0);
  if (lines.length === 0) return "";
  return `bring back ${lines.map((repo) => `${repo.as ?? "the workspace folder"} (${repo.ahead} commit${repo.ahead === 1 ? "" : "s"}): ${repo.command === null ? "no back command, skipped" : `runs ${repo.command}`}`).join("; ")}, in each source, with your full access?`;
}

/** What a held clone is called on the page: its thread's title, else its thread, else its id. */
export const heldName = (entry: HeldWire) => entry.title ?? entry.threadId ?? entry.id;
export const heldReasons = (entry: HeldWire) => (entry.reasons as HoldReason[]).map(reasonText);

/** The y confirmation of removing a held clone for good: it names what would be lost. */
export function heldRemoveText(entry: HeldWire): string {
  const lost = entry.unsaved.map((repo) => lossText(repo.as, repo.unsaved)).filter((line): line is string => line !== null);
  return `remove the held clone of ${heldName(entry)} for good? Lost with it: ${lost.length === 0 ? "nothing cow can see as unsaved" : lost.join("; ")}, and everything else in ${entry.path} · y removes, any other key keeps it`;
}

type Row = { kind: "repo"; folder: string; as: string | null } | { kind: "held"; id: string };

export function useWorkspaceSheet(args: { data: WorkspacesData; openReader: (target: OpenTarget) => void; say: (text: string) => void }) {
  const { data } = args;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [note, setNote] = useState("");
  /** The held clone whose removal waits on y. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const rows: Row[] = useMemo(
    () => [
      ...data.views.flatMap((view) => view.repos.map((repo) => ({ kind: "repo" as const, folder: view.folder, as: repo.as }))),
      ...data.held.map((entry) => ({ kind: "held" as const, id: entry.id })),
    ],
    [data.views, data.held],
  );
  const index = Math.min(at, Math.max(0, rows.length - 1));
  const selected = rows[index] ?? null;
  const live = useRef({ rows, selected, index, confirming });
  live.current = { rows, selected, index, confirming };

  /** Open the sheet; with a held clone's id, on its line. */
  const show = (heldId?: string) => {
    setNote("");
    setConfirming(null);
    data.reload();
    if (heldId !== undefined) {
      const at = rows.findIndex((row) => row.kind === "held" && row.id === heldId);
      if (at >= 0) setAt(at);
    }
    setOpen(true);
  };
  const close = () => setOpen(false);
  const report = (work: Promise<string>, doing: string) => {
    setNote(doing);
    work.then(setNote, (cause: unknown) => setNote(`${doing.replace(/…$/, "")} failed: ${errorText(cause)}`));
  };

  const onKey = (key: string): true => {
    const { rows: current, selected: row, index: i, confirming: pending } = live.current;
    const chosen = row?.kind === "repo" ? row : null;
    const heldEntry = row?.kind === "held" ? (data.held.find((entry) => entry.id === row.id) ?? null) : null;
    if (pending !== null) {
      // Any key answers the confirmation; only y removes.
      setConfirming(null);
      const entry = data.held.find((candidate) => candidate.id === pending);
      if (key === "y" && entry) report(data.removeHeld(entry), `removing the held clone ${entry.id}…`);
      else setNote("kept: the held clone is not removed");
      return true;
    }
    if (heldEntry !== null && (key === "t" || key === "d" || key === "Enter")) {
      if (key === "t") {
        if (!heldEntry.fromFile) setNote("this clone was not made from a workspace file, so no teardown applies to it");
        else report(data.teardownHeld(heldEntry), `running the teardown of ${heldName(heldEntry)} again…`);
      } else if (key === "d") {
        setConfirming(heldEntry.id);
        setNote(heldRemoveText(heldEntry));
      } else {
        data.heldOutput(heldEntry).then(
          (content) => {
            close();
            args.openReader({ kind: "text", threadId: null, title: `teardown of the held clone ${heldEntry.id}`, content });
          },
          (cause: unknown) => setNote(`could not read the output: ${errorText(cause)}`),
        );
      }
      return true;
    }
    if (key === "Escape" || key === "q" || key === "W") close();
    else if (key === "j" || key === "ArrowDown") setAt(Math.min(i + 1, Math.max(0, current.length - 1)));
    else if (key === "k" || key === "ArrowUp") setAt(Math.max(i - 1, 0));
    else if (key === "S") report(data.sync(null, null), "syncing every approved workspace…");
    else if (key === "s") {
      if (!chosen) setNote("nothing to sync");
      else report(data.sync(chosen.folder, chosen.as ?? "."), `syncing ${chosen.as ?? "the workspace folder"}…`);
    } else if (key === "r") {
      // The file's change, whether or not its notice was dismissed: the approved content runs until it is approved.
      const view = chosen ? data.views.find((entry) => entry.folder === chosen.folder) : undefined;
      if (!view || view.status === "approved" || !view.review) setNote("its workspace file has not changed since you approved it");
      else {
        close();
        args.openReader(reviewTarget(data, view));
      }
    } else if (key === "Enter") {
      // Always the selected repository's output: a file waiting on you does not hide it.
      if (!chosen) return true;
      data.output(chosen.folder, chosen.as).then(
        (content) => {
          close();
          args.openReader({ kind: "text", threadId: null, title: `last sync of ${chosen.as ?? "the workspace folder"}`, content });
        },
        (cause: unknown) => setNote(`could not read the output: ${errorText(cause)}`),
      );
    }
    return true;
  };

  const now = Date.now();
  const node: ReactNode = open ? (
    <div className="cow-help" data-cow-workspaces="" onClick={close}>
      <div className="cow-card" onClick={(event) => event.stopPropagation()}>
        <h3>Workspaces · j k move · s syncs the selected repository, S every approved workspace · Enter shows its last output · r opens its workspace's file when it changed · q or Esc closes</h3>
        <p className="cow-ledger-about">
          Each workspace folder cow knows, from its {WORKSPACE_FILE}. Its commands run with your full access, outside any sandbox, and only as you last approved them;
          `bb cow workspace add &lt;folder&gt;` proposes one, and a change waits in your queue until you approve it.
        </p>
        {data.error ? <p data-cow-workspaces-error="">could not read the workspaces: {data.error}</p> : null}
        {data.views.length === 0 ? <p data-cow-workspaces-empty="">No workspace yet: `bb cow workspace add &lt;folder&gt;` proposes one.</p> : null}
        {data.views.map((view) => (
          <div key={view.folder} data-cow-workspace={view.folder} data-cow-workspace-status={view.status}>
            <h3>
              {view.folder} · {view.status === "approved" ? "approved" : view.status === "changed" ? "changed: waiting on you" : view.status === "new" ? "never approved: waiting on you" : view.status}
            </h3>
            {view.repos.map((repo) => {
              const isSelected = selected?.kind === "repo" && selected.folder === view.folder && selected.as === repo.as;
              const commands = (["sync", "setup", "back", "teardown"] as const).filter((kind) => repo.commands[kind]);
              return (
                <div className={`cow-row${isSelected ? " cow-cur" : ""}`} key={repo.as ?? "."} data-cow-workspace-repo={repo.as ?? "."} data-cow-selected={isSelected || undefined}>
                  <span>
                    <b>{repo.as ?? "."}</b>
                  </span>
                  <span>
                    {repo.exists ? (repo.dirty ? "dirty" : "clean") : "missing"} ·{" "}
                    {repo.sync === null ? "never synced" : `synced ${formatAge(Math.max(0, now - repo.sync.at))} ago, ${repo.sync.timedOut ? "stopped at its time limit" : `exit ${repo.sync.code}`}`} · commands:{" "}
                    {commands.length === 0 ? "none" : commands.join(", ")}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {data.held.length > 0 || data.heldError ? (
          <div data-cow-held-clones={data.held.length}>
            <h3>Held clones · bb removed them, cow kept them since work might be lost · Enter shows teardown's output · t runs teardown again · d removes one for good (y confirms)</h3>
            {data.heldError ? <p data-cow-held-error="">could not read the held clones: {data.heldError}</p> : null}
            {data.held.map((entry) => {
              const isSelected = selected?.kind === "held" && selected.id === entry.id;
              return (
                <div className={`cow-row${isSelected ? " cow-cur" : ""}`} key={entry.id} data-cow-held={entry.id} data-cow-selected={isSelected || undefined}>
                  <span>
                    <b>{heldName(entry)}</b>
                  </span>
                  <span>
                    held {formatAge(Math.max(0, now - entry.heldAt))} ago · {heldReasons(entry).join("; ") || "why is not recorded"} · {entry.path}
                    {entry.missing ? " (its folder is gone)" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {note ? <p data-cow-workspaces-note="" data-cow-held-confirm={confirming ?? undefined}>{note}</p> : null}
      </div>
    </div>
  ) : null;

  return { open, show, onKey, node };
}
