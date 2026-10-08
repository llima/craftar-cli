import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "../schema/index.js";
import { written } from "./capabilities.js";
import { exists } from "./forge.js";
import { isMissing, isRegistered, namedCacheKeys, readRegistry, registryFile, rowStatus } from "./registry.js";
import { cacheKey, classifyForge, inspectCache, type CacheSnapshot } from "./remote.js";
import { paramsFor } from "./resolve.js";
import { loadForgeFor, plan, readLock, readWorkspaceConfig, status, type MergedConfig, type Plan, type Workspace } from "./sync.js";
import { outName } from "../emitters/shared.js";

/*
 * `craftar doctor` (spec 24): every check Craftar can make about this machine and, inside one, this
 * workspace — one line per finding, `ok` / `warn` / `error`, each with its fix. It only reports: nothing
 * is written to a workspace, a lock or the registry (the Forge cache is read as every reader reads it).
 * This module returns data and never prints.
 */

export type CheckLevel = "ok" | "warn" | "error";

/** One line of the report; `--json` keeps these keys in this order (spec 24 §4.5). */
export interface Check {
  id: string;
  scope: "machine" | "workspace";
  level: CheckLevel;
  message: string;
  fix: string | null;
}

export interface DoctorReport {
  version: string;
  /** The checked workspace's real path, or null for the machine checks only. */
  workspace: string | null;
  fetch: boolean;
  strict: boolean;
  checks: Check[];
  summary: Record<CheckLevel, number>;
}

export interface DoctorOptions {
  version: string;
  /** `$CRAFTAR_HOME`, resolved. */
  home: string;
  /** A directory holding `craftar.yaml`, or null for the machine checks only. */
  workspace: string | null;
  fetch: boolean;
  strict: boolean;
  /** A non-empty `CRAFTAR_NO_REGISTRY` (read by the CLI, spec 24 §4.2). */
  registryOff: boolean;
  /** Environment to read `${NAME}` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seams: the Node version and `git --version` (null when git is not found). */
  nodeVersion?: string;
  gitVersion?: () => Promise<string | null>;
}

const execFileP = promisify(execFile);

async function defaultGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["--version"]);
    return stdout.trim().replace(/^git version\s*/, "") || "unknown";
  } catch {
    return null;
  }
}

