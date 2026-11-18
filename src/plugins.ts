// Other plugins on a thread's line: the badges and actions bb's registries
// hold for a thread. cow only joins its lines to bb's threads, lists the
// actions and picks one: drawing a badge and running an action are the other
// plugin's own code.

/** The fields of bb's sidebar thread an action is evaluated with. */
export interface SidebarThreadLike {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  parentNotifications: "auto" | "off" | "stuck";
  archivedAt: number | null;
  pinnedAt: number | null;
  sectionId: string | null;
  isUnread: boolean;
  status: string;
  environment: { id: string | null; path: string | null } | null;
}

/** What cow knows of a thread without bb's sidebar. */
export interface FactsLike {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  parentNotifications?: "auto" | "off" | "stuck";
  archivedAt: number | null;
  sectionId?: string | null;
  lastReadAt: number | null;
  latestAttentionAt: number;
  status: string;
}

/** bb's sidebar threads by id, so each of cow's lines finds its own. */
export function indexById<T extends { id: string }>(threads: readonly T[]): ReadonlyMap<string, T> {
  const byId = new Map<string, T>();
  for (const thread of threads) byId.set(thread.id, thread);
  return byId;
}

/**
 * The thread an action is evaluated for. bb's sidebar thread has every field
 * bb's own menus pass; when it has none (an archived thread, say), cow's
 * facts stand in, and the thread has no environment to offer.
 */
export function actionTarget<S extends SidebarThreadLike>(facts: FactsLike, sidebar: S | undefined) {
  if (sidebar !== undefined) {
    const env = sidebar.environment;
    return {
      id: sidebar.id,
      projectId: sidebar.projectId,
      parentThreadId: sidebar.parentThreadId,
      parentNotifications: sidebar.parentNotifications,
      archivedAt: sidebar.archivedAt,
      pinnedAt: sidebar.pinnedAt,
      sectionId: sidebar.sectionId,
      isUnread: sidebar.isUnread,
      status: sidebar.status,
      environment: env !== null && env.id !== null ? { id: env.id, path: env.path } : null,
    };
  }
  return {
    id: facts.id,
    projectId: facts.projectId,
    parentThreadId: facts.parentThreadId,
    parentNotifications: facts.parentNotifications ?? "auto",
    archivedAt: facts.archivedAt,
    pinnedAt: null,
    sectionId: facts.sectionId ?? null,
    isUnread: facts.lastReadAt === null || facts.latestAttentionAt > facts.lastReadAt,
    status: facts.status,
    environment: null,
  };
}

/** bb's own actions are listed under this owner; they are bb's menu, not another plugin's. */
export const BB_CORE = "bb--core";

export interface ChoiceLike {
  id: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface EntryLike {
  key: string;
  pluginId: string;
  group: string;
  action: {
    label: string;
    detail?: string;
    disabled?: boolean;
    variant?: "default" | "destructive";
    choices?: { heading?: string; hint?: string; items: readonly ChoiceLike[] };
  };
}

/** The keys that pick a row of the menu: digits, then letters. `f` is left for hints, `q` for closing. */
export const PICK_KEYS = [..."123456789", ..."asdghjklwertyuiopzxcvbnm"];

export interface MenuRow<E> {
  /** The key that picks it; empty when there are more rows than keys. */
  pick: string;
  entry: E;
  /** The plugin that offers it, as the person would recognise it. */
  from: string;
}

/**
 * The actions other plugins offer for a thread, in bb's menu order: bb's own
 * and cow's are left out (cow's are its keys), and each row gets a key.
 */
export function otherActions<E extends EntryLike>(entries: readonly E[], ownPluginId: string | null): MenuRow<E>[] {
  return entries
    .filter((entry) => entry.pluginId !== BB_CORE && entry.pluginId !== ownPluginId)
    .map((entry, index) => ({ pick: PICK_KEYS[index] ?? "", entry, from: entry.pluginId }));
}

export type Picked<E> =
  | { kind: "run"; entry: E; value?: string }
  | { kind: "choices"; entry: E }
  | { kind: "disabled"; label: string }
  | { kind: "miss" };

/** What a key picks in the menu's list of actions. */
export function pickAction<E extends EntryLike>(rows: readonly MenuRow<E>[], key: string): Picked<E> {
  const row = key === "" ? undefined : rows.find((other) => other.pick === key);
  if (row === undefined) return { kind: "miss" };
  const { action } = row.entry;
  if (action.disabled) return { kind: "disabled", label: action.label };
  if (action.choices !== undefined) return { kind: "choices", entry: row.entry };
  return { kind: "run", entry: row.entry };
}

/** The keys of an action's choices, in its order. */
export function choiceRows(entry: EntryLike): { pick: string; choice: ChoiceLike }[] {
  return (entry.action.choices?.items ?? []).map((choice, index) => ({ pick: PICK_KEYS[index] ?? "", choice }));
}

/** What a key picks among an action's choices. */
export function pickChoice<E extends EntryLike>(entry: E, key: string): Picked<E> {
  const row = key === "" ? undefined : choiceRows(entry).find((other) => other.pick === key);
  if (row === undefined) return { kind: "miss" };
  if (row.choice.disabled) return { kind: "disabled", label: row.choice.label };
  return { kind: "run", entry, value: row.choice.id };
}
