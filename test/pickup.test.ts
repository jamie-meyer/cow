import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDay, parsePickUp } from "../src/pickup.ts";
import { DAY } from "./fixtures.ts";

/** Monday 16 November 2026, mid-afternoon, local time. */
const NOW = new Date(2026, 10, 16, 15, 30).getTime();
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date).getTime();

const date = (input: string) => {
  const result = parsePickUp(input, NOW);
  assert.ok(result.ok, `${input}: ${result.ok ? "" : result.error}`);
  assert.equal(result.pickUp.kind, "date", input);
  return result.pickUp.kind === "date" ? result.pickUp.at : 0;
};
const rejected = (input: string) => {
  const result = parsePickUp(input, NOW);
  assert.equal(result.ok, false, `${input} should be rejected`);
  return result.ok ? "" : result.error;
};

test("empty means no pick-up", () => {
  assert.deepEqual(parsePickUp("", NOW), { ok: true, pickUp: { kind: "none" } });
  assert.deepEqual(parsePickUp("   ", NOW), { ok: true, pickUp: { kind: "none" } });
});

test("relative times count from now", () => {
  assert.equal(date("+3d"), NOW + 3 * DAY);
  assert.equal(date("+2w"), NOW + 14 * DAY);
  assert.equal(date("+ 1 W"), NOW + 7 * DAY);
});

test("a malformed relative time is rejected, not kept as a condition", () => {
  for (const input of ["+3", "+d", "+3x", "+3 days", "+-2d", "+0d", "+1.5w"]) rejected(input);
});

test("a day and a month is the start of that day, the next time it comes", () => {
  assert.equal(date("19 Nov"), day(2026, 11, 19));
  assert.equal(date("nov 19"), day(2026, 11, 19));
  assert.equal(date("19th November"), day(2026, 11, 19));
  assert.equal(date("3 Jan"), day(2027, 1, 3));
  assert.equal(date("15 Nov"), day(2027, 11, 15));
  assert.equal(date("1 sept"), day(2027, 9, 1));
});

test("a year is honoured, and ISO dates work", () => {
  assert.equal(date("19 Nov 2027"), day(2027, 11, 19));
  assert.equal(date("Mar 4, 2028"), day(2028, 3, 4));
  assert.equal(date("2026-12-01"), day(2026, 12, 1));
});

test("days that do not exist, have passed, or are today are rejected", () => {
  assert.match(rejected("31 Nov"), /no 31 Nov/);
  assert.match(rejected("30 Feb 2027"), /no 30 Feb 2027/);
  assert.match(rejected("16 Nov"), /today/);
  assert.match(rejected("1 Jan 2026"), /not after today/);
  assert.match(rejected("2026-11-16"), /not after today/);
  rejected("2026-13-01");
  rejected("0 Dec");
});

test("29 Feb waits for a leap year only if one is within a year", () => {
  rejected("29 Feb");
  const now = new Date(2027, 5, 1).getTime();
  assert.deepEqual(parsePickUp("29 Feb", now), {
    ok: true,
    pickUp: { kind: "date", at: day(2028, 2, 29) },
  });
});

test("something that starts like a date but is not one is rejected, never guessed", () => {
  for (const input of ["19 Nvo", "2 weeks", "19/11", "19.11.2026", "12", "19 no"]) rejected(input);
});

test("anything else is a condition, kept as written", () => {
  for (const text of ["the vendor replies", "CI 12 is green", "3 reviewers approve", "March release ships"]) {
    assert.deepEqual(parsePickUp(`  ${text} `, NOW), { ok: true, pickUp: { kind: "condition", text } });
  }
  rejected("x".repeat(201));
});

test("days are written without the year when it is this year", () => {
  assert.equal(formatDay(day(2026, 11, 19), NOW), "19 Nov");
  assert.equal(formatDay(day(2027, 1, 4), NOW), "4 Jan 2027");
});
