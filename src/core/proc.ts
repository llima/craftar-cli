/**
 * External-process execution (design D3): every external program craftar runs — git, dotnet — is run
 * from here; `process.env` is read only as `execProgram`'s default. capture (stdout of a finished process,
 * execFile), execProgram (stdout and stderr, resolved by onPath) and spawnInherited (inherited output, spawn).
 * A program is resolved by onPath before it is run. No shell.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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

/**
 * The entries of a PATH value a program is looked for in: the absolute ones, in order. On win32 an entry may be
 * wrapped in quotes (quotes are removed only when they wrap the whole entry), and must start with a drive (`X:\`,
 * `X:/`) or be a UNC path (`\\host\…`, `//host/…`) — a rooted entry without a drive depends on the current
 * directory's drive. Empty and relative entries are dropped everywhere.
 */
export function pathEntries(value: string, win: boolean = WIN): string[] {
  const raw = value.split(win ? ";" : ":");
  const entries: string[] = [];
  for (let e of raw) {
    if (win && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
    if (e === "") continue;
    if (win) {
      if (/^[A-Za-z]:[\\/]/.test(e) || /^[\\/]{2}[^\\/]/.test(e)) entries.push(e);
    } else {
      if (e.startsWith("/")) entries.push(e);
    }
  }
  return entries;
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
  const entries = pathEntries((key === undefined ? undefined : env[key]) ?? "");
  const names = WIN && !WIN_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)) ? WIN_EXTENSIONS.map((ext) => file + ext) : [file];
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await isProgram(candidate)) return candidate;
    }
  }
  return null;
}

/** Reject with an ENOENT error for a file not on PATH, matching what Node gives for a program it cannot find. */
function notOnPath(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${file}`, path: file });
}

export interface ExecOptions { env?: NodeJS.ProcessEnv; cwd?: string; maxBuffer?: number; timeout?: number }
/**
 * stdout and stderr of a program that exited 0, the program resolved by `onPath` over `opts.env` (the process's
 * environment when none is given) — never by the platform's lookup. Rejects as `execFile` does: with `code`,
 * `stdout` and `stderr` on a non-zero exit, and with `code: "ENOENT"` when the program is on no absolute PATH entry.
 */
export async function execProgram(file: string, args: string[], opts: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const program = await onPath(file, opts.env ?? process.env);
  if (program === null) throw notOnPath(file);
  const { stdout, stderr } = await promisify(execFile)(program, args, { ...opts, encoding: "utf8" });
  return { stdout, stderr };
}

/** stdout of a process that exited 0; rejects otherwise (ENOENT when it cannot start). No shell. */
export const capture: Probe = async (file, args, env, cwd) =>
  (await execProgram(file, args, { env, cwd, timeout: PROBE_TIMEOUT_MS })).stdout;

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
