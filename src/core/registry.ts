import { promises as fs } from "node:fs";
import path from "node:path";
import { REGISTRY_SCHEMAS, RegistrySchema, type Lock, type Registry, type RegistryEntry } from "../schema/index.js";
import { SchemaError, shownSchema } from "./schema-fault.js";
import { exists } from "./forge.js";
import { withLock, type LockTiming } from "./home-lock.js";
import { cacheKey, credentialFault, CREDENTIAL_HIDDEN, UNVOUCHED_HIDDEN } from "./remote.js";
import { loadWorkspace, plan, readLock, status, unsetDeclared, unsetSummary, WORKSPACE_FILE, type FileStatus, type Plan, type Workspace } from "./sync.js";

/*
 * The workspace registry (spec 21): `$CRAFTAR_HOME/registry.json`, one entry per workspace a
 * writing `sync` ran in on this machine. An index, not the memory — `craftar.lock` stays that. This
 * module is the only one that writes it; it returns data and throws, and never prints.
 */

export const REGISTRY_FILE = "registry.json";
const LOCK_LABEL = "the workspace registry";

export function registryFile(home: string): string {
  return path.join(home, REGISTRY_FILE);
}

/** Paths compare without case on Windows (spec 21 §5.3). */
export function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A directory's real path when it exists, else its resolved path. */
async function realOrResolved(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

/** The registry on disk; none yet is an empty one. Refused by name when this craftar cannot read it. */
export async function readRegistry(home: string): Promise<Registry> {
  const file = registryFile(home);
  if (!(await exists(file))) return { schema: 1, workspaces: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof SyntaxError ? "not valid JSON" : (e as Error).message}`);
  }
  if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "schema") && !REGISTRY_SCHEMAS.includes((raw as { schema: unknown }).schema))
    throw new Error(`${REGISTRY_FILE} declares schema ${shownSchema((raw as { schema: unknown }).schema)}, which this craftar does not read — upgrade craftar`);
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) throw new SchemaError(`invalid ${file}`, parsed.error);
  return parsed.data;
}

const byPath = (a: RegistryEntry, b: RegistryEntry) => a.path.localeCompare(b.path);

/** Atomic: a sibling temporary file renamed over the registry, so a reader never sees half of it. */
async function writeRegistry(home: string, reg: Registry): Promise<void> {
  const file = registryFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  reg.workspaces.sort(byPath);
  try {
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Read, change and write the registry under its lock; `$CRAFTAR_HOME` is created first (§6.2). */
async function update<T>(home: string, timing: LockTiming, change: (reg: Registry) => Promise<T> | T): Promise<T> {
  await fs.mkdir(home, { recursive: true });
  return withLock(path.join(home, "registry.lock"), LOCK_LABEL, timing, async () => {
    const reg = await readRegistry(home);
    const out = await change(reg);
    await writeRegistry(home, reg);
    return out;
  });
}

/** Where the Forge lives (§5.2): a path Forge's real path, a remote one's cache key. */
async function forgeKey(ws: Workspace): Promise<string | null> {
  if (ws.origin.kind === "remote") return cacheKey(ws.config.forge.trim());
  try {
    return await fs.realpath(path.resolve(ws.root, ws.config.forge));
  } catch {
    return null;
  }
}

/** slot → recipe for the resolved recipes that declare one, in application order. */
function stackOf(ws: Workspace, recipes: string[]): Record<string, string> {
  const stack: Record<string, string> = {};
  for (const name of recipes) {
    const slot = ws.forge.recipes.get(name)?.slot;
    if (slot !== undefined) stack[slot] = name;
  }
  return stack;
}

/** Add this workspace's entry, or replace the one with the same real path (spec 21 §4.1, §6.1). */
export async function register(home: string, ws: Workspace, p: Plan, opts: { now?: Date; lock?: LockTiming } = {}): Promise<RegistryEntry> {
  const entry: RegistryEntry = {
    path: await realOrResolved(ws.root),
    profile: ws.config.profile,
    forge: {
      kind: ws.origin.kind,
      source: ws.config.forge,
      key: await forgeKey(ws),
      ref: ws.origin.ref,
      commit: ws.forge.commit,
      fromLocalFile: ws.origin.fromLocalFile,
    },
    recipes: p.resolution.recipes,
    stack: stackOf(ws, p.resolution.recipes),
    targets: p.resolution.targets,
    lastSync: (opts.now ?? new Date()).toISOString(),
  };
  return update(home, opts.lock ?? {}, (reg) => {
    reg.workspaces = reg.workspaces.filter((e) => !samePath(e.path, entry.path));
    reg.workspaces.push(entry);
    return entry;
  });
}

/** `craftar workspaces forget <dir>` (§4.3): the removed path; an unregistered one is an error. */
export async function forget(home: string, dir: string): Promise<string> {
  const target = await realOrResolved(dir);
  const notRegistered = () => new Error(`${target} is not registered`);
  if (!(await exists(registryFile(home)))) throw notRegistered();
  return update(home, {}, (reg) => {
    const kept = reg.workspaces.filter((e) => !samePath(e.path, target));
    if (kept.length === reg.workspaces.length) throw notRegistered();
    reg.workspaces = kept;
    return target;
  });
}

/**
 * The directory or its craftar.yaml is gone (§4.2, step 1): only ENOENT / ENOTDIR. A path that
 * exists but cannot be inspected (EACCES…) is not gone — the load fails and the row reads `error`,
 * which `prune` never removes.
 */
export async function isMissing(entry: RegistryEntry): Promise<boolean> {
  try {
    await fs.stat(path.join(entry.path, WORKSPACE_FILE));
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * The cache keys of the entries whose recorded Forge URL `credentialFault` flags. A release whose
 * check was narrower recorded such a URL, and the key built from it — the name of the cache entry —
 * holds the user and the password in clear.
 */
export function credentialKeys(reg: Registry): string[] {
  const keys = new Set<string>();
  for (const e of reg.workspaces) if (e.forge.key !== null && credentialFault(e.forge.source)) keys.add(e.forge.key);
  return [...keys];
}

/** `text` with every one of `keys` replaced by the fixed label: what `cache prune` and `doctor` print of a cache entry. */
export function hideKeys(text: string, keys: readonly string[]): string {
  let out = text;
  for (const k of keys) out = out.split(k).join(CREDENTIAL_HIDDEN);
  return out;
}

/**
 * The vouched keys: the keys of `named` minus `credentialKeys(reg)`. Empty when `reg` is null or `named`
 * is empty (spec 39 §5.1). A vouched key is printed as-is; an unvouched key gets `UNVOUCHED_HIDDEN`.
 */
export function vouchedKeys(named: ReadonlyMap<string, readonly string[]>, reg: Registry | null): Set<string> {
  if (reg === null || named.size === 0) return new Set();
  const flagged = new Set(credentialKeys(reg));
  const vouched = new Set<string>();
  for (const k of named.keys()) if (!flagged.has(k)) vouched.add(k);
  return vouched;
}

/** `text` with every one of `keys` replaced by `UNVOUCHED_HIDDEN`: what `cache prune` and `doctor` print for an unvouched key. */
export function hideUnvouched(text: string, keys: readonly string[]): string {
  let out = text;
  for (const k of keys) {
    if (k === "") continue;
    out = out.split(k).join(UNVOUCHED_HIDDEN);
  }
  return out;
}

/**
 * `text` with every path segment that follows `<path.resolve(home)>/forges/` or `<home>\forges\`
 * (either separator after `forges`) up to the next `/`, `\`, white space or quote replaced by
 * `UNVOUCHED_HIDDEN`. The no-snapshot rule, spec 39 §5.1 — vouched or not.
 */
export function hideCacheSegment(text: string, home: string): string {
  // Strip trailing separators so the root `/` becomes empty and the pattern is `[/\\]forges[/\\]`
  const resolved = path.resolve(home).replace(/[/\\]+$/, "");
  // Escape special regex characters in the home path
  const escaped = resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: <home>/forges/ or <home>\forges\ followed by the segment (up to / \ space or quote)
  // Capture the prefix (including the separator after forges) in group 1
  const pattern = new RegExp(`(${escaped}[/\\\\]forges[/\\\\])([^/\\\\\\s"']+)`, "g");
  // Use a function replacement to avoid $&, $1, etc. in the home path being interpreted
  return text.replace(pattern, (_, prefix: string) => prefix + UNVOUCHED_HIDDEN);
}

/** Whether `dir` has a registry entry — by real path, without case on Windows, as `register` keys it (spec 24 §5.1). */
export async function isRegistered(reg: Registry, dir: string): Promise<boolean> {
  const target = await realOrResolved(dir);
  return reg.workspaces.some((e) => samePath(e.path, target));
}

/**
 * What names a cache entry (spec 24 §4.3): every registry entry's `forge.key` —
 * `missing` ones included, until `workspaces prune` — and the checked workspace's own key. Returns
 * each named key with the workspace paths that name it.
 */
export function namedCacheKeys(reg: Registry, checked: { key: string; path: string } | null): Map<string, string[]> {
  const named = new Map<string, string[]>();
  const add = (key: string | null, by: string) => {
    if (key === null) return;
    const list = named.get(key) ?? [];
    if (!list.some((p) => samePath(p, by))) list.push(by);
    named.set(key, list);
  };
  for (const e of reg.workspaces) add(e.forge.key, e.path);
  if (checked) add(checked.key, checked.path);
  return named;
}

/** `craftar workspaces prune` (§4.4): removes every `missing` entry; returns their paths. Loads nothing else. */
export async function prune(home: string): Promise<string[]> {
  if (!(await exists(registryFile(home)))) return [];
  const gone: string[] = [];
  for (const e of (await readRegistry(home)).workspaces) if (await isMissing(e)) gone.push(e.path);
  if (gone.length === 0) return [];
  return update(home, {}, async (reg) => {
    const removed: string[] = [];
    const kept: RegistryEntry[] = [];
    for (const e of reg.workspaces) {
      if (await isMissing(e)) removed.push(e.path);
      else kept.push(e);
    }
    reg.workspaces = kept;
    return removed;
  });
}

/* ------------------------------------------------------------------ */
/* The table (§4.2, §4.5)                                               */
/* ------------------------------------------------------------------ */

export type RowStatus = "up-to-date" | "outdated" | "drift" | "no-lock" | "missing" | "error";

/** A row that loaded: the first matching line of §4.2's table, after `missing` and `error`. */
export function rowStatus(statuses: FileStatus[], lock: Lock | null): Exclude<RowStatus, "missing" | "error"> {
  if (lock === null) return "no-lock";
  const any = (...states: FileStatus["state"][]) => statuses.some((s) => states.includes(s.state));
  if (any("drift", "orphan-drift", "collision")) return "drift";
  if (any("new", "update", "orphan")) return "outdated";
  return "up-to-date";
}

/** One row of `craftar workspaces --json` (§4.5), keys in contract order. */
export interface WorkspaceRow {
  name: string;
  path: string;
  profile: string;
  recipes: string[];
  stack: Record<string, string>;
  targets: string[];
  forge: {
    kind: "path" | "remote";
    source: string;
    key: string | null;
    ref: string | null;
    defaultBranch: string | null;
    commit: string | null;
    lockCommit: string | null;
    fromLocalFile: boolean;
    fetched: boolean;
  };
  lastSync: string;
  status: RowStatus;
  forgeMoved: boolean | null;
  files: Record<string, number> | null;
}

export interface WorkspaceTable {
  registry: string;
  rows: WorkspaceRow[];
  /** Each prefixed `<path>: `, in row order (§4.2). */
  warnings: string[];
}

/**
 * A `missing` or `error` row: what the last sync recorded (§4.5) — except a Forge URL that
 * `credentialFault` flags, recorded by a release whose check was narrower: the fixed label stands
 * for it, and the key built from it is not given.
 */
function fromEntry(e: RegistryEntry, rowStatus: "missing" | "error"): WorkspaceRow {
  const hidden = credentialFault(e.forge.source);
  return {
    name: path.basename(e.path),
    path: e.path,
    profile: e.profile,
    recipes: e.recipes,
    stack: e.stack,
    targets: e.targets,
    forge: {
      kind: e.forge.kind,
      source: hidden ? CREDENTIAL_HIDDEN : e.forge.source,
      key: hidden ? null : e.forge.key,
      ref: e.forge.ref,
      defaultBranch: null,
      commit: e.forge.commit,
      lockCommit: null,
      fromLocalFile: e.forge.fromLocalFile,
      fetched: false,
    },
    lastSync: e.lastSync,
    status: rowStatus,
    forgeMoved: null,
    files: null,
  };
}

function counts(statuses: FileStatus[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

/**
 * Every entry with its status computed now (§4.2): the Forge from its path or the cache, never the
 * network unless `fetch`. Writes nothing to the registry, a workspace or a lock. `reason` words the
 * warning of an `error` row (spec 36 §4.5: `craftar ui` passes its own); absent, the error's message.
 */
export async function listWorkspaces(home: string, opts: { fetch: boolean; reason?: (e: unknown) => string }): Promise<WorkspaceTable> {
  const reg = await readRegistry(home);
  const rows: WorkspaceRow[] = [];
  const warnings: string[] = [];
  // Sorted on read too: a registry written by hand or by another craftar prints in path order.
  for (const e of [...reg.workspaces].sort(byPath)) {
    if (await isMissing(e)) {
      rows.push(fromEntry(e, "missing"));
      continue;
    }
    const say = (w: string) => warnings.push(`${e.path}: ${w}`);
    let ws: Workspace | undefined;
    let planSaid = false; // the plan's warnings, which open with the load's, were already said
    try {
      ws = await loadWorkspace(e.path, { mode: opts.fetch ? "read" : "no-fetch", home });
      const p = await plan(ws);
      // Spec 29 §4.1: a sync that would refuse is an `error` row, rebuilt from the entry like any other, its reason a
      // warning after the plan's, in a loaded row's order. Asked before the lock is read, as `nextSync` asks, so both
      // give the same reason.
      const unset = unsetDeclared(p);
      if (unset.length) {
        for (const w of p.warnings) say(w);
        planSaid = true;
        throw new Error(unsetSummary(unset));
      }
      const lock = await readLock(ws.root);
      const st = await status(ws, p, lock);
      const commit = ws.forge.commit;
      const lockCommit = lock?.forge.commit ?? null;
      rows.push({
        name: path.basename(e.path),
        path: e.path,
        profile: ws.config.profile,
        recipes: p.resolution.recipes,
        stack: stackOf(ws, p.resolution.recipes),
        targets: p.resolution.targets,
        forge: {
          kind: ws.origin.kind,
          source: ws.config.forge,
          key: await forgeKey(ws),
          ref: ws.origin.ref,
          defaultBranch: ws.origin.defaultBranch,
          commit,
          lockCommit,
          fromLocalFile: ws.origin.fromLocalFile,
          fetched: ws.origin.fetched,
        },
        lastSync: e.lastSync,
        status: rowStatus(st, lock),
        forgeMoved: commit !== null && lockCommit !== null ? commit !== lockCommit : null,
        files: counts(st),
      });
      for (const w of p.warnings) say(w);
    } catch (err) {
      rows.push(fromEntry(e, "error"));
      if (!planSaid) for (const w of ws?.warnings ?? []) say(w);
      say((opts.reason ?? ((e: unknown) => (e instanceof Error ? e.message : String(e))))(err));
    }
  }
  return { registry: registryFile(home), rows, warnings };
}
