/**
 * `craftar setup` (spec 62), the part that touches the disk and git: the checks made before any write (§4.3), the proof on a
 * scratch directory (§5.3 step 1), the create-only write of the new Forge (step 2) and its one commit (step 4). Data and
 * throws only — no `console`, no `process.exit`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUnderOrEqual } from "./cache-label.js";
import { gitRead, realpathOfNearest, removeProofCopy } from "./forge.js";
import { checkInitFlags, planInit } from "./init.js";
import { profileName } from "./new-profile.js";
import { execProgram, spawnInherited, type Runner } from "./proc.js";
import { assertNotCacheTree } from "./remote.js";
import { shellQuote, type SetupFile } from "./setup.js";
import { TARGETS, type Target } from "../schema/index.js";
import { importClaudeCode, type ImportReport } from "../importers/claude-code.js";

/** What the flags (or the answers) give, before anything is read (S1, S5, S11). */
export interface SetupFlags {
  forgeDir: string;
  name?: string;
  profile: string;
  targets?: string[];
  workspaces: string[];
  import?: boolean;
}

/**
 * S1, S5, S11: the checks on the values alone. `platform` decides the win32 refusal of `"` and `%` in `--forge-dir`, which `cmd`
 * cannot quote in the printed undo (§4.8).
 */
