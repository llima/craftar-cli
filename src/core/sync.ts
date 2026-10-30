import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { loadForge, exists, listFiles, FORGE_MANIFEST, type Forge } from "./forge.js";
import { resolve, substitute, type ParamLayer, type Resolution, type ResolvedIngredient, paramLayer, paramsFor, sectionKey, sectionsFor } from "./resolve.js";
import { climbsOut, hashNormalized, isUtf8, legacyHash, stripBom, toLf } from "./text.js";
import { parseWorkspaceYaml } from "./workspace-yaml.js";
import { classifyForge, credentialFault, ensureTree, refHoldsCredentials, shownRef, ForgeFetchError, NoCachedCopyError, type CachedTree, type GitRunner } from "./remote.js";
import { resolveHome } from "./home-lock.js";
import { deepMerge } from "./merge.js";
import { canonicalValue, checkDeclaredOnce, expandSections, firstMarkerLine, markerLine, parseSections, projectSections, readsTargetSections, type ParsedSections } from "./sections.js";
import { placeholders, bodyFile, emittedFile } from "./extract.js";
import { LOCK_SCHEMAS, LockSchema, WorkspaceConfigSchema, type Lock, type LockEntry, type LockEntryV3, type LockV2, type LockV3, type Owner, type Target, type WorkspaceConfig } from "../schema/index.js";
import { SchemaError, shownSchema } from "./schema-fault.js";
import { claudeCode } from "../emitters/claude-code.js";
import { kiro } from "../emitters/kiro.js";
import { AGENTS_MD_BUDGET_KEY, agentsMd } from "../emitters/agents-md.js";
import type { EmitBase, Emitter, PlannedFile } from "../emitters/types.js";
import { CAPABILITIES, written } from "./capabilities.js";
import { planServices } from "./services.js";
import { INTEGRATIONS_PREFIX, readsIntegrations } from "./integrations.js";
import { appliesTo, effectiveTargets } from "../emitters/shared.js";
import { readsRulesIndex, RULES_INDEX_KEY, belowGateLiteralWarning, ignoredValueWarning } from "./rules-index.js";

export const WORKSPACE_FILE = "craftar.yaml";
export const LOCAL_FILE = "craftar.local.yaml";
export const LOCK_FILE = "craftar.lock";

export { AGENTS_MD_BUDGET_KEY };
/** The default AGENTS.md size budget in bytes. */
export const AGENTS_MD_DEFAULT_MAX_BYTES = 32768;

// Mapped, not Record<Target, Emitter>: an emitter in another target's slot does not compile (spec 18 §3.3).
const EMITTERS: { [T in Target]: Emitter<T> } = { "claude-code": claudeCode, kiro, "agents-md": agentsMd };

/**
 * Runs one target's emitter on the walk of what the matrix says it writes. The walk warns about the
 * rest, so an emitter that returns before finishing it would lose warnings: that fails the plan.
 */
export async function emitFor<T extends Target>(t: T, emitter: Emitter<T>, base: EmitBase): Promise<PlannedFile[]> {
  const aimed = written(base.resolution, t, base.warn);
  const files = await emitter.emit({ ...base, aimed });
  if (!aimed.finished) throw new Error(`internal: the ${t} emitter returned before walking every ingredient aimed at it`);
  return files;
}

/** Where the Forge came from (spec 13 §5.3), for headers and `status --json`. Always set. */
export interface ForgeOrigin {
  kind: "path" | "remote";
  /** `forge:` as written (after the local merge). */
  source: string;
  /** The requested ref; null when none was given or the Forge is a path. */
  ref: string | null;
  /** The resolved branch when `ref` is null and the Forge is remote, else null. */
  defaultBranch: string | null;
  /** True only when this command fetched. */
  fetched: boolean;
  /** When the cached copy was last fetched (remote only). */
  fetchedAt?: string;
  /** `forge:` came from craftar.local.yaml. */
  fromLocalFile: boolean;
}

export interface Workspace {
  root: string;
  config: WorkspaceConfig;
  forge: Forge;
  origin: ForgeOrigin;
  /** Warnings from loading the workspace itself (spec 13 §4.2); `plan()` puts them first. */
  warnings: string[];
}

/**
 * How a command treats the network for a remote Forge (spec 13 §4.1, Ruling 6): `sync` fails when the
 * fetch fails; `read` warns and uses the cached copy; `no-fetch` never fetches (`targets`, spec 16 §7).
 */
export type FetchMode = "sync" | "read" | "no-fetch";

export interface LoadOptions {
  mode?: FetchMode;
  /** `--offline`: the cached copy, on purpose. No effect on a path Forge. */
  offline?: boolean;
  /** `$CRAFTAR_HOME`; defaults to `~/.craftar`. */
  home?: string;
  /** Refuse a remote Forge with this message before anything is fetched (`forge unify`, spec 13 §4.4). */
  refuseRemote?: (url: string) => string;
  /** Test seam: counts or fails the git calls of a remote load; absent, `defaultGit`. */
  git?: GitRunner;
  /**
   * When a sync-mode fetch fails and there is a cached copy, what the error's tail says (spec 37 §5.2):
   * - `"offline"` (default): "run with --offline to use the cached copy"
   * - `"fresh-copy"`: "repos clone reads the profile's repositories only from a fresh copy"
   * - `"mcp"`: "craftar mcp syncs a remote Forge only from a fresh fetch — run craftar sync --offline in a terminal to use the cached copy"
   */
  fetchHint?: "offline" | "fresh-copy" | "mcp";
}

/** The result of loading a Forge by its source before a profile is known (spec 28 §5.2). */
export interface LoadedForge {
  forge: Forge;
  origin: ForgeOrigin;
  /** Warnings of the load itself: the path Forge's ignored ref, the --offline / fetch-failure line. */
  warnings: string[];
}


/** A workspace's configuration, merged and validated, before its Forge is loaded (spec 24 §5.1). */
export interface MergedConfig {
  config: WorkspaceConfig;
  /** `forge:` came from craftar.local.yaml. */
  fromLocalFile: boolean;
  /** Warnings of the merge itself (a local `forge:` override). */
  warnings: string[];
  /** The parsed base document exactly as `mergeWorkspaceConfig` received it (`{}` when empty). */
  base: unknown;
  /** The parsed local document exactly as `mergeWorkspaceConfig` received it (`null` when no file, `{}` when empty). */
  local: unknown | null;
}

export async function loadWorkspace(root: string, opts: LoadOptions = {}): Promise<Workspace> {
  root = path.resolve(root);
  return loadForgeFor(root, await readWorkspaceConfig(root), opts);
}

/**
 * The two workspace files read and merged, the Forge not loaded (spec 24 §5.1): what `doctor` needs to
 * know a Forge's kind and cache key even when the Forge does not load. The one reader of the files.
 */
