// Who a capability applies to: one thread, a thread and everything under
// it, or everything under a Main. Pure.

import { type Capability, type Scope, isActive } from "./cap.ts";

/**
 * Whether a scope takes in a thread. `ancestors` are the ids above the
 * thread, nearest first.
 */
export function applies(scope: Scope, threadId: string, ancestors: readonly string[]): boolean {
  if (scope.kind === "thread") return scope.threadId === threadId;
  if (scope.kind === "subtree") return scope.threadId === threadId || ancestors.includes(scope.threadId);
  return ancestors.includes(scope.threadId);
}

/** Where a thread gets a capability from. */
export type Source =
  /** It names the thread itself. */
  | { from: "itself" }
  /** It names a thread above this one, and everything under that. */
  | { from: "ancestor"; threadId: string }
  /** It names everything under a Main above this one. */
  | { from: "main"; threadId: string };

export interface Held {
  capability: Capability;
  source: Source;
}

/** The capabilities in force that apply to a thread, oldest first, each with where it comes from. */
export function held(capabilities: readonly Capability[], threadId: string, ancestors: readonly string[]): Held[] {
  const found: Held[] = [];
  for (const capability of capabilities) {
    if (!isActive(capability) || !applies(capability.scope, threadId, ancestors)) continue;
    const { scope } = capability;
    const source: Source = scope.kind === "main" ? { from: "main", threadId: scope.threadId } : scope.threadId === threadId ? { from: "itself" } : { from: "ancestor", threadId: scope.threadId };
    found.push({ capability, source });
  }
  return found.sort((a, b) => a.capability.createdAt - b.capability.createdAt || a.capability.id.localeCompare(b.capability.id));
}

/** Where a held capability comes from, in words. */
export function sourceText(source: Source, titleOf: (threadId: string) => string): string {
  if (source.from === "itself") return "its own";
  if (source.from === "ancestor") return `from “${titleOf(source.threadId)}”, above it`;
  return `from Main “${titleOf(source.threadId)}”: every thread under it`;
}

/** The ids above a thread, nearest first. A loop in the parents ends the walk. */
export function ancestorsOf(parentOf: (threadId: string) => string | null | undefined, threadId: string): string[] {
  const above: string[] = [];
  const seen = new Set([threadId]);
  for (let at = parentOf(threadId) ?? null; at !== null && !seen.has(at); at = parentOf(at) ?? null) {
    above.push(at);
    seen.add(at);
  }
  return above;
}

/** The threads among `threads` that a scope takes in today: the ones that lose a capability when it is deleted. */
export function holders(scope: Scope, threads: readonly { id: string; parentThreadId: string | null }[]): string[] {
  const parents = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  return threads.filter((thread) => applies(scope, thread.id, ancestorsOf((id) => parents.get(id), thread.id))).map((thread) => thread.id);
}
