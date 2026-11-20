// Workspaces, in cow's server: which workspace folders cow knows, the content
// of each one's file the person last approved, and the relays to the host
// entry that reads the files and runs the commands.
//
// The file sits where agents can write, and its commands run outside any
// sandbox. So cow keeps, per workspace folder (by real path), the last
// content the person approved, in its own storage, and passes only that to
// the host entry. A workspace is made known, and each change approved, only
// by a signed call from the page; `bb cow workspace add` only proposes.

import { z } from "zod";
import type { BackCandidateWire, BackResultWire, RepoStatusWire, SyncResultWire } from "../clone/contract.ts";
import type { LogStore } from "../caps/logstore.ts";
import { type Kv, Refusal, serial } from "../kv.ts";
import { type CommandEntry, type CommandKind, WORKSPACE_FILE, commandFor, newCommands, parseWorkspaceFile, reviewText } from "./file.ts";

const STORE_KEY = "workspaces";
const MAX_KNOWN = 100;

const approvalSchema = z.object({ text: z.string(), hash: z.string(), at: z.number(), by: z.string() });
const knownSchema = z.object({
  folder: z.string(),
  approved: approvalSchema.nullable(),
  /** The hash of a file whose notice the person dismissed without approving: it stays out of the queue until the file changes again. */
  dismissed: z.string().nullable(),
  proposedAt: z.number(),
});
const storeSchema = z.record(z.string(), knownSchema);
type Known = z.infer<typeof knownSchema>;

export interface Approved {
  folder: string;
  text: string;
  hash: string;
}

/** What the host entry does for the server. Each call goes to one machine. */
export interface HostPort {
  inspect(items: Array<{ folder: string; listText: string | null }>): Promise<Array<{ folder: string | null; text: string | null; error: string | null; repos: RepoStatusWire[] }>>;
  sync(approved: Approved, only: string | null): Promise<SyncResultWire[]>;
  backPreview(hostId: string, clonePath: string, approved: Approved | null): Promise<{ branch: string; workspace: string | null; repos: BackCandidateWire[] }>;
  back(hostId: string, clonePath: string, approved: Approved): Promise<BackResultWire[]>;
  output(approved: Approved, as: string | null, kind: CommandKind): Promise<{ at: number; ms: number; code: number | null; timedOut: boolean; tail: string[]; cwd: string } | null>;
}

export type FileStatus = "approved" | "changed" | "new" | "missing" | "unreadable";

export interface WorkspaceView {
  folder: string;
  status: FileStatus;
  /** Why the folder or its file cannot be read, when it cannot. */
  error: string | null;
  currentHash: string | null;
  approvedHash: string | null;
  approvedAt: number | null;
  /** Problems with the current file: it cannot be approved until they are fixed. */
  problems: string[];
  /** The commands the current file would newly run, against the approved content. */
  fresh: CommandEntry[];
  /** What the reader shows: new commands first, then the diff of approved against current. */
  review: string | null;
  /** In the person's queue: changed or new, and not dismissed at this content. */
  waiting: boolean;
  /** By the approved file when there is one, else by the current one. Never a command's text. */
  repos: RepoStatusWire[];
}

export interface ThreadClone {
  hostId: string;
  clonePath: string;
}

export interface WorkspacesDeps {
  kv: Kv;
  log: LogStore;
  hash: (text: string) => string;
  now: () => number;
  host: HostPort;
  /** The copy-on-write workspace a thread runs in, or null when it runs in something else. */
  threadClone: (threadId: string) => Promise<ThreadClone | null>;
  changed: () => void;
}

export interface BackPlan {
  threadId: string;
  workspace: string | null;
  branch: string;
  repos: Array<{ as: string | null; source: string; ahead: number | null; command: string | null; why: string | null }>;
}

export type Workspaces = ReturnType<typeof createWorkspaces>;

