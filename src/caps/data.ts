// The page's copy of the capabilities, the notices not yet acknowledged and
// what capabilities have allowed on each thread, kept current with what the
// backend changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PermissionResolution } from "../permission.ts";
import type { capsRpcContract } from "./backend.ts";
import { CAPS_CHANGED, type Capability, type RuleDraft, type Scope, type Via } from "./cap.ts";
import type { ChainCheck, LogEntry } from "./log.ts";
import type { Places } from "./paths.ts";
import type { Notice, Use } from "./service.ts";
import type { Signer } from "../signing/page.ts";

export interface CapsData {
  /** False until the first read: until then nothing is known to be held. */
  loaded: boolean;
  /** Every capability, deleted ones included. */
  capabilities: readonly Capability[];
  /** The notices not yet acknowledged, oldest first. */
  notices: readonly Notice[];
  /** Thread id to what capabilities have allowed on it. */
  uses: ReadonlyMap<string, Use>;
  /** Thread id to the decisions on its requests that cow did not make and the person has not acknowledged. */
  outside: ReadonlyMap<string, readonly Notice[]>;
  /** Where the refused places are, for checking a rule as it is typed. */
  places: Places;
  /** Counts up whenever anything here changes: a reason to read the log again. */
  changes: number;
  create: (input: { name: string; note: string | null; rule: RuleDraft; scope: Scope; via: Via; sourceThreadId: string | null; askId: string | null }) => Promise<Capability>;
  remove: (id: string) => Promise<Capability>;
  restore: (id: string) => Promise<Capability>;
  acknowledge: (noticeId: string) => Promise<void>;
  log: (capabilityId?: string) => Promise<{ entries: LogEntry[]; total: number; check: ChainCheck }>;
  /** Answer one of bb's permission requests through cow, so cow knows it was decided here. */
  decide: (threadId: string, interactionId: string, resolution: PermissionResolution) => Promise<void>;
}

const NO_PLACES: Places = { home: null, dataDir: null };

export function useCaps(signer: Signer): CapsData {
  const rpc = useRpc<typeof capsRpcContract>();
  const [loaded, setLoaded] = useState(false);
  const [capabilities, setCapabilities] = useState<readonly Capability[]>([]);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [uses, setUses] = useState<ReadonlyMap<string, Use>>(new Map());
  const [places, setPlaces] = useState<Places>(NO_PLACES);
  const [changes, setChanges] = useState(0);
  const request = useRef(0);

  const reload = useCallback(() => {
    const seq = ++request.current;
    // Capabilities only add to the page; if they cannot be read it still shows its threads.
    rpc.call("caps_state").then(
      (state) => {
        if (seq !== request.current) return;
        setCapabilities(state.capabilities);
        setNotices(state.notices);
        setUses(new Map(Object.entries(state.uses)));
        setPlaces(state.places);
        setLoaded(true);
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(reload, [reload]);
  useRealtime(CAPS_CHANGED, () => {
    setChanges((value) => value + 1);
    reload();
  });

  const outside = useMemo(() => {
    const found = new Map<string, Notice[]>();
    for (const notice of notices) {
      if (notice.kind !== "outside" || notice.threadId === null) continue;
      found.set(notice.threadId, [...(found.get(notice.threadId) ?? []), notice]);
    }
    return found;
  }, [notices]);

  return useMemo(
    () => ({
      loaded,
      capabilities,
      notices,
      uses,
      outside,
      places,
      changes,
      create: async (input) => {
        const made = await signer.call("cap_create", input);
        reload();
        return made;
      },
      remove: async (id) => {
        const gone = await signer.call("cap_delete", { id });
        reload();
        return gone;
      },
      restore: async (id) => {
        const back = await signer.call("cap_restore", { id });
        reload();
        return back;
      },
      acknowledge: async (noticeId) => {
        await signer.call("cap_ack", { noticeId });
        // Gone from the page at once; the reload confirms it.
        setNotices((current) => current.filter((notice) => notice.id !== noticeId));
        reload();
      },
      log: (capabilityId) => rpc.call("caps_log", capabilityId === undefined ? {} : { capabilityId }),
      decide: async (threadId, interactionId, resolution) => {
        await signer.call("permission_decide", { threadId, interactionId, resolution });
      },
    }),
    [loaded, capabilities, notices, uses, outside, places, changes, rpc, reload, signer],
  );
}
