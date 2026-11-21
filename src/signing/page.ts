// The page's signing key: made once in this browser, kept in its IndexedDB
// with the private half not extractable, enrolled with cow's backend, and
// used to sign every call that only the person may make.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Ask } from "../asks/ask.ts";
import { CAPS_CHANGED, type Capability } from "../caps/cap.ts";
import type { ActionArgs, signingRpcContract } from "./backend.ts";
import { FIRST_USE_SHOWN_MS, readDismissed, rememberDismissed } from "../support.ts";
import { type EnrolledKey, type KeysState, type PersonAction, type PublicKey, fingerprintText, formatFingerprint, notEnrolledText, signedText } from "./envelope.ts";

/** What each of the person's actions gives back. */
import type { BackResultWire } from "../clone/contract.ts";

export interface ActionResult {
  cap_create: Capability;
  cap_delete: Capability;
  cap_restore: Capability;
  cap_ack: null;
  limit_ack: null;
  permission_decide: null;
  send: null;
  ask_answer: Ask;
  ask_close: Ask;
  seen_set: null;
  dismissal_set: null;
  brief_read: null;
  main_choose: { mains: Record<string, string>; currentProjectId: string | null };
  automation_delete: null;
  outcome_set: null;
  workspace_approve: { folder: string; hash: string; newCommands: number };
  workspace_dismiss: null;
  workspace_back: { workspace: string; results: BackResultWire[] };
  workspace_output: { at: number; ms: number; code: number | null; timedOut: boolean; tail: string[]; cwd: string } | null;
  workspace_held_teardown: { removed: boolean; reasons: string[] };
  workspace_held_output: { teardowns: Array<{ as: string | null; at: number; ms: number; code: number | null; timedOut: boolean; tail: string[] }>; path: string };
  workspace_held_remove: { id: string };
  key_approve: EnrolledKey;
  key_refuse: null;
  key_remove: null;
}

export type SignerStatus =
  /** The key is being read, or the backend asked. */
  | "loading"
  | "enrolled"
  /** Another key is enrolled, and this page waits for a page that holds one to approve it. */
  | "pending"
  | "refused"
  /** This browser cannot make or keep a signing key here. */
  | "unavailable";

export interface Signer {
  status: SignerStatus;
  /** This page's key, as shown. */
  fingerprint: string | null;
  /** This page's key was enrolled by first use, while this page was open: it says so until dismissed. */
  firstUse: boolean;
  dismissFirstUse: () => void;
  /** The enrolled keys and the pages that ask to be; null until read. */
  keys: KeysState | null;
  /** Why this page cannot do what only the person may; empty when it can. */
  why: string;
  /** Make one of the person's calls, signed. Rejects, saying why, when this page's key is not enrolled. */
  call: <Action extends PersonAction>(action: Action, args: ActionArgs[Action]) => Promise<ActionResult[Action]>;
}

interface Held {
  privateKey: CryptoKey;
  publicKey: PublicKey;
  fingerprint: string;
}

const DB = "cow-signing";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser's storage could not be opened"));
  });
}
const stored = <T,>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser's storage failed"));
  });

const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes as ArrayBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** This browser's key for cow: the one it has, or a new one. The private half cannot be exported, by this page or any other code. */
async function loadKey(): Promise<Held> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) throw new Error("no key store");
  const db = await openDb();
  let pair = await stored<{ privateKey: CryptoKey; publicKey: PublicKey } | undefined>(db, "readonly", (store) => store.get("page"));
  if (!pair) {
    const made = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", made.publicKey);
    pair = { privateKey: made.privateKey, publicKey: { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" } };
    await stored(db, "readwrite", (store) => store.put(pair, "page"));
    // Another tab may have made one in the same moment: whichever is stored is the browser's key.
    pair = (await stored<typeof pair>(db, "readonly", (store) => store.get("page"))) ?? pair;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintText(pair.publicKey)));
  return { ...pair, fingerprint: formatFingerprint(hex(digest)) };
}

