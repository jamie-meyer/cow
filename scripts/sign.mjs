// A signing key for the end-to-end checks: made in this process, enrolled
// with cow the way a page's is, and used to sign the calls only the person
// may make. Needs Node 22 or newer and no dependencies.
//
// The same text is signed as on the page: the action, its arguments, a
// time and a nonce, written with sorted keys (see src/signing).
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function createSigner(bb, label = "the end-to-end check") {
  const post = async (method, input) => {
    const response = await fetch(`${bb}/api/v1/plugins/cow/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return response.json();
  };
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const key = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const hex = createHash("sha256").update(canonical({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest("hex");
  const fingerprint = hex.slice(0, 16).match(/.{4}/g).join("-");
  const state = async () => (await post("keys_state", null)).result;
  /** The envelope for one call, signed. `change` alters it after signing, for checks of tampering. */
  const envelope = async (action, args) => {
    const signed = { action, args, at: (await state()).now, nonce: randomBytes(16).toString("hex") };
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(canonical(signed)));
    return { ...signed, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return {
    fingerprint,
    key,
    state,
    post,
    envelope,
    /** Present this key. Returns "enrolled-first", "enrolled", "pending" or "refused". */
    enrol: async () => (await post("key_enrol", { key, label })).result?.outcome ?? null,
    /** One of the person's actions, signed with this key. A refusal is an answer: `{ ok: false, error }`. */
    call: async (action, args) => post("signed", await envelope(action, args)),
    /** The same; a refusal throws. */
    must: async (action, args) => {
      const done = await post("signed", await envelope(action, args));
      if (!done.ok) throw new Error(`${action}: ${JSON.stringify(done.error ?? done)}`);
      return done.result.result;
    },
    /**
     * Clear every enrolled key, as the person does from their own terminal:
     * by creating the reset file. It also clears the keys of whoever uses
     * this bb; their page is enrolled again, by first use, when it next
     * opens cow with no key enrolled.
     */
    resetEnrollment: async () => {
      const { resetPath } = await state();
      mkdirSync(dirname(resetPath), { recursive: true });
      writeFileSync(resetPath, "reset\n");
      // Asking about the keys is what makes cow look for the file. A page that is open may be enrolled again at once, so the file going is the sign.
      for (let tries = 0; tries < 50; tries += 1) {
        await state();
        if (!existsSync(resetPath)) return resetPath;
        await sleep(200);
      }
      throw new Error("cow did not take the reset file");
    },
  };
}
