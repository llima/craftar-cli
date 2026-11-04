import { spawnSync } from "node:child_process";
import path from "node:path";
import { TSX_LOADER } from "./tsx-loader.js";

const REPO = path.resolve(__dirname, "../..");

/**
 * 10 s under vitest's per-test limit (180 s on win32, 30 s elsewhere): a child slowed by a CPU burst
 * on windows-latest fails with its own ETIMEDOUT before vitest's timeout, and spawnSync blocks the
 * event loop, so vitest cannot cut it sooner.
 */
export const CLI_SPAWN_TIMEOUT = process.platform === "win32" ? 170_000 : 25_000;

/** Run the CLI from source as a real process, colours off. */
export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: "utf8",
    env: { ...process.env, ...opts.env, NO_COLOR: "1" },
    timeout: CLI_SPAWN_TIMEOUT,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