const MB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "no git");
const NAME_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CACHE_FIX = (dir: string) => `remove ${dir} by hand (craftar cache prune is planned)`;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const m = (id: string, level: CheckLevel, message: string, fix: string | null = null) => checks.push({ id, scope: "machine", level, message, fix });
  const w = (id: string, level: CheckLevel, message: string, fix: string | null = null) => checks.push({ id, scope: "workspace", level, message, fix });
  const env = opts.env ?? process.env;
  const root = opts.workspace === null ? null : await fs.realpath(path.resolve(opts.workspace)).catch(() => path.resolve(opts.workspace!));

  // The cache snapshot first (§4.3: the cache as it was when doctor started), then the configuration,
  // which `git` and `cache` need even when the Forge does not load (§5.1).
  let snapshot: CacheSnapshot | null = null;
  let snapshotError: string | null = null;
  try {
    snapshot = await inspectCache(opts.home);
  } catch (e) {
    snapshotError = (e as Error).message;
  }
  let merged: MergedConfig | null = null;
  let configError: string | null = null;
  if (root !== null) {
    try {
      merged = await readWorkspaceConfig(root);
    } catch (e) {
      configError = (e as Error).message;
    }
  }
  const remote = merged !== null && classifyForge(merged.config.forge) === "url";

  // ---- machine
  const node = opts.nodeVersion ?? process.versions.node;
  if (Number(node.split(".")[0]) >= 22) m("node", "ok", node);
  else m("node", "error", `${node} — craftar needs Node 22 or later`, "install Node 22 or later");

  const git = await (opts.gitVersion ?? defaultGitVersion)();
  const gitMissingRemote = git === null && remote;
  if (git !== null) m("git", "ok", git);
  else if (remote) m("git", "error", "git not found — the workspace names a remote Forge", "install git");
  else m("git", "warn", "git not found", "install git");

  const home = opts.home;
  const homeStat = await fs.stat(home).catch(() => null);
  if (homeStat === null) m("home", "ok", `${home} (not created yet)`);
  else if (!homeStat.isDirectory()) m("home", "error", `${home} is not a directory`, `fix or move $CRAFTAR_HOME (${home})`);
  else if (!(await fs.access(home, fsc.W_OK).then(() => true, () => false))) m("home", "error", `${home} is not writable`, `fix or move $CRAFTAR_HOME (${home})`);
  else m("home", "ok", home);

  let reg: Registry | null = null;
  let registryWhyNot: string | null = null;
  if (opts.registryOff) {
    registryWhyNot = "the registry is off (CRAFTAR_NO_REGISTRY)";
    m("registry", "ok", "off (CRAFTAR_NO_REGISTRY)");
  } else {
    try {
      reg = await readRegistry(home);
      const there = await exists(registryFile(home));
      const missing: string[] = [];
      for (const e of reg.workspaces) if (await isMissing(e)) missing.push(e.path);
      if (!there) m("registry", "ok", "none yet");
      else if (missing.length === 0) m("registry", "ok", `${reg.workspaces.length} registered`);
      else
        m(
          "registry",
          "warn",
          `${missing.length} registered workspace${missing.length === 1 ? " is" : "s are"} gone: ${missing.join(", ")}`,
          "craftar workspaces prune",
        );
    } catch (e) {
      registryWhyNot = "the registry cannot be read";
      const msg = (e as Error).message;
      m("registry", "error", msg, /declares schema/.test(msg) ? "upgrade craftar" : `repair or remove ${registryFile(home)}`);
    }
  }

  // ---- cache (§4.3)
  if (snapshot === null) {
    m("cache", "warn", `cannot read the Forge cache: ${snapshotError}`, `fix or move $CRAFTAR_HOME (${home})`);
  } else {
    const total = snapshot.entries.reduce((n, e) => n + e.bytes, 0);
    const summary = `${snapshot.entries.length} entr${snapshot.entries.length === 1 ? "y" : "ies"}, ${MB(total)}`;
    let skip: string | null = registryWhyNot;
    if (skip === null && root !== null && merged === null) skip = "the checked craftar.yaml does not read";
    const findings: Check[] = [];
    for (const e of snapshot.entries) {
      if (!e.fetched) findings.push({ id: "cache", scope: "machine", level: "warn", message: `${e.key} — a fetch never completed`, fix: CACHE_FIX(e.dir) });
    }
    if (skip === null && reg !== null) {
      const checked = remote && root !== null ? { key: cacheKey(merged!.config.forge.trim()), path: root } : null;
      const named = namedCacheKeys(reg, checked);
      for (const e of snapshot.entries)
        if (e.fetched && !named.has(e.key)) findings.push({ id: "cache", scope: "machine", level: "warn", message: `${e.key} — nothing names it`, fix: CACHE_FIX(e.dir) });
    }
    if (findings.length === 0) m("cache", "ok", skip === null ? summary : `${summary} (orphans not checked: ${skip})`);
    else checks.push(...findings);
  }

  // ---- workspace
  if (root !== null) await workspaceChecks(root, merged, configError, gitMissingRemote, reg, registryWhyNot, opts, w, env);

  const summary: Record<CheckLevel, number> = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.level]++;
  return { version: opts.version, workspace: root, fetch: opts.fetch, strict: opts.strict, checks, summary };
}

