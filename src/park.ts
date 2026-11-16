// Parking: a note cow keeps on a thread the user has set aside, and when
// that thread comes back to ask whether it is still wanted.

import { type PickUp, formatDay } from "./pickup.ts";
import type { ParkRecord } from "./shared.ts";
import { formatAge } from "./text.ts";

const WEEK = 7 * 86_400_000;

/** Why a parked thread is back in the queue, and since when. */
export type Due =
  | { kind: "date"; at: number }
  /** No date to wait for, so it asks again; `weeks` is how long it has been parked. */
  | { kind: "check"; at: number; weeks: number };

export function parkNow(reason: string, pickUp: PickUp, now: number): ParkRecord {
  return { at: now, reason, pickUp, checkedAt: now };
}

/** Keep it parked with a new pick-up. The reason and the parked time stay. */
export function reparkNow(record: ParkRecord, pickUp: PickUp, now: number): ParkRecord {
  return { ...record, pickUp, checkedAt: now };
}

/**
 * Whether a parked thread has come back. A date brings it back when it
 * arrives. Without a date it comes back every `checkMs`; a condition in
 * words cannot be detected, so it is treated the same way.
 */
export function parkDue(record: ParkRecord, now: number, checkMs: number): Due | null {
  if (record.pickUp.kind === "date") {
    return now >= record.pickUp.at ? { kind: "date", at: record.pickUp.at } : null;
  }
  const at = record.checkedAt + checkMs;
  if (now < at) return null;
  return { kind: "check", at, weeks: Math.floor((now - record.at) / WEEK) };
}

/** The pick-up as a line shows it while the thread waits on the shelf. */
export function pickUpText(record: ParkRecord, now: number, checkMs: number): string {
  if (record.pickUp.kind === "date") return `pick up ${formatDay(record.pickUp.at, now)}`;
  const left = formatAge(Math.max(0, record.checkedAt + checkMs - now));
  return record.pickUp.kind === "condition"
    ? `when ${record.pickUp.text} · asks in ${left}`
    : `asks again in ${left}`;
}

/** Why it is back, in the few words a line's last column has room for. */
export function dueShort(due: Due, now: number): string {
  return due.kind === "date" ? `date arrived: ${formatDay(due.at, now)}` : "still wanted? keep, resume, drop";
}

/** What a returned thread asks, in full, for the queue. */
export function dueText(record: ParkRecord, due: Due, now: number): string {
  if (due.kind === "date") return `pick-up date arrived (${formatDay(due.at, now)}): resume, re-park, or drop?`;
  const weeks = `${due.weeks} ${due.weeks === 1 ? "week" : "weeks"}`;
  const condition = record.pickUp.kind === "condition" ? ` Waiting for: ${record.pickUp.text}.` : "";
  return `still parked for ${weeks}: keep, resume, or drop?${condition}`;
}
