// What a signed call is, for the page that signs and the backend that
// verifies. Pure.
//
// Some things on cow's page only the person may do. bb does not say who
// calls a plugin, so the page proves it instead: it holds a signing key that
// never leaves the browser, and signs each such call. The backend acts on a
// call only when the signature verifies against a key that was enrolled.

import { z } from "zod";
import { canonical } from "./canonical.ts";

/**
 * THE LIST of what only the person may do, and so must be signed. Each name
 * is an action the backend carries out only for a verified signature; there
 * is no unsigned way to any of them.
 */
export const PERSON_ACTIONS = [
  /** Make, delete or put back a capability. There is no editing one. */
  "cap_create",
  "cap_delete",
  "cap_restore",
  /** Acknowledge a notice: a new capability, or a decision made outside cow. */
  "cap_ack",
  /** Decide one of bb's permission requests. */
  "permission_decide",
  /** Send a thread a message as the person: "ask again as me", "carry on without it", the reason for a denial, and what is said to a thread from the page. */
  "send",
  /** Answer an ask, or close one as already answered in chat. */
  "ask_answer",
  "ask_close",
  /**
   * Take a line out of the queue of what waits on the person, or put it back:
   * mark a thread's reply as seen (null takes the mark back), dismiss what bb
   * refused a thread (null shows it again), and mark a brief as read (or not).
   * Opening a chat or a brief on the page does the first and the last, and
   * signs them the same way.
   */
  "seen_set",
  "dismissal_set",
  "brief_read",
  /**
   * Record which thread is a project's Main: where every new window starts.
   * A window's own choice needs no signature; what other windows start from
   * does, or a new window could be opened on a tree that is not the person's.
   */
  "main_choose",
  /** Delete one of bb's automations, through the automations plugin. Its past run threads stay; nothing undoes it. */
  "automation_delete",
  /** Say what a finished worker came to, for cow's ledger. What the person judges, no thread overwrites. */
  "outcome_set",
  /** Approve or refuse a page that asks for its key to be enrolled; remove an enrolled key. */
  "key_approve",
  "key_refuse",
  "key_remove",
] as const;
export type PersonAction = (typeof PERSON_ACTIONS)[number];

/** A signature is good for this long either side of the backend's clock. */
export const SIGNATURE_WINDOW_MS = 2 * 60_000;

/** The public half of a page's key, as the browser exports it. */
export const publicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PublicKey = z.infer<typeof publicKeySchema>;

export const envelopeSchema = z.object({
  action: z.string().max(60),
  /** The action's arguments, exactly as they were signed. */
  args: z.unknown(),
  /** When it was signed, by the backend's clock as the page knows it. */
  at: z.number(),
  /** Used once. */
  nonce: z.string().min(16).max(64),
  /** The fingerprint of the key that signed it. */
  key: z.string().max(40),
  /** The signature, base64url: ECDSA P-256 over SHA-256, r then s. */
  sig: z.string().max(200),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** The exact text that is signed: the action, its arguments, when, and the nonce. */
export function signedText(call: Pick<Envelope, "action" | "args" | "at" | "nonce">): string {
  return canonical({ action: call.action, args: call.args ?? null, at: call.at, nonce: call.nonce });
}

/** What a key's fingerprint is the hash of. */
export function fingerprintText(key: PublicKey): string {
  return canonical({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
}

/** A fingerprint as shown: the first 16 hex digits of the hash, in fours. */
export function formatFingerprint(sha256Hex: string): string {
  return (sha256Hex.slice(0, 16).match(/.{4}/g) ?? []).join("-");
}

export const enrolledKeySchema = z.object({
  fingerprint: z.string(),
  key: publicKeySchema,
  /** What the page said it was: its browser, in a few words. It is the page's own word. */
  label: z.string(),
  enrolledAt: z.number(),
  /** `first`: nothing was enrolled, and this was the first page to open. `approved`: an enrolled page approved it. */
  how: z.enum(["first", "approved"]),
  /** The key that approved it; null for the first. */
  approvedBy: z.string().nullable(),
  lastUsedAt: z.number().nullable(),
});
export type EnrolledKey = z.infer<typeof enrolledKeySchema>;

export const keyRequestSchema = z.object({
  fingerprint: z.string(),
  key: publicKeySchema,
  label: z.string(),
  requestedAt: z.number(),
  status: z.enum(["pending", "refused"]),
});
export type KeyRequest = z.infer<typeof keyRequestSchema>;

export const keysStateSchema = z.object({
  keys: z.array(enrolledKeySchema),
  requests: z.array(keyRequestSchema),
  /** The backend's clock, so that a page whose own clock is off still signs a time the backend accepts. */
  now: z.number(),
  /** The file whose presence resets enrollment. */
  resetPath: z.string(),
});
export type KeysState = z.infer<typeof keysStateSchema>;

/** What a page that asks to be enrolled is told. */
export type EnrolOutcome = "enrolled-first" | "enrolled" | "pending" | "refused";

/** Why a page cannot do what only the person may, and how to change that. */
export function notEnrolledText(status: "pending" | "refused" | "unavailable" | "loading", fingerprint: string | null, resetPath: string): string {
  const reset = resetPath ? ` Or reset enrollment from your own terminal: touch ${resetPath}` : "";
  if (status === "loading") return "this page's key is still being read: try again in a moment";
  if (status === "unavailable") return "this browser cannot hold a signing key here, so this page can only read";
  if (status === "refused") return `this page's key ${fingerprint ?? ""} was refused, so this page can only read. Ask again from a page that is enrolled (C, then remove the refusal), if this is you.${reset}`;
  return `this page's key ${fingerprint ?? ""} is not enrolled, so this page can only read. Approve it from a page that is enrolled: C there, then Enter on this key.${reset}`;
}
