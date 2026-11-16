// What a thread says is next for it: one line of its own words, and a short
// ordered list of work it has not started. These are notes, not permissions:
// a thread writes them about itself, or about the threads under it.

import { MAX_NEXT, MAX_TODOS, MAX_TODO_TITLE, type TodoItem } from "./shared.ts";
import type { ThreadFacts } from "./state.ts";

/** One line of plain text, or why it will not do. */
export function planText(value: string, max: number, what: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = value.trim().replace(/\s+/g, " ");
  if (text === "") return { ok: false, error: `${what} is empty: say it in a few words` };
  if (text.length > max) return { ok: false, error: `keep ${what} under ${max} characters` };
  return { ok: true, text };
}
export const nextText = (value: string) => planText(value, MAX_NEXT, "the note");
export const todoTitle = (value: string) => planText(value, MAX_TODO_TITLE, "the title");

/**
 * Why the thread `callerId` may not write a plan for `targetId`, or null
 * when it may: a thread plans for itself and for the threads under it.
 * With no caller the command was run by the person, who may plan for any.
 */
export function planRefused(threads: readonly ThreadFacts[], callerId: string | null, targetId: string): string | null {
  if (callerId === null || callerId === targetId) return null;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const visited = new Set<string>();
  for (let at = byId.get(targetId); at && !visited.has(at.id); at = byId.get(at.parentThreadId ?? "")) {
    visited.add(at.id);
    if (at.parentThreadId === callerId) return null;
  }
  return "a thread sets this only for itself and for the threads under it";
}

export type TodoChange = { ok: true; list: TodoItem[]; item: TodoItem } | { ok: false; error: string };

export function todoAdd(list: readonly TodoItem[], title: string, now: number, id: string): TodoChange {
  if (list.length >= MAX_TODOS) {
    return { ok: false, error: `the list is full at ${MAX_TODOS}: keep it to the next few items, and finish or remove one first` };
  }
  const item = { id, title, at: now };
  return { ok: true, list: [...list, item], item };
}

/** Take item number `n` (1-based) off the list: it was started, or dropped. */
export function todoTake(list: readonly TodoItem[], n: number): TodoChange {
  const item = list[n - 1];
  if (!Number.isInteger(n) || !item) {
    return { ok: false, error: list.length === 0 ? "the list is empty" : `there is no item ${n}: the list has ${list.length}` };
  }
  return { ok: true, list: list.filter((other) => other !== item), item };
}

/** Take the item with this id off the list. */
export function todoTakeId(list: readonly TodoItem[], id: string): TodoChange {
  const at = list.findIndex((item) => item.id === id);
  return at < 0 ? { ok: false, error: "that item is no longer on the list" } : todoTake(list, at + 1);
}

/** Move the item with this id one place up (-1) or down (1); at the end it stays. */
export function todoMove(list: readonly TodoItem[], id: string, by: 1 | -1): TodoChange {
  const at = list.findIndex((item) => item.id === id);
  const item = list[at];
  if (!item) return { ok: false, error: "that item is no longer on the list" };
  const to = at + by;
  if (to < 0 || to >= list.length) return { ok: true, list: [...list], item };
  const next = [...list];
  next[at] = next[to]!;
  next[to] = item;
  return { ok: true, list: next, item };
}
