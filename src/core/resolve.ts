import type { Forge, LoadedIngredient } from "./forge.js";
import type { IngredientRef, Profile, Sections, Target, WorkspaceConfig } from "../schema/index.js";
import { deepMerge } from "./merge.js";
import { outName } from "../emitters/shared.js";

/** Builds the "profile not found" message (spec 28 §5.2, N5). */
export function profileNotFoundMessage(profile: string, profileNames: string[]): string {
  const names = profileNames.join(", ") || "none";
  return `profile "${profile}" not found in Forge (${names})`;
}

export interface ResolvedIngredient extends LoadedIngredient {
  /** Recipe chain that brought this ingredient in (last one wins). */
  via: string[];
}

export interface Resolution {
  profile: Profile;
  recipes: string[]; // in application order
  targets: Target[];
  params: Record<string, unknown>;
  /** Section values by `<type>/<outName>`, then name: the profile's deep-merged under the workspace's (spec 11 §6.3). */
  sections: Sections;
  /** The two layers `sections` was merged from, kept so `plan()` can name the one that set a value. */
  sectionLayers: { profile: Sections; workspace: Sections };
  /**
   * The global layers `params` was merged from, kept so `paramLayer` can name the one that set a key (spec 29
   * §4.1): per key the last recipe with a default, then the profile's and the workspace's own records.
   */
  paramLayers: { recipes: Map<string, string>; profile: Record<string, unknown>; workspace: Record<string, unknown> };
  ingredients: ResolvedIngredient[];
  disabled: IngredientRef[];
  warnings: string[];
}

/**
 * Depth-first `extends` walk: returns recipes in application order (parents before children).
 * Throws on a cycle or an unknown recipe, with the same two messages `resolve()` produced.
 * @param forge  The Forge to look recipes up in.
 * @param wanted The top-level recipes to walk (profile's + workspace's add, minus remove).
 * @param origin A human-readable string for the "referenced by" part of the not-found error.
 */
export function recipeOrder(forge: Forge, wanted: string[], origin: string): string[] {
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string, chain: string[]) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) throw new Error(`recipe cycle: ${[...chain, name].join(" → ")}`);
    const r = forge.recipes.get(name);
    if (!r) throw new Error(`recipe "${name}" not found (referenced by ${chain.at(-1) ?? origin})`);
    visiting.add(name);
    for (const parent of r.extends) visit(parent, [...chain, name]);
    visiting.delete(name);
    order.push(name);
  };
  for (const r of wanted) visit(r, []);
  return order;
}

/**
 * Layer order (weak → strong): ingredient defaults (scoped to that ingredient, see `paramsFor`) →
 * base recipes → stack recipes → profile → workspace → local.
 * Recipes are expanded depth-first through `extends`, each recipe applied once.
 */
