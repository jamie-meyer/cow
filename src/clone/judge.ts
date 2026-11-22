// Whether a clone may be removed, from what its teardowns did and what its
// repositories hold. Pure: the host entry judges with it, and the page and
// the CLI say why with it.

/** What a repository in a clone holds that its source does not. */
export interface Unsaved {
  /** False for a folder that is not a git repository: it cannot be judged, and does not hold the clone. */
  repo: boolean;
  /** Uncommitted, staged or untracked entries (`git status --porcelain`); ignored files do not count. */
  uncommitted: number;
  /** Branches (and a detached HEAD or a stash) with commits that are neither in the source nor in a remote-tracking ref of the clone. */
  branches: string[];
  /** Why it could not be told, when it could not. */
  error: string | null;
}

export type HoldReason =
  | { as: string | null; kind: "teardown-failed"; code: number | null; timedOut: boolean }
  | { as: string | null; kind: "uncommitted"; count: number }
  | { as: string | null; kind: "unsaved-commits"; branches: string[] }
  | { as: string | null; kind: "cannot-check"; why: string };

/** One repository of a clone at removal: its teardown's result if it has one, and what it holds. */
export interface RepoAtRemoval {
  as: string | null;
  teardown: { code: number | null; timedOut: boolean } | null;
  unsaved: Unsaved | null;
}

/**
 * The outcome table. A repository with a teardown is judged by it alone (a
 * clean teardown is taken as having saved what mattered); one without is
 * judged by what it holds. No reason: the clone is removed.
 */
export function judge(repos: readonly RepoAtRemoval[]): HoldReason[] {
  const reasons: HoldReason[] = [];
  for (const repo of repos) {
    if (repo.teardown !== null) {
      if (repo.teardown.code !== 0 || repo.teardown.timedOut) reasons.push({ as: repo.as, kind: "teardown-failed", code: repo.teardown.code, timedOut: repo.teardown.timedOut });
      continue;
    }
    const unsaved = repo.unsaved;
    if (unsaved === null || !unsaved.repo) continue;
    if (unsaved.error !== null) {
      reasons.push({ as: repo.as, kind: "cannot-check", why: unsaved.error });
      continue;
    }
    if (unsaved.uncommitted > 0) reasons.push({ as: repo.as, kind: "uncommitted", count: unsaved.uncommitted });
    if (unsaved.branches.length > 0) reasons.push({ as: repo.as, kind: "unsaved-commits", branches: unsaved.branches });
  }
  return reasons;
}

const nameOf = (as: string | null) => as ?? "the workspace folder";

export function reasonText(reason: HoldReason): string {
  switch (reason.kind) {
    case "teardown-failed":
      return `${nameOf(reason.as)}: teardown ${reason.timedOut ? "ran past its time limit" : `exited ${reason.code}`}`;
    case "uncommitted":
      return `${nameOf(reason.as)}: ${reason.count} uncommitted or untracked ${reason.count === 1 ? "change" : "changes"}, and no teardown`;
    case "unsaved-commits":
      return `${nameOf(reason.as)}: commits neither its source nor a remote has (${reason.branches.join(", ")}), and no teardown`;
    case "cannot-check":
      return `${nameOf(reason.as)}: could not tell whether it holds unsaved work (${reason.why})`;
  }
}

/** What would be lost with a repository, from what it holds: for the confirmation. */
export function lossText(as: string | null, unsaved: Unsaved): string | null {
  if (!unsaved.repo) return null;
  if (unsaved.error !== null) return `${nameOf(as)}: unknown (${unsaved.error})`;
  const parts = [
    ...(unsaved.uncommitted > 0 ? [`${unsaved.uncommitted} uncommitted or untracked ${unsaved.uncommitted === 1 ? "change" : "changes"}`] : []),
    ...(unsaved.branches.length > 0 ? [`commits neither its source nor a remote has on ${unsaved.branches.join(", ")}`] : []),
  ];
  return parts.length === 0 ? null : `${nameOf(as)}: ${parts.join(" and ")}`;
}

