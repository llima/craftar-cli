/**
 * Repository cloning for `craftar init --clone` and `craftar repos clone` (spec 37 §5.1, §5.2).
 * The destination checks (C5) are stricter than the rest of craftar on purpose: real-path
 * containment (§7), so neither a `..` segment nor a symlink can carry a clone outside the workspace
 * or into the Forge. The check-then-act gap is known (§7): a destination can appear between the
 * plan and the clone; `cloneRepos` re-checks before each runner call, and a failure there is
 * reported as one entry's failure.
 *
 * PURE: no console; `process` read only for `process.platform`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Profile } from "../schema/index.js";
import { realpathOfNearest } from "./forge.js";
import { nameShaped } from "./integrations.js";
import { LOCATION_VARIABLES, onPath, spawnInherited, type Runner } from "./proc.js";
import { cloneArgs, isRepoName, profileRepos, type RepoEntry } from "./repos.js";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface DestinationContext {
  /** Workspace-relative POSIX paths of files `sync` would write (the plan). */
  planned: readonly string[];
  /** Workspace-relative POSIX paths `craftar.lock` records (files sync wrote before). */
  lockPaths: readonly string[];
  /** Absolute path of the Forge directory. */
  forgeDir: string;
}

export type RepoState = "present" | "missing" | "blocked";

export type CloneResult =
  | { entry: RepoEntry; outcome: "cloned" }
  | { entry: RepoEntry; outcome: "failed"; reason: string };

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const WIN = process.platform === "win32";

/**
 * The repository-local environment variables git itself clears when it moves to another repository.
 * This is what `git rev-parse --local-env-vars` lists (git 2.53): the location variables plus
 * configuration entries (`GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`).
 * Built from `LOCATION_VARIABLES` so there is no second spelling (spec 49 §5.5).
 */
