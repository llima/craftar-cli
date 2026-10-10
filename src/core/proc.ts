/**
 * External-process execution (design D3): capture (stdout of a finished process, execFile)
 * and spawnInherited (inherited output, spawn). No shell.
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

/**
 * The absolute path of the program `file`, looked for in the ABSOLUTE entries of `env`'s PATH only — or null.
 * The platform's own lookup is not used: it also searches the child's working directory (on Windows always; elsewhere
 * for an empty or relative PATH entry), and craftar runs `dotnet` with the workspace root as working directory
 * (spec 32 §7: a program is found on PATH only). An absolute `file` is returned as given; a relative path is null.
 */
export async function onPath(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  // An absolute file is returned as given
  if (path.isAbsolute(file)) return file;

  // A relative path (contains a separator, or is empty) is not looked for
  if (file !== path.basename(file) || file === "") return null;

  // Get the PATH value: on win32, first key whose upper-cased name is PATH; elsewhere, env.PATH
  let pathValue: string | undefined;
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") {
        pathValue = env[key];
        break;
      }
    }
  } else {
    pathValue = env.PATH;
  }

  // No PATH means no entries
  if (pathValue === undefined) return null;

  // Split by the platform delimiter and filter to absolute entries only
  const entries = pathValue.split(path.delimiter).filter((entry) => {
    if (!path.isAbsolute(entry)) return false;
    // On win32, a rooted path without a drive (\tools) depends on the current directory's drive
    if (process.platform === "win32") {
      // Must start with a drive (A: or a:) followed by / or \, OR be a UNC path (\\...)
      if (/^[A-Za-z]:[\\/]/.test(entry)) return true;
      if (entry.startsWith("\\\\")) return true;
      return false;
    }
    return true;
  });

  // On win32, determine the names to try
  const names: string[] = [];
  if (process.platform === "win32") {
    // If file already ends with one of the extensions, just use it
    const lower = file.toLowerCase();
    if (WIN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      names.push(file);
    } else {
      // Try each extension
      for (const ext of WIN_EXTENSIONS) {
        names.push(file + ext);
      }
    }
  } else {
    names.push(file);
  }

  // Search each entry for each name
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        // On non-win32, check executable bit
        if (process.platform !== "win32") {
          await fs.access(candidate, constants.X_OK);
        }
        return candidate;
      } catch {
        // Not this one
      }
    }
  }

  return null;
}

/** Helper: reject with an ENOENT error for a file not on PATH. */
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
