import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KEY_GROUPS, KEY_MAP } from "../src/keys.ts";
import { EXPERIMENTAL_SURFACES, TESTED, isCowTheme, outsideTested, outsideText, parseDismissed } from "../src/support.ts";
import { insteadFromCli, insteadOnPage } from "../src/verbs.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("the list of experimental surfaces is exactly what the code uses", () => {
  const used = new Set<string>();
  for (const path of ["server.ts", "app.tsx", ...sources("src")]) {
    if (path === join("src", "support.ts")) continue;
    for (const match of read(path).matchAll(/\bexperimental_[A-Za-z]+/g)) used.add(match[0]);
  }
  assert.deepEqual([...used].sort(), EXPERIMENTAL_SURFACES.map((surface) => surface.name).sort());
});

test("the README names every experimental surface and the tested versions", () => {
  const readme = read("README.md");
  for (const surface of EXPERIMENTAL_SURFACES) assert.ok(readme.includes(`\`${surface.name}\``), surface.name);
  for (const value of [TESTED.bb, TESTED.pluginSdk, TESTED.provider, TESTED.os]) assert.ok(readme.includes(value), value);
});

test("the manifest, the changelog and the tested versions agree", () => {
  const manifest = JSON.parse(read("package.json")) as { version: string; engines: Record<string, string>; devDependencies: Record<string, string> };
  assert.equal(manifest.devDependencies["@get-bb/plugin-sdk"], TESTED.pluginSdk);
  assert.equal(manifest.engines.bbPluginSdk, `>=${TESTED.pluginSdk}`);
  assert.equal(manifest.engines.bb, `>=${TESTED.bb.split(".").slice(0, 2).join(".")}`);
  assert.ok(read("CHANGELOG.md").includes(`## ${manifest.version}`), "the changelog has an entry for the manifest's version");
  assert.equal((JSON.parse(read("package-lock.json")) as { version: string }).version, manifest.version);
});

test("a bb of another minor or major release is outside what was tested; a patch release is not", () => {
  assert.equal(outsideTested("0.49.0", "0.49.0"), null);
  assert.equal(outsideTested("0.49.7", "0.49.0"), null);
  assert.equal(outsideTested("v0.49.7-beta.1", "0.49.0"), null);
  assert.equal(outsideTested("0.50.0", "0.49.0"), "newer");
  assert.equal(outsideTested("1.0.0", "0.49.0"), "newer");
  assert.equal(outsideTested("0.48.9", "0.49.0"), "older");
});

test("a development build and an unreadable version say nothing", () => {
  assert.equal(outsideTested("0.0.0", "0.49.0"), null);
  assert.equal(outsideTested("", "0.49.0"), null);
  assert.equal(outsideTested("next", "0.49.0"), null);
});

test("the aside names the running version and the tested one", () => {
  assert.match(outsideText("0.51.2", "newer"), /bb 0\.51\.2.*tested on bb 0\.49.*experimental/);
  assert.match(outsideText("0.40.0", "older"), /bb 0\.40\.0.*built for bb 0\.49/);
});

test("cow's theme is recognised under whatever id cow is installed", () => {
  assert.ok(isCowTheme("plugin:cow:cow"));
  assert.ok(isCowTheme("plugin:cow-check:cow"));
  assert.ok(!isCowTheme("default"));
  assert.ok(!isCowTheme("plugin:cow:other"));
});

test("stored dismissals are read as a list of names, whatever is stored", () => {
  assert.deepEqual(parseDismissed(null), []);
  assert.deepEqual(parseDismissed("not json"), []);
  assert.deepEqual(parseDismissed('{"a":1}'), []);
  assert.deepEqual(parseDismissed('["theme", 3, "bb:0.50.0"]'), ["theme", "bb:0.50.0"]);
});

test("the legend's groups hold every key once", () => {
  assert.equal(KEY_MAP.length, new Set(KEY_MAP.map((entry) => entry.keys)).size);
  assert.ok(KEY_GROUPS.every((group) => group.title !== "" && group.keys.length > 0));
});

test("a refusal says what to do instead, without repeating itself", () => {
  assert.equal(insteadOnPage("it is not parked"), "p parks it");
  assert.equal(insteadOnPage("threads under it are still open"), "archive or park those first");
  assert.equal(insteadOnPage("something cow has no advice for"), "");
  assert.match(insteadFromCli("it is already archived"), /bb thread unarchive/);
});

test("the README's key map says what the legend says", () => {
  const readme = read("README.md");
  for (const group of KEY_GROUPS) {
    assert.ok(readme.includes(`**${group.title}**`), group.title);
    for (const entry of group.keys) assert.ok(readme.includes(`| ${entry.does} |`), entry.keys);
  }
});
