/**
 * Impact analysis (spec 25 §5.1): which registered workspaces read a Forge, planned against it.
 * Reads only — never writes to a workspace, the registry, or the cache.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Forge } from "./forge.js";
import { isMissing, readRegistry, samePath } from "./registry.js";
import { cacheKey, classifyForge, credentialFault } from "./remote.js";
import {
  plan,
  readLock,
  readWorkspaceConfig,
  status,
  type FileState,
  type FileStatus,
  type MergedConfig,
  type Workspace,
} from "./sync.js";
import type { Lock, RegistryEntry } from "../schema/index.js";

const execFileP = promisify(execFile);

export type MatchKind = "path" | "remote" | "clone";
export type RegistryState = "read" | "partial" | "none" | "off";

/**
 * Refine the registry state: "partial" when any planned entry is missing or stage-config error.
 * Used by forge impact and unify's impact passes (spec 25 §3).
 */
export function refineRegistryState(state: RegistryState, planned: Planned[]): RegistryState {
  if (state !== "read" && state !== "partial") return state;
  const hasMissingOrConfig = planned.some(
    (p) => p.kind === "missing" || (p.kind === "error" && p.stage === "config"),
  );
  return hasMissingOrConfig ? "partial" : state;
}

export interface ForgeWorkspace {
  entry: RegistryEntry;
  match: MatchKind;
  /** Remote name or clone directory; null for path matches. */
  via: string | null;
  /** The workspace's requested ref; null when none. */
  ref: string | null;
}

export interface ForgeWorkspaces {
  state: RegistryState;
  workspaces: ForgeWorkspace[];
  warnings: string[];
  /** The real path of the Forge directory (fs.realpath). */
  realForge: string;
}

/** Run git and return stdout, or null if git fails (not a repository, etc.). */
async function gitSafe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * The fetch URLs of every remote, in `git remote` order, each with its remote name.
 * A URL that `credentialFault` flags is not returned and adds a warning.
 */
async function remoteUrls(
  dir: string,
  warnings: string[],
  warningDir: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const remotes = await gitSafe(dir, "remote");
  if (remotes === null) return out;
  for (const name of remotes.trim().split(/\r?\n/).filter(Boolean)) {
    const urlsOut = await gitSafe(dir, "remote", "get-url", "--all", name);
    if (urlsOut === null) continue;
    for (const url of urlsOut.trim().split(/\r?\n/).filter(Boolean)) {
      if (credentialFault(url)) {
        warnings.push(`remote ${name} of ${warningDir} holds credentials in its URL — not matched`);
        continue;
      }
      const list = out.get(name) ?? [];
      list.push(url);
      out.set(name, list);
    }
  }
  return out;
}

/**
 * Convert a remote URL to a cache key. For a local path remote (e.g. pointing at a bare repo),
 * convert to file:// URL first — this is what a workspace's `file://` URL names.
 */
function urlToKey(url: string, baseDir: string): string {
  if (classifyForge(url) === "path") {
    // A local bare repository named by path: convert to file:// URL as that's what cacheKey expects
    return cacheKey(pathToFileURL(path.resolve(baseDir, url)).href);
  }
  return cacheKey(url);
}

/**
 * Every registered workspace of a Forge directory (spec 25 §3):
 * - **path** — entries whose Forge is this directory;
 * - **remote** — entries whose Forge is a URL matching one of this directory's git remotes;
 * - **clone** — path entries whose Forge directory shares a remote URL with this one.
 *
 * Never fetches. A remote URL holding credentials is not matched and not printed.
 */
