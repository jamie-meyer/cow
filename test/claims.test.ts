// What cow's documents say about its own code, checked against the code. Each
// test reads the files, as support.test.ts does, and fails when a document and
// the code it describes drift apart.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXED, KEPT, NO_REPOSITORY, noRepository } from "../src/clone/git.ts";
import { PERSON_ACTIONS } from "../src/signing/envelope.ts";
import { ADDRESSES, MINIMUM_BB, NODE_MODULES, STARTS_PROGRAMS, TESTED } from "../src/support.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** cow's own code: what bb's server, the host entry and the page run. */
const CODE = ["server.ts", "app.tsx", ...sources("src")];
const code = new Map(CODE.map((path) => [path, read(path)]));
/** The same without src/support.ts, which holds the lists themselves. */
const described = new Map([...code].filter(([path]) => path !== join("src", "support.ts")));

/** The text between a heading and the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `no heading ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** The text between two markers. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `no ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end >= 0, `no ${to} after ${from}`);
  return text.slice(start + from.length, end);
}

/**
 * The keys of the object literal that opens at `open` (the index of its `{`):
 * names at the first level only, skipping strings, template literals and
 * comments.
 */
function topKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = open;
  let atKey = true;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      atKey = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 2;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0) return keys;
    } else if (c === "," && depth === 1) atKey = true;
    else if (depth === 1 && atKey && /[A-Za-z_]/.test(c)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      if (/^\s*:/.test(text.slice(i + name.length))) keys.push(name);
      i += name.length;
      atKey = false;
      continue;
    }
    i += 1;
  }
  throw new Error("unclosed object");
}

/** The keys of every object passed to `call` across cow's code, by file. */
function objectsPassedTo(call: string): Array<{ path: string; keys: string[] }> {
  const found: Array<{ path: string; keys: string[] }> = [];
  for (const [path, text] of code) {
    let at = text.indexOf(`${call}({`);
    while (at >= 0) {
      found.push({ path, keys: topKeys(text, at + call.length + 1) });
      at = text.indexOf(`${call}({`, at + 1);
    }
  }
  return found;
}

const readme = read("README.md");
const reference = read("docs/reference.md");
const checked = section(readme, "### How this was checked");

