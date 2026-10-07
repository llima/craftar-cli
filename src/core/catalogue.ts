/**
 * The catalogue: every recipe and ingredient of a Forge, marked against a context (spec 16 §4.1–§4.3).
 * Pure data: no console, no process.exit, no picocolors, no file reads.
 */
import type { Forge } from "./forge.js";
import { recipeOrder, resolve, type Resolution } from "./resolve.js";
import { outName } from "../emitters/shared.js";
import { INGREDIENT_TYPES, WorkspaceConfigSchema, type IngredientRef, type IngredientType, type Target, type WorkspaceConfig } from "../schema/index.js";

/* ------------------------------------------------------------------ */
/* Context (spec 16 §4.1)                                               */
/* ------------------------------------------------------------------ */

export type ContextSource = { kind: "workspace"; config: WorkspaceConfig } | { kind: "profile"; profile: string };

export interface CatalogueContext {
  kind: "workspace" | "profile";
  profile: string;
  config: WorkspaceConfig;
  resolution: Resolution | null;
  warnings: string[];
}

/**
 * Build the context the catalogue is marked against (spec 16 §4.1, §5.2).
 * Returns null when source is null.
 * Throws on an unknown profile (same message as resolve).
 * When resolve throws for any other reason, returns context with resolution: null and one warning.
 */
export function catalogueContext(forge: Forge, source: ContextSource | null): CatalogueContext | null {
  if (source === null) return null;

  const profile = source.kind === "profile" ? source.profile : source.config.profile;
  
  // Profile lookup first (rule 2): throw resolve's message if absent
  if (!forge.profiles.has(profile)) {
    const names = [...forge.profiles.keys()].join(", ") || "none";
    throw new Error(`profile "${profile}" not found in Forge (${names})`);
  }

  const config = source.kind === "profile"
    ? WorkspaceConfigSchema.parse({ forge: forge.root, profile })
    : source.config;

  try {
    const resolution = resolve(forge, config);
    return { kind: source.kind, profile, config, resolution, warnings: resolution.warnings };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const prefix = source.kind === "workspace"
      ? `cannot resolve this workspace (profile ${profile})`
      : `cannot resolve profile ${profile}`;
    return { kind: source.kind, profile, config, resolution: null, warnings: [`${prefix}: ${message} — nothing is marked as in use`] };
  }
}

/* ------------------------------------------------------------------ */
/* listRecipes (spec 16 §4.2)                                           */
/* ------------------------------------------------------------------ */

export interface ForgeJson {
  name: string;
  commit: string | null;
}

export interface ContextJson {
  kind: "workspace" | "profile";
  profile: string;
  recipes: string[];
}

export interface RecipeInUse {
  order: number;
  by: Array<"profile" | "workspace" | "extends">;
  extendedBy: string[];
}

export interface RecipeEntry {
  name: string;
  description: string | null;
  slot: string | null;
  extends: string[];
  ingredients: string[];
  profiles: string[];
  inUse: RecipeInUse | null;
  removedByWorkspace: boolean;
}

export interface RecipesListing {
  forge: ForgeJson;
  context: ContextJson | null;
  recipes: RecipeEntry[];
  warnings: string[];
}

/**
 * Compute which profiles reach a recipe, directly or through extends (rule 8).
 * Tolerant depth-first walk: skips unknown recipes, stops on cycles.
 */
function computeProfilesForRecipes(forge: Forge): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const name of forge.recipes.keys()) result.set(name, []);

  for (const [profileName, profile] of forge.profiles) {
    const visited = new Set<string>();
    const stack: string[] = [...profile.recipes];
    while (stack.length) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const rec = forge.recipes.get(name);
      if (!rec) continue; // unknown recipe: skip
      result.get(name)!.push(profileName);
      for (const parent of rec.extends) stack.push(parent);
    }
  }

  // Sort profiles for each recipe
  for (const [name, profiles] of result) {
    result.set(name, [...new Set(profiles)].sort());
  }
  return result;
}

