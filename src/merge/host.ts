// What the host entry works merge-readiness out from: the checkout bb names,
// and, for one of cow's clones, the source folder's repository from cow's
// own record of the clone (written when it was made, never a file the agent
// can edit in it).
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { layout } from "../clone/remove.ts";
import { cloneRecord } from "../workspace/ops.ts";
import type { MergeInput } from "./facts.ts";

export function mergeInput(dataDir: string, asked: { path: string; baseBranch: string | null; defaultBranch: string | null }): MergeInput {
  const paths = layout(dataDir);
  let real = asked.path;
  try {
    real = realpathSync(asked.path);
  } catch {}
  const plain = { path: asked.path, baseBranch: asked.baseBranch, defaultBranch: asked.defaultBranch, sourcePath: null };
  if (dirname(dirname(real)) !== paths.clones) return plain;
  try {
    return { ...plain, sourcePath: cloneRecord(paths, real).resource.source.path };
  } catch {
    // Its own repository's base would be the one copied when it was made, not the one it goes back to.
    return { ...plain, notKnown: "not known for a clone: cow's record of it could not be read" };
  }
}
