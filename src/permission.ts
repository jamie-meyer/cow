// A permission request: an agent wants to run a command or change a file and
// bb did not approve it by itself. This reads bb's request, lists what the
// user can decide, and builds the answer bb expects back.
//
// Only the kinds proven against a real request are answered from the page:
// a command, and a file change. The rest are described and left to the chat.

import { firstLine } from "./text.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** What bb says a session-wide grant would open up. Sent back to bb as it came. */
export interface Grant {
  fileSystem: { read: string[]; write: string[] } | null;
  network: { enabled: boolean | null } | null;
}

export type PermissionSubject =
  | { kind: "command"; command: string; cwd: string | null }
  | { kind: "file_change"; writeScope: string | null };

export type Decision = "allow_once" | "allow_for_session" | "deny";

export interface PermissionOption {
  /** What bb is told. "deny_with_message" is a denial followed by a message to the thread. */
  action: Decision | "deny_with_message";
  label: string;
  /** What choosing it means, in a few words. */
  detail: string;
  /** Wider than this one request: needs a second confirmation. */
  broad: boolean;
  /** Takes typed text. */
  text: boolean;
}

export interface PermissionAsk {
  kind: "permission";
  id: string;
  at: number;
  /** The agent's tool call this is about; its details are in the thread's timeline. */
  itemId: string;
  subject: PermissionSubject;
  /** Why bb asks, in bb's words. */
  reason: string;
  /** What "allow for this session" would grant, or null when bb offers none. */
  grant: Grant | null;
  options: PermissionOption[];
}

function toGrant(raw: unknown): Grant | null {
  const r = record(raw);
  if (!r) return null;
  const fileSystem = record(r.fileSystem);
  const network = record(r.network);
  return {
    fileSystem: fileSystem ? { read: strings(fileSystem.read), write: strings(fileSystem.write) } : null,
    network: network ? { enabled: typeof network.enabled === "boolean" ? network.enabled : null } : null,
  };
}

/** Every path a grant names, without repeats. */
function grantPaths(grant: Grant | null): string[] {
  return [...new Set([...(grant?.fileSystem?.write ?? []), ...(grant?.fileSystem?.read ?? [])])];
}

/** What a session-wide grant opens up, named exactly. */
export function grantText(ask: PermissionAsk): string {
  const parts: string[] = [];
  const write = ask.grant?.fileSystem?.write ?? [];
  const read = (ask.grant?.fileSystem?.read ?? []).filter((path) => !write.includes(path));
  if (write.length > 0) parts.push(`read and write anything under ${write.join(" and ")}`);
  if (read.length > 0) parts.push(`read anything under ${read.join(" and ")}`);
  if (ask.grant?.network?.enabled) parts.push("use the network");
  if (ask.subject.kind === "command") {
    parts.push("run this command, and others bb judges to be like it, without asking");
  }
  return parts.length > 0 ? parts.join("; ") : "whatever bb attaches to this request (bb does not say what)";
}

function describeSubject(subject: Record<string, unknown>): PermissionSubject | null {
  if (subject.kind === "command" && typeof subject.command === "string" && subject.command !== "") {
    return { kind: "command", command: subject.command, cwd: text(subject.cwd) || null };
  }
  if (subject.kind === "file_change") {
    return { kind: "file_change", writeScope: text(subject.writeScope) || null };
  }
  return null;
}

/**
 * What a request is for, in one line, for the thread's line and the queue.
 * Works for every kind bb defines, including the ones only the chat answers.
 */
export function permissionSummary(payload: Record<string, unknown>): string {
  const subject = record(payload.subject) ?? {};
  switch (subject.kind) {
    case "command":
      return `permission to run: ${firstLine(text(subject.command)) || "a command"}`;
    case "file_change": {
      const where = text(subject.writeScope) || grantPaths(toGrant(subject.sessionGrant))[0];
      return where ? `permission to change a file in ${where}` : "permission to change a file";
    }
    case "plan":
      return "permission to carry out its plan";
    case "permission_grant": {
      const tool = text(subject.toolName);
      return tool ? `permission to use ${tool}` : "permission for more access";
    }
    case "tool_use":
      return `permission to use ${text(subject.tool) || "a tool"}`;
    default:
      return "permission request";
  }
}

/** Why a kind of request is left to the chat. */
export function unsupportedWhy(payload: Record<string, unknown>): string {
  const kind = record(payload.subject)?.kind;
  const what =
    kind === "plan"
      ? "a plan to approve"
      : kind === "permission_grant" || kind === "tool_use"
        ? "a request to use a tool"
        : "a kind of permission request";
  return `This is ${what}, which this page does not answer yet: it answers requests to run a command or change a file. Grant or deny it in its chat.`;
}

/**
 * Read an approval request. Null when it is of a kind, or offers a decision,
 * that this page has not been proven to answer.
 */
