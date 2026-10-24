import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { ENV_NAME, type Lock, type Registry } from "../schema/index.js";
import { written } from "./capabilities.js";
import { exists } from "./forge.js";
import { renderServer, rendersServers } from "./mcp-server.js";
import { credentialKeys, hideCacheSegment, hideKeys, isMissing, isRegistered, namedCacheKeys, readRegistry, registryFile, rowStatus, vouchedKeys } from "./registry.js";
import { FULL_SHA, cacheKey, classifyForge, CREDENTIAL_HIDDEN, inspectCache, UNVOUCHED_HIDDEN, type CacheSnapshot } from "./remote.js";
import { dockerVersion, dockerFinding, dockerRunner as defaultDockerRunner, fragmentPaths, type DockerRunner } from "./services.js";
import { paramsFor } from "./resolve.js";
import { SchemaError, errorText } from "./schema-fault.js";
import { LOCK_FILE, declaredWithoutValue, loadForgeFor, plan, readLock, readWorkspaceConfig, status, type LoadOptions, type MergedConfig, type Plan, type Workspace, AGENTS_MD_BUDGET_KEY, agentsMdOverBudgetMessage, agentsMdOverDefaultMessage, AGENTS_MD_BUDGET_FIX, AGENTS_MD_SHRINK } from "./sync.js";
import { outName } from "../emitters/shared.js";
import { declaredTemplates, DOTNET_MISSING, DOTNET_MISSING_FIX, dotnetVersion as defaultDotnetVersion, feedMessage, notInstalled, profileLabel, unpinnedSources, type Declared } from "./templates.js";
import { capture, execProgram } from "./proc.js";

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
  /** A configuration already read, used in place of doctor's own read of the two workspace files (spec 35 §5.1). */
  merged?: MergedConfig;
  /** Test seam: sees the git calls of a remote Forge's load; absent, `defaultGit`. */
  git?: LoadOptions["git"];
  /** Test seams: the Node version, `git --version` and `dotnet --version` (null when not found). */
  nodeVersion?: string;
  gitVersion?: () => Promise<string | null>;
  dotnetVersion?: () => Promise<string | null>;
  /** Test seam: injected runner for `docker compose version --short` (spec 31 §4.7). */
  dockerRunner?: DockerRunner;
  /** Test seam: a replacement for the real `inspectCache` (spec 39 §5.1). */
  inspectCache?: typeof inspectCache;
}

async function defaultGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execProgram("git", ["--version"]);
    return stdout.trim().replace(/^git version\s*/, "") || "unknown";
  } catch {
    return null;
  }
}