export async function readWorkspaceConfig(root: string): Promise<MergedConfig> {
  root = path.resolve(root);
  const file = path.join(root, WORKSPACE_FILE);
  if (!(await exists(file)))
    throw new Error(
      `${WORKSPACE_FILE} not found in ${root} — run \`craftar init --workspace "${root}" --forge <dir> --profile <name>\` to start one, or \`craftar import --workspace "${root}" --from claude-code --forge <dir> --profile <name> --write-config\` to bring in an existing harness`,
    );
  const base = parseWorkspaceYaml(WORKSPACE_FILE, await fs.readFile(file, "utf8")) ?? {};
  const localFile = path.join(root, LOCAL_FILE);
  const local = (await exists(localFile)) ? parseWorkspaceYaml(LOCAL_FILE, await fs.readFile(localFile, "utf8")) ?? {} : null;
  return mergeWorkspaceConfig(base, local);
}

/**
 * Everything `loadWorkspace` does after reading the two files (spec 23 §5.2): the credential check,
 * the merge, the schema, the Forge load and the warnings — for a configuration held in memory
 * (`craftar init`). `local` is null when there is no `craftar.local.yaml`.
 */
export async function loadWorkspaceConfig(root: string, base: unknown, localDoc: unknown | null, opts: LoadOptions = {}): Promise<Workspace> {
  return loadForgeFor(path.resolve(root), mergeWorkspaceConfig(base, localDoc), opts);
}

/**
 * The credential check, the merge and the schema (spec 24 §5.1). `localDoc` is null when there is no
 * `craftar.local.yaml` (`{}` when it exists but is empty), so the schema error names the local file
 * exactly when it exists.
 */
export function mergeWorkspaceConfig(base: unknown, localDoc: unknown | null): MergedConfig {
  const hasLocal = localDoc !== null;
  const local = localDoc ?? {};
  // Before anything can print the value: a credential in either file is refused by file and field (spec 13 §4.3).
  for (const [name, raw] of [[WORKSPACE_FILE, base], [LOCAL_FILE, local]] as const) {
    const value: unknown = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).forge : undefined;
    if (typeof value === "string" && credentialFault(value))
      throw new Error(`${name} › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)`);
  }
  const fromLocalFile = local !== null && typeof local === "object" && Object.hasOwn(local, "forge");
  const parsed = WorkspaceConfigSchema.safeParse(deepMerge(base, local));
  // Named, as a Forge file is: a wrong-shape `overrides.sections` key fails here (spec 11 §5.2).
  if (!parsed.success) throw new SchemaError(`invalid ${WORKSPACE_FILE}${hasLocal ? ` (merged with ${LOCAL_FILE})` : ""}`, parsed.error);
  const config = parsed.data;
  const warnings: string[] = [];
  if (fromLocalFile) warnings.push(`Forge overridden by ${LOCAL_FILE} (${config.forge}) — do not commit ${LOCK_FILE} or the generated files`);
  return { config, fromLocalFile, warnings, base: base ?? {}, local: localDoc };
}

/** The Forge of a merged configuration — from its path, or from the cache for a URL (spec 24 §5.1). */
export async function loadForgeFor(root: string, merged: MergedConfig, opts: LoadOptions = {}): Promise<Workspace> {
  root = path.resolve(root);
  const { config, fromLocalFile } = merged;
  const loaded = await loadForgeSource(root, config.forge, config.ref ?? null, { ...opts, fromLocalFile });
  return workspaceOf(root, merged, loaded);
}

/**
 * Builds a Workspace from an already-loaded Forge (spec 28 §5.2): the order of `Workspace.warnings`
 * is path → `[...loaded.warnings, ...merged.warnings]`, remote → `[...merged.warnings, ...loaded.warnings]`.
 */
export function workspaceOf(root: string, merged: MergedConfig, loaded: LoadedForge): Workspace {
  const warnings: string[] =
    loaded.origin.kind === "path"
      ? [...loaded.warnings, ...merged.warnings]
      : [...merged.warnings, ...loaded.warnings];
  return { root, config: merged.config, forge: loaded.forge, origin: loaded.origin, warnings };
}

/** `source` is the value `craftar.yaml › forge` holds: a URL, or a path relative to `root`. */
export async function loadForgeSource(
  root: string,
  source: string,
  ref: string | null,
  opts: LoadOptions & { fromLocalFile?: boolean } = {},
): Promise<LoadedForge> {
  root = path.resolve(root);
  const fromLocalFile = opts.fromLocalFile ?? false;
  const warnings: string[] = [];
  if (classifyForge(source) === "url") {
    if (opts.refuseRemote) throw new Error(opts.refuseRemote(source));
    const { tree, origin, warning } = await remoteTree(source, ref, opts, fromLocalFile);
    if (warning) warnings.push(warning);
    return { forge: await loadForge(tree), origin, warnings };
  }
  const forgeRoot = path.resolve(root, source);
  if (!(await exists(forgeRoot))) throw new Error(`Forge not found at ${forgeRoot}`);
  // A path means the working tree as it is; a ref beside it is ignored, said out loud (Ruling 9).
  if (ref !== null) warnings.push(`${shownRef(ref)} is ignored: the Forge is a path (${source}), read as its working tree`);
  const origin: ForgeOrigin = { kind: "path", source, ref: null, defaultBranch: null, fetched: false, fromLocalFile };
  return { forge: await loadForge(forgeRoot), origin, warnings };
}

const short = (sha: string) => sha.slice(0, 8);