async function workspaceChecks(
  root: string,
  merged: MergedConfig | null,
  configError: string | null,
  gitMissingRemote: boolean,
  reg: Registry | null,
  registryWhyNot: string | null,
  opts: DoctorOptions,
  w: (id: string, level: CheckLevel, message: string, fix?: string | null) => void,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // `git` missing with a remote Forge is git's error: the checks that need the load are not run (§4.2).
  let ws: Workspace | null = null;
  if (!gitMissingRemote) {
    if (merged === null) {
      w("config", "error", configError ?? "craftar.yaml does not read", null);
    } else {
      const remote = classifyForge(merged.config.forge) === "url";
      try {
        ws = await loadForgeFor(root, merged, { mode: opts.fetch ? "read" : "no-fetch", home: opts.home });
      } catch (e) {
        // Decided by stage, not by message (§5.1): the Forge of a remote configuration read offline failed to load.
        w("config", "error", (e as Error).message, remote && !opts.fetch ? "craftar doctor --fetch" : null);
      }
    }
  }

  if (ws !== null) {
    const o = ws.origin;
    const fallback = o.kind === "remote" && opts.fetch && !o.fetched ? ws.warnings.find((x) => x.startsWith(`Forge ${o.source} not fetched (`)) ?? null : null;
    const configWarnings = ws.warnings.filter((x) => x !== fallback);
    w("config", "ok", `craftar.yaml loads (forge ${ws.config.forge}, profile ${ws.config.profile})`);
    for (const x of configWarnings) w("config", "warn", x, null);

    // forge
    if (o.kind === "path") w("forge", "ok", `${o.source} @ ${short(ws.forge.commit)}`);
    else if (fallback !== null) w("forge", "warn", fallback, `check the network or credentials for ${o.source}`);
    else if (opts.fetch && o.fetched) w("forge", "ok", `${o.source} @ ${o.ref ?? `${o.defaultBranch} (default branch)`} ${short(ws.forge.commit)}, fetched now`);
    else if (opts.fetch) w("forge", "ok", `${o.source} @ pinned ${short(ws.forge.commit)}, cached`);
    else w("forge", "ok", `${o.source} @ ${o.ref ?? `${o.defaultBranch} (default branch)`} ${short(ws.forge.commit)}, cached ${o.fetchedAt ?? "(time unknown)"}`);

    // forge-inside
    if (o.kind === "path") {
      const forgeReal = await fs.realpath(ws.forge.root).catch(() => ws!.forge.root);
      const rel = path.relative(forgeReal, root);
      const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      if (inside) w("forge-inside", "warn", `the workspace lies inside its Forge (${forgeReal})`, "move the workspace out of the Forge");
      else w("forge-inside", "ok", "outside the Forge");
    } else w("forge-inside", "ok", "outside the Forge (remote)");

    // plan, params, mcp-env
    let p: Plan | null = null;
    try {
      p = await plan(ws);
    } catch (e) {
      w("plan", "error", (e as Error).message, null);
    }
    if (p !== null) {
      const declaredUnset = declaredWithoutValue(p);
      const owned = new Set<string>();
      for (const mp of p.missingParams) if (declaredUnset.has(mp.key)) owned.add(mp.warning);
      const own = p.warnings.slice(ws.warnings.length).filter((x) => !owned.has(x));
      w("plan", "ok", `${p.files.length} files`);
      for (const x of own) w("plan", "warn", x, null);

      if (declaredUnset.size === 0) w("params", "ok", "every declared parameter has a value");
      for (const [key, declaredBy] of declaredUnset) {
        const cited = p.missingParams.find((mp) => mp.key === key)?.refs ?? [];
        w(
          "params",
          "warn",
          `"${key}" declared by ${declaredBy.join(", ")} has no value${cited.length ? ` — cited by ${cited.join(", ")}` : ""}`,
          `set ${key} in the profile's params or overrides.params`,
        );
      }

      const unset = mcpUnset(p, env);
      if (unset.length === 0) w("mcp-env", "ok", "every variable a written MCP server expects is set");
      for (const { server, name } of unset) w("mcp-env", "warn", `server "${server}" expects ${name}, not set`, `export ${name}`);
    }

    // lock, status
    await lockAndStatus(root, ws, p, w);

    // registered
    if (registryWhyNot === "the registry is off (CRAFTAR_NO_REGISTRY)") w("registered", "ok", "registry off");
    else if (reg === null) w("registered", "ok", "not checked (the registry cannot be read)");
    else if (await isRegistered(reg, root)) w("registered", "ok", "in the registry");
    else if (await exists(path.join(root, "craftar.lock"))) w("registered", "warn", "synced but not registered", "craftar sync");
    else w("registered", "ok", "never synced, nothing to register yet");
  } else {
    // The workspace did not load: only `lock` runs (it needs only the directory, §6 case 1).
    await lockAndStatus(root, null, null, w);
  }
}

