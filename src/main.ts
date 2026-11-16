// Which thread is Main in this window. The choice belongs to the window: it
// is kept in the window's session storage, so another window choosing a
// different Main does not move this one. bb's server keeps the last choice
// per project, and the project chosen most recently, only as the place a
// new window starts from.

/** What the server remembers, shared by every window. */
export interface StoredMains {
  /** Project id to that project's Main thread id. */
  mains: Record<string, string>;
  /** The project whose Main was chosen last. */
  currentProjectId: string | null;
}

/** What this window has chosen, or taken as its start. */
export interface WindowMains {
  mains: Record<string, string>;
  /** The project this window shows when bb names none. */
  projectId: string | null;
}

export const emptyWindowMains: WindowMains = { mains: {}, projectId: null };

export const WINDOW_MAINS_KEY = "cow:main";

/** Read a window's choice from storage, trusting nothing about what is there. */
export function parseWindowMains(raw: string | null): WindowMains {
  if (!raw) return emptyWindowMains;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return emptyWindowMains;
    const { mains, projectId } = value as Record<string, unknown>;
    const kept: Record<string, string> = {};
    if (typeof mains === "object" && mains !== null) {
      for (const [project, thread] of Object.entries(mains)) {
        if (typeof thread === "string" && thread !== "") kept[project] = thread;
      }
    }
    return { mains: kept, projectId: typeof projectId === "string" && projectId !== "" ? projectId : null };
  } catch {
    return emptyWindowMains;
  }
}

export interface ResolvedMain {
  projectId: string | null;
  mainId: string | null;
  /** True when the window had no choice of its own and took the stored one. */
  fromStored: boolean;
}

/**
 * The Main this window shows. `scopedProjectId` is the project bb names when
 * the page is opened inside one; otherwise the window's own project is used,
 * and failing that the project chosen most recently anywhere. Within the
 * project, the window's own choice wins over the stored one.
 */
export function resolveMain(
  own: WindowMains,
  stored: StoredMains | null,
  scopedProjectId: string | null,
): ResolvedMain {
  const projectId = scopedProjectId ?? own.projectId ?? stored?.currentProjectId ?? null;
  if (projectId === null) return { projectId: null, mainId: null, fromStored: false };
  const mine = own.mains[projectId];
  if (mine !== undefined) return { projectId, mainId: mine, fromStored: false };
  const theirs = stored?.mains[projectId];
  return { projectId, mainId: theirs ?? null, fromStored: theirs !== undefined };
}

/** This window now shows `threadId` as the Main of `projectId`. */
export function chooseInWindow(own: WindowMains, projectId: string, threadId: string): WindowMains {
  return { mains: { ...own.mains, [projectId]: threadId }, projectId };
}

/**
 * Make a start taken from the server the window's own, so that a later
 * choice in another window cannot move it. Returns the same object when
 * there is nothing to take.
 */
export function adopt(own: WindowMains, resolved: ResolvedMain): WindowMains {
  if (!resolved.fromStored || resolved.projectId === null || resolved.mainId === null) return own;
  return {
    mains: { ...own.mains, [resolved.projectId]: resolved.mainId },
    projectId: own.projectId ?? resolved.projectId,
  };
}