/** Fetch (or not) by the rule of `opts.mode`, and say what was used (spec 13 §4.1, §4.8). */
async function remoteTree(
  url: string,
  ref: string | null,
  opts: LoadOptions,
  fromLocalFile: boolean,
): Promise<{ tree: string; origin: ForgeOrigin; warning: string | null }> {
  const home = resolveHome(opts.home);
  const mode = opts.mode ?? "read";
  const offline = opts.offline || mode === "no-fetch";
  const git = opts.git;
  const fetchHint = opts.fetchHint ?? "offline";
  const origin = (t: CachedTree): ForgeOrigin => ({
    kind: "remote",
    source: url,
    ref,
    defaultBranch: t.defaultBranch,
    fetched: t.fetched,
    ...(t.fetchedAt ? { fetchedAt: t.fetchedAt } : {}),
    fromLocalFile,
  });
  const used = (t: CachedTree) => `the cached copy at ${short(t.commit)}, fetched ${t.fetchedAt ?? "never"}`;
  if (offline) {
    let t: CachedTree;
    try {
      t = await ensureTree(url, ref, { home, offline: true, git });
    } catch (e) {
      if (!(e instanceof NoCachedCopyError)) throw e;
      // `targets` (no-fetch) takes no --offline: point at a command that fetches.
      throw new Error(`${e.message} — ${opts.offline ? "run without --offline once to fetch it" : "run craftar status once to fetch it"}`);
    }
    return { tree: t.dir, origin: origin(t), warning: opts.offline ? `Forge ${url} not fetched (--offline) — using ${used(t)}` : null };
  }
  try {
    const t = await ensureTree(url, ref, { home, git });
    return { tree: t.dir, origin: origin(t), warning: null };
  } catch (e) {
    if (!(e instanceof ForgeFetchError)) throw e;
    if (!e.cached)
      throw new Error(
        `cannot fetch the Forge ${url}: ${e.gitMessage} — ${e.haveCopy ? `and the cached copy cannot resolve ${ref === null ? "the default branch" : refHoldsCredentials(ref) ? shownRef(ref) : ref}` : "and there is no cached copy to fall back on"}`,
      );
    if (mode === "sync") {
      const tail = fetchHint === "fresh-copy"
        ? "repos clone reads the profile's repositories only from a fresh copy"
        : fetchHint === "mcp"
          ? `craftar mcp syncs a remote Forge only from a fresh fetch — run craftar sync --offline in a terminal to use the cached copy (${short(e.cached.commit)} fetched ${e.cached.fetchedAt ?? "never"})`
          : `run with --offline to use the cached copy (${short(e.cached.commit)} fetched ${e.cached.fetchedAt ?? "never"})`;
      throw new Error(`cannot fetch the Forge ${url}: ${e.gitMessage} — ${tail}`);
    }
    const t = await ensureTree(url, ref, { home, offline: true, git });
    return { tree: t.dir, origin: origin(t), warning: `Forge ${url} not fetched (${e.gitMessage}) — using ${used(t)}` };
  }
}

/**
 * The Forge and (optionally) the workspace a command operates on.
 * `--forge` names the Forge directly, `workspace` is undefined.
 * Otherwise the workspace's craftar.yaml gives both.
 */
export async function resolveForgeSource(opts: { forge?: string; workspace?: string } & LoadOptions): Promise<{ forge: Forge; workspace?: Workspace }> {
  if (opts.forge !== undefined && opts.workspace !== undefined) {
    throw new Error("pass either --forge or --workspace, not both — two sources for one Forge");
  }
  if (opts.forge !== undefined) {
    // A URL is not a directory to load: a remote Forge is read through a workspace that names it (spec 13 §4.4).
    if (classifyForge(opts.forge) === "url") throw new Error("--forge takes a directory; to read a remote Forge, run inside a workspace that names it");
    return { forge: await loadForge(path.resolve(opts.forge)) };
  }
  const root = path.resolve(opts.workspace ?? ".");
  if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
    throw new Error(
      `no ${WORKSPACE_FILE} in ${root} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`,
    );
  }
  const workspace = await loadWorkspace(root, opts);
  return { forge: workspace.forge, workspace };
}

/**
 * The Forge a `forge` command operates on (spec 04 §4.3). `--forge` names it directly;
 * otherwise the workspace's craftar.yaml does. Both at once is ambiguous, so it fails.
 */
export async function resolveForge(opts: { forge?: string; workspace?: string } & LoadOptions): Promise<Forge> {
  return (await resolveForgeSource(opts)).forge;
}

export type SectionLayer = "default" | "profile" | "workspace";

export interface Plan {
  resolution: Resolution;
  files: PlannedFile[];
  warnings: string[];
  /** Per ingredient ref, each section it declares, with the layer that filled it (spec 11 §5.3, for `explain`). */
  sections: Map<string, Array<{ file: string; name: string; layer: SectionLayer; targets?: Target[] }>>;
  /** Per ingredient ref, each `{{key}}` a file rendered for it cites, sorted, with the layer that filled it (spec 29 §4.1, for `explain`). */
  params: Map<string, Array<{ key: string; layer: ParamLayer }>>;
  /**
   * Each cited `{{key}}` no layer fills, the refs citing it, and the warning that says so (spec 24 §4.2);
   * `declaredBy` names the resolved ingredients that declare the key with no value — empty for a key nobody
   * declares that way (spec 29 §4.1).
   */
  missingParams: Array<{ key: string; refs: string[]; warning: string; declaredBy: string[] }>;
  /**
   * AGENTS.md size budget info: present when the plan includes an AGENTS.md file; null otherwise.
   * `explicit` is true when the key is present in resolved params with a valid value.
   */
  agentsMd: {
    bytes: number;
    maxBytes: number;
    explicit: boolean;
    /** Rules sorted by bytes desc, then name asc. */
    rules: Array<{ name: string; bytes: number; scoped: boolean }>;
    /** The exact warning line pushed into Plan.warnings, or null if within budget. */
    warning: string | null;
  } | null;
  /** Paths of planned texts reworded because of agents-md.primary, sorted (spec 41 §4.4); [] with the mode off. */
  reworded: string[];
  /**
   * Kiro agent resources check (spec 41 §4.5–§4.6): null when the mode is off; otherwise holds
   * the hand-written entries that name files the plan does not write.
   */
  kiroResources: {
    unplanned: Array<{ agent: string; path: string }>;
    present: Array<{ agent: string; path: string }>;
    warning: string | null;
  } | null;
}

/** Declared keys with no default that no layer fills, with the ingredients declaring them (spec 24 §4.2) — cited or not. */
export function declaredWithoutValue(p: Pick<Plan, "resolution">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ing of p.resolution.ingredients) {
    const values = paramsFor(ing, p.resolution);
    // `paramsFor` already holds the ingredient's own default, so a key it lacks has neither default nor value.
    for (const key of Object.keys(ing.meta.params ?? {})) {
      // At the rules-index gate, skip the key (spec 44 §4.2)
      if (p.resolution.rulesIndex && key === RULES_INDEX_KEY) continue;
      if (Object.hasOwn(values, key)) continue;
      out.set(key, [...(out.get(key) ?? []), ing.ref]);
    }
  }
  return out;
}

/** A declared parameter with no value that a planned file cites: what refuses a sync (spec 29 §3). */
export interface UnsetParam {
  key: string;
  declaredBy: string[];
  citedBy: string[];
}

/** The unset declared parameters of a plan, in `missingParams` order (sorted by key). */
export function unsetDeclared(p: Plan): UnsetParam[] {
  return p.missingParams.filter((m) => m.declaredBy.length > 0).map((m) => ({ key: m.key, declaredBy: m.declaredBy, citedBy: m.refs }));
}

/**
 * The refusal block of spec 29 §4.1, without the `error: ` prefix. `thenSync` is `init`'s form: it has just written
 * `craftar.yaml`, so its first line says that instead of "nothing written", and its fix line ends with the sync to run.
 */
