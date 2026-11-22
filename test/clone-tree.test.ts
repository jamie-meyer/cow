// The cloner, on temporary directories. These need macOS and APFS; the perl
// helper is used so they also run where osascript is refused.
import assert from "node:assert/strict";
import fs, { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createMatcher } from "../src/clone/glob.ts";
import { type CloneCall, checkPath, startHelper } from "../src/clone/helper.ts";
import { CloneError, EXDEV, cloneTree } from "../src/clone/tree.ts";

const mac = process.platform === "darwin";
let helper: CloneCall;
let base: string;

before(async () => {
  if (!mac) return;
  helper = await startHelper({ prefer: ["perl"] });
  base = mkdtempSync(join(tmpdir(), "cow-clone-test-"));
});
after(() => {
  helper?.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

let n = 0;
const fresh = (name: string) => {
  n += 1;
  const dir = join(base, `${n}-${name}`);
  mkdirSync(dir);
  return dir;
};

function list(root: string, relative = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const rel = relative === "" ? name : `${relative}/${name}`;
    out.push(rel);
    const stats = lstatSync(join(root, rel));
    if (stats.isDirectory()) out.push(...list(root, rel));
  }
  return out;
}

/** A tree of `dirs` directories with `files` files each, two levels deep. */
function makeTree(root: string, dirs: number, files: number): void {
  for (let d = 0; d < dirs; d += 1) {
    const dir = join(root, `d${d}`, "inner");
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < files; f += 1) writeFileSync(join(dir, `f${f}.txt`), `${d}/${f}`);
    writeFileSync(join(root, `d${d}`, "top.txt"), `top ${d}`);
  }
}

test("glob patterns: names at any depth, paths from the top, directories only", () => {
  const m = createMatcher([".env", ".env.*", "*.pem", "notes/private", "build/", "**/cache/*.bin"]);
  assert.equal(m.matches(".env", false), true);
  assert.equal(m.matches("a/b/.env", false), true);
  assert.equal(m.matches("a/.env.local", false), true);
  assert.equal(m.matches("a/.envrc", false), false);
  assert.equal(m.matches("x/server.pem", false), true);
  assert.equal(m.matches("notes/private", true), true);
  assert.equal(m.matches("other/notes/private", true), false);
  assert.equal(m.matches("build", true), true);
  assert.equal(m.matches("build", false), false);
  assert.equal(m.matches("x/y/cache/a.bin", false), true);
  assert.equal(m.matches("cache/a.bin", false), true);
});

test("a path with a newline is refused before it reaches the helper", () => {
  assert.throws(() => checkPath("/tmp/a\nb"), /newline/);
});

test("chunking clones every entry exactly once", { skip: !mac }, async () => {
  const source = fresh("source");
  makeTree(source, 30, 20); // 30 * (1 + 1 + 1 + 20) = 690 entries below the top
  symlinkSync("d0/top.txt", join(source, "link"));
  const destination = join(fresh("out"), "clone");
  const result = await cloneTree(helper, source, destination, { chunk: 50 });
  assert.deepEqual(list(destination), list(source));
  assert.equal(result.entries, list(source).length + 1);
  assert.ok(result.chunks > 1, `expected several chunks, got ${result.chunks}`);
  assert.ok(result.largestChunk <= 50);
  assert.equal(readFileSync(join(destination, "d7/inner/f3.txt"), "utf8"), "7/3");
  assert.equal(readlinkSync(join(destination, "link")), "d0/top.txt");
  // A copy-on-write clone is a separate file: writing it leaves the source alone.
  writeFileSync(join(destination, "d7/inner/f3.txt"), "changed");
  assert.equal(readFileSync(join(source, "d7/inner/f3.txt"), "utf8"), "7/3");
});

test("a small clean tree is one call", { skip: !mac }, async () => {
  const source = fresh("small");
  makeTree(source, 2, 3);
  const result = await cloneTree(helper, source, join(fresh("out"), "clone"));
  assert.equal(result.chunks, 1);
  assert.equal(result.files, 0);
  assert.equal(result.recreated, 0);
});

