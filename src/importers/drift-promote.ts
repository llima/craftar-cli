/**
 * `craftar drift promote` (spec 30 §4.4–§4.7): carry a hand-edited file back to the Forge as a variant.
 * Writes nothing in a workspace, its lock, the registry or the Forge cache.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { classifyForge, cacheKey as computeCacheKey } from "../core/remote.js";
import {
  loadForge,
  gitIsRepo,
  gitHasCommit,
  gitIgnored,
  gitUnheld,
  exists,
  listFiles,
  typeFolder,
  type Forge,
  type UnheldPath,
} from "../core/forge.js";
import { readWorkspaceConfig, plan, status, readLock, type FileStatus } from "../core/sync.js";
import { driftList } from "../core/drift.js";
import { hashNormalized } from "../core/text.js";
import { fingerprintOf } from "../core/fingerprint.js";
import {
  workspaceAgainst,
  forgeWorkspaces,
  remoteUrls,
  urlToKey,
  planAll,
  impactOf,
  nextSync,
  type RegistryState,
  type ForgeWorkspace,
  type MatchKind,
  type NextSyncResult,
} from "../core/impact.js";
import { findProfileFile, resolvedBy } from "../core/param-writes.js";
import {
  readEmitted,
  secretIn,
  markerIn,
  validateImported,
  recipesOf,
  recipeFile,
  ForgeStage,
  type RecipeOptions,
} from "./claude-code.js";
import { decide, workspaceParams, workspaceSections, type RunContext } from "./decide.js";
import { citedKeys, expandedTexts, readBase, sectionNames } from "../core/template-import.js";
import { sectionKey } from "../core/resolve.js";
import { editYamlText } from "../core/yaml-edit.js";
import type { WriteJournal } from "../core/unify.js";
import type { Ingredient, IngredientRef } from "../schema/index.js";

export interface PromoteInput {
  workspaceRoot: string;
  /** `--forge <dir>`, or null to use the workspace's path Forge. */
  forgeDir: string | null;
  /** The workspace-relative path to promote. */
  path: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** One entry written or edited by promote. */
export interface PromoteEntry {
  /** Forge-relative POSIX path. */
  rel: string;
  /** True for a new file, false for an overwrite. */
  created: boolean;
}

/** Error thrown when gitUnheld finds paths that are not held by git. */
export class UnheldError extends Error {
  constructor(
    readonly forgeRoot: string,
    readonly unheld: UnheldPath[],
  ) {
    super("gitUnheld");
  }
}

/** One row in impact.workspaces, matching spec 25's forge impact --json shape. */
export interface ImpactWorkspaceRow {
  path: string;
  profile: string;
  match: MatchKind;
  via: string | null;
  ref: string | null;
  state: "unchanged" | "changed" | "missing" | "error";
  counts: Record<string, number>;
  error: string | null;
}

export interface PromotePlan {
  outcome: "params" | "sections" | "variant" | "variant-updated";
  /** The ref of the promoted ingredient (null for params/sections). */
  promoted: string | null;
  profile: string;
  /** The path that was promoted, workspace-relative. */
  inputPath: string;
  /** Entries written or edited. */
  entries: PromoteEntry[];
  /** Keys edited per file, for the report. */
  editedKeys: Map<string, string[]>;
  /** Params changed (for params outcome). */
  params: Array<{ key: string; old: string | null; value: string }>;
  /** Sections changed (for sections outcome). */
  sections: Array<{ key: string; name: string; lines: number }>;
  /** Params and sections flattened by the variant. */
  flattened: { params: string[]; sections: string[] };
  /** Dependent workspace paths. */
  dependents: string[];
  /** True if all other files (not in E and not dependent) are byte-equal. */
  otherFilesUnchanged: number;
  /** What the next sync would do (statuses for CLI to print through countStates/nextSyncLine). */
  nextSync: FileStatus[];
  /** Impact on other workspaces. */
  impact: { registry: RegistryState; workspaces: ImpactWorkspaceRow[] };
  /** Warnings to print. */
  warnings: string[];

  // For the apply step:
  stage: ForgeStage;
  forgeRoot: string;
  mustHold: string[];
  creates: string[];

  // For JSON output:
  /** Absolute path of the workspace root. */
  workspaceRealPath: string;
  /** The ingredient ref (e.g. "rule/a"). */
  ingredientRef: string;
  /** True if --dry-run. */
  isUrlForge: boolean;
}

/** D1–D17 messages. */
const D1 = "the Forge of this workspace is remote, read from a cache craftar never writes — pass `--forge <your clone>`";
const D2_PATH = (given: string, real: string) => `--forge ${given} is not this workspace's Forge (${real})`;
const D2_URL = (given: string) => `--forge ${given} is not a clone of this workspace's Forge — none of its git remotes matches`;
const D3 = (dir: string) => `${dir} is not a git repository with at least one commit — promote needs git to undo its edit`;
const D4_UNMANAGED = (p: string) =>
  `${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)`;
const D4_OTHER = (p: string, state: string) => `${p} is not drifted (${state}) — nothing to promote`;
const D4_ORPHAN = (p: string) => `${p} is no longer produced by the Forge — nothing to promote into; \`craftar drift discard ${p}\` removes it`;
const D5_KIRO = (p: string, hint: string) => `${p} is a kiro file — promote reads only what the claude-code target wrote${hint}`;
const D5_AGENTSMD = (p: string) => `${p} holds several rules in one file — promote reads only what the claude-code target wrote`;
const D6 = (p: string) => `${p} holds every mcp ingredient in one file — edit the mcp ingredient in the Forge`;
const D7 = (ing: string, p: string, state: string, profile: string) =>
  `the Forge changed ${ing} since the last sync (${p}: ${state}) — a variant taken from the disk would undo that change for profile ${profile}; sync the rest, redo the edit on top, and promote again`;
const D8 = (p: string, ing: string) => `${p} of ${ing} is missing on disk — restore it with \`craftar sync\` first`;
const D9 = (ing: string, reason: string) => `${ing} looks like it holds a secret (${reason}) — nothing was written`;
const D10 = (ing: string, q: string) => `${ing} is also used by profile ${q} — its files would change there`;
const D11 = (p: string, line: number) => `${p}:${line} holds a section marker — a variant body cannot hold one; remove it and promote again`;
const D12_SECTION = (ing: string, name: string) =>
  `${ing} takes section "${name}" from this workspace's overrides (craftar.yaml) — a variant would silently stop applying it; edit craftar.yaml, or remove the override and sync first`;