export function unsetRefusal(unset: UnsetParam[], opts: { thenSync?: boolean } = {}): string {
  const width = Math.max(...unset.map((u) => u.key.length));
  return [
    `${unset.length} declared parameter(s) have no value — ${opts.thenSync ? "craftar.yaml written, sync not run" : "nothing written"}`,
    ...unset.map((u) => `  ${u.key.padEnd(width)}  declared by ${u.declaredBy.join(", ")} · cited by ${u.citedBy.join(", ")}`),
    `  fix: set each under params in the profile, or under overrides.params in craftar.yaml${opts.thenSync ? ", then run craftar sync" : ""}`,
  ].join("\n");
}

/** What stands where a sync's file counts would: `next sync:` (`add recipe`, `init --no-sync`) and `first sync:` (the interactive `init`). */
export function unsetRefused(unset: UnsetParam[]): string {
  return `refused — ${unset.length} declared parameter(s) have no value (${unset.map((u) => u.key).join(", ")})`;
}

/** The refusal in one line, for a row that has no room for the block (`workspaces`, `forge impact`). */
export function unsetSummary(unset: UnsetParam[]): string {
  return `sync refused: declared parameter(s) with no value: ${unset.map((u) => u.key).join(", ")}`;
}

/**
 * Non-null when the plan has an AGENTS.md, the budget is explicit, maxBytes > 0, and bytes > maxBytes.
 * Used by CLI surfaces that fail on an explicit budget violation.
 */
export function agentsMdOverBudget(p: Plan): { bytes: number; maxBytes: number } | null {
  if (!p.agentsMd) return null;
  const { bytes, maxBytes, explicit } = p.agentsMd;
  if (!explicit) return null;
  if (maxBytes === 0) return null;
  if (bytes <= maxBytes) return null;
  return { bytes, maxBytes };
}

/** The message for an explicit AGENTS.md budget violation. */
export function agentsMdOverBudgetMessage(o: { bytes: number; maxBytes: number }): string {
  return `AGENTS.md is ${o.bytes} bytes, over the budget of ${o.maxBytes} set by ${AGENTS_MD_BUDGET_KEY}`;
}

/** The message for an AGENTS.md over the default budget (no budget set). */
export function agentsMdOverDefaultMessage(o: { bytes: number; maxBytes: number }): string {
  return `AGENTS.md is ${o.bytes} bytes, over the default budget of ${o.maxBytes}`;
}

/** What shrinks AGENTS.md: the two kinds of rule body it holds. */
export const AGENTS_MD_SHRINK = "move always-on rules to inclusion: fileMatch, write scoped rules to their own files (target claude-code or kiro)";
/** The fix for an explicit AGENTS.md budget violation. */
export const AGENTS_MD_BUDGET_FIX = `${AGENTS_MD_SHRINK}, or raise ${AGENTS_MD_BUDGET_KEY}`;

/**
 * The refusal block for an explicit AGENTS.md budget violation, without the `error: ` prefix.
 */
