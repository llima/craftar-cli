/**
 * The catalogue: every recipe and ingredient of a Forge, marked against a context (spec 16 §4.1–§4.3).
 * Pure data: no console, no process.exit, no picocolors, no file reads.
 */
import type { Forge } from "./forge.js";
import { effectiveProfile, recipesOrWritten } from "./integrations.js";
import { recipeOrder, resolve, type Resolution } from "./resolve.js";
import { outName } from "../emitters/shared.js";
import { forgeFor, readsProfileLocal } from "./profile-local.js";
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
  /** At Forge schema 8 and above only (spec 51 §4.4): where the recipe lives, and its owner. */
  scope?: Scope;
  profile?: string | null;
}

/** A recipe's or an ingredient's place (spec 51 §4.4): the root, or one profile's folder. */
export type Scope = "forge" | "profile";

/**
 * What a listing walks (spec 51 §4.4): the root, then each profile whose locals it shows — the context's profile
 * alone with a context, every profile with locals without one — each with the view that profile sees.
 */
function scopesOf(forge: Forge, context: CatalogueContext | null): Array<{ profile: string | null; view: Forge }> {
  const out: Array<{ profile: string | null; view: Forge }> = [{ profile: null, view: context ? forgeFor(forge, context.profile) : forge }];
  if (!readsProfileLocal(forge.manifest)) return out;
  const owners = context ? [context.profile] : [...forge.locals.keys()].sort();
  for (const p of owners) if (forge.locals.has(p)) out.push({ profile: p, view: forgeFor(forge, p) });
  return out;
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
 * Returns the map and the warnings collected (profile name + text), in Forge profile order.
 */
function computeProfilesForRecipes(forge: Forge): { map: Map<string, string[]>; warnings: { profile: string; text: string }[] } {
  // Keyed by recipe name for a root recipe, `<profile>\0<name>` for a local one: a profile reaches its own locals only.
  const result = new Map<string, string[]>();
  for (const name of forge.recipes.keys()) result.set(name, []);
  for (const [p, layer] of forge.locals) for (const name of layer.recipes.keys()) result.set(`${p}\0${name}`, []);

  const warnings: { profile: string; text: string }[] = [];
  for (const [profileName, profile] of forge.profiles) {
    const { recipes, warning } = recipesOrWritten(forge, profile);
    if (warning !== null) warnings.push({ profile: profileName, text: warning });
    const visited = new Set<string>();
    const stack: string[] = [...recipes];
    const local = forge.locals.get(profileName)?.recipes;
    while (stack.length) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const rec = local?.get(name)?.recipe ?? forge.recipes.get(name);
      if (!rec) continue; // unknown recipe: skip
      result.get(local?.has(name) ? `${profileName}\0${name}` : name)!.push(profileName);
      for (const parent of rec.extends) stack.push(parent);
    }
  }

  // Sort profiles for each recipe
  for (const [name, profiles] of result) {
    result.set(name, [...new Set(profiles)].sort());
  }
  return { map: result, warnings };
}