const D12_PARAM = (ing: string, key: string) =>
  `${ing} takes param "${key}" from this workspace's overrides (craftar.yaml) — a variant would silently stop applying it; edit craftar.yaml, or remove the override and sync first`;
const D13_EXISTS = (rel: string) => `${rel} already exists in the Forge — promote does not overwrite it`;
const D13_IGNORED = (rel: string) => `${rel} is ignored by git — git could not show or undo it`;
const D15 = (what: string) => `promote could not be proved for this workspace: ${what} — the Forge was left untouched`;
const D16_OTHER_PROFILE = (wsPath: string, profile: string, changedPath: string) =>
  `promote would change ${wsPath} (profile ${profile}): ${changedPath} — the Forge was left untouched`;
const D16_SAME_PROFILE_OUTSIDE = (wsPath: string, ingredient: string, changedPath: string) =>
  `promote would change ${wsPath} beyond ${ingredient}: ${changedPath} — the Forge was left untouched`;
const D16_SAME_PROFILE_OVERRIDE = (wsPath: string, ingredient: string) =>
  `${wsPath} fills ${ingredient} from its own overrides — a variant would silently stop applying them there; the Forge was left untouched`;
const D17 = (recipe: string, chain: string) =>
  `recipe ${recipe} reaches this workspace through ${chain} — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand`;
const INTERNAL_REUSE = (p: string) => `internal: ${p} is drift but the Forge already renders it — please report this`;

interface OtherWorkspaceCheck {
  entries: ForgeWorkspace[];
  before: ReturnType<typeof planAll> extends Promise<infer T> ? T : never;
  after: ReturnType<typeof planAll> extends Promise<infer T> ? T : never;
  rows: ImpactWorkspaceRow[];
}

/**
 * Check other workspaces for impact (spec 30 §4.6 items 5-6).
 * Throws on D16 refusals; returns the impact rows to report otherwise.
 */
async function checkOtherWorkspaces(
  opts: {
    home: string;
    forgeDir: string;
    env: NodeJS.ProcessEnv;
    thisWsRealPath: string;
    forge: Forge;
    scratchForge: Forge;
    profile: string;
    outcome: "params" | "sections" | "variant" | "variant-updated";
    ingredientRef: IngredientRef;
    allowedPaths: Set<string>;
    baseCitedKeys: Set<string>;
    baseSectionNames: string[];
    ingKey: string;
  },
): Promise<{ state: RegistryState; rows: ImpactWorkspaceRow[]; warnings: string[] }> {
  const {
    home,
    forgeDir,
    env,
    thisWsRealPath,
    forge,
    scratchForge,
    profile,
    outcome,
    ingredientRef,
    allowedPaths,
    baseCitedKeys,
    baseSectionNames,
    ingKey,
  } = opts;

  const fwResult = await forgeWorkspaces(home, forgeDir, env);
  const warnings: string[] = [];

  // Filter out this workspace
  const otherEntries = fwResult.workspaces.filter((fw) => {
    try {
      // Compare real paths
      return fw.entry.path !== thisWsRealPath;
    } catch {
      return true; // keep if can't compare
    }
  });

  if (otherEntries.length === 0 || fwResult.state === "off") {
    return {
      state: fwResult.state,
      rows: [],
      warnings: fwResult.state !== "read" && fwResult.state !== "none" ? [] : [],
    };
  }

  // Plan all before and after
  const before = await planAll(otherEntries, forge);
  const after = await planAll(otherEntries, scratchForge);

  const rows: ImpactWorkspaceRow[] = [];

  for (let i = 0; i < otherEntries.length; i++) {
    const fw = otherEntries[i];
    const bPlan = before[i];
    const aPlan = after[i];

    // Build the row using nextSync for state/counts
    const ns = await nextSync(aPlan);
    const row: ImpactWorkspaceRow = {
      path: fw.entry.path,
      profile: fw.entry.profile,
      match: fw.match,
      via: fw.via,
      ref: fw.ref,
      state: ns.state,
      counts: ns.counts,
      error: ns.error,
    };
    rows.push(row);

    // Skip missing/error for D16 checks - report in warnings
    if (bPlan.kind === "missing" || aPlan.kind === "missing") {
      warnings.push(`${fw.entry.path}: missing`);
      continue;
    }
    if (bPlan.kind === "error" || aPlan.kind === "error") {
      const errMsg = aPlan.kind === "error" ? aPlan.message : bPlan.kind === "error" ? bPlan.message : "";
      warnings.push(`${fw.entry.path}: error: ${errMsg}`);
      continue;
    }

    // Compare the plans
    const impact = impactOf(bPlan, aPlan);
    if (impact.state === "no-effect") continue;
    if (impact.state === "missing" || impact.state === "error") continue;

    // D16 checks
    const changedFiles = impact.files;
    if (changedFiles.length === 0) continue;

    const otherProfile = fw.entry.profile;
    const firstChanged = changedFiles[0];

    // D16 (other profile) — any change to another profile is refused
    if (otherProfile !== profile) {
      throw new Error(D16_OTHER_PROFILE(fw.entry.path, otherProfile, firstChanged));
    }

    // Same profile - check if the change is within allowed bounds
    // For variant outcomes, check if the workspace fills the ingredient from overrides
    if (outcome === "variant" || outcome === "variant-updated") {
      // Check if this workspace's merged config sets sections or params that X cites
      const merged = aPlan.workspace.merged;
      const wsSections = merged.config.overrides?.sections?.[ingKey];
      const wsParams = merged.config.overrides?.params ?? {};

      // Check sections
      if (wsSections) {
        for (const secName of baseSectionNames) {
          if (Object.hasOwn(wsSections, secName)) {
            throw new Error(D16_SAME_PROFILE_OVERRIDE(fw.entry.path, ingredientRef));
          }
        }
      }

      // Check params
      for (const key of baseCitedKeys) {
        if (Object.hasOwn(wsParams, key)) {
          throw new Error(D16_SAME_PROFILE_OVERRIDE(fw.entry.path, ingredientRef));
        }
      }
    }

    // Check if changes are outside the allowed paths
    // For D16 same-profile-outside: use THIS workspace's before paths, not the promoting workspace's.
    // If ws2 disabled the ingredient, ws2BeforePaths for the ingredient is empty,
    // and any new file appearing is "outside" what ws2 expected.
    // We approximate this by checking if the changed file existed in ws2's before plan.
    // If ws2 had the file before and it changed content, that's within bounds.
    // If ws2 didn't have the file before and it now appears, that's outside bounds.
    for (const changed of changedFiles) {
      if (!bPlan.files.has(changed)) {
        throw new Error(D16_SAME_PROFILE_OUTSIDE(fw.entry.path, ingredientRef, changed));
      }
    }
  }

  return { state: fwResult.state, rows, warnings };
}

