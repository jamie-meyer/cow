// The keys cow trusts, on the backend: which pages' keys are enrolled, how a
// call's signature is verified, and how enrollment is reset.
//
// Trust on first use: with no key enrolled, the first page to ask is
// enrolled. After that a key is enrolled only by a signed call from a key
// that already is. Nothing here trusts a caller: bb does not say who calls.

import { type Kv, Refusal, serial } from "../kv.ts";
import type { LogStore } from "../caps/logstore.ts";
import { type EnrolOutcome, type EnrolledKey, type Envelope, type KeyRequest, type KeysState, type PublicKey, SIGNATURE_WINDOW_MS, enrolledKeySchema, envelopeSchema, fingerprintText, formatFingerprint, keyRequestSchema, publicKeySchema, signedText } from "./envelope.ts";

const KEY = "key:";
const REQUEST = "keyreq:";
/** Requests kept at once, pending and refused together: anyone can ask, so asking is bounded. */
export const MAX_REQUESTS = 8;
export const MAX_KEYS = 12;
const MAX_LABEL = 80;

export interface KeyDeps {
  kv: Kv;
  now(): number;
  /** SHA-256 of a text, as hex. */
  hash(text: string): string;
  /** Whether `sig` (base64url) is `key`'s signature of `text`. */
  verify(key: PublicKey, text: string, sig: string): boolean;
  log: LogStore;
  /** Where the reset file is looked for. */
  resetPath: string;
  /** Take the reset file away if it is there. True only when it was there and is now gone. */
  takeResetFile(): Promise<boolean>;
  changed(): void;
}

export interface Keys {
  state(): Promise<KeysState>;
  /** A page presents its key. The first one ever is enrolled; any other becomes a request for an enrolled page to approve. */
  enrol(key: unknown, label: unknown): Promise<{ outcome: EnrolOutcome; fingerprint: string }>;
  /** Check a signed call. Returns the fingerprint of the enrolled key that signed it, or refuses, saying why. */
  verify(envelope: unknown): Promise<{ by: string; envelope: Envelope }>;
  // Signed actions: `by` is the key that signed the call.
  approve(fingerprint: string, by: string): Promise<EnrolledKey>;
  refuse(fingerprint: string, by: string): Promise<void>;
  /** Remove an enrolled key, or forget a refused request so that page can ask again. */
  remove(fingerprint: string, by: string): Promise<void>;
  /** Clear every key if the reset file is there. Returns whether it did. */
  resetIfAsked(): Promise<boolean>;
}