export function listRecipes(forge: Forge, context: CatalogueContext | null): RecipesListing {
  const forgeJson: ForgeJson = { name: forge.manifest.name, commit: forge.commit };

  const resolves = context !== null && context.resolution !== null;
  const contextJson: ContextJson | null = resolves
    ? { kind: context.kind, profile: context.profile, recipes: context.resolution!.recipes }
    : null;

  const warnings = context ? [...context.warnings] : [];
  const profilesMap = computeProfilesForRecipes(forge);

  // Build the set of resolved recipes and their reasons
  const resolvedSet = new Set(resolves ? context.resolution!.recipes : []);
  
  // Build extendedBy map (rule 9): only direct children in resolved recipes
  const extendedByMap = new Map<string, string[]>();
  if (resolves) {
    for (const name of context.resolution!.recipes) {
      extendedByMap.set(name, []);
    }
    for (const name of context.resolution!.recipes) {
      const rec = forge.recipes.get(name)!;
      for (const parent of rec.extends) {
        if (resolvedSet.has(parent)) {
          extendedByMap.get(parent)!.push(name);
        }
      }
    }
  }

  // Build by reasons (rule 9): profile, workspace, extends — in that order, each once
  const byMap = new Map<string, Array<"profile" | "workspace" | "extends">>();
  if (resolves && context) {
    const config = context.config;
    const profileRecipes = new Set(forge.profiles.get(context.profile)?.recipes ?? []);
    const addRecipes = new Set(config.recipes.add);
    const removeRecipes = new Set(config.recipes.remove);

    for (const name of context.resolution!.recipes) {
      const by: Array<"profile" | "workspace" | "extends"> = [];
      // profile: profile lists it AND remove does not name it
      if (profileRecipes.has(name) && !removeRecipes.has(name)) by.push("profile");
      // workspace: add lists it AND remove does not name it
      if (addRecipes.has(name) && !removeRecipes.has(name)) by.push("workspace");
      // extends: extendedBy is non-empty
      if (extendedByMap.get(name)!.length > 0) by.push("extends");
      byMap.set(name, by);
    }
  }

  // removedByWorkspace (rule 10): context is workspace AND config.recipes.remove includes it
  const isRemovedByWorkspace = (name: string): boolean => {
    if (!resolves || !context || context.kind !== "workspace") return false;
    return context.config.recipes.remove.includes(name);
  };

  const recipes: RecipeEntry[] = [...forge.recipes.values()]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((rec) => {
      const inUse: RecipeInUse | null = resolvedSet.has(rec.name)
        ? {
            order: context!.resolution!.recipes.indexOf(rec.name) + 1,
            by: byMap.get(rec.name)!,
            extendedBy: extendedByMap.get(rec.name)!,
          }
        : null;

      return {
        name: rec.name,
        description: rec.description ?? null,
        slot: rec.slot ?? null,
        extends: rec.extends,
        ingredients: rec.ingredients,
        profiles: profilesMap.get(rec.name) ?? [],
        inUse,
        removedByWorkspace: isRemovedByWorkspace(rec.name),
      };
    });

  return { forge: forgeJson, context: contextJson, recipes, warnings };
}

/* ------------------------------------------------------------------ */
/* listIngredients (spec 16 §4.3)                                       */
/* ------------------------------------------------------------------ */

export interface IngredientEntry {
  ref: IngredientRef;
  type: IngredientType;
  name: string;
  outputName: string;
  description: string | null;
  targets: "*" | Target[];
  recipes: string[];
  inUse: boolean | null;
  disabled: boolean;
}

export interface MissingEntry {
  ref: string;
  recipes: string[];
}

export interface ChainEntry {
  recipe: string;
  ingredients: string[];
}

export interface IngredientsListing {
  forge: ForgeJson;
  context: ContextJson | null;
  recipe: { name: string; chain: ChainEntry[] } | null;
  ingredients: IngredientEntry[];
  missing: MissingEntry[];
  warnings: string[];
}

