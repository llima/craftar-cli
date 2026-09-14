import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

/** Run the CLI from source as a real process, colours off. */
export function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "src/cli.ts"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
