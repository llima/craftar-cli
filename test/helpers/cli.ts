import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(__dirname, "../..");
// An absolute loader URL, so the CLI can run from a cwd outside the repository.
const TSX = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** Run the CLI from source as a real process, colours off. */
export function runCli(args: string[], opts: { cwd?: string } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX, path.join(REPO, "src/cli.ts"), ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 25_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
