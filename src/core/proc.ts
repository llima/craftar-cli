/**
 * External-process execution (design D3): every external program craftar runs — git, dotnet, docker — is run
 * from here; `process.env` is read only as `execProgram`'s default. capture (stdout of a finished process,
 * execFile), execProgram (stdout and stderr, resolved by onPath), spawnInherited (inherited output, spawn),
 * streamProgram (stdin written, stdout read, whatever the exit) and openProgram (a child craftar talks to).
 * A program is resolved by onPath before it is run. No shell.
 */
import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
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
 * The git variables that say which repository to act on (spec 49 §3, §5.5). These are cleared from the environment
 * when craftar starts git so that a craftar command run from inside a git hook sees its own repositories, not
 * the hook's caller. Configuration variables (`GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`) stay.
 */
export const LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
] as const;

/** Set for O(1) lookup, upper-case for win32 comparison. */
const LOCATION_SET = new Set(LOCATION_VARIABLES.map((v) => v.toUpperCase()));

/**
 * Whether `entry` is `<dir>/node_modules/.bin` for `cwd` or a directory above it — the entries `npm` and `npx`
 * put first on PATH. craftar runs in a workspace or a Forge, so a program committed there would be the one it
 * runs. Lexical: separators, `.` and `..` are normalised and a trailing separator dropped (on win32 without
 * case), and no link is followed. A `node_modules/.bin` anywhere else is not one of them.
 */
export function isLocalBin(entry: string, cwd: string, win: boolean = WIN): boolean {
  const p = win ? path.win32 : path.posix;
  const norm = (s: string): string => {
    const n = p.normalize(s).replace(/[\\/]+$/, "");
    return win ? n.toLowerCase() : n;
  };
  const suffix = `${p.sep}node_modules${p.sep}.bin`;
  const e = norm(entry);
  if (!e.endsWith(suffix)) return false;
  const dir = e.slice(0, -suffix.length);
  const c = norm(cwd);
  return c === dir || c.startsWith(dir + p.sep);
}

/**
 * The entries of a PATH value a program is looked for in: the absolute ones, in order. On win32 an entry may be
 * wrapped in quotes (quotes are removed only when they wrap the whole entry), and must start with a drive (`X:\`,
 * `X:/`) or be a UNC path (`\\host\…`, `//host/…`) — a rooted entry without a drive depends on the current
 * directory's drive. Empty and relative entries are dropped everywhere, and so is a `node_modules/.bin` of `cwd`
 * (the directory craftar runs in) or of a directory above it (`isLocalBin`).
 */
export function pathEntries(value: string, win: boolean = WIN, cwd: string = process.cwd()): string[] {
  const raw = value.split(win ? ";" : ":");
  const entries: string[] = [];
  for (let e of raw) {
    if (win && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
    if (e === "" || isLocalBin(e, cwd, win)) continue;
    if (win) {
      if (/^[A-Za-z]:[\\/]/.test(e) || /^[\\/]{2}[^\\/]/.test(e)) entries.push(e);
    } else {
      if (e.startsWith("/")) entries.push(e);
    }
  }
  return entries;
}

/** The PATH value from `env`, reading the key as `onPath` reads it (on win32: whatever case). */
function pathOf(env: NodeJS.ProcessEnv): string | undefined {
  const key = WIN ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  return key === undefined ? undefined : env[key];
}

/**
 * `env` with its PATH reduced to the entries `onPath` looks in, so that what the program starts in turn (git
 * starts ssh, a credential helper, a hook) is not looked for in the working directory — nor in a
 * `node_modules/.bin` of it or above it — either. When no absolute
 * entry is left, off Windows the child gets NO PATH: an empty one makes the platform look in the working
 * directory, an absent one makes it use its default path. On win32 the key is always set, empty if need be: Node
 * gives a child with no PATH key the parent's own, unfiltered (read in libuv, not measured). No caller reaches
 * that case today — a bare `git` or `dotnet` is not found first. A copy: the caller's object is not changed.
 * Only the PATH key is replaced — on win32 every spelling of it, by one `PATH`; elsewhere `Path` and `path` are
 * other variables.
 */
function childEnv(env: NodeJS.ProcessEnv, program: string, opts: { keepIndexFile?: boolean } = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const git = isGitProgram(program);
  for (const [k, v] of Object.entries(env)) {
    const name = WIN ? k.toUpperCase() : k;
    if (name === "PATH") continue;
    if (git && LOCATION_SET.has(name)) {
      // A relative value would be read against the `-C` directory; the caller meant its own.
      if (opts.keepIndexFile && name === "GIT_INDEX_FILE" && v !== undefined) result[k] = path.resolve(process.cwd(), v);
      continue;
    }
    result[k] = v;
  }
  const entries = pathEntries(pathOf(env) ?? "");
  if (WIN || entries.length > 0) result.PATH = entries.join(path.delimiter);
  return result;
}

/** Whether `file` is named `git` (`git.exe` or `git.com` on win32, the names `onPath` takes, without case), given by name or by an absolute path. */
function isGitProgram(file: string): boolean {
  const name = path.basename(file);
  return WIN ? ["git", "git.exe", "git.com"].includes(name.toLowerCase()) : name === "git";
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
 * The first candidate that is an executable file is taken — unlike the platform, craftar does not go on to the
 * next entry when that file then fails to start. `cwd` is the directory whose `node_modules/.bin` entries, and
 * those above it, are skipped: the one craftar runs in, unless a test gives another.
 */
export async function onPath(file: string, env: NodeJS.ProcessEnv, cwd: string = process.cwd()): Promise<string | null> {
  if (path.isAbsolute(file)) return file;
  if (file === "" || file !== path.basename(file)) return null;
  const entries = pathEntries(pathOf(env) ?? "", WIN, cwd);
  const names = WIN && !WIN_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)) ? WIN_EXTENSIONS.map((ext) => file + ext) : [file];
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (await isProgram(candidate)) return candidate;
    }
  }
  return null;
}

