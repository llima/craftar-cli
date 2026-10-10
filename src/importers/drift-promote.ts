/**
 * `craftar drift promote` (spec 30 §4.4–§4.7): carry a hand-edited file back to the Forge as a variant.
 * Writes nothing in a workspace, its lock, the registry or the Forge cache.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { workspaceAgainst, forgeWorkspaces, remoteUrls, urlToKey, type RegistryState } from "../core/impact.js";
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

export interface PromotePlan {
  outcome: "variant" | "variant-updated";
  /** The ref of the promoted ingredient. */
  promoted: string;
  profile: string;
  /** The path that was promoted, workspace-relative. */
  inputPath: string;
  /** Entries written or edited. */
  entries: PromoteEntry[];
  /** Keys edited per file, for the report. */
  editedKeys: Map<string, string[]>;
  /** Params changed (step 30g placeholder). */
  params: never[];
  /** Sections changed (step 30g placeholder). */
  sections: never[];
  /** Params and sections flattened by the variant. */
  flattened: { params: string[]; sections: string[] };
  /** Dependent workspace paths. */
  dependents: string[];
  /** True if all other files (not in E and not dependent) are byte-equal. */
  otherFilesUnchanged: number;
  /** What the next sync would do (statuses for CLI to print through countStates/nextSyncLine). */
  nextSync: FileStatus[];
  /** Impact on other workspaces. */
  impact: { registry: RegistryState; workspaces: never[] };
  /** Warnings to print. */
  warnings: string[];

  // For the apply step:
  stage: ForgeStage;
  forgeRoot: string;
  mustHold: string[];
  creates: string[];
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
const D11 = (p: string, line: number) => `${p}:${line} holds a section marker — a variant body cannot hold one; remove it and promote again`;
const D13_EXISTS = (rel: string) => `${rel} already exists in the Forge — promote does not overwrite it`;
const D13_IGNORED = (rel: string) => `${rel} is ignored by git — git could not show or undo it`;
const D15 = (what: string) => `promote could not be proved for this workspace: ${what} — the Forge was left untouched`;
const D17 = (recipe: string, chain: string) =>
  `recipe ${recipe} reaches this workspace through ${chain} — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand`;
