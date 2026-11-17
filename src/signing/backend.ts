// Signed calls, wired to bb: the one RPC method through which everything
// only the person may do is reached, the table of what those things are, and
// the two unsigned methods a page needs to get enrolled.
//
// bb serves a plugin's RPC to any local caller. That is why none of the
// person's actions is an RPC method of its own any more: each is an entry in
// ACTIONS below, carried out only after `keys.verify` has checked the call's
// signature against an enrolled key.

import { type BbPluginApi, defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Asks } from "../asks/service.ts";
import { CAPS_CHANGED, CAP_LIMITS, VIAS, scopeSchema } from "../caps/cap.ts";
import type { LogStore } from "../caps/logstore.ts";
import type { Caps } from "../caps/service.ts";
import { Refusal } from "../kv.ts";
import { PERSON_ACTIONS, type PersonAction, type PublicKey, keysStateSchema } from "./envelope.ts";
import { type Keys, createKeys } from "./keys.ts";

const id = z.string().min(1).max(200);
const fingerprint = z.string().regex(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
const ruleDraftSchema = z.union([
  z.object({ kind: z.literal("dir"), text: z.string().max(5000) }),
  z.object({ kind: z.literal("command"), mode: z.enum(["exact", "prefix"]), text: z.string().max(5000) }),
]);
const grantSchema = z.object({
  fileSystem: z.object({ read: z.array(z.string()), write: z.array(z.string()) }).nullable(),
  network: z.object({ enabled: z.boolean().nullable() }).nullable(),
});
const resolutionSchema = z.union([
  z.object({ decision: z.literal("allow_once"), grantedPermissions: z.null() }),
  z.object({ decision: z.literal("allow_for_session"), grantedPermissions: grantSchema }),
  z.object({ decision: z.literal("deny") }),
]);

/** The arguments each of the person's actions takes. The keys are exactly PERSON_ACTIONS. */
export const ACTION_ARGS = {
  cap_create: z.object({
    name: z.string().max(CAP_LIMITS.name * 4),
    note: z.string().max(CAP_LIMITS.note * 4).nullable(),
    rule: ruleDraftSchema,
    scope: scopeSchema,
    via: z.enum(VIAS),
    sourceThreadId: id.nullable(),
    askId: id.nullable(),
  }),
  cap_delete: z.object({ id }),
  cap_restore: z.object({ id }),
  cap_ack: z.object({ noticeId: id }),
  permission_decide: z.object({ threadId: id, interactionId: id, resolution: resolutionSchema }),
  send: z.object({ threadId: id, text: z.string().min(1).max(20_000) }),
  ask_answer: z.object({ id, option: z.number().int().min(1).nullable(), text: z.string().max(4000).nullable() }),
  ask_close: z.object({ id }),
  key_approve: z.object({ fingerprint }),
  key_refuse: z.object({ fingerprint }),
  key_remove: z.object({ fingerprint }),
} satisfies Record<PersonAction, z.ZodType>;
export type ActionArgs = { [Action in PersonAction]: z.infer<(typeof ACTION_ARGS)[Action]> };

export const signingRpcContract = defineRpcContract({
  /** The enrolled keys, the pages that ask to be, the backend's clock, and where the reset file goes. Anyone may read it. */
  keys_state: { input: z.null(), output: keysStateSchema },
  /** A page presents its key. With none enrolled it is enrolled; otherwise it waits for an enrolled page. */
  key_enrol: {
    input: z.object({ key: z.unknown(), label: z.string().max(400) }),
    output: z.object({ outcome: z.enum(["enrolled-first", "enrolled", "pending", "refused"]), fingerprint: z.string() }),
  },
  /**
   * One of the person's actions, signed. The only way to any of them. The
   * input is checked by `keys.verify`, not here, so that a call with no
   * signature is told what it lacks instead of which field is missing.
   */
  signed: { input: z.unknown(), output: z.object({ result: z.unknown() }) },
});

const REFUSAL_CODES: Record<string, "conflict" | "forbidden" | "invalid" | "not_found"> = {
  unsigned: "forbidden",
  unknown_key: "forbidden",
  stale: "forbidden",
  replayed: "forbidden",
  bad_signature: "forbidden",
  capability_not_found: "not_found",
  notice_not_found: "not_found",
  thread_not_found: "not_found",
  ask_not_found: "not_found",
  request_not_found: "not_found",
  key_not_found: "not_found",
  name_taken: "conflict",
  already_deleted: "conflict",
  not_deleted: "conflict",
  not_decided: "conflict",
  cannot_answer: "conflict",
  cannot_close: "conflict",
};

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: REFUSAL_CODES[cause.code] ?? "invalid", message: cause.message });
    throw cause;
  }
}