test("an excluded path never appears, and splits the chunk around it", { skip: !mac }, async () => {
  const source = fresh("secrets");
  makeTree(source, 3, 3);
  writeFileSync(join(source, ".env"), "SECRET=1");
  writeFileSync(join(source, "d1/inner/.env.local"), "SECRET=2");
  writeFileSync(join(source, "d2/server.pem"), "key");
  mkdirSync(join(source, ".ssh"));
  writeFileSync(join(source, ".ssh/id_ed25519"), "key");
  mkdirSync(join(source, "private"));
  writeFileSync(join(source, "private/x"), "x");
  const destination = join(fresh("out"), "clone");
  const result = await cloneTree(helper, source, destination, { exclude: ["private"] });
  const got = list(destination);
  for (const gone of [".env", "d1/inner/.env.local", "d2/server.pem", ".ssh", "private"]) assert.ok(!got.includes(gone), `${gone} was cloned`);
  assert.ok(got.includes("d1/inner/f0.txt"));
  assert.equal(result.excluded, 5);
  // includeSecrets drops the defaults but keeps the caller's patterns.
  const all = join(fresh("out"), "clone");
  await cloneTree(helper, source, all, { includeSecrets: true, exclude: ["private"] });
  assert.ok(list(all).includes(".env"));
  assert.ok(!list(all).includes("private"));
});

test("recreated directories keep their modes and times", { skip: !mac }, async () => {
  const source = fresh("modes");
  makeTree(source, 4, 10);
  chmodSync(join(source, "d1"), 0o750);
  chmodSync(join(source, "d2"), 0o555);
  const when = new Date("2021-03-04T05:06:07Z");
  utimesSync(join(source, "d1"), when, when);
  utimesSync(join(source, "d2"), when, when);
  const destination = join(fresh("out"), "clone");
  // chunk 5 forces d1 and d2 to be recreated (each holds 13 entries).
  const result = await cloneTree(helper, source, destination, { chunk: 5 });
  assert.ok(result.recreated >= 3);
  for (const dir of ["d1", "d2"]) {
    const a = lstatSync(join(source, dir));
    const b = lstatSync(join(destination, dir));
    assert.equal(b.mode & 0o7777, a.mode & 0o7777, `${dir} mode`);
    assert.equal(b.mtimeMs, a.mtimeMs, `${dir} mtime`);
  }
  chmodSync(join(source, "d2"), 0o755);
  chmodSync(join(destination, "d2"), 0o755);
});

test("an existing destination is refused", { skip: !mac }, async () => {
  const source = fresh("exists");
  const destination = fresh("there");
  await assert.rejects(cloneTree(helper, source, destination), /already exists/);
});

test("EXDEV from the helper stops with an error naming both volumes, and nothing is copied", { skip: !mac }, async () => {
  const source = fresh("xdev");
  makeTree(source, 1, 1);
  const fake: CloneCall = { kind: "test", clone: async () => EXDEV, close() {} };
  const destination = join(fresh("out"), "clone");
  await assert.rejects(cloneTree(fake, source, destination), (error: unknown) => {
    assert.ok(error instanceof CloneError);
    assert.equal(error.errno, EXDEV);
    assert.match(error.message, /different volumes/);
    assert.match(error.message, /\(volume \/.*\).*\(volume \/.*\)/);
    return true;
  });
  assert.throws(() => lstatSync(destination));
});

