// The page's copy of bb's automations, read through cow's server. The page
// cannot hear the automations plugin's own signals, so it reads again when a
// thread an automation started appears or changes, when the section is
// unfolded, when cow records which thread a script's run started, and once a
// minute while it is open.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { AUTOMATIONS_PLUGIN, AUTOMATION_RUNS_CHANGED, type AutomationsRead, NO_AUTOMATIONS } from "./automations.ts";
import type { automationsRpcContract } from "./automations-backend.ts";
import type { ThreadFacts } from "./state.ts";

/** While the section is open, it is read again this often. */
const OPEN_EVERY_MS = 60_000;
/** A burst of changes to automations' threads is one read, this long after the last. */
const SETTLE_MS = 1500;

/** What about the automations' threads would change the section: a new one, or one that started, stopped, asked or was archived. */
export function runThreadsKey(threads: readonly ThreadFacts[]): string {
  return threads
    .filter((thread) => thread.originPluginId === AUTOMATIONS_PLUGIN)
    .map((thread) => `${thread.id}:${thread.status}:${thread.hasPendingInteraction ? 1 : 0}:${thread.archivedAt ?? ""}`)
    .sort()
    .join(" ");
}

export function useAutomations(threads: readonly ThreadFacts[], open: boolean): { read: AutomationsRead; reload: () => void } {
  const rpc = useRpc<typeof automationsRpcContract>();
  const [read, setRead] = useState<AutomationsRead>(NO_AUTOMATIONS);
  const request = useRef(0);
  const reload = useCallback(() => {
    const seq = ++request.current;
    // Without an answer the page has no section, and nothing else is held up.
    rpc.call("automations_read", null).then(
      (answer) => {
        if (seq === request.current) setRead(answer);
      },
      () => undefined,
    );
  }, [rpc]);

  const key = runThreadsKey(threads);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return reload();
    }
    const timer = setTimeout(reload, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [reload, key]);

  useEffect(() => {
    if (!open) return;
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, OPEN_EVERY_MS);
    return () => clearInterval(timer);
  }, [reload, open]);

  // A script said which thread its run started, or that record was cleared.
  useRealtime(AUTOMATION_RUNS_CHANGED, reload);

  return { read, reload };
}
