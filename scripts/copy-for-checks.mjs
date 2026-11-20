// Make a copy of this plugin under another id, to run the end-to-end checks
// against without touching a cow that is in use.
//
// The checks reset enrollment, make capabilities and write to the log. Run
// against the installed cow, they would do that to its storage, and race the
// page of whoever has it open. A copy has its own id, so its own storage,
// page, settings and `bb <id>` command; removing it takes all of that out of
// use (bb 0.49 leaves its stored rows in its database, under the copy's id).
//
//   node scripts/copy-for-checks.mjs <empty folder> [--id cow-check]
//   bb plugin install <that folder> --yes
//   npm run e2e -- --project … --environment …
//   npm run e2e:asks -- --project … --environment …
//   bb plugin remove cow-check
//
// The checks run against cow-check unless told otherwise, so with the default
// id nothing more is needed. With another id, pass --plugin <id> to both.
// They refuse the installed cow unless given --plugin cow
// --reset-the-installed-cow as well.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const at = args.indexOf("--id");
const id = at >= 0 ? args[at + 1] : "cow-check";
const target = args.find((arg, index) => !arg.startsWith("--") && (at < 0 || index !== at + 1));
if (!target || !/^[a-z][a-z0-9-]{1,30}$/.test(id ?? "") || id === "cow") {
  console.error("usage: node scripts/copy-for-checks.mjs <empty folder> [--id cow-check]   (the id must not be cow)");
  process.exit(1);
}
const from = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const to = resolve(target);
if (existsSync(to) && readdirSync(to).length > 0) {
  console.error(`${to} is not empty`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
// The skill is left out: two plugins would otherwise both tell agents about `bb cow`.
for (const name of ["app.tsx", "server.ts", "src", "assets", "themes", "tsconfig.json", "package-lock.json", ".gitignore", "node_modules"]) {
  if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });
}
const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
manifest.name = `bb-plugin-${id}`;
manifest.bb.name = id;
manifest.bb.description = `A copy of cow for its end-to-end checks. Remove it with: bb plugin remove ${id}`;
writeFileSync(join(to, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// The lockfile names the package too; a Git install reads it.
const lock = join(to, "package-lock.json");
if (existsSync(lock)) {
  const locked = JSON.parse(readFileSync(lock, "utf8"));
  locked.name = manifest.name;
  if (locked.packages?.[""]) locked.packages[""].name = manifest.name;
  writeFileSync(lock, `${JSON.stringify(locked, null, 2)}\n`);
}
const app = join(to, "app.tsx");
// Two plugins asking for the same default shortcut leave both unbound, the
// installed cow's too. So the copy asks for another, Shift added, which the
// checks press.
const source = readFileSync(app, "utf8");
const copied = source
  .replace('title: "cow"', `title: "${id}"`)
  .replace("🐄 cow: open cow's page", `${id}: open its page`)
  .replace("🐄 cow: choose the Main thread", `${id}: choose the Main thread`)
  .replace('defaultShortcut: { key: "c", control: true, alt: true }', 'defaultShortcut: { key: "c", control: true, alt: true, shift: true }');
if ([...copied.matchAll(/defaultShortcut: \{[^}]*\}/g)].some(([found]) => !found.includes("shift: true"))) {
  console.error("app.tsx names a default shortcut the copy would share with cow: update scripts/copy-for-checks.mjs");
  process.exit(1);
}
writeFileSync(app, copied);
console.log(`${id} is in ${to}\n  bb plugin install ${to} --yes\n  npm run e2e -- ${id === "cow-check" ? "" : `--plugin ${id} `}--project … --environment …\n  bb plugin remove ${id}`);