/** Run `work` with `fs[name]` wrapped by `wrap`, as the cloner's own imports see it. */
async function withPatched<K extends "lstatSync" | "readdirSync">(name: K, wrap: (original: (typeof fs)[K]) => (typeof fs)[K], work: () => Promise<void>): Promise<void> {
  const original = fs[name];
  fs[name] = wrap(original);
  syncBuiltinESMExports();
  try {
    await work();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

test("an entry that disappears between being listed and being looked at is left out, a file or a directory", { skip: !mac }, async () => {
  const source = fresh("vanish-walk");
  writeFileSync(join(source, "keep.txt"), "keep");
  mkdirSync(join(source, ".git"));
  writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(source, ".git", "index.lock"), "");
  mkdirSync(join(source, "gone", "deeper"), { recursive: true });
  writeFileSync(join(source, "gone", "a.txt"), "a");
  writeFileSync(join(source, "gone", "deeper", "b.txt"), "b");
  mkdirSync(join(source, "listed"));
  writeFileSync(join(source, "listed", "c.txt"), "c");
  const destination = join(fresh("vanish-walk-out"), "clone");
  const removed = new Set<string>();
  // index.lock is deleted just before it is looked at; "gone" just before it is looked at; "listed" after it was looked at, before it is listed.
  await withPatched("lstatSync", (lstat) => ((path: fs.PathLike, ...rest: unknown[]) => {
    const text = String(path);
    if (!removed.has(text) && (text === join(source, ".git", "index.lock") || text === join(source, "gone"))) {
      removed.add(text);
      rmSync(text, { recursive: true, force: true });
    }
    return (lstat as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.lstatSync, async () => {
    await withPatched("readdirSync", (readdir) => ((path: fs.PathLike, ...rest: unknown[]) => {
      if (!removed.has(String(path)) && String(path) === join(source, "listed")) {
        removed.add(String(path));
        rmSync(String(path), { recursive: true, force: true });
      }
      return (readdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync, async () => {
      const result = await cloneTree(helper, source, destination, { chunk: 1 });
      assert.equal(result.vanished, 3);
    });
  });
  assert.deepEqual(list(destination), [".git", ".git/HEAD", "keep.txt"]);
});

test("an entry that disappears between being listed and being cloned is left out, at any depth", { skip: !mac }, async () => {
  const source = fresh("vanish-copy");
  mkdirSync(join(source, "repo", ".git"), { recursive: true });
  writeFileSync(join(source, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(source, "repo", ".git", "index.lock"), "");
  mkdirSync(join(source, "big", "inner"), { recursive: true });
  for (let i = 0; i < 4; i += 1) writeFileSync(join(source, "big", "inner", `f${i}.txt`), `${i}`);
  writeFileSync(join(source, "big", "x.txt"), "x");
  mkdirSync(join(source, "small"));
  writeFileSync(join(source, "small", "s.txt"), "s");
  writeFileSync(join(source, "stay.txt"), "stay");
  const doomed = new Map([
    // A single file in a recreated directory.
    [join(source, "repo", ".git", "index.lock"), "file"],
    // A recreated directory (more entries than a chunk), files in it.
    [join(source, "big", "inner"), "dir"],
    // A directory cloned in one call.
    [join(source, "small"), "dir"],
  ]);
  const racing: CloneCall = {
    kind: "test",
    clone: (from, to) => {
      for (const path of doomed.keys()) rmSync(path, { recursive: true, force: true });
      return helper.clone(from, to);
    },
    close: () => {},
  };
  const destination = join(fresh("vanish-copy-out"), "clone");
  const result = await cloneTree(racing, source, destination, { chunk: 3 });
  assert.ok(result.vanished >= 3, `vanished ${result.vanished}`);
  assert.deepEqual(list(destination), ["big", "big/x.txt", "repo", "repo/.git", "repo/.git/HEAD", "stay.txt"]);
});

test("a permission error still fails the clone with its message; so does a source that is gone", { skip: !mac }, async () => {
  const source = fresh("denied");
  mkdirSync(join(source, "locked"));
  writeFileSync(join(source, "locked", "secret.txt"), "s");
  chmodSync(join(source, "locked"), 0o000);
  try {
    await assert.rejects(cloneTree(helper, source, join(fresh("denied-out"), "clone"), { chunk: 1 }), /EACCES: permission denied, scandir .*locked/);
  } finally {
    chmodSync(join(source, "locked"), 0o755);
  }
  await assert.rejects(cloneTree(helper, join(base, "no-such-source"), join(fresh("gone-out"), "clone")), /ENOENT/);
});
