// Running git from the host entry: never through a shell, hooks off, no prompts.
import { execFile } from "node:child_process";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Run git in `cwd` with hooks off; never through a shell. */
export function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(), maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