export async function forgeWorkspaces(
  home: string,
  forgeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForgeWorkspaces> {
  // Get the Forge's real path first, before checking CRAFTAR_NO_REGISTRY
  const realForge = await fs.realpath(forgeDir);

  // Check CRAFTAR_NO_REGISTRY first
  if (env.CRAFTAR_NO_REGISTRY && env.CRAFTAR_NO_REGISTRY !== "") {
    return { state: "off", workspaces: [], warnings: [], realForge };
  }

  const warnings: string[] = [];

  // Get the Forge's remotes
  const forgeRemotes = await remoteUrls(forgeDir, warnings, realForge);

  // Build a map of remote keys to their first remote name
  const forgeRemoteKeys = new Map<string, string>();
  for (const [name, urls] of forgeRemotes) {
    for (const url of urls) {
      const key = urlToKey(url, forgeDir);
      if (!forgeRemoteKeys.has(key)) {
        forgeRemoteKeys.set(key, name);
      }
    }
  }

  // Read the registry
  const reg = await readRegistry(home);

  const workspaces: ForgeWorkspace[] = [];
  let hasMissing = false;

  for (const entry of reg.workspaces) {
    // Skip entries with null key
    if (entry.forge.key === null) continue;

    let match: MatchKind | null = null;
    let via: string | null = null;

    // Check path match
    if (entry.forge.kind === "path" && samePath(entry.forge.key, realForge)) {
      match = "path";
    }
    // Check remote match
    else if (entry.forge.kind === "remote" && forgeRemoteKeys.has(entry.forge.key)) {
      match = "remote";
      via = forgeRemoteKeys.get(entry.forge.key)!;
    }
    // Check clone match
    else if (entry.forge.kind === "path") {
      // The entry's key is another directory; check if that directory shares a remote with ours
      const entryForgeDir = entry.forge.key;
      try {
        await fs.stat(entryForgeDir);
        const entryRemotes = await remoteUrls(entryForgeDir, warnings, entryForgeDir);
        for (const [, urls] of entryRemotes) {
          for (const url of urls) {
            const key = urlToKey(url, entryForgeDir);
            if (forgeRemoteKeys.has(key)) {
              match = "clone";
              via = entryForgeDir;
              break;
            }
          }
          if (match) break;
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }

    if (match !== null) {
      workspaces.push({ entry, match, via, ref: entry.forge.ref });
      if (await isMissing(entry)) hasMissing = true;
    }
  }

  // Sort by path
  workspaces.sort((a, b) => a.entry.path.localeCompare(b.entry.path));

  // Determine state
  let state: RegistryState;
  if (workspaces.length === 0) {
    state = "none";
  } else if (hasMissing) {
    state = "partial";
  } else {
    state = "read";
  }

  // Dedupe warnings (spec 25 §13 item 17: one warning per remote/clone)
  const uniqueWarnings = [...new Set(warnings)];

  return { state, workspaces, warnings: uniqueWarnings, realForge };
}

export type Planned =
  | { kind: "planned"; files: Map<string, Buffer>; workspace: Workspace & { merged: MergedConfig } }
  | { kind: "missing" }
  | { kind: "error"; stage: "config" | "plan"; message: string; merged?: MergedConfig };

/**
 * Plan every workspace entry against a Forge. Same order as `entries`.
 * - `isMissing` → `missing`
 * - config load fails → `error` (stage `config`)
 * - plan throws → `error` (stage `plan`, with `merged`)
 * - else → `planned` with files keyed by path, value `PlannedFile.content`
 */
export async function planAll(entries: ForgeWorkspace[], forge: Forge): Promise<Planned[]> {
  const results: Planned[] = [];
  for (const { entry } of entries) {
    if (await isMissing(entry)) {
      results.push({ kind: "missing" });
      continue;
    }
    try {
      const ws = await workspaceAgainst(entry.path, forge);
      try {
        const p = await plan(ws);
        const files = new Map<string, Buffer>();
        for (const f of p.files) {
          files.set(f.path, f.content);
        }
        results.push({ kind: "planned", files, workspace: ws });
      } catch (e) {
        results.push({
          kind: "error",
          stage: "plan",
          message: e instanceof Error ? e.message : String(e),
          merged: ws.merged,
        });
      }
    } catch (e) {
      results.push({
        kind: "error",
        stage: "config",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

export interface ImpactResult {
  state: "no-effect" | "changed" | "missing" | "error";
  files: string[];
  error: string | null;
}

/**
 * Compare two planned states: the paths added, removed, or whose Buffers differ.
 * - Either `missing` → `missing`
 * - Either `error` → `error` (after's message first)
 * - Else the sorted union of changed paths → `no-effect` when empty, `changed` otherwise.
 */
export function impactOf(before: Planned, after: Planned): ImpactResult {
  // Either missing → missing
  if (before.kind === "missing" || after.kind === "missing") {
    return { state: "missing", files: [], error: null };
  }
  // Either error → error (after's message first)
  if (after.kind === "error") {
    return { state: "error", files: [], error: after.message };
  }
  if (before.kind === "error") {
    return { state: "error", files: [], error: before.message };
  }

  // Both planned: compare files
  const changedFiles: string[] = [];
  const allPaths = new Set([...before.files.keys(), ...after.files.keys()]);

  for (const p of allPaths) {
    const beforeBuf = before.files.get(p);
    const afterBuf = after.files.get(p);

    if (beforeBuf === undefined || afterBuf === undefined) {
      // Path only in one side
      changedFiles.push(p);
    } else if (!beforeBuf.equals(afterBuf)) {
      // Content differs
      changedFiles.push(p);
    }
  }

  changedFiles.sort();

  if (changedFiles.length === 0) {
    return { state: "no-effect", files: [], error: null };
  }
  return { state: "changed", files: changedFiles, error: null };
}

export interface NextSyncResult {
  state: "unchanged" | "changed" | "missing" | "error";
  counts: Record<string, number>;
  error: string | null;
}

/**
 * FileState values in declaration order, compile-time exhaustive: adding a state without updating
 * this record is a type error (spec 25 §9 item 5 nit, spec 28 §5.2).
 */
export const FILE_STATE_ORDER_MAP: Record<FileState, number> = {
  unchanged: 0,
  new: 1,
  update: 2,
  drift: 3,
  adopt: 4,
  collision: 5,
  orphan: 6,
  "orphan-drift": 7,
};
const FILE_STATE_ORDER: FileState[] = (Object.keys(FILE_STATE_ORDER_MAP) as FileState[]).sort(
  (a, b) => FILE_STATE_ORDER_MAP[a] - FILE_STATE_ORDER_MAP[b],
);

/** The states `next sync:` counts, in FILE_STATE_ORDER_MAP order, without `unchanged` (spec 28 §5.2). */
export const NEXT_SYNC_STATES: Array<Exclude<FileState, "unchanged">> = FILE_STATE_ORDER.filter(
  (s): s is Exclude<FileState, "unchanged"> => s !== "unchanged",
);

/**
 * Count statuses by state, returning non-zero counts for every state but `unchanged`, in
 * FILE_STATE_ORDER_MAP order (spec 28 §5.2). The counting that `nextSync` and `nextSyncLine` share.
 */
export function countStates(
  statuses: FileStatus[],
): Array<[Exclude<FileState, "unchanged">, number]> {
  const counts: Partial<Record<Exclude<FileState, "unchanged">, number>> = {};
  for (const s of statuses) {
    if (s.state !== "unchanged") {
      counts[s.state] = (counts[s.state] ?? 0) + 1;
    }
  }
  const result: Array<[Exclude<FileState, "unchanged">, number]> = [];
  for (const state of NEXT_SYNC_STATES) {
    const n = counts[state];
    if (n !== undefined && n > 0) {
      result.push([state, n]);
    }
  }
  return result;
}

/**
 * What the next `sync` would do for a planned workspace: `status()` counts.
 * Keys are `FileState` values, only non-zero; `unchanged` when none.
 * Catches errors from readLock/status so one workspace's failure stays on its row (spec 25 §4.1).
 */
export async function nextSync(p: Planned): Promise<NextSyncResult> {
  if (p.kind === "missing") {
    return { state: "missing", counts: {}, error: null };
  }
  if (p.kind === "error") {
    return { state: "error", counts: {}, error: p.message };
  }

  const ws = p.workspace;
  let lock: Lock | null;
  let statuses: FileStatus[];
  try {
    const planned = await plan(ws);
    lock = await readLock(ws.root);
    statuses = await status(ws, planned, lock);
  } catch (e) {
    // An error here (e.g. a lock with schema: 9) becomes an error row, not a failed command
    return { state: "error", counts: {}, error: e instanceof Error ? e.message : String(e) };
  }

  // Use countStates for the counting (spec 28 §5.2)
  const pairs = countStates(statuses);
  if (pairs.length === 0) {
    return { state: "unchanged", counts: {}, error: null };
  }
  // Build the counts object from the pairs, preserving key order
  const counts: Record<string, number> = {};
  for (const [state, n] of pairs) {
    counts[state] = n;
  }
  return { state: "changed", counts, error: null };
}

export interface ConcernedResult {
  concerned: Array<{ path: string; file: "craftar.yaml" | "craftar.local.yaml" }>;
  unchecked: number;
}

/**
 * Which workspaces are concerned by a condition on their configuration (spec 25 §4.3).
 * Tests the MERGED configuration to decide, then checks `local` first, else `base` to name the file.
 * Arrays replace on merge, so with `base.x: [a]` and `local.x: []`, the merged config has `[]`
 * and the workspace is NOT concerned — even though `base` had `a`.
 * `missing` entries and stage-`config` errors count as `unchecked`.
 */
export function concerned(
  planned: Planned[],
  entries: ForgeWorkspace[],
  test: (doc: unknown) => boolean,
): ConcernedResult {
  const result: ConcernedResult = { concerned: [], unchecked: 0 };

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const entry = entries[i];

    // missing → unchecked
    if (p.kind === "missing") {
      result.unchecked++;
      continue;
    }
    // error stage config → unchecked
    if (p.kind === "error" && p.stage === "config") {
      result.unchecked++;
      continue;
    }

    // Get merged config: from planned.workspace or from error.merged (stage plan)
    let merged: MergedConfig | undefined;
    if (p.kind === "planned") {
      merged = p.workspace.merged;
    } else if (p.kind === "error" && p.stage === "plan" && p.merged) {
      merged = p.merged;
    }

    if (!merged) {
      result.unchecked++;
      continue;
    }

    // Test the MERGED configuration first to decide if concerned (spec 25 §4.3)
    if (!test(merged.config)) continue;

    // Concerned: find which file holds the entry (local first, then base)
    if (test(merged.local)) {
      result.concerned.push({ path: entry.entry.path, file: "craftar.local.yaml" });
    } else if (test(merged.base)) {
      result.concerned.push({ path: entry.entry.path, file: "craftar.yaml" });
    }
    // No else: merged.config is built from base + local via deepMerge, so if test(merged.config)
    // passes, the value must exist in at least one of them. This branch cannot be reached.
  }

  return result;
}

/**
 * Load a workspace's configuration against a given Forge, without fetching (spec 25 §5.1).
 * The returned `Workspace.forge` is the given `forge`, not the one `config.forge` names.
 * The `origin` says it was planned against this Forge.
 */
export async function workspaceAgainst(
  root: string,
  forge: Forge,
): Promise<Workspace & { merged: MergedConfig }> {
  root = path.resolve(root);
  const merged = await readWorkspaceConfig(root);
  const ws: Workspace & { merged: MergedConfig } = {
    root,
    config: merged.config,
    forge,
    origin: {
      kind: "path",
      source: forge.root,
      ref: null,
      defaultBranch: null,
      fetched: false,
      fromLocalFile: merged.fromLocalFile,
    },
    warnings: merged.warnings,
    merged,
  };
  return ws;
}
