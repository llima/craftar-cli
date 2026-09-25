import { spawnSync } from "node:child_process";
import path from "node:path";
import { TSX_LOADER } from "./tsx-loader.js";

const REPO = path.resolve(__dirname, "../..");

/** Run the CLI from source as a real process, colours off. */
export function runCli(args: string[], opts: { cwd?: string } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 25_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