const INTERNAL_REUSE = (p: string) => `internal: ${p} is drift but the Forge already renders it — please report this`;

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
  let outcome: "variant" | "variant-updated";
  const N = outputName;
  const variantName = `${N}--${profile}`;
  const variantRef = `${meta.type}/${variantName}` as IngredientRef;

  if (decision.kind === "reuse") {
    // No delta means the Forge already renders this — internal error
    if (!decision.delta?.length && !decision.sectioned?.length && !decision.sectionDelta?.length) {
      throw new Error(INTERNAL_REUSE(normalized));
    }
    // Has delta: this step treats it as variant until step 30g implements params/sections
    outcome = "variant";
  } else if (decision.kind === "variant") {
    // Check if this is updating an existing variant
    const existingVariant = forge.ingredients.get(variantRef);
    if (existingVariant && existingVariant.meta.as === N) {
      outcome = "variant-updated";
    } else {
      outcome = "variant";
    }
  } else {
    // literal — shouldn't happen with no others, treat as variant
    outcome = "variant";
  }

  // D11: marker check
  const marker = markerIn(sourceMeta, emitted.files, normalized);
  if (marker) throw new Error(D11(marker.where, marker.line));

  // Build the variant ingredient
  const variantMeta: Ingredient = {
    ...validateImported(sourceMeta),
    name: variantName,
    as: N,
    origin: {
      workspace: path.basename(root),
      path: meta.type === "skill" && meta.layout === "dir" ? `.claude/skills/${N}/` : normalized,
    },
  } as Ingredient;

  // Stage the variant files using typeFolder
  const folder = typeFolder(meta.type);
  const variantDir = path.join(forgeDir, "ingredients", folder, variantName);
  const variantDirRel = `ingredients/${folder}/${variantName}`;

  // D13 early check: variant directory must not already exist
  if (await exists(variantDir)) {
    throw new Error(D13_EXISTS(variantDirRel));
  }

  const ingredientYaml = YAML.stringify(variantMeta, { lineWidth: 0 });
  stage.write(path.join(variantDir, "ingredient.yaml"), ingredientYaml);

  // For skills with dir layout, only write files that were planned (not hand-added ones)
  const plannedRelPaths =
    meta.type === "skill" && meta.layout === "dir"
      ? new Set(E.map((f) => f.path.replace(/^\.claude\/skills\/[^/]+\//, "")))
      : null;

  for (const [fileRel, content] of Object.entries(emitted.files)) {
    if (plannedRelPaths && !plannedRelPaths.has(fileRel)) continue; // skip hand-added files
    stage.write(path.join(variantDir, fileRel), content);
  }

  // Step 6: Recipe placement
  const viaRecipes = X.via;
  const editedKeys = new Map<string, string[]>();

  // First pass: collect recipe files we'll need to edit and check D14
  const recipesToEdit: Array<{ recipe: string; recFile: string }> = [];

  for (const R of viaRecipes) {
    // Check if this profile owns the recipe
    const profileOwns = recipesOf(forge, profile).has(R);
    // Check if any other profile resolves it
    let otherOwns = false;
    for (const [q] of forge.profiles) {
      if (q !== profile && recipesOf(forge, q).has(R)) {
        otherOwns = true;
        break;
      }
    }

    if (profileOwns && !otherOwns) {
      // Case 1: will edit recipe in place - collect the file path
      const recipeOpts: RecipeOptions = {
        stage,
        dir: path.join(forgeDir, "recipes"),
        profile,
        forge,
        report: { recipes: [], recipeSplits: [] } as unknown as import("./claude-code.js").ImportReport,
        currentRules: null,
      };
      const recFile = await recipeFile(recipeOpts, R, "drift promote");
      recipesToEdit.push({ recipe: R, recFile });
    } else {
      // Cases 2-3: D17
      // Determine the chain
      let chain: string;
      const profileRecipes = forge.profiles.get(profile)?.recipes ?? [];
      if (profileRecipes.includes(R)) {
        // Case 2: in profile's recipes list — for this step, refuse
        const extendsChain = findExtendsChain(forge, R);
        chain = extendsChain ?? R;
      } else {
        // Case 3: reaches through extends or recipes.add
        const wsAdds = ws.config.recipes?.add ?? [];
        if (wsAdds.includes(R)) {
          chain = "recipes.add (craftar.yaml)";
        } else {
          const extendsChain = findExtendsChain(forge, R);
          chain = extendsChain ?? R;
        }
      }
      throw new Error(D17(R, chain));
    }
  }

  // D14 early check: recipe files must be held by git before we try to edit them
  if (recipesToEdit.length > 0) {
    const unheld = await gitUnheld(forgeDir, recipesToEdit.map((r) => r.recFile));
    if (unheld.length > 0) {
      throw new UnheldError(realForgeDir, unheld);
    }
  }

  // Second pass: actually edit the recipe files
  for (const { recipe: R, recFile } of recipesToEdit) {
    const raw = await fs.readFile(recFile, "utf8");
    const label = `recipes/${R}.yaml`;
    const content = editYamlText(raw, { command: "drift promote", label, keys: ["ingredients"] }, (doc) => {
      const seq = doc.get("ingredients", true);
      if (!YAML.isSeq(seq)) return;
      for (const item of seq.items) {
        if (YAML.isScalar(item) && item.value === ingredientRef) {
          item.value = variantRef;
        }
      }
    });
    stage.write(recFile, content);
    editedKeys.set(`recipes/${R}.yaml`, ["ingredients"]);
  }

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
    const dependentPaths = new Set<string>();
    for (const pf of p0.files) {
      if (pf.ingredient === ingredientRef && pf.target !== "claude-code") {
        dependentPaths.add(pf.path);
      }
    }
    // Also add rule/* files for AGENTS.md (step 30f handles this fully)
    if (meta.type === "rule") {
      const agentsMd = p0.files.find((f) => f.ingredient === ("rule/*" as const));
      if (agentsMd) dependentPaths.add(agentsMd.path);
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

    // 4. X.ref should not be in p1's resolution
    const p1Refs = new Set(p1.resolution.ingredients.map((i) => i.ref));
    if (p1Refs.has(ingredientRef)) {
      throw new Error(D15(`${ingredientRef} would still resolve beside ${variantRef}`));
    }

    // Compute next sync statuses (return FileStatus[] for CLI to use countStates/nextSyncLine)
    const stScratch = await status(wsScratch, p1, lock);

    // Impact: check for other workspaces (step 30h handles this fully)
    const fwResult = await forgeWorkspaces(home, forgeDir, env);

    return {
      outcome,
      promoted: variantRef,
      profile,
      inputPath: normalized,
      entries: entries.map((e) => ({ rel: e.rel, created: e.created })),
      editedKeys,
      params: [],
      sections: [],
      flattened: { params: [], sections: [] },
      dependents: [...dependentPaths],
      otherFilesUnchanged,
      nextSync: stScratch,
      impact: { registry: fwResult.state, workspaces: [] },
      warnings,
      stage,
      forgeRoot: realForgeDir,
      mustHold,
      creates,
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

function findExtendsChain(forge: Forge, targetRecipe: string): string | null {
  // Find a recipe that extends the target
  for (const [name, r] of forge.recipes) {
    if (r.extends?.includes(targetRecipe)) {
      return `${targetRecipe} → ${name}`;
    }
  }
  return null;
}