export function listRecipes(forge: Forge, context: CatalogueContext | null): RecipesListing {
  const forgeJson: ForgeJson = { name: forge.manifest.name, commit: forge.commit };

  const resolves = context !== null && context.resolution !== null;
  const contextJson: ContextJson | null = resolves
    ? { kind: context.kind, profile: context.profile, recipes: context.resolution!.recipes }
    : null;

  const warnings = context ? [...context.warnings] : [];
  const { map: profilesMap, warnings: walkWarnings } = computeProfilesForRecipes(forge);
  // Append walk warnings, but leave out the one for context.profile (catalogueContext already gives it)
  for (const w of walkWarnings) {
    if (w.profile === context?.profile) continue;
    warnings.push(w.text);
  }

  // Build the set of resolved recipes and their reasons
  const resolvedSet = new Set(resolves ? context.resolution!.recipes : []);
  
  // Build extendedBy map (rule 9): only direct children in resolved recipes
  const extendedByMap = new Map<string, string[]>();
  if (resolves) {
    for (const name of context.resolution!.recipes) {
      extendedByMap.set(name, []);
    }
    const view = forgeFor(forge, context.profile);
    for (const name of context.resolution!.recipes) {
      const rec = view.recipes.get(name)!;
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
    // Use the effective recipes for the context's profile (it resolved, so this cannot throw)
    const profileRecipes = new Set(effectiveProfile(forge, forge.profiles.get(context.profile)!).recipes);
    const addRecipes = new Set(config.recipes.add);
    const removeRecipes = new Set(config.recipes.remove);

    for (const name of context.resolution!.recipes) {
      const by: Array<"profile" | "workspace" | "extends"> = [];
      // profile: profile's effective recipes include it AND remove does not name it
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

  const gated = readsProfileLocal(forge.manifest);
  const sortByName = <T extends { name: string }>(list: T[]) => list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const recipes: RecipeEntry[] = [];
  for (const scope of scopesOf(forge, context)) {
    const own = scope.profile === null ? [...forge.recipes.values()] : [...forge.locals.get(scope.profile)!.recipes.values()].map((r) => r.recipe);
    // A local recipe is in use only in its own profile's context, which is the only context that lists it with one.
    const marks = scope.profile === null || scope.profile === context?.profile;
    for (const rec of sortByName(own)) {
      const inUse: RecipeInUse | null = marks && resolvedSet.has(rec.name)
        ? {
            order: context!.resolution!.recipes.indexOf(rec.name) + 1,
            by: byMap.get(rec.name)!,
            extendedBy: extendedByMap.get(rec.name)!,
          }
        : null;
      const entry: RecipeEntry = {
        name: rec.name,
        description: rec.description ?? null,
        slot: rec.slot ?? null,
        extends: rec.extends,
        ingredients: rec.ingredients,
        profiles: profilesMap.get(scope.profile === null ? rec.name : `${scope.profile}\0${rec.name}`) ?? [],
        inUse,
        removedByWorkspace: marks && isRemovedByWorkspace(rec.name),
      };
      if (gated) Object.assign(entry, { scope: scope.profile === null ? "forge" : "profile", profile: scope.profile });
      recipes.push(entry);
    }
  }

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
  /** At Forge schema 8 and above only (spec 51 §4.4). */
  scope?: Scope;
  profile?: string | null;
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

  const gated = readsProfileLocal(forge.manifest);
  const scopes = scopesOf(forge, context);

  // Build recipe chain if --recipe given (rule 11, 12, 13), in the view that holds the recipe (spec 51 §4.4)
  let chain: ChainEntry[] | null = null;
  let chainRefs: Set<string> | null = null;
  let recipeName: string | null = null;
  let chainView: Forge = scopes[0].view;
  let chainOwner: string | null = context?.profile ?? null;

  if (opts?.recipe !== undefined) {
    recipeName = opts.recipe;
    if (!chainView.recipes.has(recipeName)) {
      // With a context the profile sees only its own locals; without one, the one profile that holds the name (spec 51 §4.4).
      const owners = gated && !context ? [...forge.locals].filter(([, l]) => l.recipes.has(recipeName!)).map(([p]) => p).sort() : [];
      if (owners.length > 1) throw new Error(`recipe "${recipeName}" is local to profiles ${owners.join(", ")} — pass --profile`);
      if (owners.length === 1) {
        chainView = forgeFor(forge, owners[0]);
        chainOwner = owners[0];
      }
      else {
        const names = [...chainView.recipes.keys()].sort().join(", ") || "none";
        throw new Error(`recipe "${recipeName}" not found in this Forge (${names})`);
      }
    }
    const view = chainView;

    // Use recipeOrder to get the chain (rule 13)
    const order = recipeOrder(view, [recipeName], "--recipe");

    // Check for slot conflicts (rule 13) - same logic as resolve's slot check
    const slots = new Map<string, string>();
    for (const name of order) {
      const slot = view.recipes.get(name)!.slot;
      if (!slot) continue;
      const prev = slots.get(slot);
      if (prev && prev !== name) {
        warnings.push(`recipes "${prev}" and "${name}" both occupy slot "${slot}" — no workspace can resolve "${recipeName}"`);
      }
      slots.set(slot, name);
    }

    chain = order.map((name) => {
      const rec = view.recipes.get(name)!;
      const ingredients = typeFilter
        ? rec.ingredients.filter((ref) => ref.startsWith(`${typeFilter}/`))
        : rec.ingredients;
      return { recipe: name, ingredients };
    });

    chainRefs = new Set(order.flatMap((name) => view.recipes.get(name)!.ingredients));
  }

  /** ref → the recipes that list it, in one view (all its recipes, sorted, each once). */
  const citing = (view: Forge): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const [name, rec] of view.recipes) {
      for (const ref of rec.ingredients) {
        if (!out.has(ref)) out.set(ref, []);
        const list = out.get(ref)!;
        if (!list.includes(name)) list.push(name);
      }
    }
    for (const [ref, recipes] of out) out.set(ref, recipes.sort());
    return out;
  };

  // Build resolved ingredients set for inUse check
  const resolvedRefs = resolves
    ? new Set(context.resolution!.ingredients.map((i) => i.ref))
    : null;

  // Build disabled set for disabled check
  const disabledRefs = resolves && context && context.kind === "workspace"
    ? new Set(context.config.overrides.ingredients.disable)
    : null;

  const ingredients: IngredientEntry[] = [];
  const missingByRef = new Map<string, string[]>();
  for (const scope of scopes) {
    const own = scope.profile === null ? forge.ingredients : forge.locals.get(scope.profile)!.ingredients;
    // With --recipe, only the scopes of the chain's view, and only what the chain cites (rule 11)
    if (chainRefs && scope.profile !== null && scope.profile !== chainOwner) continue;
    const refToRecipes = citing(scope.view);
    const marks = scope.profile === null || scope.profile === context?.profile;
    const refsToInclude = chainRefs ? [...chainRefs].filter((ref) => own.has(ref as IngredientRef)) : [...own.keys()];
    const entries = refsToInclude
      .map((ref) => own.get(ref as IngredientRef)!)
      .filter((ing) => !typeFilter || ing.meta.type === typeFilter)
      .sort((a, b) => {
        const typeOrder = INGREDIENT_TYPES.indexOf(a.meta.type) - INGREDIENT_TYPES.indexOf(b.meta.type);
        if (typeOrder !== 0) return typeOrder;
        return a.meta.name < b.meta.name ? -1 : a.meta.name > b.meta.name ? 1 : 0;
      })
      .map((ing) => {
        const ref = ing.ref;
        const disabled = marks ? (disabledRefs?.has(ref) ?? false) : false;
        const inUse = resolvedRefs === null || !marks ? null : disabled ? false : resolvedRefs.has(ref);
        const entry: IngredientEntry = {
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
        if (gated) Object.assign(entry, { scope: scope.profile === null ? "forge" : "profile", profile: scope.profile });
        return entry;
      });
    ingredients.push(...entries);

    // Refs the scope's recipes cite that it lacks (rule 11); below schema 8 the root scope alone, as before
    if (scope.profile === null) {
      const cited = chainRefs ? [...chainRefs] : [...new Set([...scope.view.recipes.values()].flatMap((r) => r.ingredients))];
      for (const ref of cited) if (!chainView.ingredients.has(ref as IngredientRef) && !scope.view.ingredients.has(ref as IngredientRef)) missingByRef.set(ref, refToRecipes.get(ref)?.sort() ?? []);
    }
  }

  const missing: MissingEntry[] = [...missingByRef.keys()]
    .filter((ref) => !typeFilter || ref.startsWith(`${typeFilter}/`))
    .sort()
    .map((ref) => ({ ref, recipes: missingByRef.get(ref)! }));

  const recipeJson = recipeName !== null && chain !== null
    ? { name: recipeName, chain }
    : null;

  return { forge: forgeJson, context: contextJson, recipe: recipeJson, ingredients, missing, warnings };
}

/** The warnings of loading the workspace go first, as `plan()` puts them (spec 13 §4.2). Mutates and returns `listing`. */
export function withLoadWarnings<T extends { warnings: string[] }>(listing: T, loadWarnings: readonly string[]): T {
  listing.warnings.unshift(...loadWarnings);
  return listing;
}
