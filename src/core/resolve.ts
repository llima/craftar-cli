import type { Forge, LoadedIngredient } from "./forge.js";
import type { IngredientRef, Profile, Sections, Target, WorkspaceConfig } from "../schema/index.js";
import { FORGE_SCHEMA_AGENTS_MD_PRIMARY } from "../schema/index.js";
import { deepMerge } from "./merge.js";
import { abstractRefusal, familyOf, isAbstract, mergedProfile, parentSections } from "./profile-extends.js";
import { readsRecipeSections, recipeSectionLayer, type RecipeSectionLayer } from "./recipe-sections.js";
import { outName } from "../emitters/shared.js";
import { AGENTS_MD_PRIMARY_KEY } from "../emitters/agents-md.js";
import { effectiveProfile, integrationOrigin } from "./integrations.js";
import { readsRulesIndex, RULES_INDEX_KEY } from "./rules-index.js";
import { rendersMetadata } from "./metadata-params.js";
import { forgeFor, ignoredLocalWarning, skippedLinkWarning } from "./profile-local.js";
import { unnamedSectionFileWarning } from "./section-files.js";
import { declaredListKeys, expandYamlItems, renderFiltered, rendersListParams, type ListContext } from "./list-params.js";

/** Builds the "profile not found" message (spec 28 §5.2, N5). */
export function profileNotFoundMessage(profile: string, profileNames: string[]): string {
  const names = profileNames.join(", ") || "none";
  return `profile "${profile}" not found in Forge (${names})`;
}

export interface ResolvedIngredient extends LoadedIngredient {
  /** Recipe chain that brought this ingredient in (last one wins). */
  via: string[];
}

/** Whether the manifest schema reads agents-md.primary (spec 41 §4.1). The ONE comparison with that constant. */
export function readsPrimary(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_AGENTS_MD_PRIMARY;
}

