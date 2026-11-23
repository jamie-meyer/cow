// Merge-readiness on the page: on a finished worker's line, whether its
// branch still merges into its base. The facts come from cow's server (see
// merge/backend.ts), which works them out read-only on the checkout's
// machine and says when one changed; the page only reads them.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { mergeRpcContract } from "./merge/backend.ts";
import { MERGE_CHANGED, type MergeFacts, mergeLineText } from "./merge/text.ts";

/** The page asks again this often: the server looks at an environment's tips at most every 30 seconds. */
const READ_EVERY_MS = 30_000;

/** Each of these threads' facts, as last read. `threadIds` are the finished workers on the page. */
export function useMerge(threadIds: readonly string[]): Readonly<Record<string, MergeFacts>> {
  const rpc = useRpc<typeof mergeRpcContract>();
  const [found, setFound] = useState<Readonly<Record<string, MergeFacts>>>({});
  const key = [...threadIds].sort().join(",");
  const ids = useRef<readonly string[]>(threadIds);
  ids.current = threadIds;
  const request = useRef(0);
  const reload = useCallback(() => {
    const asked = ids.current;
    if (asked.length === 0) return setFound({});
    const seq = ++request.current;
    rpc.call("merge_read", { threadIds: asked.slice(0, 500) }).then(
      (got) => seq === request.current && setFound(got),
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    reload();
    const every = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, READ_EVERY_MS);
    return () => clearInterval(every);
  }, [reload, key]);
  useRealtime(MERGE_CHANGED, reload);
  return found;
}

/** On the line: quiet when it merges cleanly or is not known, loud for a conflict. Nothing when there is nothing to say. */
export function MergeMark({ facts }: { facts: MergeFacts | undefined }) {
  const said = mergeLineText(facts);
  if (said === null || facts === undefined) return null;
  const Tag = said.tone === "loud" ? "b" : "small";
  return (
    <Tag
      className={said.tone === "loud" ? "cow-merge cow-merge-bad" : "cow-merge"}
      data-cow-merge={facts.state}
      data-cow-merge-files={facts.conflicts.join("\n") || undefined}
      data-cow-merge-behind={facts.behind ?? undefined}
      title={`${said.title} · shown only: cow never merges`}
    >
      {said.text}
      {" · "}
    </Tag>
  );
}