const MB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "no git");
const NAME_REF = new RegExp("\\$\\{(" + ENV_NAME + ")\\}", "g");
const refLabel = (ref: string | null, defaultBranch: string | null) => ref ?? (defaultBranch ? `${defaultBranch} (default branch)` : "the default branch");
const CACHE_FIX = "craftar cache prune";

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const m = (id: string, level: CheckLevel, message: string, fix: string | null = null) => checks.push({ id, scope: "machine", level, message, fix });
  const w = (id: string, level: CheckLevel, message: string, fix: string | null = null) => checks.push({ id, scope: "workspace", level, message, fix });
  const env = opts.env ?? process.env;
  // Loaded as given, as every other command loads it (a relative `forge:` reads from the path the user named);
  // the real path is what the report, `forge-inside` and `registered` compare (§4.5).
  const given = opts.workspace === null ? null : path.resolve(opts.workspace);
  const root = given === null ? null : await fs.realpath(given).catch(() => given);

  // The cache snapshot first (§4.3: the cache as it was when doctor started), then the configuration,
  // which `git` and `cache` need even when the Forge does not load (§5.1).
  let snapshot: CacheSnapshot | null = null;
  let snapshotError: string | null = null;
  const doInspect = opts.inspectCache ?? inspectCache;
  try {
    snapshot = await doInspect(opts.home);
  } catch (e) {
    snapshotError = oneLine(e);
  }
  let merged: MergedConfig | null = null;
  let configError: string | null = null;
  if (given !== null) {
    try {
      merged = opts.merged ?? (await readWorkspaceConfig(given));
    } catch (e) {
      configError = oneLine(e);
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
    registryWhyNot = "CRAFTAR_NO_REGISTRY is set";
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
      const msg = errorText(e);
      m("registry", "error", oneLine(e), /declares schema/.test(msg) ? "upgrade craftar" : `repair or remove ${registryFile(home)}`);
    }
  }

  // ---- cache (§4.3)
  if (homeStat !== null && !homeStat.isDirectory()) {
    // One cause, one line (§13 item 12): a home that is not a directory is `home`'s error.
    m("cache", "ok", "not checked ($CRAFTAR_HOME is not a directory)");
  } else if (snapshot === null) {
    // No snapshot: use hideCacheSegment, then hideKeys (spec 39 §5.1).
    // Two passes are safe: hideCacheSegment replaces the whole segment after `forges/`, and a
    // credential key is a cacheKey — only [a-z0-9._-], ending in `-<12 hex>` — while the inserted
    // label holds no such run and starts with `(` and holds spaces, so hideKeys can match neither
    // inside nor across it.
    const msg = hideCacheSegment(snapshotError ?? "", opts.home);
    m("cache", "warn", `cannot read the Forge cache: ${hideKeys(msg, reg === null ? [] : credentialKeys(reg))}`, `fix or move $CRAFTAR_HOME (${home})`);
  } else {
    const summary = `${snapshot.entries.length} entr${snapshot.entries.length === 1 ? "y" : "ies"}, ${MB(snapshot.bytes)}`;
    let skip: string | null = registryWhyNot;
    if (skip === null && root !== null && merged === null) skip = "the checked craftar.yaml does not read";
    const findings: Check[] = [];
    // A key the registry records for a URL with credentials is never printed (the name holds them).
    const hide = reg === null ? [] : credentialKeys(reg);
    // Compute the named map before both loops so both can use it (spec 39 §5.1).
    const checked = skip === null && reg !== null && remote && root !== null ? { key: cacheKey(merged!.config.forge.trim()), path: root } : null;
    const named = skip === null && reg !== null ? namedCacheKeys(reg, checked) : new Map<string, string[]>();
    const vouched = vouchedKeys(named, reg);
    // `a fetch never completed`: show key as-is only when vouched, as CREDENTIAL_HIDDEN when credentialKeys holds it, else UNVOUCHED_HIDDEN.
    for (const e of snapshot.entries) {
      if (!e.fetched) {
        const label = vouched.has(e.key) ? e.key : hide.includes(e.key) ? CREDENTIAL_HIDDEN : UNVOUCHED_HIDDEN;
        findings.push({ id: "cache", scope: "machine", level: "warn", message: `${label} — a fetch never completed`, fix: CACHE_FIX });
      }
    }
    // `nothing names it`: always UNVOUCHED_HIDDEN (such a key is never vouched).
    if (skip === null && reg !== null) {
      for (const e of snapshot.entries)
        if (e.fetched && !named.has(e.key)) findings.push({ id: "cache", scope: "machine", level: "warn", message: `${UNVOUCHED_HIDDEN} — nothing names it`, fix: CACHE_FIX });
    }
    // A skipped orphan part is said on every cache line, findings included (§4.3, §13 item 6).
    const why = skip === null ? "" : ` (orphans not checked: ${skip})`;
    if (findings.length === 0) m("cache", "ok", `${summary}${why}`);
    else checks.push(...findings.map((c) => ({ ...c, message: `${c.message}${why}` })));
  }

  // ---- workspace
  if (root !== null && given !== null) await workspaceChecks(given, root, merged, configError, gitMissingRemote, reg, registryWhyNot, opts, w, env);

  const summary: Record<CheckLevel, number> = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.level]++;
  return { version: opts.version, workspace: root, fetch: opts.fetch, strict: opts.strict, checks, summary };
}

