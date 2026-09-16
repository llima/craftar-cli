import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge, exists, type Forge } from "./forge.js";
import { resolve, substitute, type Resolution, type ResolvedIngredient } from "./resolve.js";
import { hashNormalized, stripBom, toLf } from "./text.js";
import { LockSchema, WorkspaceConfigSchema, type Lock, type LockEntry, type Target, type WorkspaceConfig } from "../schema/index.js";
import { claudeCode } from "../emitters/claude-code.js";
import { kiro } from "../emitters/kiro.js";
import { agentsMd } from "../emitters/agents-md.js";
import type { Emitter, PlannedFile } from "../emitters/types.js";

export const WORKSPACE_FILE = "craftar.yaml";
export const LOCAL_FILE = "craftar.local.yaml";
export const LOCK_FILE = "craftar.lock";

const EMITTERS: Record<Target, Emitter> = { "claude-code": claudeCode, kiro, "agents-md": agentsMd };

export interface Workspace {
  root: string;
  config: WorkspaceConfig;
  forge: Forge;
}

export async function loadWorkspace(root: string): Promise<Workspace> {
  root = path.resolve(root);
  const file = path.join(root, WORKSPACE_FILE);
  if (!(await exists(file)))
    throw new Error(
      `${WORKSPACE_FILE} not found in ${root} — run \`craftar import --workspace "${root}" --from claude-code --forge <dir> --profile <name> --write-config\` to create it`,
    );
  const base = YAML.parse(await fs.readFile(file, "utf8")) ?? {};
  const localFile = path.join(root, LOCAL_FILE);
  const local = (await exists(localFile)) ? YAML.parse(await fs.readFile(localFile, "utf8")) ?? {} : {};
  const config = WorkspaceConfigSchema.parse(deepMerge(base, local));
  const forgeRoot = /^[a-z]+:\/\/|^git@/.test(config.forge) ? config.forge : path.resolve(root, config.forge);
  if (!(await exists(forgeRoot))) throw new Error(`Forge not found at ${forgeRoot} (remote Forges are not supported yet — clone it and point \`forge:\` at the path)`);
  return { root, config, forge: await loadForge(forgeRoot) };
}

/**
 * The Forge a `forge` command operates on (spec 04 §4.3). `--forge` names it directly;
 * otherwise the workspace's craftar.yaml does. Both at once is ambiguous, so it fails.
 */
export async function resolveForge(opts: { forge?: string; workspace?: string }): Promise<Forge> {
  if (opts.forge && opts.workspace) {
    throw new Error("pass either --forge or --workspace, not both — two sources for one Forge");
  }
  if (opts.forge) return loadForge(path.resolve(opts.forge));
  const root = path.resolve(opts.workspace ?? ".");
  if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
    throw new Error(
      `no ${WORKSPACE_FILE} in ${root} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`,
    );
  }
  return (await loadWorkspace(root)).forge;
}

/** Layer merge: objects merge key by key; arrays and scalars from the stronger layer replace the weaker one. */
function deepMerge(a: any, b: any): any {
  if (b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b)) return b;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    return out;
  }
  return b;
}

export interface Plan {
  resolution: Resolution;
  files: PlannedFile[];
  warnings: string[];
}

export async function plan(ws: Workspace): Promise<Plan> {
  const resolution = resolve(ws.forge, ws.config);
  const warnings = [...resolution.warnings];
  if (resolution.targets.length === 0) {
    warnings.push(
      "no targets resolved — nothing will be emitted and every file in craftar.lock becomes an orphan (an empty list in craftar.local.yaml replaces the workspace's)",
    );
  }
  /** Unresolved placeholder → refs of the ingredients citing it. */
  const missingParams = new Map<string, Set<string>>();
  const ctx = {
    forge: ws.forge,
    resolution,
    workspaceRoot: ws.root,
    async readExisting(rel: string) {
      try {
        return await fs.readFile(path.join(ws.root, rel));
      } catch {
        return null;
      }
    },
    async text(ing: ResolvedIngredient, file: string) {
      const raw = await fs.readFile(path.join(ing.dir, file), "utf8");
      const missing = new Set<string>();
      const out = substitute(toLf(stripBom(raw)), resolution.params, missing);
      for (const key of missing) missingParams.set(key, (missingParams.get(key) ?? new Set<string>()).add(ing.ref));
      return out;
    },
    bytes(ing: ResolvedIngredient, file: string) {
      return fs.readFile(path.join(ing.dir, file));
    },
    warn(msg: string) {
      warnings.push(msg);
    },
  };
  const files: PlannedFile[] = [];
  for (const t of resolution.targets) {
    const em = EMITTERS[t];
    if (!em) {
      warnings.push(`target "${t}" has no emitter yet`);
      continue;
    }
    files.push(...(await em.emit(ctx)));
  }
  for (const [key, refs] of [...missingParams].sort(([a], [b]) => a.localeCompare(b))) {
    warnings.push(`param "${key}" has no value in any layer — left verbatim (${[...refs].sort().join(", ")})`);
  }
  // Duplicate path guard
  const seen = new Map<string, string>();
  for (const f of files) {
    const prev = seen.get(f.path);
    if (prev) warnings.push(`two ingredients write ${f.path}: ${prev} and ${f.ingredient} (last wins)`);
    seen.set(f.path, f.ingredient);
  }
  return { resolution, files: dedupeLastWins(files), warnings };
}