export const GIT_LOCAL_ENV = [
  ...LOCATION_VARIABLES,
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

/** Set for O(1) lookup, upper-case for win32. */
const GIT_LOCAL_SET = new Set(GIT_LOCAL_ENV.map((v) => v.toUpperCase()));

/** Whether a key is one of git's repository-local variables — case-insensitive on win32, exact elsewhere. */
function isLocalEnvVar(k: string): boolean {
  return WIN ? GIT_LOCAL_SET.has(k.toUpperCase()) : GIT_LOCAL_SET.has(k);
}

/** Case-insensitive comparison on Windows, case-sensitive elsewhere. */
function eq(a: string, b: string): boolean {
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether `a` is equal to `b` or strictly inside `b`, by `path.relative`. The comparison is
 * case-insensitive on win32.
 */
function isInsideOrEqual(a: string, b: string): boolean {
  const rel = path.relative(b, a);
  if (rel === "") return true; // equal
  if (path.isAbsolute(rel)) return false;
  // A relative path starting with ".." (but not "..something") is outside
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  // On win32, compare without case
  if (WIN) {
    const relLower = path.relative(b.toLowerCase(), a.toLowerCase());
    if (relLower === ".." || relLower.startsWith(".." + path.sep) || path.isAbsolute(relLower)) return false;
  }
  return true;
}

/**
 * Whether `a` is strictly inside `b` (equal returns false).
 */
function isStrictlyInside(a: string, b: string): boolean {
  const rel = path.relative(b, a);
  if (rel === "") return false; // equal, not strictly inside
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  if (WIN) {
    const relLower = path.relative(b.toLowerCase(), a.toLowerCase());
    if (relLower === "" || relLower === ".." || relLower.startsWith(".." + path.sep) || path.isAbsolute(relLower)) return false;
  }
  return true;
}

/** Whether `lstat` can see anything at `p` (a file, directory, or dangling link). */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up from `from` toward `stop`, following links via `fs.stat`. Returns the first existing
 * path (a directory check), or null if nothing exists. Never goes above `stop`.
 */
async function firstExistingAncestor(from: string, stop: string): Promise<{ path: string; isDir: boolean } | null> {
  let current = from;
  while (current !== stop && !eq(current, stop)) {
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    try {
      const stat = await fs.stat(parent);
      return { path: parent, isDir: stat.isDirectory() };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        current = parent;
        continue;
      }
      // Other errors (permission, etc.): stop walking
      break;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* destinationFault — C5 in each of its forms                          */
/* ------------------------------------------------------------------ */

/**
 * The reason this destination cannot be used, or null. Checks in §5.1's order (first hit wins):
 * 1. already exists (lstat succeeds)
 * 2. a file sync writes (planned or lockPaths, with prefix matching)
 * 3. resolution error (realpathOfNearest throws)
 * 4. inside the Forge
 * 5. leaves the workspace through a link
 * 6. a parent is not a directory
 *
 * `root` and `ctx.forgeDir` are absolute; `e.path` is POSIX relative.
 */
export async function destinationFault(root: string, e: RepoEntry, ctx: DestinationContext): Promise<string | null> {
  const abs = path.join(root, ...e.path.split("/"));
  const pPath = e.path; // the profile's spelling, POSIX

  // 1. lstat succeeds → already exists
  try {
    await fs.lstat(abs);
    return `${pPath} already exists in the workspace — move it, or leave the clone out`;
  } catch (lstatErr) {
    const code = (lstatErr as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      // Some other lstat error (EACCES, EIO, …) falls through on purpose: step 3's
      // realpathOfNearest fails closed, refusing the destination rather than missing it.
    }
  }

  // 2. A file sync writes — check planned and lockPaths
  const pLower = pPath.toLowerCase();
  for (const planned of ctx.planned) {
    const plannedLower = planned.toLowerCase();
    // Equal or e.path is a prefix of planned followed by /
    if (pLower === plannedLower || plannedLower.startsWith(pLower + "/")) {
      return `${pPath} is a file sync writes`;
    }
  }
  for (const lock of ctx.lockPaths) {
    const lockLower = lock.toLowerCase();
    if (pLower === lockLower || lockLower.startsWith(pLower + "/")) {
      return `${pPath} is a file sync writes`;
    }
  }

  // 3. Resolve paths — any error → return the error message
  let destReal: string;
  let rootReal: string;
  let forgeReal: string;
  try {
    destReal = await realpathOfNearest(abs);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  try {
    rootReal = await realpathOfNearest(root);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  try {
    forgeReal = await realpathOfNearest(ctx.forgeDir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  // 4. Inside the Forge
  if (isInsideOrEqual(destReal, forgeReal)) {
    return `${pPath} lies inside the Forge`;
  }

  // 5. Not strictly inside workspace (leaves through a link)
  if (!isStrictlyInside(destReal, rootReal)) {
    return `${pPath} leaves the workspace through a link`;
  }

  // 6. Walk up from parent toward root: first existing path that is not a directory
  const ancestor = await firstExistingAncestor(abs, root);
  if (ancestor && !ancestor.isDir) {
    // Report the path relative to root, POSIX
    const relPath = path.relative(root, ancestor.path).split(path.sep).join("/");
    return `${relPath} is not a directory`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* listRepos — present, missing, blocked                               */
/* ------------------------------------------------------------------ */

/**
 * Classify each entry: `present` (lstat succeeds — present wins over a sync-writes check, §4.7),
 * `missing` (no fault), or `blocked` (with the reason). Nothing is written.
 */
export async function listRepos(
  root: string,
  entries: RepoEntry[],
  ctx: DestinationContext,
): Promise<Array<RepoEntry & { state: RepoState; reason: string | null }>> {
  const results: Array<RepoEntry & { state: RepoState; reason: string | null }> = [];
  for (const entry of entries) {
    const abs = path.join(root, ...entry.path.split("/"));
    // Present wins (§4.7)
    if (await exists(abs)) {
      results.push({ ...entry, state: "present", reason: null });
      continue;
    }
    const fault = await destinationFault(root, entry, ctx);
    if (fault === null) {
      results.push({ ...entry, state: "missing", reason: null });
    } else {
      results.push({ ...entry, state: "blocked", reason: fault });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* planClone — C3, C4, C5 and R1–R3                                    */
/* ------------------------------------------------------------------ */

/**
 * Plan which entries to clone. This is the one place C3 and C5 (and R1–R3) are decided and C4
 * becomes a refusal (spec 37 §5.2). The real-path containment is stricter than the rest of craftar
 * on purpose (§7), and the check-then-act gap is known (§7).
 *
 * @param root Absolute path of the workspace.
 * @param profile The profile (needs `name` and `repos`).
 * @param ctx Destination context (planned paths, lock paths, Forge dir).
 * @param opts.present How to handle a destination that already exists: "refuse" (init) or "skip" (repos clone).
 * @param opts.noEntries The message tail for C3 ("nothing to clone; drop --clone" or similar).
 * @param opts.names When given, only these names are considered; compared case-insensitively.
 * @returns The entries to clone (in profile order) and the skipped ones (present, unnamed).
 * @throws On C3 (no entries), C4 (profileRepos fails), C5 (destination fault), R1 (unknown name), R2 (named present), R3 (name given twice).
 */
export async function planClone(
  root: string,
  profile: Pick<Profile, "name" | "repos">,
  ctx: DestinationContext,
  opts: { present: "refuse" | "skip"; noEntries: string; names?: string[] },
): Promise<{ entries: RepoEntry[]; skipped: RepoEntry[] }> {
  // C4: let profileRepos throw its own error
  const allEntries = profileRepos(profile);

  // C3: no entries
  if (allEntries.length === 0) {
    throw new Error(`profile ${profile.name} lists no repositories — ${opts.noEntries}`);
  }

  // Handle names option: R1, R3 checks, then filter
  let entriesToConsider: RepoEntry[];
  const namedSet = new Set<string>(); // lower-cased names that were explicitly given

  if (opts.names && opts.names.length > 0) {
    // R1: check all names exist before R3
    const entryNameMap = new Map<string, RepoEntry>();
    for (const entry of allEntries) {
      entryNameMap.set(entry.name.toLowerCase(), entry);
    }
    for (const name of opts.names) {
      if (!entryNameMap.has(name.toLowerCase())) {
        // R1: unknown name — print it only when it is shaped like a repository name
        if (isRepoName(name) && nameShaped(name)) {
          throw new Error(`profile ${profile.name} has no repository ${name}`);
        } else {
          throw new Error(`profile ${profile.name}: a name given is not a repository name`);
        }
      }
    }

    // R3: check for duplicates (after R1)
    const seenNames = new Map<string, string>(); // lower → original
    for (const name of opts.names) {
      const lower = name.toLowerCase();
      const existing = seenNames.get(lower);
      if (existing !== undefined) {
        throw new Error(`${existing} is given twice`);
      }
      seenNames.set(lower, name);
      namedSet.add(lower);
    }

    // Filter to named entries, in profile order
    entriesToConsider = allEntries.filter((e) => namedSet.has(e.name.toLowerCase()));
  } else {
    entriesToConsider = allEntries;
  }

  const entries: RepoEntry[] = [];
  const skipped: RepoEntry[] = [];

  for (const entry of entriesToConsider) {
    const abs = path.join(root, ...entry.path.split("/"));
    const isNamed = namedSet.has(entry.name.toLowerCase());
    const isPresent = await exists(abs);

    if (isPresent) {
      if (opts.present === "refuse") {
        // C5: refuse with the exists reason
        throw new Error(`cannot clone ${entry.name}: ${entry.path} already exists in the workspace — move it, or leave the clone out`);
      } else {
        // present: skip
        if (isNamed) {
          // R2: a named entry that is present
          throw new Error(`${entry.name} is present at ${entry.path} — nothing to clone`);
        } else {
          skipped.push(entry);
          continue;
        }
      }
    }

    // Check destination fault (C5)
    const fault = await destinationFault(root, entry, ctx);
    if (fault !== null) {
      throw new Error(`cannot clone ${entry.name}: ${fault}`);
    }

    entries.push(entry);
  }

  return { entries, skipped };
}

/* ------------------------------------------------------------------ */
/* findGit — onPath, nothing else                                      */
/* ------------------------------------------------------------------ */

/**
 * Find `git` on the PATH. Returns the absolute path if found, or null.
 * Uses `onPath` from `./proc.js` — no other lookup.
 */
export async function findGit(env: NodeJS.ProcessEnv): Promise<string | null> {
  return onPath("git", env);
}

/* ------------------------------------------------------------------ */
/* cloneRepos — sequential runner calls                                */
/* ------------------------------------------------------------------ */

/**
 * Clone the entries sequentially, one at a time. Before each clone:
 * - If `lstat(abs)` succeeds → failed "already exists", no runner call
 * - If the nearest existing ancestor is not strictly inside the workspace → failed "leaves the workspace through a link"
 *
 * The runner is called with `GIT_ALLOW_PROTOCOL: "https:ssh"` and, when `!opts.stdinIsTty`,
 * `GIT_TERMINAL_PROMPT: "0"`.
 *
 * @returns One result per entry: cloned or failed with a reason. Never throws for one entry.
 */
export async function cloneRepos(
  root: string,
  entries: RepoEntry[],
  opts: { git: string; env: NodeJS.ProcessEnv; stdinIsTty: boolean },
  run: Runner = spawnInherited,
): Promise<CloneResult[]> {
  const results: CloneResult[] = [];

  for (const entry of entries) {
    const abs = path.join(root, ...entry.path.split("/"));

    // Re-check: if destination now exists, fail
    if (await exists(abs)) {
      results.push({ entry, outcome: "failed", reason: "already exists" });
      continue;
    }

    // Re-check: containment via real paths. A realpathOfNearest error (EACCES, a dangling link
    // appeared, …) is reported as "leaves the workspace through a link" — fail closed rather than
    // letting the clone through.
    let destNearest: string;
    let rootReal: string;
    try {
      destNearest = await realpathOfNearest(abs);
      rootReal = await realpathOfNearest(root);
    } catch {
      results.push({ entry, outcome: "failed", reason: "leaves the workspace through a link" });
      continue;
    }

    if (!isStrictlyInside(destNearest, rootReal)) {
      results.push({ entry, outcome: "failed", reason: "leaves the workspace through a link" });
      continue;
    }

    // Build environment: drop repository-local variables (they would place the checkout or parts
    // of it outside the checked destination) and any inherited GIT_ALLOW_PROTOCOL. Craftar's own
    // values are set last, so nothing inherited can widen the transports (spec 37 §4.4, §7).
    const env: NodeJS.ProcessEnv = {};
    const isAllowProtocol = (k: string): boolean =>
      WIN ? k.toUpperCase() === "GIT_ALLOW_PROTOCOL" : k === "GIT_ALLOW_PROTOCOL";
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined && !isLocalEnvVar(k) && !isAllowProtocol(k)) env[k] = v;
    }
    env.GIT_ALLOW_PROTOCOL = "https:ssh";
    if (!opts.stdinIsTty) {
      env.GIT_TERMINAL_PROMPT = "0";
    }

    // Run the clone
    try {
      const result = await run({
        file: opts.git,
        args: cloneArgs(entry),
        cwd: root,
        env,
        stdin: "inherit",
      });

      if (result.code === 0) {
        results.push({ entry, outcome: "cloned" });
      } else if (result.code === null) {
        results.push({ entry, outcome: "failed", reason: "git was ended by a signal" });
      } else {
        results.push({ entry, outcome: "failed", reason: `git exited ${result.code}` });
      }
    } catch {
      results.push({ entry, outcome: "failed", reason: "git could not be started" });
    }
  }

  return results;
}
