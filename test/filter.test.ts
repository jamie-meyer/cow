import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOverview, matches } from "../src/filter.ts";
import { parkNow } from "../src/park.ts";
import { derive } from "../src/state.ts";
import { buildOverview } from "../src/tree.ts";
import { NOW, activity, thread } from "./fixtures.ts";

test("a word matches a name loosely: its letters in order, any case", () => {
  assert.equal(matches("sso", "SSO cutover"), true);
  assert.equal(matches("scut", "SSO cutover"), true);
  assert.equal(matches("CUT", "sso cutover"), true);
  assert.equal(matches("tuc", "SSO cutover"), false);
  assert.equal(matches("", "anything"), true);
  assert.equal(matches("   ", "anything"), true);
});

test("a word matches what the line is doing only as written", () => {
  assert.equal(matches("npm", "Worker", "$ npm test"), true);
  assert.equal(matches("nt", "Worker", "$ npm test"), false);
  assert.equal(matches("wrk npm", "Worker", "$ npm test"), true);
  assert.equal(matches("wrk yarn", "Worker", "$ npm test"), false);
});

const overview = () => {
  const threads = [
    thread({ id: "main", title: "Main", createdAt: 1 }),
    thread({ id: "proj", title: "Billing", parentThreadId: "main", status: "active", createdAt: 2 }),
    thread({ id: "w1", title: "Invoice export", parentThreadId: "proj", status: "active", createdAt: 3 }),
    thread({ id: "w2", title: "Tax rules", parentThreadId: "proj", status: "active", createdAt: 4 }),
    thread({ id: "w2a", title: "Rounding", parentThreadId: "w2", status: "active", createdAt: 5 }),
    thread({ id: "solo", title: "Docs", parentThreadId: "main", status: "active", createdAt: 6 }),
    thread({ id: "shelf", title: "Old invoices", parentThreadId: "main", createdAt: 7 }),
    thread({ id: "fin", title: "Invoice fix", parentThreadId: "main", createdAt: 8 }),
  ];
  const doing: Record<string, string> = { solo: "writing the rounding guide" };
  return buildOverview(
    threads,
    "main",
    (t) => derive(t, activity({ latestStep: doing[t.id] ?? "" }), NOW, t.id === "shelf" ? parkNow("later", { kind: "none" }, NOW) : null),
    NOW,
    { note: () => null, todos: (id) => (id === "proj" ? [{ id: "t1", title: "invoice templates", at: NOW }] : []) },
  );
};

test("matches keep the page's order, and include the shelf, Done and what is not started", () => {
  const found = filterOverview(overview(), "invoice");
  assert.deepEqual(found.matches, ["w1", "todo:proj:t1", "shelf", "fin"]);
});

test("the heads of a match's groups are kept for context, and are not matches themselves", () => {
  const found = filterOverview(overview(), "rounding");
  assert.deepEqual(found.matches, ["w2a", "solo"]);
  assert.deepEqual([...found.keep].sort(), ["proj", "solo", "w2", "w2a"]);
  // A head that matches is a match; its members are not kept for that.
  const head = filterOverview(overview(), "billing");
  assert.deepEqual(head.matches, ["proj"]);
  assert.deepEqual([...head.keep], ["proj"]);
});

test("an empty query keeps everything; one that matches nothing keeps nothing", () => {
  const all = filterOverview(overview(), "");
  assert.equal(all.matches.length, 8);
  assert.equal(all.keep.size, 6);
  const none = filterOverview(overview(), "zzz");
  assert.deepEqual(none.matches, []);
  assert.equal(none.keep.size, 0);
});
