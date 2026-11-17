// Make a copy of this plugin under another id, to run the end-to-end checks
// against without touching a cow that is in use.
//
// The checks reset enrollment, make capabilities and write to the log. Run
// against the installed cow, they would do that to its storage, and race the
// page of whoever has it open. A copy has its own id, so its own storage,
// page, settings and `bb <id>` command; removing it removes all of that.
//
//   node scripts/copy-for-checks.mjs <empty folder> [--id cow-check]
//   bb plugin install <that folder> --yes
//   npm run e2e -- --plugin cow-check --project … --environment …
//   npm run e2e:asks -- --plugin cow-check --project … --environment …
//   bb plugin remove cow-check
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
for (const name of ["app.tsx", "server.ts", "src", "assets", "themes", "tsconfig.json", "package-lock.json", "node_modules"]) {
  if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });
}
const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
manifest.name = `bb-plugin-${id}`;
manifest.bb.name = id;
manifest.bb.description = `A copy of cow for its end-to-end checks. Remove it with: bb plugin remove ${id}`;
writeFileSync(join(to, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const app = join(to, "app.tsx");
writeFileSync(app, readFileSync(app, "utf8").replace('title: "cow"', `title: "${id}"`).replace("🐄 cow: choose the Main thread", `${id}: choose the Main thread`));
console.log(`${id} is in ${to}\n  bb plugin install ${to} --yes\n  … --plugin ${id}\n  bb plugin remove ${id}`);