/** The entries `onPath` looks in, for a caller asking about a file `onPath` would not start (a `.cmd`, an extensionless shim). */
export function lookupEntries(env: NodeJS.ProcessEnv): string[] {
  return pathEntries(pathOf(env) ?? "");
}

/** Reject with an ENOENT error for a file not on PATH, matching what Node gives for a program it cannot find. */
function notOnPath(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${file}`, path: file });
}

/** Options for `execProgram`. */
export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBuffer?: number;
  timeout?: number;
  /** When true, keep `GIT_INDEX_FILE` for git children (made absolute against cwd). */
  keepIndexFile?: boolean;
}

/**
 * stdout and stderr of a program that exited 0, the program resolved by `onPath` over `opts.env` (the process's
 * environment when none is given) — never by the platform's lookup. Rejects as `execFile` does: with `code`,
 * `stdout` and `stderr` on a non-zero exit, and with `code: "ENOENT"` when the program is on no absolute PATH entry.
 * For git children, location variables are removed from the environment (spec 49 §5.5); pass `keepIndexFile: true`
 * to preserve `GIT_INDEX_FILE`.
 */
export async function execProgram(file: string, args: string[], opts: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const env = opts.env ?? process.env;
  const program = await onPath(file, env);
  if (program === null) throw notOnPath(file);
  const { keepIndexFile, ...rest } = opts;
  const { stdout, stderr } = await promisify(execFile)(program, args, { ...rest, env: childEnv(env, program, { keepIndexFile }), encoding: "utf8" });
  return { stdout, stderr };
}

/** stdout of a process that exited 0; rejects otherwise (ENOENT when it cannot start). No shell. */
export const capture: Probe = async (file, args, env, cwd) =>
  (await execProgram(file, args, { env, cwd, timeout: PROBE_TIMEOUT_MS })).stdout;

/** Output inherited, stdin as asked; resolves with the exit code (null when killed by a signal); rejects when it cannot start. No shell. For git children, location variables are removed (spec 49 §5.5). */
export const spawnInherited: Runner = async (req) => {
  const program = await onPath(req.file, req.env);
  if (program === null) throw notOnPath(req.file);
  return new Promise((resolve, reject) => {
    const child = spawn(program, req.args, {
      cwd: req.cwd,
      env: childEnv(req.env, program),
      stdio: [req.stdin, "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
};

/**
 * Input written to a program's stdin, resolved with its exit code and stdout whatever the code: a caller that keeps what
 * a failing program printed before it stopped needs both (spec 49 §5.2). Rejects with ENOENT as `execProgram` does. The
 * program's stderr is dropped, so nothing it quotes can reach an output. For git children, location variables are
 * removed (spec 49 §5.5); pass `keepIndexFile: true` to preserve `GIT_INDEX_FILE`.
 */
export async function streamProgram(
  file: string,
  args: string[],
  opts: { input: string; env?: NodeJS.ProcessEnv; cwd?: string; keepIndexFile?: boolean },
): Promise<{ code: number | null; stdout: string }> {
  const child = await openProgram(file, args, opts);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  child.stdin.write(opts.input);
  const code = await child.close();
  return { code, stdout: Buffer.concat(chunks).toString("utf8") };
}

/** A program craftar talks to: see `openProgram`. */
export interface OpenedProgram {
  stdin: Writable;
  /** Raw Buffers. */
  stdout: Readable;
  /** Ends stdin and resolves with the exit code (null when killed by a signal), once stdout has ended. */
  close(): Promise<number | null>;
}

/**
 * A running program with its stdin and stdout open, for one craftar sends several requests to (`cat-file --batch`,
 * spec 49 §5.2). Resolved by `onPath`, no shell, environment through `childEnv`; stderr is dropped, so nothing it quotes
 * can reach an output. Rejects with ENOENT as `execProgram` does, and when the program cannot start.
 */
export async function openProgram(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; keepIndexFile?: boolean } = {},
): Promise<OpenedProgram> {
  const env = opts.env ?? process.env;
  const program = await onPath(file, env);
  if (program === null) throw notOnPath(file);
  const child = spawn(program, args, { cwd: opts.cwd, env: childEnv(env, program, { keepIndexFile: opts.keepIndexFile }), stdio: ["pipe", "pipe", "ignore"] });
  // A program that stops before reading its stdin (a failed git) ends the pipe: its exit says so, not this error.
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  // A failed start rejects below; this promise is then never asked.
  closed.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    close: () => {
      child.stdin.end();
      return closed;
    },
  };
}