export function createWorkspaces(deps: WorkspacesDeps) {
  const locked = serial();
  const read = async (): Promise<Record<string, Known>> => {
    const parsed = storeSchema.safeParse(await deps.kv.get(STORE_KEY));
    return parsed.success ? parsed.data : {};
  };
  const write = (all: Record<string, Known>) => deps.kv.set(STORE_KEY, all);

  /** A folder's real path, through the host entry; refused when it is not a directory. */
  const resolve = async (asked: string) => {
    const [found] = await deps.host.inspect([{ folder: asked, listText: null }]);
    if (!found || found.folder === null) throw new Refusal("workspace_not_found", found?.error ?? `${asked} is not a directory`);
    return found;
  };

  const viewOf = (known: Known, found: { folder: string | null; text: string | null; error: string | null; repos: RepoStatusWire[] }): WorkspaceView => {
    const approved = known.approved;
    const approvedParsed = approved ? parseWorkspaceFile(approved.text) : null;
    const base = { folder: known.folder, approvedHash: approved?.hash ?? null, approvedAt: approved?.at ?? null, repos: found.repos };
    if (found.folder === null || found.error !== null) {
      return { ...base, status: found.folder === null ? "missing" : "unreadable", error: found.error, currentHash: null, problems: [], fresh: [], review: null, waiting: false };
    }
    if (found.text === null) return { ...base, status: "missing", error: null, currentHash: null, problems: [], fresh: [], review: null, waiting: false };
    const currentHash = deps.hash(found.text);
    const current = parseWorkspaceFile(found.text);
    const problems = current.ok ? [] : current.problems;
    const fresh = current.ok ? newCommands(approvedParsed?.ok ? approvedParsed.file : null, current.file) : [];
    const status: FileStatus = approved === null ? "new" : approved.hash === currentHash ? "approved" : "changed";
    const review = status === "approved" ? null : reviewText({ folder: known.folder, approvedText: approved?.text ?? null, currentText: found.text, problems, fresh });
    return { ...base, status, error: null, currentHash, problems, fresh, review, waiting: status !== "approved" && known.dismissed !== currentHash };
  };

  const views = async (only?: string): Promise<WorkspaceView[]> => {
    const all = Object.values(await read()).filter((known) => only === undefined || known.folder === only);
    if (all.length === 0) return [];
    const found = await deps.host.inspect(all.map((known) => ({ folder: known.folder, listText: known.approved?.text ?? null })));
    return all.map((known, index) => viewOf(known, found[index] ?? { folder: null, text: null, error: "the host entry did not answer for it", repos: [] }));
  };

  /** The approved content of a folder (by real path), or a refusal saying why there is none. */
  const approvedFor = async (folder: string): Promise<Approved> => {
    const known = (await read())[folder];
    if (!known) throw new Refusal("workspace_not_found", `cow does not know the workspace ${folder}`, `Propose it with \`bb cow workspace add ${folder}\`; the user approves its file on cow's page.`);
    if (!known.approved) throw new Refusal("not_approved", `the ${WORKSPACE_FILE} of ${folder} has never been approved, so none of its commands run`, "The user approves it on cow's page, from the notice in their queue.");
    return { folder, text: known.approved.text, hash: known.approved.hash };
  };

  /** Resolve a folder the caller named to the real path cow keys it by. */
  const folderOf = async (asked: string): Promise<string> => (await resolve(asked)).folder!;

  return {
    views,
    approvedFor,
    folderOf,

    /** Make a folder known, so its file's notice appears. Anyone may: it approves nothing. */
    propose: (asked: string) =>
      locked("store", async () => {
        const found = await resolve(asked);
        const folder = found.folder!;
        const all = await read();
        if (!all[folder]) {
          if (Object.keys(all).length >= MAX_KNOWN) throw new Refusal("too_many", `cow knows ${MAX_KNOWN} workspaces already`);
          all[folder] = { folder, approved: null, dismissed: null, proposedAt: deps.now() };
          await write(all);
          deps.changed();
        }
        const [view] = await views(folder);
        return view!;
      }),

    /**
     * Approve exactly the content that was shown: `hash` is the hash of the
     * text the page showed, and the file must still have it. Signed.
     */
    approve: (args: { folder: string; hash: string }, by: string) =>
      locked("store", async () => {
        const all = await read();
        const known = all[args.folder];
        if (!known) throw new Refusal("workspace_not_found", `cow does not know the workspace ${args.folder}`);
        const [found] = await deps.host.inspect([{ folder: args.folder, listText: null }]);
        if (!found || found.folder !== args.folder || found.text === null) throw new Refusal("stale_file", `the ${WORKSPACE_FILE} of ${args.folder} is gone or moved since it was shown: nothing was approved`);
        const hash = deps.hash(found.text);
        if (hash !== args.hash) throw new Refusal("stale_file", `the ${WORKSPACE_FILE} of ${args.folder} changed after it was shown: nothing was approved. Open it again to see the change.`);
        const parsed = parseWorkspaceFile(found.text);
        if (!parsed.ok) throw new Refusal("bad_file", `the ${WORKSPACE_FILE} of ${args.folder} cannot be approved: ${parsed.problems.join("; ")}`);
        const before = known.approved ? parseWorkspaceFile(known.approved.text) : null;
        const fresh = newCommands(before?.ok ? before.file : null, parsed.file);
        all[args.folder] = { ...known, approved: { text: found.text, hash, at: deps.now(), by }, dismissed: null };
        await write(all);
        await deps.log.append({ kind: "workspace-approved", folder: args.folder, hash, newCommands: fresh.length }, by);
        deps.changed();
        return { folder: args.folder, hash, newCommands: fresh.length };
      }),

    /** Take the notice out of the queue without approving, until the file changes again. Signed. */
    dismiss: (args: { folder: string; hash: string }, by: string) =>
      locked("store", async () => {
        const all = await read();
        const known = all[args.folder];
        if (!known) throw new Refusal("workspace_not_found", `cow does not know the workspace ${args.folder}`);
        all[args.folder] = { ...known, dismissed: args.hash };
        await write(all);
        await deps.log.append({ kind: "workspace-dismissed", folder: args.folder, hash: args.hash }, by);
        deps.changed();
        return null;
      }),

    /** Sync one workspace, or every approved one. Anyone may: only approved commands run, with fixed arguments. */
    async sync(asked: string | null, only: string | null): Promise<Array<{ folder: string; results: SyncResultWire[]; error: string | null }>> {
      const folders = asked === null ? Object.values(await read()).filter((known) => known.approved !== null).map((known) => known.folder) : [await folderOf(asked)];
      if (asked === null && folders.length === 0) throw new Refusal("not_approved", "no workspace file has been approved yet, so there is nothing to sync");
      const out = [];
      for (const folder of folders) {
        const approved = await approvedFor(folder);
        try {
          out.push({ folder, results: await deps.host.sync(approved, only), error: null });
        } catch (cause) {
          if (asked !== null) throw cause;
          out.push({ folder, results: [], error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      deps.changed();
      return out;
    },

    /** What `back` would do for a thread: the repositories with new commits, and the approved command each would run. Reads only. */
    async backPlan(threadId: string): Promise<BackPlan & { clone: ThreadClone; approved: Approved | null }> {
      const clone = await deps.threadClone(threadId);
      if (clone === null) throw new Refusal("not_a_clone", `${threadId} does not run in a copy-on-write workspace of cow's`, "Bring back works only for threads started with the cow-clone environment.");
      const first = await deps.host.backPreview(clone.hostId, clone.clonePath, null);
      // The approved file of the workspace it was made from; for explicit inputs, of its source folder if cow knows it.
      const all = await read();
      const folder = first.workspace ?? first.repos.find((repo) => repo.as === null)?.source ?? null;
      const known = folder === null ? undefined : all[folder];
      const approved = known?.approved ? { folder: known.folder, text: known.approved.text, hash: known.approved.hash } : null;
      const file = approved ? parseWorkspaceFile(approved.text) : null;
      const repos = first.repos.map((repo) => ({
        as: repo.as,
        source: repo.source,
        ahead: repo.ahead,
        command: file?.ok ? commandFor(file.file, repo.as, "back") : null,
        why: repo.why,
      }));
      return { threadId, workspace: approved?.folder ?? folder, branch: first.branch, repos, clone, approved };
    },

    /**
     * Run `back` for a thread's clone. Only the person, from the page: the
     * signed `workspace_back` is its one caller, and `by` is the key that signed it.
     */
    async back(threadId: string, by: string): Promise<{ workspace: string; results: BackResultWire[] }> {
      const plan = await this.backPlan(threadId);
      if (plan.approved === null) {
        throw new Refusal("not_approved", `no approved ${WORKSPACE_FILE} covers this clone${plan.workspace ? ` (its workspace is ${plan.workspace})` : ""}, so there is no back command to run`);
      }
      const results = await deps.host.back(plan.clone.hostId, plan.clone.clonePath, plan.approved);
      const ran = results.filter((result) => result.status === "ran");
      await deps.log.append(
        {
          kind: "workspace-back",
          threadId,
          folder: plan.approved.folder,
          hash: plan.approved.hash,
          what: ran.length === 0 ? "nothing to bring back" : ran.map((result) => `${result.as ?? "the workspace folder"}: exit ${result.code ?? "none"}`).join(", "),
        },
        by,
      );
      deps.changed();
      return { workspace: plan.approved.folder, results };
    },

    /** A repository's last run of one kind with its output. Signed: output may hold secrets, so only the person reads it. */
    async output(args: { folder: string; as: string | null; kind: CommandKind }) {
      return deps.host.output(await approvedFor(args.folder), args.as, args.kind);
    },
  };
}