/** What this page calls itself when it asks to be enrolled: its browser and system, in a few words. */
function pageLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Electron/.test(ua) ? "bb's desktop app" : /HeadlessChrome/.test(ua) ? "headless Chrome" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const system = /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useSigner(): Signer {
  const rpc = useRpc<typeof signingRpcContract>();
  const [held, setHeld] = useState<Held | null>(null);
  const [status, setStatus] = useState<SignerStatus>("loading");
  const [keys, setKeys] = useState<KeysState | null>(null);
  const [understood, setUnderstood] = useState<string[]>(readDismissed);
  /** The backend's clock minus this page's. */
  const offset = useRef(0);
  const live = useRef({ held, status });
  live.current = { held, status };

  useEffect(() => {
    let cancelled = false;
    loadKey().then(
      (key) => {
        if (!cancelled) setHeld(key);
      },
      () => {
        if (!cancelled) setStatus("unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Read who is enrolled, and when this page is not, ask to be. */
  const refresh = useCallback(async () => {
    const mine = live.current.held;
    const state = await rpc.call("keys_state");
    offset.current = state.now - Date.now();
    setKeys(state);
    if (mine === null) return;
    if (state.keys.some((entry) => entry.fingerprint === mine.fingerprint)) return setStatus("enrolled");
    const asked = await rpc.call("key_enrol", { key: mine.publicKey, label: pageLabel() });
    setStatus(asked.outcome === "pending" ? "pending" : asked.outcome === "refused" ? "refused" : "enrolled");
    // Read again whatever came of it: enrolled by first use, the page says so from what is stored.
    setKeys(await rpc.call("keys_state"));
  }, [rpc]);
  const refreshing = useRef<Promise<void> | null>(null);
  const reload = useCallback(() => {
    // One at a time: two at once could both ask to be enrolled.
    refreshing.current = (refreshing.current ?? Promise.resolve()).then(refresh, refresh).catch(() => undefined);
    return refreshing.current;
  }, [refresh]);
  useEffect(() => {
    if (held !== null) void reload();
  }, [held, reload]);
  useRealtime(CAPS_CHANGED, () => void reload());

  const why = status === "enrolled" ? "" : notEnrolledText(status, held?.fingerprint ?? null, keys?.resetPath ?? "");
  const whyRef = useRef(why);
  whyRef.current = why;

  const call = useCallback(
    async <Action extends PersonAction>(action: Action, args: ActionArgs[Action]): Promise<ActionResult[Action]> => {
      const { held: mine, status: now } = live.current;
      if (mine === null || now !== "enrolled") throw new Error(whyRef.current || "this page's key is not enrolled");
      const send = async () => {
        const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
        const signed = { action, args, at: Date.now() + offset.current, nonce };
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, mine.privateKey, new TextEncoder().encode(signedText(signed)));
        return rpc.call("signed", { ...signed, key: mine.fingerprint, sig: base64url(sig) });
      };
      try {
        return (await send()).result as ActionResult[Action];
      } catch (cause) {
        // The backend restarted, or this page's clock drifted: read its clock and sign once more.
        if (!/signed too long ago/.test(errorText(cause))) {
          if (/is not enrolled with cow/.test(errorText(cause))) void reload();
          throw cause;
        }
        await reload();
        return (await send()).result as ActionResult[Action];
      }
    },
    [rpc, reload],
  );

  // Said from what is stored, not from this page's memory, so a reload or a resized window does not lose it:
  // this page's key was the first enrolled, lately, and the notice has not been put away in this browser.
  const mine = status === "enrolled" ? keys?.keys.find((entry) => entry.fingerprint === held?.fingerprint) : undefined;
  const firstUseId = mine?.how === "first" ? `first-use:${mine.fingerprint}:${mine.enrolledAt}` : null;
  const firstUse = firstUseId !== null && mine !== undefined && keys !== null && keys.now - mine.enrolledAt < FIRST_USE_SHOWN_MS && !understood.includes(firstUseId);
  const dismissFirstUse = useCallback(() => {
    if (firstUseId !== null) setUnderstood((current) => rememberDismissed(current, firstUseId));
  }, [firstUseId]);

  return useMemo(
    () => ({ status, fingerprint: held?.fingerprint ?? null, firstUse, dismissFirstUse, keys, why, call }),
    [status, held, firstUse, dismissFirstUse, keys, why, call],
  );
}
