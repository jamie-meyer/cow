// What a brief's thread changed, as the host entry collects it: in one of
// cow's clones, from the workspace folder and every repository the clone
// brought, by cow's own record of the clone (written when it was made, never
// a file the agent can edit in it); anywhere else, in the thread's checkout.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "../clone/git.ts";
import { layout } from "../clone/remove.ts";
import { cloneRecord } from "../workspace/ops.ts";
import { type DiffResult, collectCloneDiff, collectDiff, readTextFile } from "./diff.ts";

export async function collectBriefDiff(dataDir: string, path: string, bases: readonly string[]): Promise<DiffResult> {
  const paths = layout(dataDir);
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  if (dirname(dirname(real)) !== paths.clones) return collectDiff(git, path, bases, readTextFile);
  const record = cloneRecord(paths, real);
  const repos = [
    { as: null, head: record.resource.source.head },
    ...record.resource.bring.filter((repo) => repo.as !== null).map((repo) => ({ as: repo.as, head: repo.head })),
  ];
  return collectCloneDiff(git, record.path, repos, bases, readTextFile);
}