export interface Resolution {
  profile: Profile;
  recipes: string[]; // in application order
  targets: Target[];
  params: Record<string, unknown>;
  /** Section values by `<type>/<outName>`, then name: the profile's deep-merged under the workspace's (spec 11 §6.3). */
  sections: Sections;
  /**
   * The layers `sections` was merged from, kept so `plan()` can name the one that set a value: since spec 54 Part A the
   * recipe layer too (`{}` below Forge schema 10), with the recipe that set each value.
   */
  sectionLayers: { recipes: RecipeSectionLayer; parents: RecipeSectionLayer; profile: Sections; workspace: Sections };
  /**
   * The global layers `params` was merged from, kept so `paramLayer` can name the one that set a key (spec 29
   * §4.1): per key the last recipe with a default, then the profile's and the workspace's own records.
   */
  paramLayers: { recipes: Map<string, string>; profile: Record<string, unknown>; workspace: Record<string, unknown>; profileOf?: Map<string, string> };
  ingredients: ResolvedIngredient[];
  disabled: IngredientRef[];
  warnings: string[];
  /** agents-md.primary is on for this workspace (spec 41 §4.1); decided once by resolve(). */
  primary: boolean;
  /** Whether the Forge reads the rules index (spec 44 §4.1); decided once by resolve(). */
  rulesIndex: boolean;
  /** Whether the Forge renders params in metadata fields (spec 50 §5.1); decided once by resolve(). */
  metadataParams: boolean;
  /** Whether the Forge reads a recipe's sections (spec 54 §4.1); decided once by resolve(). */
  recipeSections: boolean;
  /**
   * Spec 55 §4.2: the keys an ingredient this resolution holds, or a recipe it applies, declares `type: list` — empty below the
   * list-params gate. Decided once by resolve(); `listParamFault` (src/core/list-params.ts) checks their values for `plan()`.
   */
  listKeys: ReadonlySet<string>;
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
export function resolve(root: Forge, ws: WorkspaceConfig): Resolution {
  const own = root.profiles.get(ws.profile);
  if (!own) throw new Error(profileNotFoundMessage(ws.profile, [...root.profiles.keys()]));
  // Spec 54 §5.7: an abstract profile is no workspace's.
  if (isAbstract(root, ws.profile)) throw new Error(abstractRefusal(root, ws.profile));
  // Spec 54 §5.3: the profile as its family makes it; itself when it extends nothing.
  const profile = mergedProfile(root, ws.profile);
  // What this profile sees: its locals over the root (spec 51 §4.3).
  const forge = forgeFor(root, ws.profile);

  // The effective profile once integrations are applied (spec 33 §5.2).
  const eff = effectiveProfile(forge, own);
  const warnings: string[] = [...eff.warnings];
  const ignored = root.ignoredLocals.get(profile.name);
  for (const sub of ignored?.subs ?? []) warnings.push(ignoredLocalWarning(ignored!.folder, sub));
  for (const rel of root.skippedLinks ?? []) warnings.push(skippedLinkWarning(rel));
  // Spec 55 §5.3: a file under this profile's sections/ that no value names — at the section-files gate only; and under
  // its parents' (spec 54 §5.11), which no workspace resolves on its own, so a child is where it is said.
  for (const q of familyOf(root, profile.name)) for (const rel of root.unnamedSectionFiles?.get(q) ?? []) warnings.push(unnamedSectionFileWarning(rel));

  // Check unknown integration recipes before recipes.add (spec 33 §4.3, design.md item 4).
  for (const s of eff.selected) {
    if (!ws.recipes.remove.includes(s.recipe) && !forge.recipes.has(s.recipe)) {
      throw new Error(`recipe "${s.recipe}" not found (referenced by ${integrationOrigin(s.slot, profile.name)})`);
    }
  }

  // recipeOrder takes one origin for the whole list, so a workspace's own names are checked first (spec 22 §14 item 7).
  for (const r of ws.recipes.add)
    if (!ws.recipes.remove.includes(r) && !forge.recipes.has(r)) throw new Error(`recipe "${r}" not found (referenced by craftar.yaml recipes.add)`);
  const wanted = [...eff.recipes, ...ws.recipes.add].filter((r) => !ws.recipes.remove.includes(r));
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
  Object.assign(params, eff.params, ws.overrides.params);

  // Sections: body default → recipes in application order (spec 54 §4.2, at schema 10) → profile → workspace
  // (craftar.yaml under craftar.local.yaml, merged by loadWorkspace). Deep, so a layer setting one section of a key
  // keeps the weaker layers' others (P4).
  const recipeSections = readsRecipeSections(forge.manifest);
  const recipeLayer = recipeSectionLayer(order, (name) => forge.recipes.get(name), recipeSections);
  // Spec 54 §5.5: the profile's parents, farthest first, between the recipes and the profile's own.
  const parents = parentSections(root, ws.profile);
  const sections: Sections = deepMerge(deepMerge(deepMerge(recipeLayer.sections, parents.sections), own.sections), ws.overrides.sections);

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

  // Decide agents-md.primary (spec 41 §4.1): at most one warning, in order
  let primary = false;
  if (Object.hasOwn(params, AGENTS_MD_PRIMARY_KEY)) {
    const value = params[AGENTS_MD_PRIMARY_KEY];
    if (!readsPrimary(forge.manifest)) {
      // Below the gate: warn only when the value is exactly true
      if (value === true) {
        warnings.push("agents-md.primary needs a Forge at schema: 5 — the mode is off");
      }
    } else if (typeof value !== "boolean") {
      // Not a boolean at schema 5+
      warnings.push("agents-md.primary must be true or false — the mode is off");
    } else if (value === true && !targets.includes("agents-md")) {
      // true without the agents-md target
      warnings.push("agents-md.primary has no effect without the agents-md target");
    } else {
      primary = value;
    }
  }

  return {
    profile,
    recipes: order,
    targets,
    params,
    sections,
    sectionLayers: { recipes: recipeLayer, parents, profile: own.sections, workspace: ws.overrides.sections },
    paramLayers: { recipes: recipeParams, profile: eff.params, workspace: ws.overrides.params, profileOf: eff.owners },
    ingredients: [...picked.values()],
    disabled,
    warnings,
    primary,
    rulesIndex: readsRulesIndex(forge.manifest),
    metadataParams: rendersMetadata(forge.manifest),
    recipeSections,
    listKeys: rendersListParams(forge.manifest) ? declaredListKeys([...picked.values()], order.map((n) => forge.recipes.get(n)!)) : new Set<string>(),
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
 * At the rules-index gate (spec 44 §4.2), `craftar.rules.index` is omitted.
 */
export function paramsFor(ing: LoadedIngredient, resolution: Resolution): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(ing.meta.params ?? {})) {
    if (resolution.rulesIndex && k === RULES_INDEX_KEY) continue;
    if (v.default !== undefined) out[k] = v.default;
  }
  for (const [k, v] of Object.entries(resolution.params)) {
    if (resolution.rulesIndex && k === RULES_INDEX_KEY) continue;
    out[k] = v;
  }
  return out;
}

/** The list keys of a resolution as a `ListContext` (spec 55 §4.3), `where` naming the text a refusal comes from. */
export function listsOf(resolution: Pick<Resolution, "listKeys">, where?: string): ListContext {
  return { keys: resolution.listKeys ?? new Set<string>(), where };
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
  if (Object.hasOwn(profile, key)) return { profile: resolution.paramLayers.profileOf?.get(key) ?? resolution.profile.name };
  const recipe = recipes.get(key);
  if (recipe !== undefined) return { recipe };
  const declared = ing.meta.params ?? {};
  return Object.hasOwn(declared, key) && declared[key].default !== undefined ? "default" : "unset";
}

/** The placeholder pattern: `{{key}}` with optional whitespace around the key (spec 08 §6.4). */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Substitute `{{param}}` placeholders. Unknown placeholders are left untouched (and reported by the caller). */
export function substitute(text: string, params: Record<string, unknown>, lists: ListContext, missing?: Set<string>): string {
  // Spec 55 §4.3: with a list key in the resolution, both forms in one pass, `yaml-items` lines first.
  if (lists.keys.size) return renderFiltered(expandYamlItems(text, params, lists, missing), params, lists, missing);
  return text.replace(PLACEHOLDER_RE, (m, key: string) => {
    // Own properties only: `key in params` resolved {{constructor}} to Object.prototype.constructor.
    if (Object.hasOwn(params, key)) return String(params[key]);
    missing?.add(key);
    return m;
  });
}
