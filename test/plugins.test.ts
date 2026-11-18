import assert from "node:assert/strict";
import { test } from "node:test";
import { BB_CORE, type EntryLike, PICK_KEYS, actionTarget, choiceRows, indexById, otherActions, pickAction, pickChoice } from "../src/plugins.ts";

const facts = {
  id: "thr_a",
  projectId: "proj_1",
  parentThreadId: "thr_main",
  parentNotifications: "stuck" as const,
  archivedAt: null,
  sectionId: null,
  lastReadAt: 10,
  latestAttentionAt: 20,
  status: "idle",
};

const sidebar = {
  id: "thr_a",
  projectId: "proj_1",
  parentThreadId: "thr_main",
  parentNotifications: "stuck" as const,
  archivedAt: null,
  pinnedAt: 5,
  sectionId: "sec_1",
  isUnread: false,
  status: "idle",
  environment: { id: "env_1", path: "/checkout", name: "x" },
  displayTitle: "a thread",
};

const entry = (key: string, pluginId: string, action: Partial<EntryLike["action"]> = {}, group = "g"): EntryLike => ({
  key,
  pluginId,
  group,
  action: { label: key, ...action },
});

test("each of cow's lines finds bb's own copy of its thread by id", () => {
  const byId = indexById([sidebar, { ...sidebar, id: "thr_b" }]);
  assert.equal(byId.get("thr_a"), sidebar);
  assert.equal(byId.get("thr_b")?.id, "thr_b");
  assert.equal(byId.get("thr_c"), undefined);
});

test("an action is evaluated with bb's copy of the thread, environment and all", () => {
  const target = actionTarget(facts, sidebar);
  assert.deepEqual(target, {
    id: "thr_a",
    projectId: "proj_1",
    parentThreadId: "thr_main",
    parentNotifications: "stuck",
    archivedAt: null,
    pinnedAt: 5,
    sectionId: "sec_1",
    isUnread: false,
    status: "idle",
    environment: { id: "env_1", path: "/checkout" },
  });
  // An environment bb has no id for is no environment to offer.
  assert.equal(actionTarget(facts, { ...sidebar, environment: { id: null, path: null } }).environment, null);
});

test("without bb's copy, cow's facts stand in, with no environment", () => {
  const target = actionTarget(facts, undefined);
  assert.equal(target.id, "thr_a");
  assert.equal(target.environment, null);
  assert.equal(target.pinnedAt, null);
  assert.equal(target.isUnread, true, "attention after it was last read");
  assert.equal(actionTarget({ ...facts, latestAttentionAt: 5 }, undefined).isUnread, false);
  assert.equal(actionTarget({ ...facts, parentNotifications: undefined }, undefined).parentNotifications, "auto");
});

test("the menu lists other plugins' actions in bb's order, leaving out bb's own and cow's", () => {
  const rows = otherActions(
    [entry("bb--core/pin", BB_CORE), entry("ci/fix", "ci"), entry("cow/x", "cow"), entry("ci/restack", "ci"), entry("notes/tag", "notes", {}, "h")],
    "cow",
  );
  assert.deepEqual(
    rows.map((row) => [row.pick, row.entry.key, row.from]),
    [
      ["1", "ci/fix", "ci"],
      ["2", "ci/restack", "ci"],
      ["3", "notes/tag", "notes"],
    ],
  );
});

test("past the digits rows are picked by letters, never f or q, and past those by nothing", () => {
  assert.ok(!PICK_KEYS.includes("f") && !PICK_KEYS.includes("q"));
  assert.equal(new Set(PICK_KEYS).size, PICK_KEYS.length);
  const many = Array.from({ length: PICK_KEYS.length + 2 }, (_, index) => entry(`p/${index}`, "p"));
  const rows = otherActions(many, null);
  assert.equal(rows[9]?.pick, "a");
  assert.equal(rows[PICK_KEYS.length]?.pick, "");
  assert.equal(pickAction(rows, "").kind, "miss", "a row with no key cannot be picked by a key");
});

test("picking runs a plain action, opens an action's choices, and refuses a disabled one", () => {
  const rows = otherActions(
    [entry("p/plain", "p"), entry("p/off", "p", { disabled: true }), entry("p/pick", "p", { choices: { items: [{ id: "a", label: "A" }] } })],
    null,
  );
  const plain = pickAction(rows, "1");
  assert.equal(plain.kind, "run");
  assert.equal(plain.kind === "run" && plain.entry.key, "p/plain");
  assert.equal(plain.kind === "run" && plain.value, undefined);
  assert.deepEqual(pickAction(rows, "2"), { kind: "disabled", label: "p/off" });
  assert.equal(pickAction(rows, "3").kind, "choices");
  assert.equal(pickAction(rows, "9").kind, "miss");
  assert.equal(pickAction(rows, "Escape").kind, "miss");
});

test("a choice runs its action with the choice's id; a disabled choice cannot be picked", () => {
  const withChoices = entry("p/pick", "p", {
    choices: { items: [{ id: "red", label: "red" }, { id: "blue", label: "blue" }, { id: "grey", label: "grey", disabled: true }] },
  });
  assert.deepEqual(
    choiceRows(withChoices).map((row) => [row.pick, row.choice.id]),
    [
      ["1", "red"],
      ["2", "blue"],
      ["3", "grey"],
    ],
  );
  assert.deepEqual(pickChoice(withChoices, "2"), { kind: "run", entry: withChoices, value: "blue" });
  assert.deepEqual(pickChoice(withChoices, "3"), { kind: "disabled", label: "grey" });
  assert.equal(pickChoice(withChoices, "4").kind, "miss");
});
