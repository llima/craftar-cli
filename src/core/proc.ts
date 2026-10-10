/**
 * External-process execution (design D3): capture (stdout of a finished process, execFile)
 * and spawnInherited (inherited output, spawn). A program is resolved by onPath before it is run. No shell.
 */
import { execFile, spawn } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import path from "node:path";

export interface RunRequest {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "inherit";
}

export type Runner = (req: RunRequest) => Promise<{ code: number | null }>;

export type Probe = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) => Promise<string>;

/** A wedged probe should not hang doctor forever. */
const PROBE_TIMEOUT_MS = 30_000;

/** What a program's file may end with on win32 when no shell runs it; a `.cmd` or `.bat` needs one, so it is never a program here. */
const WIN_EXTENSIONS = [".exe", ".com"];

const WIN = process.platform === "win32";

/** Absolute; on win32 a drive `X:\` / `X:/` or a UNC path — a rooted path without a drive depends on the current directory's drive. */
function isAnchored(entry: string): boolean {
  if (!path.isAbsolute(entry)) return false;
  if (WIN) {
    if (/^[A-Za-z]:[\\/]/.test(entry)) return true;
    if (entry.startsWith("\\\\")) return true;
    return false;
  }
  return true;
}

/** A file; off win32 also executable; any error → false. */
async function isProgram(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (!WIN) await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of the program `file`, looked for in the ABSOLUTE entries of `env`'s PATH only — or null.
 * The platform's own lookup is not used: it also searches the child's working directory (on Windows always; elsewhere
 * for an empty or relative PATH entry), and craftar runs `dotnet` with the workspace root as working directory
 * (spec 32 §7: a program is found on PATH only). An absolute `file` is returned as given; a relative path is null.
 */
export async function onPath(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (path.isAbsolute(file)) return file;
  if (file === "" || file !== path.basename(file)) return null;
  const key = WIN ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const entries = ((key === undefined ? undefined : env[key]) ?? "").split(path.delimiter).filter(isAnchored);
  const names = WIN && !WIN_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)) ? WIN_EXTENSIONS.map((ext) => file + ext) : [file];
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await isProgram(candidate)) return candidate;
    }
  }
  return null;
}

/** Reject with an ENOENT error for a file not on PATH. */
function notOnPath(file: string): Error {
  return Object.assign(new Error(`${file} is not on PATH`), { code: "ENOENT" });
}

/** stdout of a process that exited 0; rejects otherwise (ENOENT when it cannot start). No shell. */
export const capture: Probe = async (file, args, env, cwd) => {
  const program = await onPath(file, env);
  if (program === null) throw notOnPath(file);
  return new Promise((resolve, reject) => {
    execFile(program, args, { env, cwd, timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
};

/** Output inherited, stdin as asked; resolves with the exit code (null when killed by a signal); rejects when it cannot start. No shell. */
export const spawnInherited: Runner = async (req) => {
  const program = await onPath(req.file, req.env);
  if (program === null) throw notOnPath(req.file);
  return new Promise((resolve, reject) => {
    const child = spawn(program, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: [req.stdin, "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
};
