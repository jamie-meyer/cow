import assert from "node:assert/strict";
import { test } from "node:test";
import { toAskDetail } from "../src/answer.ts";
import {
  type PermissionAsk,
  choosePermission,
  confirmPermission,
  emptyPermissionDraft,
  fileChanges,
  grantText,
  permissionSummary,
  reasonText,
} from "../src/permission.ts";

// The two requests below are what bb sent for a real fixture thread.
const command = {
  id: "pint_1",
  status: "pending",
  createdAt: 10,
  payload: {
    kind: "approval",
    subject: {
      kind: "command",
      itemId: "item-96",
      command: "echo cow",
      cwd: null,
      actions: [{ type: "unknown", command: "echo cow" }],
      sessionGrant: { network: null, fileSystem: null },
    },
    reason: "dangerouslyDisableSandbox",
    availableDecisions: ["allow_once", "deny"],
  },
};
const fileChange = {
  id: "pint_2",
  status: "pending",
  createdAt: 20,
  payload: {
    kind: "approval",
    subject: {
      kind: "file_change",
      itemId: "item-107",
      writeScope: null,
      sessionGrant: { network: null, fileSystem: { read: [], write: ["/tmp/cow-test", "/private/tmp/cow-test"] } },
    },
    reason: "Path is outside allowed working directories",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  },
};

function permission(raw: unknown): PermissionAsk {
  const ask = toAskDetail(raw);
  assert.ok(ask?.kind === "permission");
  return ask;
}

test("a command request is read with its command and bb's options, in bb's order", () => {
  const ask = permission(command);
  assert.deepEqual(ask.subject, { kind: "command", command: "echo cow", cwd: null });
  assert.equal(ask.itemId, "item-96");
  assert.deepEqual(
    ask.options.map((option) => option.action),
    ["allow_once", "deny", "deny_with_message"],
  );
  assert.equal(ask.options.some((option) => option.broad), false);
  assert.equal(reasonText(ask.reason), "it asks to run this outside the sandbox");
});

test("a file-change request offers the session grant, marked as wider than the request", () => {
  const ask = permission(fileChange);
  assert.deepEqual(
    ask.options.map((option) => [option.action, option.broad, option.text]),
    [
      ["allow_once", false, false],
      ["allow_for_session", true, false],
      ["deny", false, false],
      ["deny_with_message", false, true],
    ],
  );
  assert.equal(grantText(ask), "read and write anything under /tmp/cow-test and /private/tmp/cow-test");
});

test("each request reads as one line, whatever its kind", () => {
  assert.equal(permissionSummary(command.payload), "permission to run: echo cow");
  assert.equal(permissionSummary(fileChange.payload), "permission to change a file in /tmp/cow-test");
  assert.equal(permissionSummary({ subject: { kind: "file_change" } }), "permission to change a file");
  assert.equal(permissionSummary({ subject: { kind: "plan", plan: "x" } }), "permission to carry out its plan");
  assert.equal(permissionSummary({ subject: { kind: "permission_grant", toolName: "WebFetch" } }), "permission to use WebFetch");
  assert.equal(permissionSummary({ subject: { kind: "tool_use", tool: "deploy" } }), "permission to use deploy");
  assert.equal(permissionSummary({}), "permission request");
});

test("requests the page has not been proven to answer are left to the chat", () => {
  const withSubject = (subject: unknown, availableDecisions: unknown = ["allow_once", "deny"]) =>
    toAskDetail({ ...command, payload: { kind: "approval", reason: null, subject, availableDecisions } });
  assert.equal(withSubject({ kind: "permission_grant", itemId: "i", toolName: "WebFetch", permissions: {} })?.kind, "other");
  assert.equal(withSubject({ kind: "tool_use", itemId: "i", tool: "deploy" })?.kind, "other");
  // A command with no text, a decision bb has not defined, and no decisions at all.
  assert.equal(withSubject({ kind: "command", itemId: "i", command: "" })?.kind, "other");
  assert.equal(withSubject(command.payload.subject, ["allow_once", "allow_forever"])?.kind, "other");
  assert.equal(withSubject(command.payload.subject, [])?.kind, "other");
  // A session grant that does not say what it grants cannot be sent.
  assert.equal(
    withSubject({ ...command.payload.subject, sessionGrant: null }, ["allow_once", "allow_for_session", "deny"])?.kind,
    "other",
  );
});

test("a digit only marks an option; Enter sends a narrow decision", () => {
  const ask = permission(command);
  assert.deepEqual(confirmPermission(emptyPermissionDraft, ask), { kind: "incomplete", why: "choose an option first" });
  assert.equal(choosePermission(emptyPermissionDraft, ask, 9), emptyPermissionDraft);
  const allow = choosePermission(emptyPermissionDraft, ask, 1);
  assert.deepEqual(confirmPermission(allow, ask), {
    kind: "send",
    resolution: { decision: "allow_once", grantedPermissions: null },
    message: null,
  });
  const deny = choosePermission(allow, ask, 2);
  assert.deepEqual(confirmPermission(deny, ask), { kind: "send", resolution: { decision: "deny" }, message: null });
});

test("a wider grant takes two Enters, and sends back exactly what bb said it grants", () => {
  const ask = permission(fileChange);
  const chosen = choosePermission(emptyPermissionDraft, ask, 2);
  const first = confirmPermission(chosen, ask);
  assert.ok(first.kind === "confirm");
  assert.equal(first.draft.confirming, true);
  assert.deepEqual(confirmPermission(first.draft, ask), {
    kind: "send",
    resolution: {
      decision: "allow_for_session",
      grantedPermissions: { network: null, fileSystem: { read: [], write: ["/tmp/cow-test", "/private/tmp/cow-test"] } },
    },
    message: null,
  });
  // Choosing again backs out of the confirmation.
  const again = choosePermission(first.draft, ask, 1);
  assert.equal(again.confirming, false);
  assert.equal(confirmPermission(again, ask).kind, "send");
});

test("denying with a message needs the message, and sends a plain denial with it", () => {
  const ask = permission(command);
  const chosen = choosePermission(emptyPermissionDraft, ask, 3);
  assert.deepEqual(confirmPermission(chosen, ask), { kind: "incomplete", why: "type what to tell it first" });
  assert.deepEqual(confirmPermission({ ...chosen, message: "  use the scratch folder  " }, ask), {
    kind: "send",
    resolution: { decision: "deny" },
    message: "use the scratch folder",
  });
});

test("the file and diff of a change come from the timeline row of the same tool call", () => {
  const rows = [
    { workKind: "command", callId: "item-107", command: "ls" },
    { workKind: "file-change", callId: "other", change: { path: "/a", kind: "add", diff: "+a\n" } },
    {
      workKind: "file-change",
      callId: "item-107",
      change: { path: "/tmp/cow-test/cow.txt", kind: "add", diff: "--- /dev/null\n+++ b/tmp/cow-test/cow.txt\n+cow\n" },
    },
    "junk",
  ];
  assert.deepEqual(fileChanges(rows, "item-107"), [
    { path: "/tmp/cow-test/cow.txt", change: "add", diff: "--- /dev/null\n+++ b/tmp/cow-test/cow.txt\n+cow\n" },
  ]);
  assert.deepEqual(fileChanges(rows, "none"), []);
});
