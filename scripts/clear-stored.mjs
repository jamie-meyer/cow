// Clear everything cow stored in bb, after the plugin has been removed.
//
// `bb plugin remove cow` (bb 0.49) deletes the plugin's settings and leaves
// the rest in bb's database: cow's own storage (Mains, seen replies, asks,
// briefs, capabilities, the log, enrolled keys) and its notes on threads.
// This deletes those rows, and the folder that held the reset file.
//
//   bb plugin remove cow
//   node scripts/clear-stored.mjs            # says what it would delete
//   node scripts/clear-stored.mjs --yes      # deletes it; cannot be undone
//
// Options:
//   --id <plugin id>     default cow; a copy made for the checks is cow-check
//   --data-dir <dir>     bb's data directory; default: what `bb status`
//                        prints, else ~/.bb
//   --yes                delete; without it nothing is changed
//
// It refuses while the plugin is still installed: a running cow would write
// its storage again. It needs Node 22.5 or newer, or the sqlite3 command.
// What it cannot reach, it lists at the end: each browser's own storage.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const id = option("id", "cow");
const yes = args.includes("--yes");
if (!/^[a-z][a-z0-9-]{1,40}$/.test(id) || args.includes("--help")) {
  console.error("usage: node scripts/clear-stored.mjs [--id cow] [--data-dir <bb's data directory>] [--yes]");
  process.exit(args.includes("--help") ? 0 : 1);
}

function dataDir() {
  const given = option("data-dir", "");
  if (given) return resolve(given);
  try {
    const found = /^Data dir:\s*(.+)$/m.exec(execFileSync("bb", ["status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (found) return found[1].trim();
  } catch {
    // bb is not on PATH, or is not running: fall back to its default.
  }
  return join(homedir(), ".bb");
}

const dir = dataDir();
const database = join(dir, "bb.db");
if (!existsSync(database)) {
  console.error(`there is no bb database at ${database}; pass --data-dir <bb's data directory> (bb status prints it)`);
  process.exit(1);
}

/** Run SQL against bb's database: with Node's own SQLite when it has one, else the sqlite3 command. */
async function open() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(database);
    db.exec("pragma busy_timeout = 5000");
    return {
      count: (sql, ...values) => Number(Object.values(db.prepare(sql).get(...values) ?? { n: 0 })[0]),
      run: (sql, ...values) => void db.prepare(sql).run(...values),
      close: () => db.close(),
    };
  } catch (cause) {
    if (cause?.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw cause;
  }
  // The id was checked above: letters, digits and hyphens only.
  const cli = (sql) => execFileSync("sqlite3", ["-cmd", ".timeout 5000", database, sql], { encoding: "utf8" }).trim();
  const fill = (sql, values) => values.reduce((text, value) => text.replace("?", `'${String(value).replaceAll("'", "''")}'`), sql);
  return { count: (sql, ...values) => Number(cli(fill(sql, values))), run: (sql, ...values) => void cli(fill(sql, values)), close: () => undefined };
}

const db = await open();
const has = (table) => db.count("select count(*) from sqlite_master where type = 'table' and name = ?", table) > 0;

if (has("plugins") && db.count("select count(*) from plugins where id = ?", id) > 0) {
  console.error(`${id} is still installed in this bb. Remove it first:\n  bb plugin remove ${id}`);
  process.exit(1);
}

// Every table of bb 0.49 that keeps rows under a plugin's id. Removing the plugin empties the last two already.
const TABLES = [
  ["plugin_kv", "cow's own storage: Mains, seen replies, asks, briefs, capabilities, the log, enrolled keys"],
  ["thread_plugin_metadata", "cow's notes on threads: parked, archived why, dismissed refusals, next, not started, project"],
  ["plugin_settings", "settings"],
  ["plugin_schedules", "schedules"],
].filter(([table]) => has(table));
const folder = join(dir, "plugins", id);
const inFolder = existsSync(folder) ? readdirSync(folder) : null;

console.log(`${yes ? "Clearing" : "Would clear"} what the plugin “${id}” stored in ${database}:`);
let total = 0;
for (const [table, what] of TABLES) {
  const rows = db.count(`select count(*) from ${table} where plugin_id = ?`, id);
  total += rows;
  console.log(`  ${String(rows).padStart(5)} ${rows === 1 ? "row " : "rows"} in ${table}  (${what})`);
  if (yes && rows > 0) db.run(`delete from ${table} where plugin_id = ?`, id);
}
console.log(inFolder === null ? `  no folder ${folder}` : `  the folder ${folder} (${inFolder.length === 0 ? "empty" : inFolder.join(", ")})`);
if (yes && inFolder !== null) rmSync(folder, { recursive: true, force: true });

if (yes) {
  const left = TABLES.reduce((sum, [table]) => sum + db.count(`select count(*) from ${table} where plugin_id = ?`, id), 0);
  console.log(left === 0 && !existsSync(folder) ? `Done: ${total} ${total === 1 ? "row" : "rows"} deleted, nothing of “${id}” is left in bb's data directory.` : `Not everything went: ${left} rows are left${existsSync(folder) ? `, and ${folder}` : ""}.`);
  if (left > 0 || existsSync(folder)) process.exitCode = 1;
} else {
  console.log("Nothing was changed. Run it again with --yes to delete; that cannot be undone.");
}
db.close();

console.log(`
Not reached from here, because it is not in bb's data directory:
  - each browser that opened the page keeps, in its storage for bb's address: the signing key (IndexedDB
    database “cow-signing”), dismissed notices (local storage, “cow:dismissed”), and per window the chosen
    Main and folded groups (session storage). Clear that site's data in the browser to remove them. The key
    is of no use once the enrolled keys above are gone.
  - if bb's theme is still cow's: bb theme reset
  - the threads themselves, the hidden checker threads cow started (archived, titled “cow check”) and the
    messages cow sent for you are bb's own records and stay in bb.`);