export function createKeys(deps: KeyDeps): Keys {
  const { kv } = deps;
  const locked = serial();
  /** When this backend started: a call signed before then is refused, since the nonces it had seen are forgotten. */
  const startedAt = deps.now();
  const seen = new Map<string, number>();

  const fingerprintOf = (key: PublicKey): string => formatFingerprint(deps.hash(fingerprintText(key)));
  const readAll = async <T>(prefix: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T[]> => {
    const found = await Promise.all((await kv.list(prefix)).map(async (key) => schema.safeParse(await kv.get(key))));
    return found.flatMap((entry) => (entry.success ? [entry.data] : []));
  };
  const keys = async (): Promise<EnrolledKey[]> => (await readAll(KEY, enrolledKeySchema)).sort((a, b) => a.enrolledAt - b.enrolledAt || a.fingerprint.localeCompare(b.fingerprint));
  const requests = async (): Promise<KeyRequest[]> => (await readAll(REQUEST, keyRequestSchema)).sort((a, b) => a.requestedAt - b.requestedAt || a.fingerprint.localeCompare(b.fingerprint));

  const resetIfAsked: Keys["resetIfAsked"] = () =>
    locked("keys", async () => {
      if (!(await deps.takeResetFile().catch(() => false))) return false;
      const all = await kv.list(KEY);
      for (const key of [...all, ...(await kv.list(REQUEST))]) await kv.delete(key);
      seen.clear();
      await deps.log.append({ kind: "enrollment-reset", keys: all.length }, null);
      deps.changed();
      return true;
    });

  const refuse = (code: string, message: string): never => {
    throw new Refusal(code, message);
  };

  return {
    resetIfAsked,

    async state() {
      await resetIfAsked();
      return { keys: await keys(), requests: await requests(), now: deps.now(), resetPath: deps.resetPath };
    },

    async enrol(rawKey, rawLabel) {
      await resetIfAsked();
      const parsed = publicKeySchema.safeParse(rawKey);
      if (!parsed.success) throw new Refusal("bad_key", "that is not a P-256 public key");
      const key = parsed.data;
      const label = (typeof rawLabel === "string" ? rawLabel : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) || "a page";
      const fingerprint = fingerprintOf(key);
      return locked("keys", async () => {
        const enrolled = await keys();
        if (enrolled.some((entry) => entry.fingerprint === fingerprint)) return { outcome: "enrolled" as const, fingerprint };
        if (enrolled.length === 0) {
          const first: EnrolledKey = { fingerprint, key, label, enrolledAt: deps.now(), how: "first", approvedBy: null, lastUsedAt: null };
          await deps.log.append({ kind: "key-enrolled", fingerprint, how: "first", label }, null);
          await kv.set(KEY + fingerprint, first);
          await kv.delete(REQUEST + fingerprint);
          deps.changed();
          return { outcome: "enrolled-first" as const, fingerprint };
        }
        const waiting = await requests();
        const mine = waiting.find((entry) => entry.fingerprint === fingerprint);
        if (mine) return { outcome: mine.status, fingerprint };
        if (waiting.length >= MAX_REQUESTS) throw new Refusal("too_many_requests", `${waiting.length} pages already wait to be enrolled or were refused: deal with those first, from a page that is enrolled`);
        await deps.log.append({ kind: "key-requested", fingerprint, label }, null);
        await kv.set(REQUEST + fingerprint, { fingerprint, key, label, requestedAt: deps.now(), status: "pending" } satisfies KeyRequest);
        deps.changed();
        return { outcome: "pending" as const, fingerprint };
      });
    },

    async verify(raw) {
      await resetIfAsked();
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success || parsed.data.sig === "" || parsed.data.key === "") return refuse("unsigned", "this is something only the person may do, so the call has to be signed by a key enrolled with cow: it carries no usable signature");
      const envelope = parsed.data;
      const enrolled = enrolledKeySchema.safeParse(await kv.get(KEY + envelope.key));
      if (!enrolled.success || enrolled.data.fingerprint !== envelope.key) return refuse("unknown_key", `the key ${envelope.key} is not enrolled with cow`);
      const now = deps.now();
      if (!Number.isFinite(envelope.at) || Math.abs(now - envelope.at) > SIGNATURE_WINDOW_MS || envelope.at < startedAt) {
        return refuse("stale", "the call was signed too long ago, or before cow last started: sign it again");
      }
      // The signature is checked before the nonce is remembered, so that an unsigned call cannot use one up.
      let good = false;
      try {
        good = deps.verify(enrolled.data.key, signedText(envelope), envelope.sig);
      } catch {
        good = false;
      }
      if (!good) return refuse("bad_signature", "the signature does not match the call: it was not signed by that key, or it was changed after it was signed");
      for (const [nonce, at] of seen) if (now - at > 2 * SIGNATURE_WINDOW_MS) seen.delete(nonce);
      if (seen.has(envelope.nonce)) return refuse("replayed", "this signed call was already used once");
      seen.set(envelope.nonce, now);
      await kv.set(KEY + envelope.key, { ...enrolled.data, lastUsedAt: now });
      return { by: envelope.key, envelope };
    },

    approve: (fingerprint, by) =>
      locked("keys", async () => {
        const request = keyRequestSchema.safeParse(await kv.get(REQUEST + fingerprint));
        if (!request.success) throw new Refusal("request_not_found", `no page with the key ${fingerprint} is asking to be enrolled`);
        if ((await keys()).length >= MAX_KEYS) throw new Refusal("too_many_keys", `${MAX_KEYS} keys are enrolled already: remove one first`);
        const made: EnrolledKey = { fingerprint, key: request.data.key, label: request.data.label, enrolledAt: deps.now(), how: "approved", approvedBy: by, lastUsedAt: null };
        await deps.log.append({ kind: "key-enrolled", fingerprint, how: "approved", label: made.label }, by);
        await kv.set(KEY + fingerprint, made);
        await kv.delete(REQUEST + fingerprint);
        deps.changed();
        return made;
      }),

    refuse: (fingerprint, by) =>
      locked("keys", async () => {
        const request = keyRequestSchema.safeParse(await kv.get(REQUEST + fingerprint));
        if (!request.success) throw new Refusal("request_not_found", `no page with the key ${fingerprint} is asking to be enrolled`);
        await deps.log.append({ kind: "key-refused", fingerprint }, by);
        await kv.set(REQUEST + fingerprint, { ...request.data, status: "refused" } satisfies KeyRequest);
        deps.changed();
      }),

    remove: (fingerprint, by) =>
      locked("keys", async () => {
        const enrolled = (await kv.get(KEY + fingerprint)) !== undefined;
        const requested = (await kv.get(REQUEST + fingerprint)) !== undefined;
        if (!enrolled && !requested) throw new Refusal("key_not_found", `there is no key ${fingerprint}`);
        await deps.log.append({ kind: "key-removed", fingerprint }, by);
        await kv.delete(KEY + fingerprint);
        await kv.delete(REQUEST + fingerprint);
        deps.changed();
      }),
  };
}
