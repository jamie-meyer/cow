// Waiting on someone other than the person: a reviewer, CI, someone outside
// the team. A thread says so with `bb cow wait`, or the person with `w`. The
// note holds until the thread starts a new turn, whoever starts it, since
// something has happened; with a reminder, it puts the line in front of the
// person on that day.

import { planText } from "./plans.ts";
import { formatDay, parsePickUp } from "./pickup.ts";
import { MAX_WAIT_FOR, MAX_WAIT_ON, type WaitNote } from "./shared.ts";
import { formatAge } from "./text.ts";

const DAY = 86_400_000;

/**
 * Whether the note still holds: no turn has started since it was set. A
 * thread that sets it during its own turn keeps it when that turn ends.
 * Without the time of its newest start (its events not read yet) it holds.
 */
export function waitHolds(note: WaitNote, startedAt: number | null | undefined): boolean {
  return startedAt == null || startedAt <= note.at;
}

/** Whether its reminder has arrived. */
export function waitDue(note: WaitNote, now: number): boolean {
  return note.remindAt !== null && now >= note.remindAt;
}

/** Whole days since it was set, at least one. */
function daysText(note: WaitNote, now: number): string {
  const days = Math.max(1, Math.floor((now - note.at) / DAY));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** What a waiting line says: "waiting on the reviewer · 3d", and what for when it was said. */
export function waitText(note: WaitNote, now: number): string {
  return `waiting on ${note.on}${note.for ? `: ${note.for}` : ""} · ${formatAge(Math.max(0, now - note.at))}`;
}

/** What a line whose reminder has arrived says in the queue. */
export function waitDueText(note: WaitNote, now: number): string {
  return `still waiting on ${note.on} after ${daysText(note, now)}${note.for ? `: ${note.for}` : ""}`;
}

/** The next-move column of a waiting line. */
export function waitNext(note: WaitNote, now: number, due: boolean): string {
  if (due) return "keep waiting, or take it back: press a";
  return note.remindAt === null ? "clears when it starts a turn · w clears it" : `reminds you ${formatDay(note.remindAt, now)}`;
}

/** A reminder as typed: a date, +3d, +2w, or nothing. Read as a park's pick-up is, but a condition in words is refused. */
export function parseRemind(value: string, now: number): { ok: true; at: number | null } | { ok: false; error: string } {
  const parsed = parsePickUp(value, now);
  if (!parsed.ok) return parsed;
  if (parsed.pickUp.kind === "condition") return { ok: false, error: "a reminder is a day: 19 Nov, +3d or +2w, or nothing for none" };
  return { ok: true, at: parsed.pickUp.kind === "date" ? parsed.pickUp.at : null };
}

/** The note from what was typed, or why it will not do. */
export function waitNote(
  input: { on: string; for: string | null; remind: string },
  now: number,
  by: string | null,
): { ok: true; note: WaitNote } | { ok: false; error: string } {
  const on = planText(input.on, MAX_WAIT_ON, "who or what it waits on");
  if (!on.ok) return on;
  let needed: string | null = null;
  if (input.for !== null && input.for.trim() !== "") {
    const parsed = planText(input.for, MAX_WAIT_FOR, "what it waits for");
    if (!parsed.ok) return parsed;
    needed = parsed.text;
  }
  const remind = parseRemind(input.remind, now);
  if (!remind.ok) return remind;
  return { ok: true, note: { on: on.text.replace(/^on\s+/i, ""), for: needed, remindAt: remind.at, at: now, by } };
}