export function resolve(forge: Forge, ws: WorkspaceConfig): Resolution {
  const profile = forge.profiles.get(ws.profile);
  if (!profile) throw new Error(profileNotFoundMessage(ws.profile, [...forge.profiles.keys()]));

  const warnings: string[] = [];
  // recipeOrder takes one origin for the whole list, so a workspace's own names are checked first (spec 22 §14 item 7).
  for (const r of ws.recipes.add)
    if (!ws.recipes.remove.includes(r) && !forge.recipes.has(r)) throw new Error(`recipe "${r}" not found (referenced by craftar.yaml recipes.add)`);
  const wanted = [...profile.recipes, ...ws.recipes.add].filter((r) => !ws.recipes.remove.includes(r));
  const order = recipeOrder(forge, wanted, `profile ${profile.name}`);

  // Slot exclusivity
  const slots = new Map<string, string>();
  for (const name of order) {
    const slot = forge.recipes.get(name)!.slot;
    if (!slot) continue;
    const prev = slots.get(slot);
    if (prev && prev !== name) throw new Error(`recipes "${prev}" and "${name}" both occupy slot "${slot}"`);
    slots.set(slot, name);
  }

  // Params: recipe defaults (in order) → profile → workspace overrides
  const params: Record<string, unknown> = {};
  const recipeParams = new Map<string, string>(); // key → the last recipe giving it a default
  for (const name of order) {
    for (const [k, v] of Object.entries(forge.recipes.get(name)!.params)) {
      if (v.default === undefined) continue;
      params[k] = v.default;
      recipeParams.set(k, name);
    }
  }
  Object.assign(params, profile.params, ws.overrides.params);

  // Sections: body default → profile → workspace (craftar.yaml under craftar.local.yaml, merged by
  // loadWorkspace). Deep, so a workspace setting one section of a key keeps the profile's others (P4).
  const sections: Sections = deepMerge(profile.sections, ws.overrides.sections);

  // Ingredients
  const disabled = ws.overrides.ingredients.disable as IngredientRef[];
  const picked = new Map<IngredientRef, ResolvedIngredient>();
  for (const name of order) {
    for (const refStr of forge.recipes.get(name)!.ingredients) {
      const ref = refStr as IngredientRef;
      const ing = forge.ingredients.get(ref);
      if (!ing) {
        warnings.push(`recipe "${name}" references missing ingredient ${ref}`);
        continue;
      }
      const prev = picked.get(ref);
      picked.set(ref, { ...ing, via: prev ? [...prev.via, name] : [name] });
    }
  }
  for (const d of disabled) picked.delete(d);

  const targets = [...new Set(ws.targets ?? profile.targets)] as Target[];
  return {
    profile,
    recipes: order,
    targets,
    params,
    sections,
    sectionLayers: { profile: profile.sections, workspace: ws.overrides.sections },
    paramLayers: { recipes: recipeParams, profile: profile.params, workspace: ws.overrides.params },
    ingredients: [...picked.values()],
    disabled,
    warnings,
  };
}

/** The key an ingredient's section values live under: `<type>/<outName>`, shared by a base and its variants (spec 11 §3, §6.3). */
export function sectionKey(meta: { type: string; name: string; as?: string }): string {
  return `${meta.type}/${outName(meta)}`;
}

/** The section values that apply to one ingredient's files for this workspace (spec 11 §6.3). */
export function sectionsFor(ing: LoadedIngredient, resolution: Resolution): Record<string, string> {
  const key = sectionKey(ing.meta);
  return Object.hasOwn(resolution.sections, key) ? resolution.sections[key] : {};
}

/**
 * The params one ingredient's files resolve against: its declared defaults, then every global
 * layer (spec 09 §5.4). Scoped — another ingredient never sees these defaults.
 */
export function paramsFor(ing: LoadedIngredient, resolution: Resolution): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(ing.meta.params ?? {})) if (v.default !== undefined) out[k] = v.default;
  for (const [k, v] of Object.entries(resolution.params)) out[k] = v;
  return out;
}

/** The layer that fills a parameter for one ingredient; `workspace` is either workspace file. */
export type ParamLayer = "default" | "workspace" | "unset" | { recipe: string } | { profile: string };

/**
 * Which layer `paramsFor` took `key` from for this ingredient, strongest first (spec 29 §4.1, for `explain`) —
 * the same order `resolve()` and `paramsFor` apply, read off the layers instead of the merged record.
 */
export function paramLayer(key: string, ing: LoadedIngredient, resolution: Resolution): ParamLayer {
  const { recipes, profile, workspace } = resolution.paramLayers;
  if (Object.hasOwn(workspace, key)) return "workspace";
  if (Object.hasOwn(profile, key)) return { profile: resolution.profile.name };
  const recipe = recipes.get(key);
  if (recipe !== undefined) return { recipe };
  const declared = ing.meta.params ?? {};
  return Object.hasOwn(declared, key) && declared[key].default !== undefined ? "default" : "unset";
}

/** Substitute `{{param}}` placeholders. Unknown placeholders are left untouched (and reported by the caller). */
export function substitute(text: string, params: Record<string, unknown>, missing?: Set<string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key: string) => {
    // Own properties only: `key in params` resolved {{constructor}} to Object.prototype.constructor.
    if (Object.hasOwn(params, key)) return String(params[key]);
    missing?.add(key);
    return m;
  });
}