export function agentsMdRefusal(o: { bytes: number; maxBytes: number }): string {
  return `${agentsMdOverBudgetMessage(o)}\n  fix: ${AGENTS_MD_BUDGET_FIX}`;
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
 * The section pass of `plan()` (spec 11 §6.6 steps 1–5): parse every body file of every resolved
 * ingredient (a malformed marker throws, whichever targets resolve), warn on marker lines in files
 * not every target renders, fail a `schema: 1` Forge that holds a marker (Ruling 7/21), and warn on
 * section values that apply to nothing.
 */
async function sectionPass(forge: Forge, resolution: Resolution, warnings: string[]) {
  const parsed = new Map<string, ParsedSections>(); // abs path → parse
  const declared = new Map<string, Set<string>>(); // section key → names declared by resolved ingredients
  const byRef: Plan["sections"] = new Map();
  let firstMarker: string | null = null;
  const parseOpts = { targets: readsTargetSections(forge.manifest) };
  for (const ing of resolution.ingredients) {
    const key = sectionKey(ing.meta);
    const names = declared.get(key) ?? new Set<string>();
    declared.set(key, names);
    if (ing.meta.type === "mcp") continue; // no file, so no marker: a value keyed mcp/<name> is warned below
    const files: Array<{ rel: string; p: ParsedSections }> = [];
    for (const rel of await listFiles(ing.dir)) {
      if (rel === "ingredient.yaml") continue;
      const abs = path.join(ing.dir, rel);
      if (bodyFile(ing.meta, rel, ing.dir)) {
        const p = parseSections(await fs.readFile(abs, "utf8"), forgeRel(forge, abs), ing.ref, parseOpts);
        parsed.set(abs, p);
        files.push({ rel, p });
        if (p.sections.length && firstMarker === null) firstMarker = `${p.file}:${p.sections[0].line}`;
        // Edge case: a service file with a targeted section fails the plan
        if (ing.meta.type === "service") {
          for (const s of p.sections) {
            if (s.targets) {
              throw new Error(`${ing.ref} ${rel}: section ${s.name} names targets, but a service file is written for no target — remove targets=`);
            }
          }
        }
        // Edge case 14: warn if a targeted section reaches no target that writes the ingredient
        const effTargets = effectiveTargets(ing.meta, resolution);
        for (const s of p.sections) {
          if (s.targets) {
            const reaches = s.targets.some((t) =>
              appliesTo(effTargets, t) && CAPABILITIES[t][ing.meta.type].state !== "unsupported"
            );
            if (!reaches) {
              warnings.push(`${ing.ref} ${rel}: section ${s.name} reaches no target that writes ${ing.ref} (targets=${s.targets.join(",")})`);
            }
          }
        }
      } else if (emittedFile(ing.meta, rel, ing.dir)) {
        // A file emitted but not every target renders as text keeps its markers; one, whatever its extension, is warned, never dropped
        // silently. Every marker form contains "craftar:section", so a file without it is not decoded.
        const bytes = await fs.readFile(abs);
        if (bytes.includes("craftar:section") && toLf(stripBom(bytes.toString("utf8"))).split("\n").some((l) => markerLine(l) !== null)) {
          warnings.push(`${ing.ref} ${rel}: section markers are read only in files every target renders as text — copied with them`);
        }
      }
      // A file no target emits is skipped silently (0.8.2) — not read for sections, not warned
    }
    checkDeclaredOnce(ing.ref, files.map((f) => f.p));
    const list: Plan["sections"] extends Map<string, infer V> ? V : never = [];
    for (const { rel, p } of files) {
      for (const s of p.sections) {
        names.add(s.name);
        list.push({ file: rel, name: s.name, layer: layerOf(resolution, key, s.name), ...(s.targets ? { targets: s.targets } : {}) });
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
 * The output guard (spec 11 §6.6 step 6, Ruling 19): a rendered body file never holds a marker
 * line. When one does, it came from a value; name the first value that carries one.
 */
function guardOutput(ing: ResolvedIngredient, file: string, out: string, p: ParsedSections, resolution: Resolution, params: Record<string, unknown>, owner: Owner): void {
  const line = firstMarkerLine(out);
  if (line === null) return;
  const key = sectionKey(ing.meta);
  const values = sectionsFor(ing, resolution);
  let from = "a section or param value";
  const q = projectSections(p, owner);
  const section = q.sections.find((s) => Object.hasOwn(values, s.name) && firstMarkerLine(substitute(canonicalValue(values[s.name]), params)) !== null);
  if (section) from = `${layerLabel(resolution, layerOf(resolution, key, section.name))}, section ${section.name}`;
  else {
    const k = placeholders(expandSections(q, values)).find((x) => Object.hasOwn(params, x) && /<!--[ \t]*\/?[ \t]*craftar:section/.test(String(params[x])));
    if (k !== undefined) from = `param ${k}`;
  }
  throw new Error(`${ing.ref} ${file}: the rendered text holds a section marker on line ${line} (from ${from}) — a value cannot open or close a section`);
}

/** A workspace-relative path that resolves above the workspace root once joined under it (`path.join`, never `path.resolve`). */
const outsideWorkspace = climbsOut;

/**
 * Fails a plan holding a path outside the workspace (0.17.3). It catches what leaves the workspace, whatever built
 * the path; a path that leaves its own folder and stays inside (`.claude/scripts/../x`) is the schema's to refuse.
 */
export function assertInsideWorkspace(files: PlannedFile[]): void {
  const f = files.find((x) => outsideWorkspace(x.path));
  if (f) throw new Error(`${f.ingredient} would write ${f.path}, outside the workspace — refused`);
}

export async function plan(ws: Workspace): Promise<Plan> {
  const resolution = resolve(ws.forge, ws.config);
  const warnings = [...ws.warnings, ...resolution.warnings];
  const hasService = resolution.ingredients.some((ing) => ing.meta.type === "service");
  if (resolution.targets.length === 0) {
    warnings.push(
      hasService
        ? "no target resolved — only the service files under .craftar/ are written"
        : "no targets resolved — nothing will be emitted and every file in craftar.lock becomes an orphan (an empty list in craftar.local.yaml replaces the workspace's)",
    );
  }
  const sections = await sectionPass(ws.forge, resolution, warnings);
  /** Unresolved placeholder → refs of the ingredients citing it. */
  const missingParams = new Map<string, Set<string>>();
  /** Ingredient ref → the placeholders the files rendered for it cite, after section expansion. */
  const cited = new Map<string, { ing: ResolvedIngredient; keys: Set<string> }>();
  /** Warnings said once per plan, for warnOnce (spec 34 §5.2). */
  const warnedOnce = new Set<string>();
  /** Per-rule byte sizes for AGENTS.md budget, collected by the agents-md emitter. */
  const agentsMdRules: Array<{ name: string; bytes: number; scoped: boolean }> = [];
  /** Paths reworded by agents-md.primary (spec 41 §4.4). */
  const rewordedPaths = new Set<string>();
  /** Kiro agent resources recorded for the check (spec 41 §4.5). */
  const kiroResourceRecords: Array<{ agent: string; path: string }> = [];
  /** Below-gate literals: `ref (file)` for each rendered text that holds `{{craftar.rules.index}}` alone on a line (spec 44 §4.2). */
  const belowGateLiterals = new Set<string>();
  /** Regex: `{{craftar.rules.index}}` alone on a line (spec 44 §4.2). */
  const rulesIndexLiteralRe = /^[ \t]*\{\{\s*craftar\.rules\.index\s*\}\}[ \t]*$/m;
  const ctx: EmitBase = {
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
    async text(ing: ResolvedIngredient, file: string, owner: Owner) {
      const abs = path.join(ing.dir, file);
      const raw = await fs.readFile(abs, "utf8");
      const missing = new Set<string>();
      const params = paramsFor(ing, resolution);
      // Sections first, then params (spec 11 §6.4), in body files only (§6.5, 0.8.2).
      const parsed = bodyFile(ing.meta, file, ing.dir) ? sections.parsed.get(abs) : null;
      // Every body file of a resolved ingredient was parsed and gated in the section pass; a miss here means the file is
      // outside the ingredient directory, behind a symlinked directory that listFiles did not descend into, or spelled
      // with different letter case on a case-insensitive file system.
      if (parsed === undefined)
        throw new Error(
          `${forgeRel(ws.forge, abs)}: ${ing.ref} declares a file outside its directory, behind a symlinked directory, or spelled differently from the file on disk — keep the file inside ${forgeRel(ws.forge, ing.dir)} and spell the declared path as it is on disk`,
        );
      const expanded = parsed ? expandSections(parsed, sectionsFor(ing, resolution), owner) : toLf(stripBom(raw));
      const out = substitute(expanded, params, missing);
      if (parsed) guardOutput(ing, file, out, parsed, resolution, params, owner);
      // Every file rendered here, body file or not: `explain` names each key the refusal can name (spec 29 §4.1).
      const c = cited.get(ing.ref) ?? { ing, keys: new Set<string>() };
      for (const key of placeholders(expanded)) {
        // At the gate, drop the key from cited (spec 44 §4.2)
        if (resolution.rulesIndex && key === RULES_INDEX_KEY) continue;
        c.keys.add(key);
      }
      if (c.keys.size) cited.set(ing.ref, c);
      for (const key of missing) {
        // At the gate, drop the key from missing (spec 44 §4.2)
        if (resolution.rulesIndex && key === RULES_INDEX_KEY) continue;
        missingParams.set(key, (missingParams.get(key) ?? new Set<string>()).add(ing.ref));
      }
      // Below the gate, track literals for the warning (spec 44 §4.2)
      if (!resolution.rulesIndex && rulesIndexLiteralRe.test(out)) {
        belowGateLiterals.add(`${ing.ref} (${file})`);
      }
      return out;
    },
    bytes(ing: ResolvedIngredient, file: string) {
      return fs.readFile(path.join(ing.dir, file));
    },
    warn(msg: string) {
      warnings.push(msg);
    },
    missing(key: string, ref: string) {
      // At the gate, drop the key (spec 44 §4.2)
      if (resolution.rulesIndex && key === RULES_INDEX_KEY) return;
      missingParams.set(key, (missingParams.get(key) ?? new Set<string>()).add(ref));
    },
    warnOnce(msg: string) {
      if (!warnedOnce.has(msg)) {
        warnedOnce.add(msg);
        warnings.push(msg);
      }
    },
    reportAgentsMdRule(name: string, bytes: number, scoped: boolean) {
      agentsMdRules.push({ name, bytes, scoped });
    },
    reportReworded(path: string) {
      rewordedPaths.add(path);
    },
    reportKiroResource(agent: string, path: string) {
      kiroResourceRecords.push({ agent, path });
    },
  };
  const files: PlannedFile[] = [];
  for (const t of resolution.targets) {
    const em = EMITTERS[t];
    if (!em) {
      warnings.push(`target "${t}" has no emitter yet`);
      continue;
    }
    files.push(...(await emitFor(t, em, ctx)));
  }
  // Service files are planned after the target loop (spec 31 §5.3, choice 24) and before the
  // containment check, so assertInsideWorkspace, the missing-param collection and the duplicate-path
  // guard all cover the service files.
  files.push(...(await planServices(ctx)));
  assertInsideWorkspace(files);
  const missing: Plan["missingParams"] = [];
  const declared = declaredWithoutValue({ resolution });
  // Keys declared by ANY resolved ingredient (with or without default) — for the warning condition
  const declaredByAny = new Set<string>();
  for (const ing of resolution.ingredients) {
    for (const key of Object.keys(ing.meta.params ?? {})) {
      declaredByAny.add(key);
    }
  }
  for (const [key, refs] of [...missingParams].sort(([a], [b]) => a.localeCompare(b))) {
    const warning = `param "${key}" has no value in any layer — left verbatim (${[...refs].sort().join(", ")})`;
    const declaredBy = [...(declared.get(key) ?? [])].sort();
    // Warn when the key is declared by ANY resolved ingredient (with or without default), or when it
    // is under `integrations.` in a Forge at schema 3+. An undeclared key is left silently.
    if (declaredByAny.has(key) || (readsIntegrations(ws.forge.manifest) && key.startsWith(INTEGRATIONS_PREFIX))) {
      warnings.push(warning);
    }
    missing.push({ key, refs: [...refs].sort(), warning, declaredBy });
  }
  const params: Plan["params"] = new Map();
  for (const [ref, { ing, keys }] of cited) {
    params.set(ref, [...keys].sort((a, b) => a.localeCompare(b)).map((key) => ({ key, layer: paramLayer(key, ing, resolution) })));
  }
  // Duplicate path guard
  const seen = new Map<string, string>();
  for (const f of files) {
    const prev = seen.get(f.path);
    if (prev) warnings.push(`two ingredients write ${f.path}: ${prev} and ${f.ingredient} (last wins)`);
    seen.set(f.path, f.ingredient);
  }

  // AGENTS.md size budget: computed after the target loop, warning pushed by plan() (spec 15 §4.5 reserves
  // the single agents-md warning for references).
  const planned = dedupeLastWins(files);
  const agentsMd = computeAgentsMdBudget(planned, resolution, agentsMdRules, warnings);

  // Collect reworded paths (spec 41 §4.4)
  const reworded = [...rewordedPaths].sort();

  // Kiro agent resources check (spec 41 §4.5–§4.6): null when the mode is off
  // Existence only (lstat): a hand-written entry's file is never read.
  const onDisk = (rel: string) => fs.lstat(path.join(ws.root, rel)).then(() => true, () => false);
  const kiroResources = await computeKiroResources(planned, kiroResourceRecords, onDisk, warnings, resolution.primary);

  // CLAUDE.md blocking check (spec 41 §4.7): only when the mode is on and claude-code is a target
  if (resolution.primary && resolution.targets.includes("claude-code")) {
    const blocks = await claudeMdBlocks(ctx.readExisting);
    if (blocks.blocking.length > 0) {
      warnings.push(claudeMdBlockedMessage(blocks.blocking[0]));
    }
  }

  // Rules-index warnings (spec 44 §4.2):
  // - Below the gate: one line for all literals
  // - At the gate: one line per layer that holds a value for the key
  if (!resolution.rulesIndex) {
    // Below the gate: warn about literals
    if (belowGateLiterals.size > 0) {
      const sorted = [...belowGateLiterals].sort();
      warnings.push(belowGateLiteralWarning(sorted));
    }
  } else {
    // At the gate: warn about values in layers (order: recipe, profile, workspace, then ingredient refs sorted)
    const { recipes, profile, workspace } = resolution.paramLayers;
    // Recipe that provides a default for the key
    const recipeWithKey = recipes.get(RULES_INDEX_KEY);
    if (recipeWithKey !== undefined) {
      warnings.push(ignoredValueWarning(`recipe ${recipeWithKey}`));
    }
    // Profile params
    if (Object.hasOwn(profile, RULES_INDEX_KEY)) {
      warnings.push(ignoredValueWarning(`profile ${resolution.profile.name}`));
    }
    // Workspace overrides.params
    if (Object.hasOwn(workspace, RULES_INDEX_KEY)) {
      warnings.push(ignoredValueWarning("workspace"));
    }
    // Ingredient's own params default (sorted by ref)
    const ingRefs: string[] = [];
    for (const ing of resolution.ingredients) {
      const decl = ing.meta.params?.[RULES_INDEX_KEY];
      if (decl && decl.default !== undefined) {
        ingRefs.push(ing.ref);
      }
    }
    for (const ref of ingRefs.sort()) {
      warnings.push(ignoredValueWarning(ref));
    }
  }

  return { resolution, files: planned, warnings, sections: sections.byRef, params, missingParams: missing, agentsMd, reworded, kiroResources };
}

/**
 * Compute the AGENTS.md budget info. Returns null when no AGENTS.md is planned.
 * Parses and validates the budget param, adds warnings, and builds the budget object.
 */
function computeAgentsMdBudget(
  files: PlannedFile[],
  resolution: Resolution,
  agentsMdRules: Array<{ name: string; bytes: number; scoped: boolean }>,
  warnings: string[],
): Plan["agentsMd"] {
  // Find the AGENTS.md file
  const agentsMdFile = files.find((f) => f.path === "AGENTS.md");
  if (!agentsMdFile) return null;

  const bytes = agentsMdFile.content.length;

  // Parse the budget param
  const rawValue = resolution.params[AGENTS_MD_BUDGET_KEY];
  const hasKey = Object.hasOwn(resolution.params, AGENTS_MD_BUDGET_KEY);
  let maxBytes: number;
  let explicit: boolean;

  if (!hasKey) {
    maxBytes = AGENTS_MD_DEFAULT_MAX_BYTES;
    explicit = false;
  } else {
    // Validate: must be a whole number >= 0 (given as number or string of digits)
    const parsed = parseAgentsMdBudget(rawValue);
    if (parsed === null) {
      warnings.push(`${AGENTS_MD_BUDGET_KEY} must be a whole number of bytes (0 turns the budget off) — the default ${AGENTS_MD_DEFAULT_MAX_BYTES} is used`);
      maxBytes = AGENTS_MD_DEFAULT_MAX_BYTES;
      explicit = false;
    } else {
      maxBytes = parsed;
      explicit = true;
    }
  }

  // Sort rules by bytes desc, then name asc
  const sortedRules = [...agentsMdRules].sort((a, b) => {
    if (b.bytes !== a.bytes) return b.bytes - a.bytes;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // Add budget warning if over budget and maxBytes > 0
  let warning: string | null = null;
  if (maxBytes > 0 && bytes > maxBytes) {
    const top5 = sortedRules.slice(0, 5);
    const rulesText = top5.length > 0 ? ` — largest rules: ${top5.map((r) => `${r.name} (${r.scoped ? "scoped, " : ""}${r.bytes} bytes)`).join(", ")}` : "";
    // Under the mode, add the clause (spec 41 §4.9)
    const primaryClause = resolution.primary ? "; these rules are in no other file" : "";
    // Two forms, each led by the wording the error block and doctor use
    warning = explicit
      ? `${agentsMdOverBudgetMessage({ bytes, maxBytes })}; sync --check fails${primaryClause}${rulesText}`
      : `${agentsMdOverDefaultMessage({ bytes, maxBytes })} (${AGENTS_MD_BUDGET_KEY})${primaryClause}${rulesText}`;
    warnings.push(warning);
  }

  return { bytes, maxBytes, explicit, rules: sortedRules, warning };
}

/**
 * Parse the agents-md.maxBytes value. Returns the number if valid, null otherwise.
 * Valid: a whole number >= 0, as a number or a string of digits.
 */
function parseAgentsMdBudget(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  return null;
}

/**
 * Compute the Kiro agent resources check (spec 41 §4.5–§4.6).
 * Returns null when the mode is off; otherwise holds the entries that name files the plan does not write.
 */
async function computeKiroResources(
  planned: PlannedFile[],
  recorded: Array<{ agent: string; path: string }>,
  onDisk: (rel: string) => Promise<boolean>,
  warnings: string[],
  primary: boolean,
): Promise<Plan["kiroResources"]> {
  if (!primary) return null;
  if (recorded.length === 0) return { unplanned: [], present: [], warning: null };

  const plannedPaths = new Set(planned.map((f) => f.path));

  // Dedupe by agent+path, sort by agent then path
  const seen = new Set<string>();
  const deduped: Array<{ agent: string; path: string }> = [];
  for (const r of recorded) {
    const key = `${r.agent}\0${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  deduped.sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));

  const unplanned: Array<{ agent: string; path: string }> = [];
  const present: Array<{ agent: string; path: string }> = [];

  for (const r of deduped) {
    if (plannedPaths.has(r.path)) continue; // fine
    // Not planned: check if present on disk
    const exists = await onDisk(r.path);
    if (exists) present.push(r);
    else unplanned.push(r);
  }

  let warning: string | null = null;
  if (unplanned.length > 0 || present.length > 0) {
    const parts: string[] = [];
    if (unplanned.length > 0) {
      parts.push(`unplanned: ${unplanned.map((r) => `${r.agent} → ${r.path}`).join(", ")}`);
    }
    if (present.length > 0) {
      parts.push(`on disk only: ${present.map((r) => `${r.agent} → ${r.path}`).join(", ")}`);
    }
    warning = `kiro: agent resources name files the plan does not write — ${parts.join("; ")}`;
    warnings.push(warning);
  }

  return { unplanned, present, warning };
}

/** The unplanned entries from kiroResources, or null when there are none (spec 41 §4.6). */
export function kiroResourcesUnplanned(p: Plan): Array<{ agent: string; path: string }> | null {
  if (!p.kiroResources) return null;
  if (p.kiroResources.unplanned.length === 0) return null;
  return p.kiroResources.unplanned;
}

/** The refusal message for unplanned Kiro agent resources (spec 41 §4.6). */
export function kiroResourcesRefusal(u: Array<{ agent: string; path: string }>): string {
  const entries = u.map((r) => `${r.agent} → ${r.path}`).join(", ");
  return `${u.length} Kiro agent resource(s) name a file the plan does not write: ${entries}\n  fix: edit the agent's resources in the Forge, or list the rule's targets so kiro writes it`;
}

/**
 * Check whether a CLAUDE.md imports AGENTS.md or blocks Claude Code from reading it (spec 41 §4.7).
 * @param readExisting - Function to read workspace files
 * @returns imports (true when @AGENTS.md found) and blocking (the files that block when not importing)
 */
export async function claudeMdBlocks(
  readExisting: (rel: string) => Promise<Buffer | null>,
): Promise<{ imports: boolean; blocking: string[] }> {
  const FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
  // An import is relative to the file that holds it (measured, Claude Code 2.1.310): from .claude/CLAUDE.md only
  // `@../AGENTS.md` reaches the root's AGENTS.md. CLAUDE.local.md is not looked at for an import.
  const IMPORT_LINES: Array<[string, string[]]> = [
    ["CLAUDE.md", ["@AGENTS.md", "@./AGENTS.md"]],
    [".claude/CLAUDE.md", ["@../AGENTS.md"]],
  ];

  for (const [file, lines] of IMPORT_LINES) {
    const content = await readExisting(file);
    if (content !== null) {
      const text = stripBom(content.toString("utf8"));
      for (const line of text.split("\n")) {
        // Strip trailing CR first, then trailing spaces/tabs
        const trimmed = line.replace(/\r$/, "").replace(/[ \t]+$/, "");
        if (lines.includes(trimmed)) {
          return { imports: true, blocking: [] };
        }
      }
    }
  }

  // Not importing: collect blocking files
  const blocking: string[] = [];
  for (const file of FILES) {
    const content = await readExisting(file);
    if (content !== null) blocking.push(file);
  }

  return { imports: false, blocking };
}

/** The warning message for a CLAUDE.md that blocks AGENTS.md (spec 41 §4.7). */
export function claudeMdBlockedMessage(file: string): string {
  return `agents-md.primary: ${file} keeps Claude Code from reading AGENTS.md — add a line @AGENTS.md to CLAUDE.md, or set Project instructions to claude-md-and-agents-md`;
}

/**
 * Why `apply()` removed `path`: the orphan wording of `craftar sync` and of the `sync` tool of `craftar mcp`, one copy
 * (spec 41 §4.8).
 */
export function orphanReason(p: Plan, statuses: readonly FileStatus[], path: string): string {
  const s = statuses.find((x) => x.path === path);
  return s !== undefined && primaryOrphan(p, s) ? "orphan: written to AGENTS.md only (agents-md.primary)" : "orphan: no longer produced by the Forge";
}

/** Returns true when the orphan is due to agents-md.primary (spec 41 §4.8). */
export function primaryOrphan(p: Plan, s: Pick<FileStatus, "state" | "target" | "ingredient">): boolean {
  if (!p.resolution.primary) return false;
  if (s.state !== "orphan") return false;
  if (s.target !== "claude-code" && s.target !== "kiro") return false;
  // Find the ingredient in the resolution
  const ing = p.resolution.ingredients.find((i) => i.ref === s.ingredient);
  if (!ing) return false;
  // The orphan is primary iff effectiveTargets does NOT admit s.target while meta.targets DOES
  const eff = effectiveTargets(ing.meta, p.resolution);
  const effAdmits = appliesTo(eff, s.target);
  const declaredAdmits = appliesTo(ing.meta.targets, s.target);
  return !effAdmits && declaredAdmits;
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
  const text = await fs.readFile(f, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${LOCK_FILE} is not valid JSON`);
  }
  // A lock a later craftar wrote is refused by name, not with a zod dump (spec 13 §4.6).
  if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, "schema") && !LOCK_SCHEMAS.includes((raw as { schema: unknown }).schema))
    throw new Error(`${LOCK_FILE} declares schema ${shownSchema((raw as { schema: unknown }).schema)}, which this craftar does not read — upgrade craftar`);
  const r = LockSchema.safeParse(raw);
  if (!r.success) throw new SchemaError(`${LOCK_FILE} is not a valid lock`, r.error);
  // The orphan pass removes what the lock names: an entry outside the workspace would delete there (0.17.3).
  const outside = r.data.files.find((e) => outsideWorkspace(e.path));
  if (outside) throw new Error(`${LOCK_FILE}: entry ${outside.path} is outside the workspace`);
  return r.data;
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
  target?: Owner;
  ingredient?: string;
  planned?: PlannedFile;
  lock?: LockEntry | LockEntryV3;
}

/** Does the disk content match the lock entry? Recognises both current and pre-0.17.4 hashes for non-UTF-8 files. */
function matchesLock(disk: Buffer, entry: LockEntry | LockEntryV3): boolean {
  return hashNormalized(disk) === entry.hash || (!isUtf8(disk) && legacyHash(disk) === entry.hash);
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
      if (diskHash === planHash) state = "unchanged";
      // The lock records this very plan — under the current hash (a valid UTF-8 plan hashes the same in both) or under
      // the pre-0.17.4 one, which did not record invalid bytes. The Forge did not change in any way the lock can show, so
      // whatever the disk holds instead is not ours to overwrite: a hand edit, a re-save in another encoding, or a Forge
      // change confined to invalid bytes all look the same here, and drift is never overwritten silently.
      else if (legacyHash(f.content) === entry.hash) state = "drift";
      else if (matchesLock(disk, entry)) state = "update";
      else state = "drift";
    } else state = hashNormalized(disk) === planHash || sameJson(f.path, disk, f.content) ? "adopt" : "collision";
    out.push({ path: f.path, state, target: f.target, ingredient: f.ingredient, planned: f, lock: entry });
  }
  const planned = new Set(p.files.map((f) => f.path));
  for (const e of lock?.files ?? []) {
    if (planned.has(e.path)) continue;
    const disk = await readDisk(ws.root, e.path);
    if (disk === null) continue; // already gone
    out.push({ path: e.path, state: matchesLock(disk, e) ? "orphan" : "orphan-drift", target: e.target, ingredient: e.ingredient, lock: e });
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
  /** Hand-edited paths to regenerate (`drift`) or remove (`orphan-drift`), one by one (spec 30 §4.3). A path in another state is left to its own case. */
  overwritePaths?: ReadonlySet<string>;
}

export interface ApplyResult {
  written: string[];
  removed: string[];
  skipped: FileStatus[];
  lock: Lock;
}

export async function apply(ws: Workspace, p: Plan, statuses: FileStatus[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  // A backstop, before the first write: `plan()` and `readLock()` already refuse such a path.
  const outside = statuses.find((s) => outsideWorkspace(s.path));
  if (outside) throw new Error(`${outside.path} is outside the workspace — refused`);
  // The gate of spec 29 §4.1, `dryRun` included: a declared parameter nobody set never reaches a file. `src/cli.ts`
  // asks first and prints the block itself; this is what no writer can go around.
  const unset = unsetDeclared(p);
  if (unset.length) throw new Error(unsetRefusal(unset));
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: FileStatus[] = [];
  const entries: LockEntryV3[] = [];

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
        if (opts.overwriteDrift || opts.overwritePaths?.has(s.path)) {
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
        // Only a path named one by one is discarded: `overwriteDrift` regenerates, and there is nothing to regenerate here.
        if (opts.overwritePaths?.has(s.path)) {
          if (!opts.dryRun) await fs.rm(path.join(ws.root, s.path), { force: true });
          removed.push(s.path);
        } else {
          skipped.push(s);
          entries.push(s.lock!); // keep the old entry so the hand-edited orphan stays visible until deleted
        }
        break;
    }
  }

  // Schema 3 when any entry has target `services`; otherwise schema 2 (spec 31 §5.2, spec 13 §5.2).
  const sortedEntries = entries.sort((a, b) => a.path.localeCompare(b.path));
  const hasServices = entries.some((e) => e.target === "services");
  // Build the shared part once; the two branches differ only in `schema` and in the entry type.
  const base = {
    forge: { source: ws.config.forge, ref: ws.origin.ref, commit: ws.forge.commit },
    profile: ws.config.profile,
    recipes: p.resolution.recipes,
    targets: p.resolution.targets,
    generatedAt: new Date().toISOString(),
  };
  const built: LockV2 | LockV3 = hasServices
    ? { schema: 3, ...base, files: sortedEntries }
    // The narrowing cast is sound: hasServices is false, so no entry has target "services",
    // thus every entry's target is a Target (claude-code | kiro | agents-md).
    : { schema: 2, ...base, files: sortedEntries as LockEntry[] };
  // Rewritten only when its content changes: generatedAt is when it last did (Ruling 10). A schema 1
  // lock always differs, so the first sync with this craftar upgrades it.
  const onDisk = opts.dryRun ? null : await readLock(ws.root);
  const unchanged = onDisk !== null && isDeepStrictEqual({ ...onDisk, generatedAt: null }, { ...built, generatedAt: null });
  const lock = unchanged ? onDisk : built;
  if (!opts.dryRun && !unchanged) await writeLock(ws.root, lock);
  return { written, removed, skipped, lock };
}

function entry(f: PlannedFile): LockEntryV3 {
  return { path: f.path, hash: hashNormalized(f.content), target: f.target, ingredient: f.ingredient };
}

async function writeFile(root: string, f: PlannedFile): Promise<void> {
  const abs = path.join(root, f.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, f.content);
  // Set mode after writing (fs.writeFile's mode applies only on creation, so chmod is needed for updates).
  if (f.mode !== undefined && process.platform !== "win32") {
    await fs.chmod(abs, f.mode);
  }
}