async function lockAndStatus(
  root: string,
  ws: Workspace | null,
  p: Plan | null,
  w: (id: string, level: CheckLevel, message: string, fix?: string | null) => void,
): Promise<void> {
  let lock;
  try {
    lock = await readLock(root);
  } catch (e) {
    const msg = (e as Error).message;
    w("lock", "error", msg, /declares schema/.test(msg) ? "upgrade craftar" : "repair or remove craftar.lock");
    return;
  }
  if (lock === null) {
    w("lock", "warn", "absent — never synced", "craftar sync");
    return;
  }
  w("lock", "ok", `schema ${lock.schema}, generated ${lock.generatedAt.slice(0, 16).replace("T", " ")} UTC`);
  if (ws === null || p === null) return;
  const st = await status(ws, p, lock);
  const row = rowStatus(st, lock);
  if (row === "up-to-date") {
    w("status", "ok", "up to date");
    return;
  }
  const counts: Record<string, number> = {};
  for (const s of st) if (s.state !== "unchanged" && s.state !== "adopt") counts[s.state] = (counts[s.state] ?? 0) + 1;
  const detail = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ");
  w("status", "warn", `${row} — ${detail}`, "craftar status, then craftar sync");
}

/** Declared keys with no default that no layer fills, with the ingredients declaring them (§4.2). */
function declaredWithoutValue(p: Plan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ing of p.resolution.ingredients) {
    const values = paramsFor(ing, p.resolution);
    // `paramsFor` already holds the ingredient's own default, so a key it lacks has neither default nor value.
    for (const key of Object.keys(ing.meta.params ?? {})) {
      if (Object.hasOwn(values, key)) continue;
      out.set(key, [...(out.get(key) ?? []), ing.ref]);
    }
  }
  return out;
}

/** One finding per (server outName, NAME) across the targets that write MCP (§4.2): the surviving server's `env`. */
function mcpUnset(p: Plan, env: NodeJS.ProcessEnv): Array<{ server: string; name: string }> {
  const servers = new Map<string, unknown>();
  for (const target of p.resolution.targets) {
    // `written()` yields only what the matrix says this target writes; the skip warnings were plan()'s.
    const walk = written(p.resolution, target, () => {});
    const perTarget = new Map<string, unknown>();
    for (const ing of walk) if (ing.meta.type === "mcp") perTarget.set(outName(ing.meta), ing.meta.server);
    for (const [k, v] of perTarget) servers.set(k, v);
  }
  const out: Array<{ server: string; name: string }> = [];
  const seen = new Set<string>();
  for (const [server, def] of servers) {
    const envBlock = def !== null && typeof def === "object" ? (def as { env?: unknown }).env : undefined;
    if (envBlock === null || typeof envBlock !== "object") continue;
    for (const value of Object.values(envBlock as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(NAME_REF)) {
        const name = match[1];
        const key = `${server}\u0000${name}`;
        if (seen.has(key) || env[name] !== undefined) continue;
        seen.add(key);
        out.push({ server, name });
      }
    }
  }
  return out;
}
