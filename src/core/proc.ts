/**
 * External-process execution (design D3): capture (stdout of a finished process, execFile)
 * and spawnInherited (inherited output, spawn). No shell.
 */
import { execFile, spawn } from "node:child_process";

export interface RunRequest {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "inherit";
}

export type Runner = (req: RunRequest) => Promise<{ code: number | null }>;

export type Probe = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/** stdout of a process that exited 0; rejects otherwise (ENOENT when it cannot start). No shell. */
export const capture: Probe = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/** Output inherited, stdin as asked; resolves with the exit code (null when killed by a signal); rejects when it cannot start. No shell. */
export const spawnInherited: Runner = (req) =>
  new Promise((resolve, reject) => {
    const child = spawn(req.file, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: [req.stdin, "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
