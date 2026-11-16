// Reading what the user typed as a parked thread's pick-up: a date, a
// relative time, a condition in their own words, or nothing.

const DAY = 86_400_000;

export type PickUp =
  | { kind: "date"; at: number }
  | { kind: "condition"; text: string }
  | { kind: "none" };

export type PickUpResult = { ok: true; pickUp: PickUp } | { ok: false; error: string };

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_CONDITION = 200;

const HOW = "use 19 Nov, +3d, +2w, or a condition in words";

const fail = (error: string): PickUpResult => ({ ok: false, error });

const FULL_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A month's name, or its first three or more letters; -1 for anything else. */
function monthIndex(word: string): number {
  const lower = word.toLowerCase().replace(/\.$/, "");
  if (lower.length < 3) return -1;
  return FULL_MONTHS.findIndex((month) => month.startsWith(lower));
}

/** Local midnight on that day, or null when the day does not exist. */
function dayStart(year: number, month: number, day: number): number | null {
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date.getTime();
}

function startOfToday(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A calendar day, which has to exist and to be after today. */
function onDay(year: number | null, month: number, day: number, now: number): PickUpResult {
  const today = startOfToday(now);
  if (year !== null) {
    const at = dayStart(year, month, day);
    if (at === null) return fail(`there is no ${day} ${MONTH_LABELS[month]} ${year}`);
    if (at <= today) return fail(`${formatDay(at, now)} is not after today`);
    return { ok: true, pickUp: { kind: "date", at } };
  }
  // No year given: the next time that day comes round.
  const thisYear = new Date(now).getFullYear();
  // Today is more likely a slip than a wish to wait a year.
  if (dayStart(thisYear, month, day) === today) return fail("that is today; pick a later day");
  for (const candidate of [thisYear, thisYear + 1]) {
    const at = dayStart(candidate, month, day);
    if (at !== null && at > today) return { ok: true, pickUp: { kind: "date", at } };
  }
  return fail(`there is no ${day} ${MONTH_LABELS[month]} in the next year`);
}

/**
 * Parse a pick-up. Anything shaped like a date or a relative time has to be
 * a valid one: it is rejected rather than guessed at or kept as a condition.
 *
 * - empty: no pick-up
 * - `+3d`, `+2w`: that long from now
 * - `19 Nov`, `Nov 19`, `19 Nov 2027`, `2027-11-19`: the start of that day
 * - anything else: a condition, kept as written
 */
export function parsePickUp(input: string, now: number): PickUpResult {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") return { ok: true, pickUp: { kind: "none" } };

  if (text.startsWith("+")) {
    const relative = /^\+ ?(\d{1,4}) ?(d|w)$/i.exec(text);
    if (!relative) return fail(`"${text}" is not a time: ${HOW}`);
    const count = Number(relative[1]);
    if (count === 0) return fail("that is now; pick a later time");
    const unit = relative[2]!.toLowerCase() === "w" ? 7 * DAY : DAY;
    return { ok: true, pickUp: { kind: "date", at: now + count * unit } };
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return fail(`"${text}" is not a date: ${HOW}`);
    return onDay(Number(iso[1]), month - 1, Number(iso[3]), now);
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+\.?),?(?: (\d{4}))?$/.exec(text);
  const monthFirst = /^([A-Za-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{4}))?$/.exec(text);
  const parts = dayFirst
    ? { day: dayFirst[1]!, word: dayFirst[2]!, year: dayFirst[3] }
    : monthFirst
      ? { day: monthFirst[2]!, word: monthFirst[1]!, year: monthFirst[3] }
      : null;
  const month = parts ? monthIndex(parts.word) : -1;
  if (parts && month >= 0) {
    return onDay(parts.year ? Number(parts.year) : null, month, Number(parts.day), now);
  }

  // "2 weeks", "19 Nvo", "19/11": a number first is an attempt at a time.
  if (dayFirst || /^[\d\s./-]+$/.test(text)) return fail(`"${text}" is not a date: ${HOW}`);
  if (text.length > MAX_CONDITION) return fail(`keep the condition under ${MAX_CONDITION} characters`);
  return { ok: true, pickUp: { kind: "condition", text } };
}

/** A day as the page writes it: 19 Nov, with the year when it is not this one. */
export function formatDay(at: number, now: number): string {
  const date = new Date(at);
  const label = `${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${date.getFullYear()}`;
}