function dedupeLastWins(files: PlannedFile[]): PlannedFile[] {
  const m = new Map<string, PlannedFile>();
  for (const f of files) m.set(f.path, f);
  return [...m.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ */
/* Lock                                                                 */
/* ------------------------------------------------------------------ */

export async function readLock(root: string): Promise<Lock | null> {
  const f = path.join(root, LOCK_FILE);
  if (!(await exists(f))) return null;
  return LockSchema.parse(JSON.parse(await fs.readFile(f, "utf8")));
}

export async function writeLock(root: string, lock: Lock): Promise<void> {
  await fs.writeFile(path.join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n", "utf8");
}

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

export type FileState =
  | "unchanged" // on disk == plan == lock
  | "new" // not on disk
  | "update" // on disk == lock, plan differs
  | "drift" // on disk != lock (hand-edited) — never overwritten silently
  | "adopt" // on disk, not in lock, content == plan → becomes managed
  | "collision" // on disk, not in lock, content != plan → user file, skipped
  | "orphan" // in lock, not in plan → to be removed
  | "orphan-drift"; // in lock, not in plan, but hand-edited → kept, reported

export interface FileStatus {
  path: string;
  state: FileState;
  target?: Target;
  ingredient?: string;
  planned?: PlannedFile;
  lock?: LockEntry;
}

export async function status(ws: Workspace, p: Plan, lock: Lock | null): Promise<FileStatus[]> {
  const out: FileStatus[] = [];
  const lockByPath = new Map((lock?.files ?? []).map((e) => [e.path, e]));
  for (const f of p.files) {
    const disk = await readDisk(ws.root, f.path);
    const entry = lockByPath.get(f.path);
    const planHash = hashNormalized(f.content);
    let state: FileState;
    if (disk === null) state = "new";
    else if (entry) {
      const diskHash = hashNormalized(disk);
      if (diskHash !== entry.hash) state = diskHash === planHash ? "unchanged" : "drift";
      else state = diskHash === planHash ? "unchanged" : "update";
    } else state = hashNormalized(disk) === planHash || sameJson(f.path, disk, f.content) ? "adopt" : "collision";
    out.push({ path: f.path, state, target: f.target, ingredient: f.ingredient, planned: f, lock: entry });
  }
  const planned = new Set(p.files.map((f) => f.path));
  for (const e of lock?.files ?? []) {
    if (planned.has(e.path)) continue;
    const disk = await readDisk(ws.root, e.path);
    if (disk === null) continue; // already gone
    out.push({ path: e.path, state: hashNormalized(disk) === e.hash ? "orphan" : "orphan-drift", target: e.target, ingredient: e.ingredient, lock: e });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Formatting-insensitive equality for JSON files (e.g. a hand-formatted .mcp.json). */
function sameJson(rel: string, a: Buffer, b: Buffer): boolean {
  if (!rel.endsWith(".json")) return false;
  try {
    return JSON.stringify(JSON.parse(stripBom(a.toString("utf8")))) === JSON.stringify(JSON.parse(stripBom(b.toString("utf8"))));
  } catch {
    return false;
  }
}

async function readDisk(root: string, rel: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(root, rel));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Apply                                                                */
/* ------------------------------------------------------------------ */

export interface ApplyOptions {
  overwriteDrift?: boolean;
  dryRun?: boolean;
}

export interface ApplyResult {
  written: string[];
  removed: string[];
  skipped: FileStatus[];
  lock: Lock;
}

export async function apply(ws: Workspace, p: Plan, statuses: FileStatus[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: FileStatus[] = [];
  const entries: LockEntry[] = [];

  for (const s of statuses) {
    switch (s.state) {
      case "new":
      case "update":
      case "adopt":
        if (!opts.dryRun) await writeFile(ws.root, s.planned!);
        written.push(s.path);
        entries.push(entry(s.planned!));
        break;
      case "unchanged":
        entries.push(entry(s.planned!));
        break;
      case "drift":
        if (opts.overwriteDrift) {
          if (!opts.dryRun) await writeFile(ws.root, s.planned!);
          written.push(s.path);
          entries.push(entry(s.planned!));
        } else {
          skipped.push(s);
          entries.push(s.lock!); // keep the old hash so the drift stays visible
        }
        break;
      case "collision":
        skipped.push(s);
        break;
      case "orphan":
        if (!opts.dryRun) await fs.rm(path.join(ws.root, s.path), { force: true });
        removed.push(s.path);
        break;
      case "orphan-drift":
        skipped.push(s);
        break;
    }
  }

  const lock: Lock = {
    schema: 1,
    forge: { source: ws.config.forge, commit: ws.forge.commit },
    profile: ws.config.profile,
    generatedAt: new Date().toISOString(),
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (!opts.dryRun) await writeLock(ws.root, lock);
  return { written, removed, skipped, lock };
}

function entry(f: PlannedFile): LockEntry {
  return { path: f.path, hash: hashNormalized(f.content), target: f.target, ingredient: f.ingredient };
}

async function writeFile(root: string, f: PlannedFile): Promise<void> {
  const abs = path.join(root, f.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, f.content);
}