async function workspaceChecks(
  given: string,
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
        ws = await loadForgeFor(given, merged, { mode: opts.fetch ? "read" : "no-fetch", home: opts.home, git: opts.git });
      } catch (e) {
        // Decided by stage, not by message (§5.1): the Forge of a remote configuration read offline failed to load.
        w("config", "error", oneLine(e), remote && !opts.fetch ? "craftar doctor --fetch" : null);
      }
    }
  }

  if (ws !== null) {
    const o = ws.origin;
    const fallback = o.kind === "remote" && opts.fetch && !o.fetched ? ws.warnings.find((x) => x.startsWith(`Forge ${o.source} not fetched (`)) ?? null : null;
    const configWarnings = ws.warnings.filter((x) => x !== fallback);
    // One `ok` line only when the check has nothing to report (§4.2, §4.5).
    if (configWarnings.length === 0) w("config", "ok", `craftar.yaml loads (forge ${ws.config.forge}, profile ${ws.config.profile})`);
    for (const x of configWarnings) w("config", "warn", x, null);

    // forge
    if (o.kind === "path") w("forge", "ok", `${o.source} @ ${short(ws.forge.commit)}`);
    else if (fallback !== null) w("forge", "warn", fallback, `check the network or credentials for ${o.source}`);
    else if (opts.fetch && o.fetched) w("forge", "ok", `${o.source} @ ${refLabel(o.ref, o.defaultBranch)} ${short(ws.forge.commit)}, fetched now`);
    // A full-SHA `ref` already cached is never fetched (spec 13), with or without --fetch.
    else if (o.ref !== null && FULL_SHA.test(o.ref)) w("forge", "ok", `${o.source} @ pinned ${short(ws.forge.commit)}, cached`);
    else w("forge", "ok", `${o.source} @ ${refLabel(o.ref, o.defaultBranch)} ${short(ws.forge.commit)}, cached ${o.fetchedAt ?? "(time unknown)"}`);

    // forge-inside
    if (o.kind === "path") {
      const forgeReal = await fs.realpath(ws.forge.root).catch(() => ws!.forge.root);
      const rel = path.relative(forgeReal, root);
      const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
      if (inside) w("forge-inside", "warn", `the workspace lies inside its Forge (${forgeReal})`, "move the workspace out of the Forge");
      else w("forge-inside", "ok", "outside the Forge");
    } else w("forge-inside", "ok", "outside the Forge (remote)");

    // plan, params, mcp-env
    let p: Plan | null = null;
    try {
      p = await plan(ws);
    } catch (e) {
      w("plan", "error", oneLine(e), null);
    }
    if (p !== null) {
      const declaredUnset = declaredWithoutValue(p);
      const owned = new Set<string>();
      for (const mp of p.missingParams) if (declaredUnset.has(mp.key)) owned.add(mp.warning);
      // Also exclude the AGENTS.md budget warning — it is reported by agents-md-size
      if (p.agentsMd?.warning) owned.add(p.agentsMd.warning);
      const own = p.warnings.slice(ws.warnings.length).filter((x) => !owned.has(x));
      if (own.length === 0) w("plan", "ok", `${p.files.length} files`);
      for (const x of own) w("plan", "warn", x, null);

      if (declaredUnset.size === 0) w("params", "ok", "every declared parameter has a value");
      for (const [key, declaredBy] of declaredUnset) {
        const cited = p.missingParams.find((mp) => mp.key === key)?.refs ?? [];
        // Spec 29 §4.1: a key a planned file cites refuses the sync, so it is an error; a stale declaration stays a warning.
        w(
          "params",
          cited.length ? "error" : "warn",
          `"${key}" declared by ${declaredBy.join(", ")} has no value${cited.length ? ` — cited by ${cited.join(", ")}` : ""}`,
          `set ${key} in the profile's params or overrides.params`,
        );
      }

      // agents-md-size: only when the plan writes AGENTS.md (the target is in use)
      if (p.agentsMd !== null) {
        const { bytes, maxBytes, explicit } = p.agentsMd;
        // maxBytes 0 means budget is off
        if (maxBytes === 0) {
          w("agents-md-size", "ok", `AGENTS.md is ${bytes} bytes; the budget is off (${AGENTS_MD_BUDGET_KEY}: 0)`);
        } else if (bytes <= maxBytes) {
          // Within budget
          w("agents-md-size", "ok", `AGENTS.md is ${bytes} bytes, within the budget of ${maxBytes}`);
        } else if (explicit) {
          // Over explicit budget: error — use shared message and fix
          w("agents-md-size", "error", agentsMdOverBudgetMessage({ bytes, maxBytes }), AGENTS_MD_BUDGET_FIX);
        } else {
          // Over default budget: warn
          w(
            "agents-md-size",
            "warn",
            agentsMdOverDefaultMessage({ bytes, maxBytes }),
            `set ${AGENTS_MD_BUDGET_KEY} to fail sync --check above it; to shrink the file: ${AGENTS_MD_SHRINK}`,
          );
        }
      }

      // agents-md-primary: present only when the mode is on and claude-code is a target (spec 41 §4.10)
      if (p.resolution.primary && p.resolution.targets.includes("claude-code")) {
        w(
          "agents-md-primary",
          "warn",
          "agents-md.primary is on; Claude Code reads AGENTS.md through a CLAUDE.md that imports it, not from its directory",
          "confirm Project instructions is set to claude-md-and-agents-md or agents-md; a CLAUDE.md that does not import AGENTS.md yields a warning in plan",
        );
      }

      // kiro-resources: present only when there are unplanned Kiro agent resources (spec 41 §4.10)
      if (p.kiroResources !== null && p.kiroResources.unplanned.length > 0) {
        const entries = p.kiroResources.unplanned.map((r) => `${r.agent} → ${r.path}`).join(", ");
        w(
          "kiro-resources",
          "warn",
          `${p.kiroResources.unplanned.length} Kiro agent resource(s) name a file the plan does not write: ${entries}`,
          "edit the agent's resources in the Forge, or list the rule's targets so kiro writes it",
        );
      }

      const unset = mcpUnset(p, env, ws.forge.manifest.schema);
      if (unset.length === 0) w("mcp-env", "ok", "every variable a written MCP server expects is set");
      for (const { server, name } of unset) w("mcp-env", "warn", `server "${server}" expects ${name}, not set`, `export ${name}`);
    }

    // docker, services-env: present only when the plan or the lock has a service (spec 31 §4.7)
    // Read lock here so we can check for services in it when plan failed
    const lock = await readLock(root).catch(() => null);
    await dockerAndServicesEnv(root, p, lock, opts.dockerRunner ?? defaultDockerRunner, w, env);

    // lock, status
    await lockAndStatus(root, ws, p, w);

    // registered
    if (opts.registryOff) w("registered", "ok", "registry off");
    else if (reg === null) w("registered", "ok", "not checked (the registry cannot be read)");
    else if (await isRegistered(reg, root)) w("registered", "ok", "in the registry");
    else if (await exists(path.join(root, LOCK_FILE))) w("registered", "warn", "synced but not registered", "craftar sync");
    else w("registered", "ok", "never synced, nothing to register yet");

    // templates, dotnet — only when the profile has the key (spec 32 §4.3, D11)
    const profile = ws.forge.profiles.get(ws.config.profile);
    if (profile) {
      const label = await profileLabel(ws.forge.root, profile.name);
      let declared: Declared | undefined;
      try {
        declared = declaredTemplates(profile, label);
      } catch (e) {
        w("templates", "warn", oneLine(e), "fix the templates block: only craftar templates reads it");
        // No dotnet check when the block is refused
      }
      if (declared && declared.declared) {
        const findings: Check[] = [];
        for (const e of declared.entries) {
          if (!e.installable) findings.push({ id: "templates", scope: "workspace", level: "warn", message: `templates[${e.entry}]: ${notInstalled(e.kind)}`, fix: "upgrade craftar, or remove the entry" });
        }
        const unpinned = await unpinnedSources(declared.entries, root);
        if (unpinned.length > 0) findings.push({ id: "templates", scope: "workspace", level: "warn", message: feedMessage(unpinned), fix: "add a NuGet.Config at the workspace root that pins the feed, or ignore this when NuGet is configured above the workspace or for the user" });
        if (findings.length === 0) {
          const n = declared.entries.length;
          w("templates", "ok", `block accepted: ${n} ${n === 1 ? "entry" : "entries"}`);
        } else {
          for (const f of findings) w(f.id, f.level, f.message, f.fix);
        }
        // dotnet check — only when at least one entry is installable
        if (declared.entries.some((e) => e.installable)) {
          const getDotnetVersion = opts.dotnetVersion ?? (() => defaultDotnetVersion(capture, env, root));
          const version = await getDotnetVersion();
          if (version !== null) w("dotnet", "ok", version);
          else w("dotnet", "warn", DOTNET_MISSING, DOTNET_MISSING_FIX);
        }
      }
    }
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
    const msg = errorText(e);
    w("lock", "error", oneLine(e), /declares schema/.test(msg) ? "upgrade craftar" : `repair or remove ${LOCK_FILE}`);
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

/**
 * Any caught error as one line (§3: each check's message is one line). A SchemaError carries its issues;
 * its first issue is shown with the count of any that follow. Everything else goes through `errorText`.
 */
export function oneLine(e: unknown): string {
  if (e instanceof SchemaError && e.issues.length > 0) {
    const first = e.issues[0];
    const n = e.issues.length;
    return `${e.what} (${first.path}: ${first.text}${n > 1 ? `, and ${n - 1} more` : ""})`;
  }
  const msg = errorText(e);
  return msg.includes("\n") ? msg.split("\n")[0] : msg;
}

/**
 * One finding per (server outName, NAME) across the targets that write MCP (§4.2, spec 27 §4.3). Each
 * target's own surviving server is read (last-wins per target, as its emitter writes it), so two targets
 * writing the same name from different ingredients are both checked. Names are the union of the
 * ingredient's `authEnv` and every `${NAME}` in a string value of its server's `env`.
 *
 * At schema 4, the server is rendered first, so a `${NAME}` a value brings into `env` is checked (spec 34 §4.4).
 */
function mcpUnset(p: Plan, env: NodeJS.ProcessEnv, schema: 1 | 2 | 3 | 4 | 5): Array<{ server: string; name: string }> {
  const servers: Array<[string, unknown, string[] | undefined]> = [];
  for (const target of p.resolution.targets) {
    // `written()` yields only what the matrix says this target writes; the skip warnings were plan()'s.
    const walk = written(p.resolution, target, () => {});
    const perTarget = new Map<string, { server: unknown; authEnv: string[] | undefined }>();
    for (const ing of walk) {
      if (ing.meta.type !== "mcp") continue;
      // At schema 4, render the server (spec 34 §4.4); below 4, read as written.
      const serverDef = rendersServers({ schema })
        ? renderServer(ing.meta, paramsFor(ing, p.resolution)).server
        : ing.meta.server;
      perTarget.set(outName(ing.meta), { server: serverDef, authEnv: ing.meta.authEnv });
    }
    for (const [name, { server, authEnv }] of perTarget) servers.push([name, server, authEnv]);
  }
  const out: Array<{ server: string; name: string }> = [];
  const seen = new Set<string>();
  for (const [server, def, authEnv] of servers) {
    // Collect from authEnv first (spec 27 §4.3: union of authEnv and ${NAME} references).
    if (authEnv) {
      for (const name of authEnv) {
        const key = `${server}\u0000${name}`;
        if (seen.has(key) || env[name] !== undefined) continue;
        seen.add(key);
        out.push({ server, name });
      }
    }
    // Then from ${NAME} references in env string values.
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

const SERVICES_ENV_FIX = "export NAME, or add it to .env";

/**
 * Pattern for `${NAME}` with no default: `${NAME}` and `${NAME?msg}` / `${NAME:?msg}` are "no default";
 * `${NAME:-...}`, `${NAME-...}`, `${NAME:+...}`, `${NAME+...}` have defaults and are not reported.
 * Unbraced `$NAME` is not read. `$${NAME}` (escaped) is not a reference.
 * Built from ENV_NAME so the pattern is never spelled twice.
 */
const SERVICES_ENV_REF = new RegExp(
  // Negative lookbehind for $$ (escape), then ${NAME} or ${NAME?...} or ${NAME:?...}
  "(?<!\\$)\\$\\{(" + ENV_NAME + ")(?::\\?[^}]*|\\?[^}]*)?\\}",
  "g",
);

/**
 * `docker` and `services-env` checks (spec 31 §4.7): present only when the plan or the lock has a service.
 * When the plan is available, both checks are present; when only the lock indicates services, only `docker`
 * is reported (services-env needs the planned fragments).
 */
async function dockerAndServicesEnv(
  root: string,
  p: Plan | null,
  lock: Lock | null,
  runner: DockerRunner,
  w: (id: string, level: CheckLevel, message: string, fix?: string | null) => void,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // "Has a service" = the plan holds a file with target === "services", or — when the plan failed — the lock does.
  const planHasService = p !== null && p.files.some((f) => f.target === "services");
  const all = lock?.files ?? [];
  const lockHasService = all.some((f) => f.target === "services");
  if (!planHasService && !lockHasService) return;

  // docker check
  const d = await dockerVersion(runner);
  const finding = dockerFinding(d, true);
  if (finding === null) {
    w("docker", "ok", `Docker Compose ${d.compose}`);
  } else {
    w("docker", "warn", finding.message, finding.fix);
  }

  // services-env check: only when the plan is available (it has the rendered fragments)
  if (p === null) return;
  const unset = await servicesEnvUnset(root, p, env);
  if (unset.length === 0) {
    w("services-env", "ok", "every variable a service fragment expects is set");
  } else {
    for (const { filePath, name } of unset) {
      w("services-env", "warn", `service fragment ${filePath} expects ${name}, not set`, SERVICES_ENV_FIX.replace("NAME", name));
    }
  }
}

/**
 * Find unset environment variables in service fragments (spec 31 §4.7).
 * Reads `${NAME}` and `${NAME?msg}` / `${NAME:?msg}` forms with no `:-`/`-` default,
 * minus `CRAFTAR_WORKSPACE` (set by `up`), minus names set in the environment,
 * minus keys of `<root>/.env` (`NAME=` at line start; nothing after `=` is read).
 */
async function servicesEnvUnset(root: string, p: Plan, env: NodeJS.ProcessEnv): Promise<Array<{ filePath: string; name: string }>> {
  // Read .env key names (NAME= at line start, value ignored) — pattern built from ENV_NAME
  const dotEnvKeys = new Set<string>();
  const dotEnvKeyPattern = new RegExp("^(" + ENV_NAME + ")=");
  try {
    const dotEnv = await fs.readFile(path.join(root, ".env"), "utf8");
    for (const line of dotEnv.split(/\r?\n/)) {
      const m = dotEnvKeyPattern.exec(line);
      if (m) dotEnvKeys.add(m[1]);
    }
  } catch {
    // .env does not exist or is not readable: no keys excluded
  }

  const out: Array<{ filePath: string; name: string }> = [];
  const seen = new Set<string>();

  // Only scan the planned fragments — each ${NAME} in an init script is a shell variable, not Compose's
  // (spec 31 §4.7: "each ${NAME} a planned fragment uses")
  const stackFile = p.files.find((f) => f.path === ".craftar/compose.yaml");
  const fragments = stackFile ? new Set(fragmentPaths(stackFile.content.toString("utf8"))) : new Set<string>();

  for (const f of p.files) {
    if (f.target !== "services") continue;
    // Only the stack's fragments — init scripts' ${NAME} are shell variables
    if (!fragments.has(f.path)) continue;
    const text = f.content.toString("utf8");
    for (const match of text.matchAll(SERVICES_ENV_REF)) {
      const name = match[1];
      // Skip if already reported, set in environment, in .env, or is CRAFTAR_WORKSPACE
      const key = `${f.path}\u0000${name}`;
      if (seen.has(key)) continue;
      if (name === "CRAFTAR_WORKSPACE") continue;
      if (env[name] !== undefined) continue;
      if (dotEnvKeys.has(name)) continue;
      seen.add(key);
      out.push({ filePath: f.path, name });
    }
  }
  return out;
}

/** The checks about one workspace, for a reader that must not see the rest of the machine (spec 35 §4.5). */
export function workspaceReport(report: DoctorReport): DoctorReport {
  // By scope, so a check added later is kept or dropped by what it is about; `node` and `git` name no path.
  const checks = report.checks.filter((c) => c.scope === "workspace" || c.id === "node" || c.id === "git");
  const summary: Record<CheckLevel, number> = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.level]++;
  return { version: report.version, workspace: report.workspace, fetch: report.fetch, strict: report.strict, checks, summary };
}