export function checkSetupFlags(f: SetupFlags, platform: NodeJS.Platform): void {
  profileName(f.profile);
  if (f.name !== undefined) {
    try {
      profileName(f.name);
    } catch (e) {
      throw new Error(`--name: ${(e as Error).message.replace("is not a profile name", "is not a Forge name")}`);
    }
  }
  if (platform === "win32" && /["%]/.test(path.resolve(f.forgeDir))) throw new Error('--forge-dir cannot hold " or % on Windows — pick another directory');
  if (f.targets !== undefined) {
    if (f.import === true) throw new Error("--targets cannot be combined with --import — import takes the targets it detects (claude-code, kiro); add others to the profile afterwards");
    if (f.targets.length === 0) throw new Error(`--targets needs at least one target (${TARGETS.join(", ")})`);
    checkInitFlags({ targets: f.targets }); // S5: init's own N7 — GEMINI_REMOVED, or the unknown-target wording
  }
  const fold = platform === "win32" || platform === "darwin";
  const seen = new Set<string>();
  for (const w of f.workspaces) {
    const k = fold ? path.resolve(w).toLowerCase() : path.resolve(w);
    if (seen.has(k)) throw new Error(`--workspace ${w} is given twice`);
    seen.add(k);
  }
}

/** What S3 found at the Forge directory: nothing there, or an empty directory that setup fills but did not create. */
export type ForgeDirState = "absent" | "empty";

/**
 * S2, S3, S4, S7: the places, read only. The Forge directory must not exist or be an empty directory (a link is refused), must
 * not lie under `$CRAFTAR_HOME/forges`, and must not nest with a workspace (real paths, without case on win32 and darwin); a
 * workspace must not hold `craftar.yaml` yet.
 */
export async function checkSetupPlaces(forgeAbs: string, workspaces: string[], home: string, platform: NodeJS.Platform): Promise<ForgeDirState> {
  let state: ForgeDirState = "absent";
  const st = await fs.lstat(forgeAbs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new Error(`${forgeAbs} cannot be inspected (${e.code ?? "error"})`);
  });
  if (st) {
    const notEmpty = `${forgeAbs} exists and is not empty — setup creates a new Forge; to use an existing one run craftar init --forge ${shellQuote(forgeAbs, platform)}`;
    if (!st.isDirectory()) throw new Error(notEmpty);
    if ((await fs.readdir(forgeAbs)).length > 0) throw new Error(notEmpty);
    state = "empty";
  }
  await assertNotCacheTree(forgeAbs, home);
  const forgeReal = await realpathOfNearest(forgeAbs);
  for (const w of workspaces) {
    const wsReal = await realpathOfNearest(path.resolve(w));
    if (isUnderOrEqual(wsReal, forgeReal, platform) || isUnderOrEqual(forgeReal, wsReal, platform)) {
      throw new Error(`the Forge and a workspace cannot nest — ${forgeAbs} and ${path.resolve(w)}`);
    }
    // init's N9: the workspace path, or the nearest existing ancestor of it, must be a directory.
    for (let d = path.resolve(w); ; d = path.dirname(d)) {
      const st = await fs.stat(d).catch(() => null);
      if (st) {
        if (!st.isDirectory()) throw new Error(`cannot use ${d} as a workspace: it is not a directory`);
        break;
      }
      if (path.dirname(d) === d) break;
    }
    const yaml = await fs.lstat(path.join(path.resolve(w), "craftar.yaml")).catch(() => null);
    if (yaml) throw new Error(`craftar.yaml already exists in ${path.resolve(w)} — that workspace is started already; setup starts new ones only`);
  }
  return state;
}

/** Whether a workspace directory holds `.claude/` (the import branch, §4.4; S8). */
export async function holdsClaude(ws: string): Promise<boolean> {
  const st = await fs.lstat(path.join(path.resolve(ws), ".claude")).catch(() => null);
  return st !== null && st.isDirectory();
}

/** S6's refusal, one wording. */
export const GIT_NEEDED =
  "setup: git is needed to create the Forge's first commit — install git, or set user.name and user.email, or pass --no-git";

/** The prefix of every scratch directory setup makes in `os.tmpdir()` (its own, so no other test or command's matches it). */
export const SCRATCH_PREFIX = "craftar-setup-proof-";

/**
 * S6: `git` found and both identities resolve — asked in an empty scratch directory with `GIT_CEILING_DIRECTORIES` at its
 * parent, so git reads only what the new repository will read (the user's global and system configuration and the environment),
 * never an enclosing repository's local `user.*`. On a host where git auto-detects an identity from its domain name both pass;
 * that is accepted.
 */
export async function checkGitIdentity(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  try {
    const isolated = { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
    for (const v of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
      try {
        await execProgram("git", [...gitRead(dir), "var", v], { env: isolated });
      } catch {
        throw new Error(GIT_NEEDED);
      }
    }
  } finally {
    await removeProofCopy(dir);
  }
}

/** Writes `files` under `root`, each created `wx`, parents made as needed. Used for the proof and for the real write. */
async function writeFilesWx(root: string, files: readonly SetupFile[], onWrite?: (rel: string) => void): Promise<void> {
  for (const f of files) {
    const abs = path.join(root, ...f.path.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.text, { flag: "wx" });
    onWrite?.(f.path);
  }
}

/** Every spelling of the scratch Forge in `msg` — absolute, real, relative to anywhere — put back as the Forge directory. */
function relabel(msg: string, scratch: string, scratchReal: string, forgeAbs: string): string {
  const base = path.basename(scratch).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = msg.split(path.join(scratchReal, "forge")).join(forgeAbs).split(path.join(scratch, "forge")).join(forgeAbs);
  out = out.replace(new RegExp(`[^\\s'"(]*${base}[\\\\/]forge`, "g"), forgeAbs);
  return out.replace(new RegExp(`[^\\s'"(]*${base}[^\\s'")]*`, "g"), "(a temporary directory)");
}

/**
 * §5.3 step 1 (S10), and on the import branch §4.4's proof too: the planned Forge written into a `forge/` beside an empty
 * `workspace/` under a fresh `os.tmpdir()` directory; on the import branch, import's own core run into that `forge/` (it reads
 * the workspace and writes nothing there); then the Forge loaded and a workspace planned on the profile through `planInit`. setup
 * writes these files itself, so this is no second copy routine. Removed in a `finally`. A refusal names the Forge directory,
 * never the scratch one, so an import refusal leaves the real Forge directory untouched.
 */
export async function proveSetupForge(
  files: readonly SetupFile[],
  profile: string,
  forgeAbs: string,
  opts: { home?: string; importWs?: string | null } = {},
): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const scratchReal = await fs.realpath(scratch);
  try {
    const forge = path.join(scratch, "forge");
    const ws = path.join(scratch, "workspace");
    await fs.mkdir(ws, { recursive: true });
    await writeFilesWx(forge, files);
    try {
      if (opts.importWs) {
        await importClaudeCode({ workspaceRoot: opts.importWs, forgeRoot: forge, profileName: profile });
        await planInit(opts.importWs, { forge, profile }, { mode: "read", home: opts.home, local: { doc: null, keys: [] } });
      } else {
        await planInit(ws, { forge, profile }, { mode: "read", home: opts.home, local: { doc: null, keys: [] } });
      }
    } catch (e) {
      const msg = relabel((e instanceof Error ? e.message : String(e)).replace(/\nThe Forge was left untouched\.$/, ""), scratch, scratchReal, forgeAbs);
      throw new Error(`setup: the new Forge would not load and plan — ${msg}`);
    }
  } finally {
    await removeProofCopy(scratch);
  }
}

/** What step 2 on wrote, for the late failure's undo (§4.8). */
export interface SetupWrites {
  /** The topmost directory this run created (the Forge directory or an ancestor), or null when it was found empty. */
  createdTop: string | null;
  /** Forge-relative paths written so far, in order. */
  written: string[];
  /** True once `git init` has run. */
  gitInit: boolean;
}

/** An error after the first write, carrying what was written (§4.8). */
export class SetupLateFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly writes: SetupWrites,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Whether a failure left anything to undo; a failure with nothing written is a plain refusal (§4.8). */
export function wroteAnything(w: SetupWrites): boolean {
  return w.createdTop !== null || w.written.length > 0 || w.gitInit;
}

/**
 * §5.3 step 2: the Forge directory made when absent — `mkdir` recursive, which answers the topmost directory it created, kept
 * for the undo; a directory that appeared since S3 (it answers none) is refused, never adopted — then every file created `wx`.
 */
export async function writeSetupForge(forgeAbs: string, state: ForgeDirState, files: readonly SetupFile[], writes: SetupWrites): Promise<void> {
  try {
    if (state === "absent") {
      const top = await fs.mkdir(forgeAbs, { recursive: true });
      if (top === undefined) throw new Error(`${forgeAbs} appeared while setup was checking it — run setup again`);
      writes.createdTop = top;
    }
    await writeFilesWx(forgeAbs, files, (rel) => writes.written.push(rel));
  } catch (e) {
    throw new SetupLateFailure(e, writes);
  }
}

/** The real import into the new Forge (§4.4 step 3), after its proof; what it wrote joins `writes`. */
export async function importIntoSetupForge(importWs: string, forgeAbs: string, profile: string, writes: SetupWrites): Promise<ImportReport> {
  try {
    const r = await importClaudeCode({ workspaceRoot: importWs, forgeRoot: forgeAbs, profileName: profile });
    for (const p of r.forgeWrites ?? []) if (!writes.written.includes(p)) writes.written.push(p);
    return r;
  } catch (e) {
    throw new SetupLateFailure(e, writes);
  }
}

/** The fixed message of the one commit setup makes (§8, C8). */
export const SETUP_COMMIT_MESSAGE = "chore: create Forge with craftar setup";

/**
 * §5.3 step 4: `git init`, `git add` of exactly the paths setup wrote and `git commit --quiet` in the new Forge, then its short
 * hash. `add` is `--literal-pathspecs … add -f --`: setup names its own files, so a global ignore rule (a `.gitkeep` pattern)
 * does not drop one, and `core.safecrlf=false` keeps an `autocrlf` setting from refusing setup's LF files — the commit itself is
 * the user's configuration, signing and hooks included. `init`, `add` and `rev-parse` capture their output (`execProgram`);
 * `commit` keeps the terminal's streams (`spawnInherited`, C11) so a signing prompt or a hook's output reaches the person.
 * `commit` is the injected runner in tests.
 */
export async function commitSetupForge(
  forgeAbs: string,
  paths: readonly string[],
  writes: SetupWrites,
  opts: { env: NodeJS.ProcessEnv; stdinIsTty: boolean; commit?: Runner },
): Promise<string> {
  try {
    await execProgram("git", ["init", "--quiet"], { cwd: forgeAbs, env: opts.env });
    writes.gitInit = true;
    await execProgram("git", ["--literal-pathspecs", "-c", "core.safecrlf=false", "add", "-f", "--", ...paths], { cwd: forgeAbs, env: opts.env });
    const run = opts.commit ?? spawnInherited;
    const { code } = await run({ file: "git", args: ["commit", "--quiet", "-m", SETUP_COMMIT_MESSAGE], cwd: forgeAbs, env: opts.env, stdin: opts.stdinIsTty ? "inherit" : "ignore" });
    if (code !== 0) throw new Error(`git commit exited with ${code === null ? "a signal" : `code ${code}`}`);
    const { stdout } = await execProgram("git", ["rev-parse", "--short", "HEAD"], { cwd: forgeAbs, env: opts.env });
    return stdout.trim();
  } catch (e) {
    throw new SetupLateFailure(e, writes);
  }
}

/** Every target `setup` accepts in `--targets`, parsed from a comma list. */
export function parseTargets(list: string): string[] {
  return list.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

export type { Target };