test("the Node modules cow imports are the list, and the README names each", () => {
  const used = new Set<string>();
  for (const [path, text] of code) {
    for (const match of text.matchAll(/\bfrom\s+["']node:([a-z_/]+)["']/g)) used.add(match[1]!);
    // A bare built-in name, a require or a dynamic import of a package would slip past the search above.
    assert.ok(!/\bfrom\s+["'](child_process|crypto|fs|fs\/promises|os|path|http|https|net|dgram|tls|dns|url|util|stream|events|worker_threads|zlib)["']/.test(text), `${path} imports a built-in by its bare name`);
    assert.ok(!/\brequire\(/.test(text), `${path} calls require`);
    assert.ok(!/(?<![.\w])import\(\s*["'](?!\.)/.test(text), `${path} imports a package dynamically`);
  }
  assert.deepEqual([...used].sort(), [...NODE_MODULES].sort());
  for (const name of NODE_MODULES) assert.ok(checked.includes(`\`${name}\``), `the README names ${name}`);
});

test("the files that start programs are the list, and the README names each", () => {
  const starting = [...described].filter(([, text]) => /\bchild_process\b/.test(text)).map(([path]) => path);
  assert.deepEqual(starting.sort(), STARTS_PROGRAMS.map((entry) => entry.file).sort());
  for (const entry of STARTS_PROGRAMS) assert.ok(checked.includes(`\`${entry.file}\``), `the README names ${entry.file}`);
});

test("no network call is in cow's code, and every address in it is on the list", () => {
  const names = checked.includes("`fetch(`") ? ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon"] : [];
  assert.equal(names.length, 5, "the README lists the names it searched for");
  for (const [path, text] of code) {
    for (const name of names) assert.ok(!text.includes(name), `${path} has ${name}`);
    assert.doesNotMatch(text, /["']node:(http|https|http2|net|dgram|tls|dns)["']/, path);
  }
  for (const module of ["http", "https", "net", "dgram", "tls", "dns"]) assert.ok(checked.includes(`\`${module}\``), `the README lists ${module}`);
  const addresses = new Set<string>();
  for (const text of described.values()) for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) addresses.add(match[0]);
  assert.deepEqual([...addresses].sort(), [...ADDRESSES].sort());
  for (const address of ADDRESSES) assert.ok(checked.includes(address), `the README accounts for ${address}`);
});

const settings = objectsPassedTo("bb.settings.define").flatMap((found) => found.keys);

test("every setting is named in the README or the reference, and the README's count is the real one", () => {
  assert.ok(settings.length > 10, "the settings were found");
  assert.equal(new Set(settings).size, settings.length, "no setting is declared twice");
  for (const name of settings) assert.ok(readme.includes(`\`${name}\``) || reference.includes(`\`${name}\``), `${name} is named`);
  const words = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
  const counts = [...readme.matchAll(/\b(\d+|[a-z]+) settings\b/g)].map((match) => match[1]!).filter((count) => /^\d+$/.test(count) || words.includes(count));
  assert.ok(counts.length > 0, "the README gives a count");
  for (const count of counts) assert.equal(count, String(settings.length), `the README says "${count} settings"`);
});

test("the reference's table of calls without a signature is every method of cow's interface", () => {
  const contracts = objectsPassedTo("defineRpcContract").filter((found) => found.path !== join("src", "clone", "contract.ts"));
  const methods = contracts.flatMap((found) => found.keys);
  assert.ok(methods.includes("signed") && methods.includes("workspace_sync"), "the contracts were found");
  const table = between(reference, "**Methods of the interface**", "**Commands of `bb cow`**");
  const listed = new Set<string>();
  for (const row of table.split("\n").filter((line) => line.startsWith("| `"))) {
    for (const match of row.split(" | ")[0]!.matchAll(/`([a-z_]+)`/g)) listed.add(match[1]!);
  }
  assert.deepEqual([...listed].sort(), [...methods].sort());
  for (const action of PERSON_ACTIONS) assert.ok(!methods.includes(action), `${action} is not a method of its own`);
});

test("the README's list of what only you may do is PERSON_ACTIONS", () => {
  const list = between(readme, "An agent **cannot**, through cow:", "Those are one method, `signed`");
  const named = [...list.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(named)].sort(), [...PERSON_ACTIONS].sort());
});

test("the documents give the tested bb, and the minimum as accepted, not tested", () => {
  for (const [name, text] of [["README.md", readme], ["docs/reference.md", reference], ["PLUGIN_OVERVIEW.md", read("PLUGIN_OVERVIEW.md")]] as const) {
    assert.ok(text.includes(`bb ${TESTED.bb}`), `${name} names bb ${TESTED.bb}`);
    assert.ok(!/bb 0\.\d+\.\d+/.test(text.replaceAll(`bb ${TESTED.bb}`, "")), `${name} names no other bb release as tested`);
  }
  const limits = section(readme, "## Limits, and what cow rests on");
  assert.match(limits, new RegExp(`from ${MINIMUM_BB.replace(".", "\\.")}[^.]*accepted[^.]*not tested`));
});

test("every git cow starts carries the fixed arguments, and what reads a working tree runs only detached", () => {
  // The two places git is started: both put FIXED first.
  for (const path of [join("src", "clone", "git.ts"), join("src", "merge", "facts.ts")]) {
    const starts = [...code.get(path)!.matchAll(/execFile\(([^,]+), \[([^\]]*)\]/g)];
    assert.equal(starts.length, 1, `${path} starts git once`);
    assert.equal(starts[0]![2], "...FIXED, ...args", path);
  }
  for (const setting of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.allow=never", "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false"]) assert.ok(FIXED.includes(setting), setting);
  assert.ok(FIXED.includes("--no-pager") && FIXED.includes("--no-optional-locks"));

  const limit = between(readme, "- **git in a thread's folder.**", "- **An approved workspace command");
  const detachedOnly = new Set(["diff", "ls-files", "check-attr", "merge-tree"]);
  const never = new Set(["status", "checkout", "switch", "restore", "reset", "add", "commit", "stash", "merge", "rebase", "fetch", "pull", "push", "clone", "submodule", "log", "show", "grep", "blame", "gc", "apply", "archive"]);
  const inRepository = new Set<string>();
  for (const [path, text] of code) {
    // Every list of arguments that opens with a git command's name, and what it is handed to.
    for (const match of text.matchAll(/([\w.]+)\(\s*(?:[\w.!]+,\s*)?\[\s*"([a-z][a-z-]+)"\s*[,\]]/g)) {
      const [, callee, command] = match;
      if (callee === "enum" || callee === "z.enum" || callee === "Set") continue;
      assert.ok(!never.has(command!), `${path} runs git ${command}`);
      if (detachedOnly.has(command!)) {
        // merge-tree is handed the detached environment in src/merge/facts.ts; the rest go through a Tree.
        if (command === "merge-tree") assert.ok(path === join("src", "merge", "facts.ts") && /const env = \{ \.\.\.detached, GIT_OBJECT_DIRECTORY/.test(text), `${path} runs merge-tree detached`);
        else assert.ok(callee!.endsWith("tree.run"), `${path} runs git ${command} through ${callee}, not detached`);
      } else if (callee === "git" || callee === "run") inRepository.add(command!);
    }
  }
  // What runs in the repository itself is what the README lists, command for command.
  const listed = between(limit, "The other commands read and write only refs and objects (", ")");
  assert.deepEqual([...inRepository].sort(), [...listed.matchAll(/`([a-z-]+)[^`]*`/g)].map((match) => match[1]!).sort());
  assert.ok(limit.replace(/\s+/g, " ").includes("Ten settings") && KEPT.length === 10);

  // cow's empty git folder is in the repository as the code expects it, to the byte.
  for (const format of ["sha1", "sha256"] as const) {
    const dir = noRepository(format);
    assert.ok(dir !== null, `assets/${NO_REPOSITORY[format].folder} is not what the code expects`);
    assert.equal(dir, join(root, "assets", NO_REPOSITORY[format].folder));
  }
});
