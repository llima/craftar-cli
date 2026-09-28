import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge, exists, listFiles, FORGE_MANIFEST, type Forge } from "./forge.js";
import { resolve, substitute, type Resolution, type ResolvedIngredient, paramsFor, sectionKey, sectionsFor } from "./resolve.js";
import { hashNormalized, stripBom, toLf } from "./text.js";
import { deepMerge } from "./merge.js";
import { canonicalValue, checkDeclaredOnce, expandSections, firstMarkerLine, markerLine, parseSections, type ParsedSections } from "./sections.js";
import { placeholders, substitutedFile } from "./extract.js";
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
  const hasLocal = await exists(localFile);
  const local = hasLocal ? YAML.parse(await fs.readFile(localFile, "utf8")) ?? {} : {};
  const parsed = WorkspaceConfigSchema.safeParse(deepMerge(base, local));
  // Named, as a Forge file is: a wrong-shape `overrides.sections` key fails here (spec 11 §5.2).
  if (!parsed.success) throw new Error(`invalid ${WORKSPACE_FILE}${hasLocal ? ` (merged with ${LOCAL_FILE})` : ""}: ${parsed.error.message}`);
  const config = parsed.data;
  const forgeRoot = /^[a-z]+:\/\/|^git@/.test(config.forge) ? config.forge : path.resolve(root, config.forge);
  if (!(await exists(forgeRoot))) throw new Error(`Forge not found at ${forgeRoot} (remote Forges are not supported yet — clone it and point \`forge:\` at the path)`);
  return { root, config, forge: await loadForge(forgeRoot) };
}

/**
 * The Forge a `forge` command operates on (spec 04 §4.3). `--forge` names it directly;
 * otherwise the workspace's craftar.yaml does. Both at once is ambiguous, so it fails.
 */
export async function resolveForge(opts: { forge?: string; workspace?: string }): Promise<Forge> {
  if (opts.forge !== undefined && opts.workspace !== undefined) {
    throw new Error("pass either --forge or --workspace, not both — two sources for one Forge");
  }
  if (opts.forge !== undefined) return loadForge(path.resolve(opts.forge));
  const root = path.resolve(opts.workspace ?? ".");
  if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
    throw new Error(
      `no ${WORKSPACE_FILE} in ${root} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`,
    );
  }
  return (await loadWorkspace(root)).forge;
}

export type SectionLayer = "default" | "profile" | "workspace";

export interface Plan {
  resolution: Resolution;
  files: PlannedFile[];
  warnings: string[];
  /** Per ingredient ref, each section it declares, with the layer that filled it (spec 11 §5.3, for `explain`). */
  sections: Map<string, Array<{ file: string; name: string; layer: SectionLayer }>>;
}

/** A path as the Forge names it: relative to its root, POSIX separators. */
function forgeRel(forge: Forge, abs: string): string {
  return path.relative(forge.root, abs).split(path.sep).join("/");
}

/** `profile <p>` or `the workspace`: the strongest layer that sets section `name` of `key` (Ruling 15). */
function layerOf(resolution: Resolution, key: string, name: string): SectionLayer {
  const has = (m: Record<string, Record<string, string>>) => Object.hasOwn(m, key) && Object.hasOwn(m[key], name);
  if (has(resolution.sectionLayers.workspace)) return "workspace";
  if (has(resolution.sectionLayers.profile)) return "profile";
  return "default";
}

function layerLabel(resolution: Resolution, layer: SectionLayer): string {
  return layer === "workspace" ? "the workspace" : `profile ${resolution.profile.name}`;
}

/**
 * The section pass of `plan()` (spec 11 §6.6 steps 1–5): parse every admitted file of every resolved
 * ingredient (a malformed marker throws, whichever targets resolve), warn on marker lines in files
 * not every target renders, fail a `schema: 1` Forge that holds a marker (Ruling 7/21), and warn on
 * section values that apply to nothing.
 */