/** Validate the --type option (rule 14): throws the named message. */
export function checkType(type: string): asserts type is IngredientType {
  if (!(INGREDIENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unknown ingredient type "${type}" — one of ${INGREDIENT_TYPES.join(", ")}`);
  }
}

export function listIngredients(
  forge: Forge,
  context: CatalogueContext | null,
  opts?: { recipe?: string; type?: string },
): IngredientsListing {
  const forgeJson: ForgeJson = { name: forge.manifest.name, commit: forge.commit };

  const resolves = context !== null && context.resolution !== null;
  const contextJson: ContextJson | null = resolves
    ? { kind: context.kind, profile: context.profile, recipes: context.resolution!.recipes }
    : null;

  const warnings = context ? [...context.warnings] : [];

  // Validate --type before --recipe (rule 15)
  if (opts?.type !== undefined) {
    checkType(opts.type);
  }
  const typeFilter = opts?.type as IngredientType | undefined;

  // Build recipe chain if --recipe given (rule 11, 12, 13)
  let chain: ChainEntry[] | null = null;
  let chainRefs: Set<string> | null = null;
  let recipeName: string | null = null;

  if (opts?.recipe !== undefined) {
    recipeName = opts.recipe;
    if (!forge.recipes.has(recipeName)) {
      const names = [...forge.recipes.keys()].sort().join(", ") || "none";
      throw new Error(`recipe "${recipeName}" not found in this Forge (${names})`);
    }

    // Use recipeOrder to get the chain (rule 13)
    const order = recipeOrder(forge, [recipeName], "--recipe");

    // Check for slot conflicts (rule 13) - same logic as resolve's slot check
    const slots = new Map<string, string>();
    for (const name of order) {
      const slot = forge.recipes.get(name)!.slot;
      if (!slot) continue;
      const prev = slots.get(slot);
      if (prev && prev !== name) {
        warnings.push(`recipes "${prev}" and "${name}" both occupy slot "${slot}" — no workspace can resolve "${recipeName}"`);
      }
      slots.set(slot, name);
    }

    chain = order.map((name) => {
      const rec = forge.recipes.get(name)!;
      const ingredients = typeFilter
        ? rec.ingredients.filter((ref) => ref.startsWith(`${typeFilter}/`))
        : rec.ingredients;
      return { recipe: name, ingredients };
    });

    chainRefs = new Set(order.flatMap((name) => forge.recipes.get(name)!.ingredients));
  }

  // Build map of ref → recipes that list it (all Forge recipes, sorted, each once)
  const refToRecipes = new Map<string, string[]>();
  for (const [name, rec] of forge.recipes) {
    for (const ref of rec.ingredients) {
      if (!refToRecipes.has(ref)) refToRecipes.set(ref, []);
      const list = refToRecipes.get(ref)!;
      if (!list.includes(name)) list.push(name);
    }
  }
  for (const [ref, recipes] of refToRecipes) {
    refToRecipes.set(ref, recipes.sort());
  }

  // Determine which refs to include (all Forge ingredients, or union of chain)
  const refsToInclude = chainRefs
    ? [...chainRefs].filter((ref) => forge.ingredients.has(ref as IngredientRef))
    : [...forge.ingredients.keys()];

  // Build resolved ingredients set for inUse check
  const resolvedRefs = resolves
    ? new Set(context.resolution!.ingredients.map((i) => i.ref))
    : null;

  // Build disabled set for disabled check
  const disabledRefs = resolves && context && context.kind === "workspace"
    ? new Set(context.config.overrides.ingredients.disable)
    : null;

  // Build ingredients list (rule 11)
  const ingredients: IngredientEntry[] = refsToInclude
    .map((ref) => forge.ingredients.get(ref as IngredientRef)!)
    .filter((ing) => !typeFilter || ing.meta.type === typeFilter)
    .sort((a, b) => {
      const typeOrder = INGREDIENT_TYPES.indexOf(a.meta.type) - INGREDIENT_TYPES.indexOf(b.meta.type);
      if (typeOrder !== 0) return typeOrder;
      return a.meta.name < b.meta.name ? -1 : a.meta.name > b.meta.name ? 1 : 0;
    })
    .map((ing) => {
      const ref = ing.ref;
      const disabled = disabledRefs?.has(ref) ?? false;
      const inUse = resolvedRefs === null
        ? null
        : disabled
          ? false
          : resolvedRefs.has(ref);

      return {
        ref,
        type: ing.meta.type,
        name: ing.meta.name,
        outputName: outName(ing.meta),
        description: ing.meta.description ?? null,
        targets: ing.meta.targets,
        recipes: refToRecipes.get(ref)?.sort() ?? [],
        inUse,
        disabled,
      };
    });

  // Build missing list (rule 11): refs recipes cite that the Forge lacks
  const allMissingRefs = chainRefs
    ? [...chainRefs].filter((ref) => !forge.ingredients.has(ref as IngredientRef))
    : [...new Set([...forge.recipes.values()].flatMap((r) => r.ingredients))]
        .filter((ref) => !forge.ingredients.has(ref as IngredientRef));

  const missing: MissingEntry[] = allMissingRefs
    .filter((ref) => !typeFilter || ref.startsWith(`${typeFilter}/`))
    .sort()
    .map((ref) => ({
      ref,
      recipes: refToRecipes.get(ref)?.sort() ?? [],
    }));

  const recipeJson = recipeName !== null && chain !== null
    ? { name: recipeName, chain }
    : null;

  return { forge: forgeJson, context: contextJson, recipe: recipeJson, ingredients, missing, warnings };
}