/** Whether `sig` is `key`'s signature of `text`, as a browser's WebCrypto makes one. */
export function verifyP256(key: PublicKey, text: string, sig: string): boolean {
  const signature = Buffer.from(sig, "base64url");
  if (signature.length !== 64) return false;
  return verifySignature("sha256", Buffer.from(text, "utf8"), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature);
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Carry out a verified action. `by` is the fingerprint of the key that signed it. */
export type Dispatch = { [Action in PersonAction]: (args: ActionArgs[Action], by: string) => Promise<unknown> };

/** Check a signed call and carry it out; refuse anything else. */
export async function runSigned(keys: Keys, dispatch: Dispatch, raw: unknown): Promise<unknown> {
  const { by, envelope } = await keys.verify(raw);
  if (!(PERSON_ACTIONS as readonly string[]).includes(envelope.action)) throw new Refusal("bad_action", `there is no action ${envelope.action}`);
  const action = envelope.action as PersonAction;
  const args = ACTION_ARGS[action].safeParse(envelope.args);
  if (!args.success) throw new Refusal("bad_arguments", `the arguments of ${action} are not in the required form: ${args.error.issues[0]?.path.join(".") ?? ""} ${args.error.issues[0]?.message ?? ""}`.trim());
  return (dispatch[action] as (input: unknown, by: string) => Promise<unknown>)(args.data, by);
}

export function registerSigning(bb: BbPluginApi, log: LogStore, caps: Caps, asks: Asks): Keys {
  const changed = () => bb.realtime.publish(CAPS_CHANGED, {});
  const resetPath = join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "reset-enrollment");
  const keys = createKeys({
    kv: bb.storage.kv,
    now: Date.now,
    hash: sha256Hex,
    verify: verifyP256,
    log,
    resetPath,
    takeResetFile: async () => {
      try {
        await rm(resetPath);
        return true;
      } catch {
        // Not there, or not removable: either way enrollment stands. A file that cannot be removed would otherwise reset it for ever.
        return false;
      }
    },
    changed,
  });

  const dispatch: Dispatch = {
    cap_create: (args, by) => caps.create(args, by),
    cap_delete: (args, by) => caps.remove(args.id, by),
    cap_restore: (args, by) => caps.restore(args.id, by),
    cap_ack: async (args, by) => {
      await caps.acknowledge(args.noticeId, by);
      return null;
    },
    permission_decide: async (args, by) => {
      await caps.decideOnPage(args.threadId, args.interactionId, args.resolution, by);
      return null;
    },
    send: async (args, by) => {
      await bb.sdk.threads.send({ threadId: args.threadId, mode: "auto", input: [{ type: "text", text: args.text, mentions: [] }] });
      await log.append({ kind: "sent", threadId: args.threadId, what: args.text.replace(/\s+/g, " ").trim().slice(0, 300) }, by);
      changed();
      return null;
    },
    ask_answer: async (args, by) => {
      const before = await asks.get(args.id);
      // Logged before it is sent: an answer the thread received is always one the log holds.
      await log.append({ kind: "ask-answered", threadId: before.threadId, askId: before.id, what: args.option === null ? (args.text ?? "").slice(0, 300) : `option ${args.option}${args.text ? `: ${args.text.slice(0, 280)}` : ""}` }, by);
      changed();
      return asks.answer(args.id, { option: args.option, text: args.text });
    },
    ask_close: async (args, by) => {
      const closed = await asks.close(args.id, { person: true });
      await log.append({ kind: "ask-closed", threadId: closed.threadId, askId: closed.id }, by);
      changed();
      return closed;
    },
    key_approve: (args, by) => keys.approve(args.fingerprint, by),
    key_refuse: async (args, by) => {
      await keys.refuse(args.fingerprint, by);
      return null;
    },
    key_remove: async (args, by) => {
      await keys.remove(args.fingerprint, by);
      return null;
    },
  };

  bb.rpc.register(signingRpcContract, {
    keys_state: () => keys.state(),
    key_enrol: ({ key, label }) => refusing(() => keys.enrol(key, label)),
    signed: async (envelope) => ({ result: (await refusing(() => runSigned(keys, dispatch, envelope))) ?? null }),
  });

  // The reset file is looked for when anything asks about keys, and every so often besides.
  const watch = setInterval(() => void keys.resetIfAsked().catch(() => undefined), 5000);
  bb.onDispose(() => clearInterval(watch));
  return keys;
}
