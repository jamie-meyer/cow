// A host data folder for a test file: cow's git needs one to make its empty
// git folder in. Imported for its effect; removed when the tests end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useHostData } from "../src/clone/git.ts";

export const hostData = mkdtempSync(join(tmpdir(), "cow-host-data-test-"));
useHostData(hostData);
process.on("exit", () => rmSync(hostData, { recursive: true, force: true }));
