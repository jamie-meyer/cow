import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adopt,
  chooseInWindow,
  emptyWindowMains,
  parseWindowMains,
  resolveMain,
} from "../src/main.ts";

const stored = { mains: { p1: "main-1", p2: "main-2" }, currentProjectId: "p2" };

test("a new window starts from the Main chosen most recently anywhere", () => {
  assert.deepEqual(resolveMain(emptyWindowMains, stored, null), { projectId: "p2", mainId: "main-2", fromStored: true });
  assert.deepEqual(resolveMain(emptyWindowMains, null, null), { projectId: null, mainId: null, fromStored: false });
  assert.deepEqual(resolveMain(emptyWindowMains, { mains: {}, currentProjectId: null }, null).mainId, null);
});

test("once a window shows a Main, another window's choice does not move it", () => {
  const first = resolveMain(emptyWindowMains, stored, null);
  const own = adopt(emptyWindowMains, first);
  assert.deepEqual(own, { mains: { p2: "main-2" }, projectId: "p2" });
  // Elsewhere a different Main is chosen, in another project and then in this one.
  const later = { mains: { p1: "other-1", p2: "other-2" }, currentProjectId: "p1" };
  assert.deepEqual(resolveMain(own, later, null), { projectId: "p2", mainId: "main-2", fromStored: false });
  // Nothing more to adopt: the window's state is left as it is.
  assert.equal(adopt(own, resolveMain(own, later, null)), own);
});

test("choosing in the window changes this window", () => {
  const own = chooseInWindow({ mains: { p2: "main-2" }, projectId: "p2" }, "p1", "picked");
  assert.deepEqual(own, { mains: { p2: "main-2", p1: "picked" }, projectId: "p1" });
  assert.deepEqual(resolveMain(own, stored, null), { projectId: "p1", mainId: "picked", fromStored: false });
});

test("a project bb names wins over the window's project, and each project keeps its Main", () => {
  const own = { mains: { p1: "picked" }, projectId: "p1" };
  assert.deepEqual(resolveMain(own, stored, "p2"), { projectId: "p2", mainId: "main-2", fromStored: true });
  assert.deepEqual(resolveMain(own, stored, "p3"), { projectId: "p3", mainId: null, fromStored: false });
  // Taking p2's stored Main keeps the window's own project.
  assert.deepEqual(adopt(own, resolveMain(own, stored, "p2")), {
    mains: { p1: "picked", p2: "main-2" },
    projectId: "p1",
  });
});

test("what is in storage is read without trusting it", () => {
  assert.deepEqual(parseWindowMains(null), emptyWindowMains);
  assert.deepEqual(parseWindowMains("not json"), emptyWindowMains);
  assert.deepEqual(parseWindowMains("[1]"), { mains: {}, projectId: null });
  assert.deepEqual(parseWindowMains(JSON.stringify({ mains: { p1: "a", p2: 7, p3: "" }, projectId: 4 })), {
    mains: { p1: "a" },
    projectId: null,
  });
  const own = chooseInWindow(emptyWindowMains, "p1", "a");
  assert.deepEqual(parseWindowMains(JSON.stringify(own)), own);
});
