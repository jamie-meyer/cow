import assert from "node:assert/strict";
import { test } from "node:test";
import { nextText, planRefused, todoAdd, todoMove, todoTake, todoTakeId, todoTitle } from "../src/plans.ts";
import { MAX_NEXT, MAX_TODOS, type TodoItem } from "../src/shared.ts";
import { NOW, thread } from "./fixtures.ts";

const item = (id: string): TodoItem => ({ id, title: `do ${id}`, at: NOW });
const titles = (list: readonly TodoItem[]) => list.map((entry) => entry.id).join("");

test("a note is one line of plain text, of bounded length", () => {
  assert.deepEqual(nextText("  open the PR\n once CI is green "), { ok: true, text: "open the PR once CI is green" });
  assert.equal(nextText("   ").ok, false);
  assert.equal(nextText("x".repeat(MAX_NEXT)).ok, true);
  assert.equal(nextText("x".repeat(MAX_NEXT + 1)).ok, false);
  assert.equal(todoTitle("").ok, false);
});

test("a thread plans for itself and for the threads under it, and for no other", () => {
  const threads = [
    thread({ id: "main" }),
    thread({ id: "proj", parentThreadId: "main" }),
    thread({ id: "worker", parentThreadId: "proj" }),
    thread({ id: "other", parentThreadId: "main" }),
  ];
  assert.equal(planRefused(threads, "proj", "proj"), null);
  assert.equal(planRefused(threads, "proj", "worker"), null);
  assert.equal(planRefused(threads, "main", "worker"), null);
  assert.notEqual(planRefused(threads, "worker", "proj"), null);
  assert.notEqual(planRefused(threads, "other", "worker"), null);
  assert.notEqual(planRefused(threads, "proj", "main"), null);
  assert.notEqual(planRefused(threads, "stranger", "worker"), null);
  // Run by the person, outside any thread.
  assert.equal(planRefused(threads, null, "worker"), null);
});

test("the ownership check survives a parent loop", () => {
  const threads = [thread({ id: "a", parentThreadId: "b" }), thread({ id: "b", parentThreadId: "a" })];
  assert.notEqual(planRefused(threads, "c", "a"), null);
});

test("items are added at the end, up to a limit", () => {
  const added = todoAdd([item("a")], "do b", NOW, "b");
  assert.ok(added.ok);
  assert.equal(titles(added.list), "ab");
  assert.deepEqual(added.item, { id: "b", title: "do b", at: NOW });
  const full = Array.from({ length: MAX_TODOS }, (_, index) => item(String(index)));
  const refused = todoAdd(full, "one more", NOW, "x");
  assert.equal(refused.ok, false);
});

test("an item is taken off by its number, counted from 1", () => {
  const list = [item("a"), item("b"), item("c")];
  const taken = todoTake(list, 2);
  assert.ok(taken.ok);
  assert.equal(titles(taken.list), "ac");
  assert.equal(taken.item.id, "b");
  for (const n of [0, 4, 1.5, Number.NaN]) assert.equal(todoTake(list, n).ok, false, String(n));
  const empty = todoTake([], 1);
  assert.deepEqual(empty, { ok: false, error: "the list is empty" });
  assert.equal(titles(list), "abc");
});

test("the page takes an item off by its id, so a list that changed under it is safe", () => {
  const list = [item("a"), item("b")];
  const taken = todoTakeId(list, "b");
  assert.ok(taken.ok);
  assert.equal(titles(taken.list), "a");
  assert.equal(todoTakeId(list, "gone").ok, false);
});

test("an item moves one place, and stays put at either end", () => {
  const list = [item("a"), item("b"), item("c")];
  const order = (id: string, by: 1 | -1) => {
    const moved = todoMove(list, id, by);
    assert.ok(moved.ok);
    return titles(moved.list);
  };
  assert.equal(order("b", -1), "bac");
  assert.equal(order("b", 1), "acb");
  assert.equal(order("a", -1), "abc");
  assert.equal(order("c", 1), "abc");
  assert.equal(todoMove(list, "gone", 1).ok, false);
});