/**
 * Plan a promote operation. Throws an Error with the D1–D17 message on every refusal.
 * Writes NOTHING in the Forge until `applyPromote` is called.
 */
export async function planPromote(input: PromoteInput): Promise<PromotePlan> {
  const { workspaceRoot, path: inputPath, home, env } = input;
  const root = path.resolve(workspaceRoot);

  // Step 1: The Forge directory (D1, D2, D3)
  const merged = await readWorkspaceConfig(root);
  const forgeValue = merged.config.forge;
  const forgeKind = classifyForge(forgeValue);

  let forgeDir: string;
  if (input.forgeDir !== null) {
    // --forge given: verify it's this workspace's Forge
    forgeDir = path.resolve(input.forgeDir);
    if (forgeKind === "path") {
      // D2: path Forge — must be the same real path
      const realWorkspaceForge = await fs.realpath(path.resolve(root, forgeValue));
      const realGiven = await fs.realpath(forgeDir);
      if (realWorkspaceForge !== realGiven) throw new Error(D2_PATH(input.forgeDir, realWorkspaceForge));
    } else {
      // D2: URL Forge — the clone must have a remote that matches
      const warnings: string[] = [];
      const cloneRemotes = await remoteUrls(forgeDir, warnings, forgeDir);
      const wsKey = computeCacheKey(forgeValue);
      let found = false;
      for (const [, urls] of cloneRemotes) {
        for (const url of urls) {
          if (urlToKey(url, forgeDir) === wsKey) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) throw new Error(D2_URL(input.forgeDir));
    }
  } else {
    // No --forge: the workspace must have a path Forge (D1)
    if (forgeKind === "url") throw new Error(D1);
    forgeDir = path.resolve(root, forgeValue);
  }

  // D3: must be a git repo with at least one commit
  const realForgeDir = await fs.realpath(forgeDir);
  const isRepo = await gitIsRepo(forgeDir);
  const hasCommit = isRepo && (await gitHasCommit(forgeDir));
  if (!isRepo || !hasCommit) throw new Error(D3(realForgeDir));

  // Load the Forge and workspace
  const forge = await loadForge(forgeDir);
  const ws = await workspaceAgainst(root, forge);
  const p0 = await plan(ws);
  const lock = await readLock(root);
  const st = await status(ws, p0, lock);

  // Step 2: Classify the path (D4, D5, D6)
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const fileStatus = st.find((s) => s.path === normalized);
  if (!fileStatus) throw new Error(D4_UNMANAGED(normalized));
  if (fileStatus.state === "orphan-drift") throw new Error(D4_ORPHAN(normalized));
  if (fileStatus.state !== "drift") throw new Error(D4_OTHER(normalized, fileStatus.state));

  // Static checks (promotability) using driftList's row
  const rows = driftList([fileStatus]);
  if (rows.length === 0) {
    throw new Error(D4_OTHER(normalized, fileStatus.state));
  }
  const row = rows[0];
  if (!row.promotable) {
    // Build the right D5/D6 message from the static reason
    const reason = row.reason;
    if (reason === "kiro file") {
      // D5 kiro: check if the plan has a claude-code path for this ingredient
      const ingredientRef = fileStatus.ingredient;
      const claudePath = ingredientRef ? p0.files.find((f) => f.ingredient === ingredientRef && f.target === "claude-code")?.path : null;
      const hint = claudePath ? `; edit and promote \`${claudePath}\` instead` : "";
      throw new Error(D5_KIRO(normalized, hint));
    } else if (reason === "AGENTS.md") {
      throw new Error(D5_AGENTSMD(normalized));
    } else if (reason === ".mcp.json") {
      throw new Error(D6(normalized));
    } else {
      // Fallback for any other reason (shouldn't happen for drift state)
      throw new Error(D4_OTHER(normalized, fileStatus.state));
    }
  }

  const profile = ws.config.profile;
  const ingredientRef = fileStatus.ingredient! as IngredientRef;

  // Step 3: The emitted set E — every file the plan emits for this ingredient on claude-code
  const E = p0.files.filter((f) => f.ingredient === ingredientRef && f.target === "claude-code");
  const EPaths = new Set(E.map((f) => f.path));

  // Check each path of E for D7 and D8, using driftList's forge field for D7
  for (const f of E) {
    const s = st.find((x) => x.path === f.path);
    if (!s) continue; // shouldn't happen

    // D8: missing on disk (the file is `new`)
    if (s.state === "new") {
      throw new Error(D8(f.path, ingredientRef));
    }

    // D7: Forge changed since last sync (for drifted files, use driftList's forge field)
    if (s.state === "drift" || s.state === "update" || s.state === "collision" || s.state === "adopt") {
      if (s.state === "drift") {
        // Get forge side from driftList
        const driftRow = driftList([s])[0];
        if (driftRow && driftRow.forge === "changed") {
          throw new Error(D7(ingredientRef, f.path, "drift, forge changed", profile));
        }
      } else {
        // update, collision, adopt
        throw new Error(D7(ingredientRef, f.path, s.state, profile));
      }
    }
  }

  // Step 4: Read the source from disk
  const X = p0.resolution.ingredients.find((i) => i.ref === ingredientRef)!;
  const claudeDir = path.join(root, ".claude");
  const meta = X.meta;
  const outputName = "as" in meta && meta.as ? (meta.as as string) : meta.name;

  // Determine the relative path for readEmitted based on type
  let rel: string;
  let readType: "rule" | "agent" | "command" | "skill" | "script" | "hook";
  if (meta.type === "skill") {
    readType = "skill";
    if (meta.layout === "dir") {
      rel = outputName; // directory name
    } else {
      rel = `${outputName}.md`; // file-layout skill
    }
  } else if (meta.type === "rule") {
    readType = "rule";
    rel = `${outputName}.md`;
  } else if (meta.type === "agent") {
    readType = "agent";
    rel = `${outputName}.md`;
  } else if (meta.type === "command") {
    readType = "command";
    rel = `${outputName}.md`;
  } else if (meta.type === "script") {
    readType = "script";
    rel = meta.files?.[0] ?? `${outputName}.sh`;
  } else if (meta.type === "hook") {
    readType = "hook";
    rel = meta.files?.[0] ?? `${outputName}.sh`;
  } else {
    throw new Error(`cannot promote ${ingredientRef} — unsupported type`);
  }

  // Call readEmitted without steering metadata — source metadata is X's own
  const emitted = await readEmitted(claudeDir, readType, rel, (r) => ({ workspace: path.basename(root), path: r }));
  if (!emitted) throw new Error(`cannot read ${readType} ${outputName} from ${claudeDir}`);

  // Source metadata: X's own, but re-read certain fields; drop params
  const sourceMeta: Ingredient = {
    ...X.meta,
    ...emittedMetaFields(emitted.meta, readType),
  } as Ingredient;
  // Remove params from source (sources carry none)
  if ("params" in sourceMeta) delete (sourceMeta as Record<string, unknown>).params;

  // D9: Secret check
  const secret = secretIn(sourceMeta, emitted.files, emitted.scan);
  if (secret) throw new Error(D9(ingredientRef, secret));

  // Collect warnings about hand-added files in a skill directory
  const warnings: string[] = [];
  if (meta.type === "skill" && meta.layout === "dir") {
    const skillDir = path.join(claudeDir, "skills", outputName);
    const diskFiles = await listFiles(skillDir).catch(() => [] as string[]);
    const plannedFiles = new Set(E.map((f) => f.path.replace(/^\.claude\/skills\/[^/]+\//, "")));
    for (const df of diskFiles) {
      if (!plannedFiles.has(df)) {
        warnings.push(`.claude/skills/${outputName}/${df} is not a file craftar generated — not promoted`);
      }
    }
  }

  // Step 5: Decide the outcome
  const stage = new ForgeStage(forgeDir);
  const readWs = (abs: string) => fs.readFile(abs, "utf8");
  const ctx: RunContext = {
    P: { ...(forge.profiles.get(profile)?.params ?? {}) },
    W: await workspaceParams(root, readWs),
    PS: structuredClone(forge.profiles.get(profile)?.sections ?? {}),
    WS: await workspaceSections(root, readWs),
    pinned: new Map(),
    forge,
    markedBase: false,
  };

  const fingerprint = fingerprintOf(validateImported(sourceMeta), emitted.files);
  const decision = await decide(ctx, X.dir, stage.reader(), ingredientRef, sourceMeta, emitted.files, fingerprint, [], new Set());

  // Handle the decision
  let outcome: "params" | "sections" | "variant" | "variant-updated";
  const N = outputName;

  // Determine if X is this profile's variant (name is `<N>--<p>` AND as is `<N>`)
  const isOwnVariant = X.meta.name === `${N}--${profile}` && X.meta.as === N;
  // Determine if X is another profile's variant (name ends with --<q> for some q)
  const variantMatch = X.meta.name.match(/^(.+)--([^-]+)$/);
  const isOtherVariant = variantMatch !== null && variantMatch[2] !== profile && X.meta.as === N;

  // The variant name is always <outputName>--<profile>
  const variantName = `${N}--${profile}`;
  const variantRef = `${meta.type}/${variantName}` as IngredientRef;

  // Params/sections that changed for the profile, if outcome is params/sections
  let paramsChanged: Array<{ key: string; old: string | null; value: string }> = [];
  let sectionsChanged: Array<{ key: string; name: string; lines: number; value: string }> = [];

  // For flattened reporting: track what the base cited that the variant no longer has
  let flattenedParams: string[] = [];
  let flattenedSections: string[] = [];

  // Read the base to detect cited keys and sections
  const base = await readBase(X.dir, stage.reader(), forge.root);
  const ingKey = sectionKey(X.meta);
  const PSk = ctx.PS[ingKey] ?? {};
  const WSk = ctx.WS[ingKey] ?? {};
  const S: Record<string, string> = { ...PSk, ...WSk };
  const baseCitedKeys = citedKeys(expandedTexts(base, S));
  const baseSectionNames = sectionNames(base);

  if (decision.kind === "reuse") {
    // No delta means the Forge already renders this — internal error
    if (!decision.delta?.length && !decision.sectioned?.length && !decision.sectionDelta?.length) {
      throw new Error(INTERNAL_REUSE(normalized));
    }
    // Has delta: params outcome
    if (decision.delta?.length) {
      outcome = "params";
      paramsChanged = decision.delta.map((d) => ({
        key: d.key,
        old: d.old,
        value: d.value,
      }));
    } else if (decision.sectionDelta?.length) {
      // Has sectionDelta: sections outcome
      outcome = "sections";
      sectionsChanged = decision.sectionDelta.map((d) => ({
        key: d.key,
        name: d.name,
        lines: d.value.split("\n").filter((l) => l !== "").length || (d.value === "" ? 0 : 1),
        value: d.value,
      }));
    } else {
      // sectioned but no delta means the profile already had the value — internal error
      throw new Error(INTERNAL_REUSE(normalized));
    }
  } else if (decision.kind === "variant" || decision.kind === "literal") {
    // Check if this is updating an existing variant
    if (isOwnVariant) {
      outcome = "variant-updated";
    } else {
      outcome = "variant";
    }
    // For variant outcomes, track what was flattened
    flattenedParams = [...baseCitedKeys].sort();
    flattenedSections = baseSectionNames;
  } else {
    // literal — shouldn't happen with no others, treat as variant
    outcome = isOwnVariant ? "variant-updated" : "variant";
    flattenedParams = [...baseCitedKeys].sort();
    flattenedSections = baseSectionNames;
  }

  // D12: check workspace overrides before variant outcomes (not for params/sections)
  if (outcome === "variant" || outcome === "variant-updated") {
    // Check if the workspace sets a section of this ingredient
    const wsIngSections = ctx.WS[ingKey];
    if (wsIngSections) {
      const firstName = Object.keys(wsIngSections).sort()[0];
      if (firstName) {
        throw new Error(D12_SECTION(ingredientRef, firstName));
      }
    }
    // Check if the workspace sets a param the body cites
    const wsCitedParam = [...baseCitedKeys].sort().find((k) => Object.hasOwn(ctx.W, k));
    if (wsCitedParam) {
      throw new Error(D12_PARAM(ingredientRef, wsCitedParam));
    }
  }

  // D10: another profile resolves that variant (only for variant-updated)
  if (outcome === "variant-updated") {
    for (const [q] of forge.profiles) {
      if (q !== profile && resolvedBy(forge, q).has(variantRef)) {
        throw new Error(D10(variantRef, q));
      }
    }
  }

  // D11: marker check (only for variant outcomes)
  if (outcome === "variant" || outcome === "variant-updated") {
    const marker = markerIn(sourceMeta, emitted.files, normalized);
    if (marker) throw new Error(D11(marker.where, marker.line));
  }

  // For params/sections outcomes, stage the profile edit
  if (outcome === "params" || outcome === "sections") {
    const profileAbs = await findProfileFile(forgeDir, profile);
    if (!profileAbs) throw new Error(`profile ${profile} not found`);

    // D14 check: profile file must be held by git
    const unheld = await gitUnheld(forgeDir, [profileAbs]);
    if (unheld.length > 0) {
      throw new UnheldError(realForgeDir, unheld);
    }

    const raw = await fs.readFile(profileAbs, "utf8");
    const label = `profiles/${profile}/profile.yaml`;
    const editKeys = outcome === "params" ? ["params"] : ["sections"];
    const content = editYamlText(raw, { command: "drift promote", label, keys: editKeys }, (doc) => {
      if (outcome === "params") {
        for (const p of paramsChanged) {
          doc.setIn(["params", p.key], p.value);
        }
      } else {
        for (const s of sectionsChanged) {
          doc.setIn(["sections", s.key, s.name], s.value);
        }
      }
    });
    stage.write(profileAbs, content);

    const editedKeys = new Map<string, string[]>();
    editedKeys.set(label, editKeys);

    // Build proof in scratch copy
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-promote-"));
    try {
      await fs.cp(forgeDir, scratchDir, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(forgeDir, src);
          if (rel === "") return true;
          const firstPart = rel.split(path.sep)[0];
          return firstPart !== ".git";
        },
      });
      await stage.flushTo(scratchDir);

      const scratchForge = await loadForge(scratchDir);
      const wsScratch = await workspaceAgainst(root, scratchForge);
      const p1 = await plan(wsScratch);

      // Proof checks
      const p0Paths = new Set(p0.files.map((f) => f.path));
      const p1Paths = new Set(p1.files.map((f) => f.path));
      if (p0Paths.size !== p1Paths.size || [...p0Paths].some((p) => !p1Paths.has(p))) {
        throw new Error(D15(`the planned files would change (${p0Paths.size} → ${p1Paths.size})`));
      }

      // For each path in E, p1 content matches disk
      for (const f of E) {
        const p1File = p1.files.find((x) => x.path === f.path);
        if (!p1File) throw new Error(D15(`${f.path} would not be planned`));
        const diskContent = await fs.readFile(path.join(root, f.path));
        if (hashNormalized(p1File.content) !== hashNormalized(diskContent)) {
          throw new Error(D15(`${f.path} would not match the file on disk`));
        }
      }

      // Every path not in E must be byte-equal (no dependent paths for params/sections)
      let otherFilesUnchanged = 0;
      for (const p0f of p0.files) {
        if (EPaths.has(p0f.path)) continue;
        const p1f = p1.files.find((x) => x.path === p0f.path);
        if (!p1f) throw new Error(D15(`${p0f.path} would change`));
        if (!p0f.content.equals(p1f.content)) {
          throw new Error(D15(`${p0f.path} would change`));
        }
        otherFilesUnchanged++;
      }

      // Compute next sync statuses
      const stScratch = await status(wsScratch, p1, lock);

      // Impact — check other workspaces (step 30h)
      const thisWsRealPath = await fs.realpath(root);
      // For params/sections, allowed paths are the paths in E plus dependent paths
      const allowedPaths = new Set([...EPaths]);
      // For params/sections, the override check is not needed (the params/sections are going into the profile)
      // So we pass empty baseCitedKeys and baseSectionNames to skip the override check
      const impactResult = await checkOtherWorkspaces({
        home,
        forgeDir,
        env,
        thisWsRealPath,
        forge,
        scratchForge,
        profile,
        outcome,
        ingredientRef,
        allowedPaths,
        baseCitedKeys: new Set<string>(), // params/sections don't trigger override check
        baseSectionNames: [], // params/sections don't trigger override check
        ingKey,
      });

      return {
        outcome,
        promoted: null,
        profile,
        inputPath: normalized,
        entries: (await stage.entries()).map((e) => ({ rel: e.rel, created: e.created })),
        editedKeys,
        params: paramsChanged,
        sections: sectionsChanged,
        flattened: { params: [], sections: [] },
        dependents: [],
        otherFilesUnchanged,
        nextSync: stScratch,
        impact: { registry: impactResult.state, workspaces: impactResult.rows },
        warnings: [...warnings, ...impactResult.warnings],
        stage,
        forgeRoot: realForgeDir,
        mustHold: [profileAbs],
        creates: [],
        workspaceRealPath: thisWsRealPath,
        ingredientRef,
        isUrlForge: forgeKind === "url",
      };
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true });
    }
  }

  // Build the variant ingredient — strip params for flattened variants
  const variantMeta: Ingredient = {
    ...validateImported(sourceMeta),
    name: variantName,
    as: N,
    origin: {
      workspace: path.basename(root),
      path: meta.type === "skill" && meta.layout === "dir" ? `.claude/skills/${N}/` : normalized,
    },
  } as Ingredient;
  // Remove params from variant (they are flattened into the body)
  if ("params" in variantMeta) delete (variantMeta as Record<string, unknown>).params;

  // Stage the variant files using typeFolder
  const folder = typeFolder(meta.type);
  const variantDir = path.join(forgeDir, "ingredients", folder, variantName);
  const variantDirRel = `ingredients/${folder}/${variantName}`;

  // For variant-updated, we don't check D13 — we're updating the existing directory
  if (outcome === "variant") {
    // D13 early check: variant directory must not already exist
    if (await exists(variantDir)) {
      throw new Error(D13_EXISTS(variantDirRel));
    }
  }

  const ingredientYaml = YAML.stringify(variantMeta, { lineWidth: 0 });
  const ingredientYamlPath = path.join(variantDir, "ingredient.yaml");

  // For variant-updated, only stage ingredient.yaml if it changed
  if (outcome === "variant") {
    stage.write(ingredientYamlPath, ingredientYaml);
  } else {
    // variant-updated: compare with existing file, only write if different
    let shouldWrite = true;
    try {
      const existingYaml = await fs.readFile(ingredientYamlPath, "utf8");
      // Compare parsed YAML to ignore formatting differences
      const existingParsed = YAML.parse(existingYaml);
      const newParsed = YAML.parse(ingredientYaml);
      // Deep compare the objects
      if (isDeepStrictEqual(existingParsed, newParsed)) {
        shouldWrite = false;
      }
    } catch {
      // File doesn't exist or can't be read — write it
    }
    if (shouldWrite) {
      stage.write(ingredientYamlPath, ingredientYaml);
    }
  }

  // For skills with dir layout, only write files that were planned (not hand-added ones)
  const plannedRelPaths =
    meta.type === "skill" && meta.layout === "dir"
      ? new Set(E.map((f) => f.path.replace(/^\.claude\/skills\/[^/]+\//, "")))
      : null;

  for (const [fileRel, content] of Object.entries(emitted.files)) {
    if (plannedRelPaths && !plannedRelPaths.has(fileRel)) continue; // skip hand-added files
    stage.write(path.join(variantDir, fileRel), content);
  }

  // Step 6: Recipe placement (§4.5)
  // For variant-updated, no recipe changes needed
  const viaRecipes = X.via;
  const editedKeys = new Map<string, string[]>();
  const profileRecipes = forge.profiles.get(profile)?.recipes ?? [];

  // The ref we're replacing in recipes: X.ref (not T/N, because X might be another profile's variant)
  const refToReplace = X.ref;

  if (outcome === "variant") {
    // Check which recipes need to be edited or forked
    for (const R of viaRecipes) {
      // Check if this profile owns the recipe (resolves it in its own layer)
      const profileOwns = recipesOf(forge, profile).has(R);
      // Check if any other profile resolves it
      let otherOwns = false;
      for (const [q] of forge.profiles) {
        if (q !== profile && recipesOf(forge, q).has(R)) {
          otherOwns = true;
          break;
        }
      }

      // Find the extends chain to R
      const extendsChain = findExtendsChain(forge, p0.resolution.recipes, R);
      // Check if R is in the profile's recipes list
      const inProfileRecipes = profileRecipes.includes(R);
      // Check if any other resolved recipe extends R
      const extendedByOther = isExtendedByOtherResolved(forge, p0.resolution.recipes, R);

      if (profileOwns && !otherOwns) {
        // Case 1: profile owns it alone — edit recipe in place
        const recipeOpts: RecipeOptions = {
          stage,
          dir: path.join(forgeDir, "recipes"),
          profile,
          forge,
          report: { recipes: [], recipeSplits: [] } as unknown as import("./claude-code.js").ImportReport,
          currentRules: null,
        };
        const recFile = await recipeFile(recipeOpts, R, "drift promote");

        // D14 check: recipe file must be held by git
        const unheld = await gitUnheld(forgeDir, [recFile]);
        if (unheld.length > 0) {
          throw new UnheldError(realForgeDir, unheld);
        }

        // Edit recipe in place
        const raw = await fs.readFile(recFile, "utf8");
        const label = `recipes/${R}.yaml`;
        const content = editYamlText(raw, { command: "drift promote", label, keys: ["ingredients"] }, (doc) => {
          const seq = doc.get("ingredients", true);
          if (!YAML.isSeq(seq)) return;
          for (const item of seq.items) {
            if (YAML.isScalar(item) && item.value === refToReplace) {
              item.value = variantRef;
            }
          }
        });
        stage.write(recFile, content);
        editedKeys.set(`recipes/${R}.yaml`, ["ingredients"]);
      } else if (inProfileRecipes && !extendedByOther) {
        // Case 2: R is in profile's recipes but also used by others, and no other resolved recipe extends R
        // Fork the recipe as R--<p> and edit the profile's recipes list
        const forkedRecipeName = `${R}--${profile}`;
        const forkedRecipeFile = path.join(forgeDir, "recipes", `${forkedRecipeName}.yaml`);
        const forkedRecipeRel = `recipes/${forkedRecipeName}.yaml`;

        // D13: check the forked recipe doesn't already exist
        if (await exists(forkedRecipeFile)) {
          throw new Error(D13_EXISTS(forkedRecipeRel));
        }
        // Check if ignored
        const ignored = await gitIgnored(forgeDir, forkedRecipeRel);
        if (ignored) {
          throw new Error(D13_IGNORED(forkedRecipeRel));
        }

        // Read the original recipe and create the forked one
        const recipeOpts: RecipeOptions = {
          stage,
          dir: path.join(forgeDir, "recipes"),
          profile,
          forge,
          report: { recipes: [], recipeSplits: [] } as unknown as import("./claude-code.js").ImportReport,
          currentRules: null,
        };
        const origRecFile = await recipeFile(recipeOpts, R, "drift promote");
        const origRaw = await fs.readFile(origRecFile, "utf8");

        // Edit the forked recipe: change name and swap the ingredient
        const forkedContent = editYamlText(origRaw, { command: "drift promote", label: forkedRecipeRel, keys: ["name", "ingredients"] }, (doc) => {
          doc.set("name", forkedRecipeName);
          const seq = doc.get("ingredients", true);
          if (!YAML.isSeq(seq)) return;
          for (const item of seq.items) {
            if (YAML.isScalar(item) && item.value === refToReplace) {
              item.value = variantRef;
            }
          }
        });
        stage.write(forkedRecipeFile, forkedContent);

        // Edit the profile's recipes list to replace R with R--<p>
        const profileFile = await findProfileFile(forgeDir, profile);
        if (!profileFile) throw new Error(`profile ${profile} not found`);

        // D14 check: profile file must be held by git
        const unheld = await gitUnheld(forgeDir, [profileFile]);
        if (unheld.length > 0) {
          throw new UnheldError(realForgeDir, unheld);
        }

        const profileRaw = await fs.readFile(profileFile, "utf8");
        const profileLabel = `profiles/${profile}/profile.yaml`;
        const newProfileContent = editYamlText(profileRaw, { command: "drift promote", label: profileLabel, keys: ["recipes"] }, (doc) => {
          const seq = doc.get("recipes", true);
          if (!YAML.isSeq(seq)) return;
          for (const item of seq.items) {
            if (YAML.isScalar(item) && item.value === R) {
              item.value = forkedRecipeName;
            }
          }
        });
        stage.write(profileFile, newProfileContent);
        editedKeys.set(profileLabel, ["recipes"]);
      } else {
        // Case 3: D17 — recipe reaches through extends or recipes.add, or case 2 applies but another resolved recipe extends R
        let chain: string;
        const wsAdds = ws.config.recipes?.add ?? [];
        if (wsAdds.includes(R)) {
          chain = "recipes.add (craftar.yaml)";
        } else if (extendsChain) {
          chain = extendsChain;
        } else {
          chain = R;
        }
        throw new Error(D17(R, chain));
      }
    }
  }
  // For variant-updated, no recipe changes are needed

  // Step 7: Gate (D13, D14)
  const entries = await stage.entries();
  const creates = entries.filter((e) => e.created).map((e) => e.rel);
  const mustHold = entries.filter((e) => !e.created).map((e) => e.abs);

  // D13: check created paths don't exist and aren't ignored
  for (const e of entries.filter((e) => e.created)) {
    // For the variant directory, check if it exists
    if (e.rel.includes("/ingredient.yaml")) {
      const varDirRel = e.rel.replace("/ingredient.yaml", "");
      const varDirAbs = path.join(forgeDir, varDirRel);
      if (await exists(varDirAbs)) {
        throw new Error(D13_EXISTS(varDirRel));
      }
    }

    // Check if ignored
    const ignored = await gitIgnored(forgeDir, e.rel);
    if (ignored) {
      throw new Error(D13_IGNORED(e.rel));
    }
  }

  // D14: gitUnheld check
  if (mustHold.length > 0) {
    const unheld = await gitUnheld(forgeDir, mustHold);
    if (unheld.length > 0) {
      throw new UnheldError(realForgeDir, unheld);
    }
  }

  // Step 8: The proof
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-promote-"));
  try {
    // Copy Forge without .git using fs.cp with filter
    await fs.cp(forgeDir, scratchDir, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(forgeDir, src);
        // Allow the root directory itself
        if (rel === "") return true;
        // Filter out .git (file or directory)
        const firstPart = rel.split(path.sep)[0];
        return firstPart !== ".git";
      },
    });
    await stage.flushTo(scratchDir);

    const scratchForge = await loadForge(scratchDir);
    const wsScratch = await workspaceAgainst(root, scratchForge);
    const p1 = await plan(wsScratch);

    // Proof checks
    // 1. Same path set
    const p0Paths = new Set(p0.files.map((f) => f.path));
    const p1Paths = new Set(p1.files.map((f) => f.path));
    if (p0Paths.size !== p1Paths.size || [...p0Paths].some((p) => !p1Paths.has(p))) {
      throw new Error(D15(`the planned files would change (${p0Paths.size} → ${p1Paths.size})`));
    }

    // 2. For each path in E, p1 content matches disk
    for (const f of E) {
      const p1File = p1.files.find((x) => x.path === f.path);
      if (!p1File) throw new Error(D15(`${f.path} would not be planned`));
      const diskContent = await fs.readFile(path.join(root, f.path));
      if (hashNormalized(p1File.content) !== hashNormalized(diskContent)) {
        throw new Error(D15(`${f.path} would not match the file on disk`));
      }
    }

    // 3. Every path not in E and not dependent must be byte-equal
    // Dependent paths: files of this ingredient on non-claude-code targets
    const dependentPaths = new Set<string>();
    for (const pf of p0.files) {
      if (pf.ingredient === ingredientRef && pf.target !== "claude-code") {
        dependentPaths.add(pf.path);
      }
    }

    // Also add AGENTS.md if this is a rule that's embedded in it (has a marker line)
    let agentsMdIsDependent = false;
    if (meta.type === "rule") {
      const agentsMd = p0.files.find((f) => f.ingredient === ("rule/*" as IngredientRef) || f.path === "AGENTS.md");
      if (agentsMd) {
        const p0AgentsContent = agentsMd.content.toString("utf8");
        const markerLine = `<!-- rule: ${N} -->`;
        if (p0AgentsContent.includes(markerLine)) {
          // This rule is embedded in AGENTS.md — it's a dependent path with bound
          dependentPaths.add(agentsMd.path);
          agentsMdIsDependent = true;
        }
        // If no marker, AGENTS.md just points at the file; it should be byte-equal
      }
    }

    let otherFilesUnchanged = 0;
    for (const p0f of p0.files) {
      if (EPaths.has(p0f.path) || dependentPaths.has(p0f.path)) continue;
      const p1f = p1.files.find((x) => x.path === p0f.path);
      if (!p1f) throw new Error(D15(`${p0f.path} would change`));
      if (!p0f.content.equals(p1f.content)) {
        throw new Error(D15(`${p0f.path} would change`));
      }
      otherFilesUnchanged++;
    }

    // Check AGENTS.md bound (§4.6 item 4)
    if (agentsMdIsDependent) {
      const p0AgentsMd = p0.files.find((f) => f.path === "AGENTS.md");
      const p1AgentsMd = p1.files.find((f) => f.path === "AGENTS.md");
      if (p0AgentsMd && p1AgentsMd) {
        const p0Text = p0AgentsMd.content.toString("utf8");
        const p1Text = p1AgentsMd.content.toString("utf8");
        if (!agentsBound(p0Text, p1Text, N)) {
          throw new Error(D15(`AGENTS.md would change outside rule ${N}`));
        }
      }
    }

    // 4. X.ref should not be in p1's resolution (only for new variants, not variant-updated)
    // For variant-updated, ingredientRef === variantRef, so it SHOULD still be there
    if (outcome === "variant") {
      const p1Refs = new Set(p1.resolution.ingredients.map((i) => i.ref));
      if (p1Refs.has(ingredientRef)) {
        throw new Error(D15(`${ingredientRef} would still resolve beside ${variantRef}`));
      }
    }

    // Compute next sync statuses (return FileStatus[] for CLI to use countStates/nextSyncLine)
    const stScratch = await status(wsScratch, p1, lock);

    // Impact: check for other workspaces (step 30h)
    const thisWsRealPath = await fs.realpath(root);
    // Allowed paths for variant outcomes: E paths + dependent paths
    const allowedPaths = new Set([...EPaths, ...dependentPaths]);
    const impactResult = await checkOtherWorkspaces({
      home,
      forgeDir,
      env,
      thisWsRealPath,
      forge,
      scratchForge,
      profile,
      outcome,
      ingredientRef,
      allowedPaths,
      baseCitedKeys,
      baseSectionNames,
      ingKey,
    });

    // Add warning for profile section values that are now unused by the variant
    if (flattenedSections.length > 0) {
      const profileSections = forge.profiles.get(profile)?.sections ?? {};
      const profileIngSections = profileSections[ingKey] ?? {};
      for (const name of flattenedSections) {
        if (Object.hasOwn(profileIngSections, name)) {
          warnings.push(`profile ${profile} still sets section ${ingKey} ${name}, which ${variantRef} no longer holds — every plan will warn until it is removed`);
        }
      }
    }

    return {
      outcome,
      promoted: variantRef,
      profile,
      inputPath: normalized,
      entries: entries.map((e) => ({ rel: e.rel, created: e.created })),
      editedKeys,
      params: [],
      sections: [],
      flattened: { params: flattenedParams, sections: flattenedSections },
      dependents: [...dependentPaths],
      otherFilesUnchanged,
      nextSync: stScratch,
      impact: { registry: impactResult.state, workspaces: impactResult.rows },
      warnings: [...warnings, ...impactResult.warnings],
      stage,
      forgeRoot: realForgeDir,
      mustHold,
      creates,
      workspaceRealPath: thisWsRealPath,
      ingredientRef,
      isUrlForge: forgeKind === "url",
    };
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Apply a promote plan: write the staged files to the Forge.
 * Order: ingredient files, then recipes, then profile.yaml last.
 */
export async function applyPromote(plan: PromotePlan, journal: WriteJournal): Promise<void> {
  // Sort entries: ingredient files first, then recipes
  const orderOf = (rel: string): number => {
    if (rel.startsWith("ingredients/")) return 0;
    if (rel.startsWith("recipes/")) return 1;
    if (rel.startsWith("profiles/")) return 2;
    return 3;
  };
  const order = (a: string, b: string) => orderOf(a) - orderOf(b) || a.localeCompare(b);

  await plan.stage.flushTo(plan.forgeRoot, { order, journal });
}

// Helper functions

function emittedMetaFields(emitted: Ingredient, type: string): Partial<Ingredient> {
  // Only re-read certain fields from the emitted source
  if (type === "agent") {
    return {
      description: (emitted as Record<string, unknown>).description as string | undefined,
      tools: (emitted as Record<string, unknown>).tools as string[] | undefined,
      model: (emitted as Record<string, unknown>).model as string | undefined,
      frontmatterRaw: (emitted as Record<string, unknown>).frontmatterRaw as string | undefined,
    };
  }
  if (type === "command") {
    return {
      description: (emitted as Record<string, unknown>).description as string | undefined,
      argumentHint: (emitted as Record<string, unknown>).argumentHint as string | undefined,
      allowedTools: (emitted as Record<string, unknown>).allowedTools as string | undefined,
      frontmatterRaw: (emitted as Record<string, unknown>).frontmatterRaw as string | undefined,
    };
  }
  return {};
}

/**
 * Find the extends chain from a resolved recipe to the target recipe.
 * Returns the chain like "target → child" if found, null otherwise.
 */
function findExtendsChain(forge: Forge, resolvedRecipes: string[], targetRecipe: string): string | null {
  // Look for a resolved recipe that extends the target
  for (const name of resolvedRecipes) {
    const r = forge.recipes.get(name);
    if (r?.extends?.includes(targetRecipe)) {
      return `${name} → ${targetRecipe}`;
    }
  }
  return null;
}

/**
 * Check if any other resolved recipe extends the given recipe.
 */
function isExtendedByOtherResolved(forge: Forge, resolvedRecipes: string[], R: string): boolean {
  for (const name of resolvedRecipes) {
    if (name === R) continue;
    const r = forge.recipes.get(name);
    if (r?.extends?.includes(R)) return true;
  }
  return false;
}

/**
 * Check if AGENTS.md changes are within the bound for rule N (spec 30 §4.6 item 4).
 * Returns true if the change is acceptable, false if it would be D15.
 */
export function agentsBound(p0Text: string, p1Text: string, N: string): boolean {
  const markerRe = /^<!-- rule: (.+) -->$/;

  // If p0 has no marker for N, p1 must be byte-equal
  const markerLine = `<!-- rule: ${N} -->`;
  if (!p0Text.includes(markerLine)) {
    return p0Text === p1Text;
  }

  // Find the boundaries in p0
  const p0Lines = p0Text.split("\n");
  const p1Lines = p1Text.split("\n");

  // Find the marker line for N in p0
  let markerIdx = -1;
  for (let i = 0; i < p0Lines.length; i++) {
    if (p0Lines[i] === markerLine) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) return p0Text === p1Text;

  // Find the next boundary in p0: next <!-- rule: ... --> or ## Scoped rules, or end
  let boundaryIdx = p0Lines.length;
  for (let i = markerIdx + 1; i < p0Lines.length; i++) {
    if (markerRe.test(p0Lines[i]) || p0Lines[i] === "## Scoped rules") {
      boundaryIdx = i;
      break;
    }
  }

  // p1 must equal p0 up to and including the marker line
  const prefixEnd = markerIdx + 1;
  for (let i = 0; i < prefixEnd; i++) {
    if (p0Lines[i] !== p1Lines[i]) return false;
  }

  // p1 must equal p0 from the boundary to the end
  const p0Suffix = p0Lines.slice(boundaryIdx).join("\n");
  const p1Suffix = p1Lines.slice(p1Lines.length - (p0Lines.length - boundaryIdx)).join("\n");

  // For the suffix comparison, we need to find where it starts in p1
  // The suffix in p1 starts at the same distance from the end as in p0
  const suffixLen = p0Lines.length - boundaryIdx;
  if (p1Lines.length < suffixLen) return false;
  const p1SuffixStart = p1Lines.length - suffixLen;
  const p1SuffixLines = p1Lines.slice(p1SuffixStart);

  return p0Suffix === p1SuffixLines.join("\n");
}
