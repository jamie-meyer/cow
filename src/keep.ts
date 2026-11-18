// Keeping a thread: the person wants it around without it asking for
// anything, perhaps for months. It is set on the page with `z`, with a few
// words or none, and holds until the thread starts a new turn: typing to it
// is the person being intentional about it again.

import { planText } from "./plans.ts";
import { type KeepNote, MAX_KEEP_WORDS } from "./shared.ts";

/**
 * Whether the note still holds: no turn has started since it was set.
 * Without the time of its newest start (its events not read yet) it holds.
 */
export function keepHolds(note: KeepNote, startedAt: number | null | undefined): boolean {
  return startedAt == null || startedAt <= note.at;
}

/** The note from what was typed, which may be nothing, or why it will not do. */
export function keepNote(words: string, now: number): { ok: true; note: KeepNote } | { ok: false; error: string } {
  if (words.trim() === "") return { ok: true, note: { words: null, at: now } };
  const parsed = planText(words, MAX_KEEP_WORDS, "the words");
  if (!parsed.ok) return parsed;
  return { ok: true, note: { words: parsed.text, at: now } };
}