async function sectionPass(forge: Forge, resolution: Resolution, warnings: string[]) {
  const parsed = new Map<string, ParsedSections>(); // abs path → parse
  const declared = new Map<string, Set<string>>(); // section key → names declared by resolved ingredients
  const byRef: Plan["sections"] = new Map();
  let firstMarker: string | null = null;
  for (const ing of resolution.ingredients) {
    const key = sectionKey(ing.meta);
    const names = declared.get(key) ?? new Set<string>();
    declared.set(key, names);
    if (ing.meta.type === "mcp") continue; // no file, so no marker: a value keyed mcp/<name> is warned below
    const files: Array<{ rel: string; p: ParsedSections }> = [];
    for (const rel of await listFiles(ing.dir)) {
      if (rel === "ingredient.yaml") continue;
      const abs = path.join(ing.dir, rel);
      if (substitutedFile(ing.meta, rel)) {
        const p = parseSections(await fs.readFile(abs, "utf8"), forgeRel(forge, abs), ing.ref);
        parsed.set(abs, p);
        files.push({ rel, p });
        if (p.sections.length && firstMarker === null) firstMarker = `${p.file}:${p.sections[0].line}`;
      } else {
        // Any other file is copied as bytes; a marker line in it, whatever its extension, is warned, never dropped silently.
        const text = toLf(stripBom(await fs.readFile(abs, "utf8")));
        if (text.split("\n").some((l) => markerLine(l) !== null)) {
          warnings.push(`${ing.ref} ${rel}: section markers are read only in files every target renders as text — copied with them`);
        }
      }
    }
    checkDeclaredOnce(ing.ref, files.map((f) => f.p));
    const list: Array<{ file: string; name: string; layer: SectionLayer }> = [];
    for (const { rel, p } of files) {
      for (const s of p.sections) {
        names.add(s.name);
        list.push({ file: rel, name: s.name, layer: layerOf(resolution, key, s.name) });
      }
    }
    if (list.length) byRef.set(ing.ref, list);
  }

  // The schema gate (Ruling 7, §6.14): only the bodies this workspace resolves, after every parse error.
  if (firstMarker !== null && forge.manifest.schema === 1) {
    throw new Error(
      `${FORGE_MANIFEST} declares schema: 1, but ${firstMarker} holds a section marker — set schema: 2 in ${FORGE_MANIFEST}, ` +
        `so that craftar 0.6.2 and older refuse this Forge instead of emitting the markers`,
    );
  }

  // Values that apply to nothing (Ruling 12): an unknown key always; an unknown name only on a resolved key.
  const forgeKeys = new Set([...forge.ingredients.values()].map((i) => sectionKey(i.meta)));
  const said = new Set<string>();
  const say = (w: string) => {
    if (!said.has(w)) warnings.push(w);
    said.add(w);
  };
  for (const [key, values] of Object.entries(resolution.sections)) {
    for (const name of Object.keys(values)) {
      const layer = layerLabel(resolution, layerOf(resolution, key, name));
      if (!forgeKeys.has(key)) say(`section key ${key} in ${layer} names no ingredient in the Forge`);
      else if (declared.has(key) && !declared.get(key)!.has(name)) say(`${layer} sets section ${name} of ${key}, which has no such marker`);
    }
  }
  return { parsed, byRef };
}

/**
 * The output guard (spec 11 §6.6 step 6, Ruling 19): a rendered admitted file never holds a marker
 * line. When one does, it came from a value; name the first value that carries one.
 */
function guardOutput(ing: ResolvedIngredient, file: string, out: string, p: ParsedSections, resolution: Resolution, params: Record<string, unknown>): void {
  const line = firstMarkerLine(out);
  if (line === null) return;
  const key = sectionKey(ing.meta);
  const values = sectionsFor(ing, resolution);
  let from = "a section or param value";
  const section = p.sections.find((s) => Object.hasOwn(values, s.name) && firstMarkerLine(substitute(canonicalValue(values[s.name]), params)) !== null);
  if (section) from = `${layerLabel(resolution, layerOf(resolution, key, section.name))}, section ${section.name}`;
  else {
    const k = placeholders(expandSections(p, values)).find((x) => Object.hasOwn(params, x) && /<!--[ \t]*\/?[ \t]*craftar:section/.test(String(params[x])));
    if (k !== undefined) from = `param ${k}`;
  }
  throw new Error(`${ing.ref} ${file}: the rendered text holds a section marker on line ${line} (from ${from}) — a value cannot open or close a section`);
}

export async function plan(ws: Workspace): Promise<Plan> {
  const resolution = resolve(ws.forge, ws.config);
  const warnings = [...resolution.warnings];
  if (resolution.targets.length === 0) {
    warnings.push(
      "no targets resolved — nothing will be emitted and every file in craftar.lock becomes an orphan (an empty list in craftar.local.yaml replaces the workspace's)",
    );
  }
  const sections = await sectionPass(ws.forge, resolution, warnings);
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
      const abs = path.join(ing.dir, file);
      const raw = await fs.readFile(abs, "utf8");
      const missing = new Set<string>();
      const params = paramsFor(ing, resolution);
      // Sections first, then params (spec 11 §6.4), in admitted files only (§6.5).
      const parsed = substitutedFile(ing.meta, file) ? sections.parsed.get(abs) : null;
      // Every admitted file of a resolved ingredient was parsed and gated in the section pass; a miss here would skip the schema gate.
      if (parsed === undefined) throw new Error(`internal: ${forgeRel(ws.forge, abs)} was not parsed by the section pass`);
      const expanded = parsed ? expandSections(parsed, sectionsFor(ing, resolution)) : toLf(stripBom(raw));
      const out = substitute(expanded, params, missing);
      if (parsed) guardOutput(ing, file, out, parsed, resolution, params);
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
  return { resolution, files: dedupeLastWins(files), warnings, sections: sections.byRef };
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
        entries.push(s.lock!); // keep the old entry so the hand-edited orphan stays visible until deleted
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
