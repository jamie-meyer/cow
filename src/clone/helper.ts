// One long-lived process that calls clonefile(2) for us. Node cannot clone a
// directory in one call, and nothing can be compiled when bb installs a
// plugin, so the call goes through what macOS already has: JavaScript for
// Automation (`osascript -l JavaScript`, which can bind a C function), or
// perl's `syscall` if osascript cannot start (inside a sandbox that refuses
// it, for one).
//
// Protocol: each request is two lines on the helper's stdin, the source and
// the destination; each answer is one line, the errno (0 for success). No
// path is ever put into a shell string or a script: the scripts are fixed
// and paths travel only on stdin. A path containing a newline (or a NUL) is
// refused before it is sent.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** CLONE_NOFOLLOW: a symlink is cloned as the link, never followed. */
const CLONE_NOFOLLOW = 1;
/** clonefileat(2) on macOS; the perl fallback calls it with AT_FDCWD (-2) for both directories. */
const SYS_CLONEFILEAT = 462;

const JXA = `ObjC.import('Foundation');
ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "int"]]);
ObjC.bindFunction("__error", ["int *", []]);
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput;
  var output = $.NSFileHandle.fileHandleWithStandardOutput;
  function say(text) { output.writeData($(text + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
  say("ready jxa");
  var buffer = $.NSMutableData.data;
  while (true) {
    var chunk = input.availableData;
    if (chunk.length == 0) return "";
    buffer.appendData(chunk);
    var text = $.NSString.alloc.initWithDataEncoding(buffer, $.NSUTF8StringEncoding);
    if (text.isNil()) continue;
    var lines = text.js.split("\\n");
    while (lines.length >= 3) {
      var source = lines.shift(), destination = lines.shift();
      var result = $.clonefile(source, destination, ${CLONE_NOFOLLOW});
      say(String(result === 0 ? 0 : $.__error()[0]));
    }
    buffer = $.NSMutableData.dataWithData($(lines.join("\\n")).dataUsingEncoding($.NSUTF8StringEncoding));
  }
}`;

const PERL = `$| = 1; print "ready perl\\n";
while (defined(my $s = <STDIN>)) {
  my $d = <STDIN>; last unless defined $d; chomp $s; chomp $d;
  my $r = syscall(${SYS_CLONEFILEAT}, -2, $s, -2, $d, ${CLONE_NOFOLLOW});
  print(($r == 0 ? 0 : ($! + 0)), "\\n");
}`;

export type HelperKind = "jxa" | "perl";

/** Something that clones one path to another and answers with an errno. */
export interface CloneCall {
  readonly kind: HelperKind | "test";
  clone(source: string, destination: string): Promise<number>;
  close(): void;
}

export function checkPath(path: string): void {
  if (path.includes("\n") || path.includes("\0")) {
    throw new Error(`refused a path containing a newline or a NUL: ${JSON.stringify(path)}`);
  }
}

class Helper implements CloneCall {
  private waiting: Array<{ resolve: (errno: number) => void; reject: (error: Error) => void }> = [];
  private buffered = "";
  private failed: Error | null = null;

  readonly kind: HelperKind;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(kind: HelperKind, child: ChildProcessWithoutNullStreams) {
    this.kind = kind;
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      this.buffered += text;
      let newline = this.buffered.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline).trim();
        this.buffered = this.buffered.slice(newline + 1);
        newline = this.buffered.indexOf("\n");
        if (line === "") continue;
        const next = this.waiting.shift();
        const errno = Number(line);
        if (next) {
          if (Number.isInteger(errno)) next.resolve(errno);
          else next.reject(new Error(`the clone helper answered ${JSON.stringify(line)}`));
        }
      }
    });
    const fail = (error: Error) => {
      this.failed ??= error;
      for (const next of this.waiting.splice(0)) next.reject(this.failed);
    };
    child.on("exit", (code, signal) => fail(new Error(`the clone helper (${kind}) exited (${signal ?? code})`)));
    child.on("error", fail);
    child.stdin.on("error", fail);
  }

  clone(source: string, destination: string): Promise<number> {
    checkPath(source);
    checkPath(destination);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.child.stdin.write(`${source}\n${destination}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
  }
}

function start(kind: HelperKind, timeoutMs: number): Promise<Helper> {
  const child =
    kind === "jxa"
      ? spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA], { stdio: "pipe" })
      : spawn("/usr/bin/perl", ["-e", PERL], { stdio: "pipe" });
  return new Promise((resolve, reject) => {
    let stderr = "";
    let out = "";
    const timer = setTimeout(() => done(new Error(`${kind} did not start within ${timeoutMs} ms`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes(`ready ${kind}\n`)) done(null);
    };
    const onErr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => done(new Error(`${kind} exited (${code}) before it was ready: ${stderr.trim().slice(0, 300)}`));
    const onError = (error: Error) => done(error);
    function done(error: Error | null) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
        return;
      }
      child.stderr.resume();
      resolve(new Helper(kind, child));
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onErr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

/** Start the helper: JXA first, perl if JXA cannot start. */
export async function startHelper(options: { prefer?: HelperKind[]; timeoutMs?: number } = {}): Promise<CloneCall> {
  if (process.platform !== "darwin") throw new Error("copy-on-write clones need macOS (clonefile on APFS)");
  const errors: string[] = [];
  for (const kind of options.prefer ?? ["jxa", "perl"]) {
    try {
      return await start(kind, options.timeoutMs ?? 10_000);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`no clone helper could start: ${errors.join("; ")}`);
}