export function toPermission(id: string, at: number, payload: Record<string, unknown>): PermissionAsk | null {
  const raw = record(payload.subject);
  const subject = raw && describeSubject(raw);
  if (!raw || !subject || typeof raw.itemId !== "string") return null;
  const decisions = Array.isArray(payload.availableDecisions) ? payload.availableDecisions : [];
  const grant = toGrant(raw.sessionGrant);
  const options: PermissionOption[] = [];
  for (const decision of decisions) {
    if (decision === "allow_once") {
      options.push({
        action: "allow_once",
        label: "Allow once",
        detail: subject.kind === "command" ? "this command, this time" : "this change, this time",
        broad: false,
        text: false,
      });
    } else if (decision === "allow_for_session") {
      // bb refuses a session grant that does not say what is granted.
      if (grant === null) return null;
      options.push({
        action: "allow_for_session",
        label: "Allow for the rest of this session",
        detail: "wider than this request; asks you to confirm",
        broad: true,
        text: false,
      });
    } else if (decision === "deny") {
      options.push({ action: "deny", label: "Deny", detail: "it is told no, and carries on", broad: false, text: false });
      options.push({
        action: "deny_with_message",
        label: "Deny, and tell it why",
        detail: "a denial, then your message to the thread",
        broad: false,
        text: true,
      });
    } else {
      return null;
    }
  }
  if (options.length === 0) return null;
  return { kind: "permission", id, at, itemId: raw.itemId, subject, reason: text(payload.reason), grant, options };
}

/** bb's reason codes that mean more than they say. */
export function reasonText(reason: string): string {
  if (reason === "dangerouslyDisableSandbox") return "it asks to run this outside the sandbox";
  return reason;
}

/** A file the request would change, read from the thread's timeline. */
export interface FileChange {
  path: string;
  /** add, modify, delete, as bb names it. */
  change: string;
  diff: string;
}

/** The file changes of the tool call `itemId`, from a thread's timeline rows. */
export function fileChanges(rows: readonly unknown[], itemId: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row || row.workKind !== "file-change" || row.callId !== itemId) continue;
    const change = record(row.change);
    if (!change || typeof change.path !== "string") continue;
    changes.push({ path: change.path, change: text(change.kind), diff: text(change.diff) });
  }
  return changes;
}

/** What the user has done on the card so far. */
export interface PermissionDraft {
  /** 1-based option, or null before any digit. */
  chosen: number | null;
  /** The message for a denial that takes one. */
  message: string;
  /** True once Enter was pressed on a broad option: the next Enter grants it. */
  confirming: boolean;
}

export const emptyPermissionDraft: PermissionDraft = { chosen: null, message: "", confirming: false };

/** A digit marks an option and never sends. It also backs out of a pending confirmation. */
export function choosePermission(draft: PermissionDraft, ask: PermissionAsk, number: number): PermissionDraft {
  if (!ask.options[number - 1]) return draft;
  return { ...draft, chosen: number, confirming: false };
}

export function chosenOption(draft: PermissionDraft, ask: PermissionAsk): PermissionOption | null {
  return draft.chosen === null ? null : (ask.options[draft.chosen - 1] ?? null);
}

/** The answer bb's interaction takes. */
export type PermissionResolution =
  | { decision: "allow_once"; grantedPermissions: null }
  | { decision: "allow_for_session"; grantedPermissions: Grant }
  | { decision: "deny" };

export type PermissionConfirmed =
  | { kind: "incomplete"; why: string }
  /** A broad grant was chosen: show exactly what it grants and wait for a second Enter. */
  | { kind: "confirm"; draft: PermissionDraft }
  | { kind: "send"; resolution: PermissionResolution; message: string | null };

/**
 * Enter: nothing without a choice; a broad grant asks once more; a denial
 * with a message needs the message; everything else is sent.
 */
export function confirmPermission(draft: PermissionDraft, ask: PermissionAsk): PermissionConfirmed {
  const option = chosenOption(draft, ask);
  if (!option) return { kind: "incomplete", why: "choose an option first" };
  switch (option.action) {
    case "allow_once":
      return { kind: "send", resolution: { decision: "allow_once", grantedPermissions: null }, message: null };
    case "allow_for_session":
      if (ask.grant === null) return { kind: "incomplete", why: "bb does not say what this would grant" };
      if (!draft.confirming) return { kind: "confirm", draft: { ...draft, confirming: true } };
      return {
        kind: "send",
        resolution: { decision: "allow_for_session", grantedPermissions: ask.grant },
        message: null,
      };
    case "deny":
      return { kind: "send", resolution: { decision: "deny" }, message: null };
    case "deny_with_message": {
      const message = draft.message.trim();
      if (message === "") return { kind: "incomplete", why: "type what to tell it first" };
      return { kind: "send", resolution: { decision: "deny" }, message };
    }
  }
}
