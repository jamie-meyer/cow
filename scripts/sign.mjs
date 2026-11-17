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

export async function createSigner(bb, label = "the end-to-end check", plugin = "cow") {
  const post = async (method, input) => {
    const response = await fetch(`${bb}/api/v1/plugins/${plugin}/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
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

/** The id the copy made by scripts/copy-for-checks.mjs is installed under, and what the checks run against unless told otherwise. */
export const COPY_ID = "cow-check";
/** The flag without which the checks refuse to run against the installed cow. */
export const INSTALLED_FLAG = "--reset-the-installed-cow";

/**
 * Stop unless it is safe to run against `plugin`, and say what the run will
 * reset. The checks clear every enrolled key of the plugin they run against,
 * make and delete capabilities in it and write to its log; on a cow in use
 * that wipes the person's key and races their open page for the next one.
 */
export async function guardPlugin(bb, plugin, args) {
  if (plugin === "cow" && !args.includes(INSTALLED_FLAG)) {
    console.error(
      `These checks do not run against the installed cow unless you say so.\n` +
        `They would clear every key enrolled with it, so that your own page is no longer enrolled, and write test entries to its log, which nothing clears.\n\n` +
        `Run them against a copy instead:\n` +
        `  node scripts/copy-for-checks.mjs <empty folder>\n` +
        `  bb plugin install <that folder> --yes\n` +
        `  (run this again; the copy, ${COPY_ID}, is the default)\n` +
        `  bb plugin remove ${COPY_ID}\n\n` +
        `To run against the installed cow all the same: --plugin cow ${INSTALLED_FLAG}`,
    );
    process.exit(2);
  }
  let state = null;
  try {
    state = (await (await fetch(`${bb}/api/v1/plugins/${plugin}/rpc/keys_state`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).json()).result ?? null;
  } catch {
    state = null;
  }
  if (state === null) {
    console.error(`The plugin "${plugin}" does not answer${plugin === COPY_ID ? `: make and install the copy first.\n  node scripts/copy-for-checks.mjs <empty folder>\n  bb plugin install <that folder> --yes` : "."}`);
    process.exit(2);
  }
  console.log(
    `These checks run against the plugin "${plugin}". They will reset its enrollment, now and when they finish: ${state.keys.length} enrolled ${state.keys.length === 1 ? "key" : "keys"}${state.keys.length > 0 ? ` (${state.keys.map((key) => `${key.fingerprint}, ${key.label}`).join("; ")})` : ""} and ${state.requests.length} ${state.requests.length === 1 ? "request" : "requests"} will be cleared, by creating ${state.resetPath}. They also make and delete capabilities there and add to its log.`,
  );
}
