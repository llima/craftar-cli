/**
 * Profile-local ingredients and recipes (spec 51 Part A): the gate, the load-time checks L1–L9 and their typed error.
 * Pure: no file system access here — `loadForge` reads the folders and hands their contents in.
 */
import type { IngredientRef, Recipe } from "../schema/index.js";
import { FORGE_SCHEMA_PROFILE_LOCAL } from "../schema/index.js";
import { nameShaped } from "./integrations.js";
import type { Forge, LoadedIngredient } from "./forge.js";

/** Whether the Forge reads `profiles/<p>/ingredients` and `recipes` (spec 51 §4.1). The ONE comparison with that constant. */
export function readsProfileLocal(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_PROFILE_LOCAL;
}

/** A local recipe: the schema's `Recipe` and its Forge-relative POSIX file. */
export interface LocalRecipe {
  recipe: Recipe;
  file: string;
}

/** What one profile's folder holds (spec 51 §4.2). */
export interface LocalLayer {
  ingredients: Map<IngredientRef, LoadedIngredient>;
  recipes: Map<string, LocalRecipe>;
}

/** The folders below the gate that a profile holds and the Forge does not read (spec 51 §4.1), by profile name, with the folder that holds them. */
export type IgnoredLocals = Map<string, { folder: string; subs: Array<"ingredients" | "recipes"> }>;

/** The warning `resolve()` gives the workspace's own profile below the gate (spec 51 §4.1), naming the folder as it is on disk. */
export function ignoredLocalWarning(folder: string, sub: "ingredients" | "recipes"): string {
  return `profiles/${folder}/${sub}: ignored below schema ${FORGE_SCHEMA_PROFILE_LOCAL}`;
}

/** A Forge whose profile-local layer does not load (spec 51 §4.2): every finding, one per line. Not a `SchemaError`, and holds no zod issues. */
export class ProfileLocalLoadError extends Error {
  constructor(readonly findings: string[]) {
    super(findings.join("\n"));
    this.name = "ProfileLocalLoadError";
  }
}

/** The one-line form of a profile-local load error: the first finding and how many follow. */
export function oneLineOfFindings(e: ProfileLocalLoadError): string {
  const n = e.findings.length;
  return `${e.findings[0]}${n > 1 ? ` (and ${n - 1} more)` : ""}`;
}

/** A name read from a file, printed only when shaped like one (spec 51 §4.2); `what` says what it is otherwise. */
export function shownLocalName(name: string, what: string): string {
  return nameShaped(name) ? name : `a ${what} (not shown: not shaped like a name)`;
}

/** A ref `<type>/<name>` printed only when both halves are shaped like names. */
export function shownIngredientRef(ref: string): string {
  const [type, name, ...rest] = ref.split("/");
  return rest.length === 0 && name !== undefined && nameShaped(type) && nameShaped(name) ? ref : "a ref (not shown: not shaped like a name)";
}

/** What the root holds, as the checks need it: recipe files are Forge-relative and POSIX. */
export interface RootView {
  ingredients: ReadonlyMap<IngredientRef, LoadedIngredient>;
  ingredientPaths: ReadonlyMap<IngredientRef, string>;
  recipes: ReadonlyMap<string, Recipe>;
  recipeFiles: ReadonlyMap<string, string>;
}

/** One local of one profile, as `loadForge` found it, before L1–L9. */
export interface FoundLocal {
  profile: string;
  ingredient?: { ing: LoadedIngredient; path: string };
  recipe?: LocalRecipe;
}

/**
 * L1–L6 and L9 (spec 51 §4.2) over a whole Forge: every finding, in a stable order. L7 and L8 are about folders and
 * are decided by `loadForge` while it walks them; it passes those findings in so one error names them all.
 */
export function checkLocals(root: RootView, locals: ReadonlyMap<string, LocalLayer>, localPaths: ReadonlyMap<string, ReadonlyMap<IngredientRef, string>>, early: string[]): string[] {
  const findings = [...early];
  const localRefsAnywhere = new Map<string, string[]>(); // ref → its paths in every profile
  const localRecipesAnywhere = new Map<string, string[]>(); // name → its files in every profile
  for (const [p, layer] of locals) {
    for (const ref of layer.ingredients.keys()) {
      const at = localPaths.get(p)?.get(ref) ?? `profiles/${p}`;
      localRefsAnywhere.set(ref, [...(localRefsAnywhere.get(ref) ?? []), at]);
    }
    for (const [name, r] of layer.recipes) localRecipesAnywhere.set(name, [...(localRecipesAnywhere.get(name) ?? []), r.file]);
  }

  // L6: a local is not a variant.
  for (const [p, layer] of locals) {
    for (const [ref, ing] of layer.ingredients) {
      const at = localPaths.get(p)?.get(ref) ?? `profiles/${p}`;
      if (ing.meta.name.includes("--") || ing.meta.as !== undefined) findings.push(`L6 ${at}: a local ingredient's name holds no "--" and it declares no "as" — it is not a variant`);
    }
  }

  // L1, L2: a local never shadows the root.
  for (const [p, layer] of locals) {
    for (const ref of layer.ingredients.keys()) {
      const at = localPaths.get(p)?.get(ref) ?? `profiles/${p}`;
      const rootAt = root.ingredientPaths.get(ref);
      if (rootAt !== undefined) findings.push(`L1 ${at} and ${rootAt}: the same ingredient, local to profile ${shownLocalName(p, "profile")} and at the root`);
      const variant = `${ref}--${p}` as IngredientRef;
      const vAt = root.ingredients.has(variant) ? root.ingredientPaths.get(variant) : undefined;
      if (vAt !== undefined) findings.push(`L1 ${at} and ${vAt}: a local ingredient and the root variant of the same name for its own profile`);
    }
    for (const [name, r] of layer.recipes) {
      const rootFile = root.recipeFiles.get(name);
      if (root.recipes.has(name)) findings.push(`L2 ${r.file} and ${rootFile ?? "recipes/"}: the same recipe, local to profile ${shownLocalName(p, "profile")} and at the root`);
    }
  }

  // L3, L4 for root recipes: a root recipe sees the root only.
  for (const [name, r] of root.recipes) {
    const file = root.recipeFiles.get(name) ?? "recipes/";
    for (const ref of r.ingredients) {
      if (root.ingredients.has(ref as IngredientRef)) continue;
      const localAt = localRefsAnywhere.get(ref);
      if (localAt) findings.push(`L3 ${file}: cites ${shownIngredientRef(ref)}, which is local (${localAt.join(", ")}) — a root recipe does not see a profile's ingredients`);
      else findings.push(`L4 ${file}: cites ${shownIngredientRef(ref)}, which does not exist`);
    }
    for (const parent of r.extends) {
      if (root.recipes.has(parent)) continue;
      const localAt = localRecipesAnywhere.get(parent);
      if (localAt) findings.push(`L3 ${file}: extends ${shownLocalName(parent, "recipe name")}, which is local (${localAt.join(", ")}) — a root recipe does not see a profile's recipes`);
      else findings.push(`L4 ${file}: extends ${shownLocalName(parent, "recipe name")}, which does not exist`);
    }
  }

  // L4 for local recipes: a local recipe sees its profile's locals and the root, never another profile's.
  for (const [p, layer] of locals) {
    for (const r of layer.recipes.values()) {
      for (const ref of r.recipe.ingredients) {
        if (layer.ingredients.has(ref as IngredientRef) || root.ingredients.has(ref as IngredientRef)) continue;
        findings.push(`L4 ${r.file}: cites ${shownIngredientRef(ref)}, which profile ${shownLocalName(p, "profile")} does not have`);
      }
      for (const parent of r.recipe.extends) {
        if (layer.recipes.has(parent) || root.recipes.has(parent)) continue;
        findings.push(`L4 ${r.file}: extends ${shownLocalName(parent, "recipe name")}, which profile ${shownLocalName(p, "profile")} does not have`);
      }
    }
  }

  // L5: no extends cycle, at the root or in any profile's view.
  const cycles = new Set<string>();
  const walk = (get: (n: string) => Recipe | undefined, names: Iterable<string>) => {
    const done = new Set<string>();
    const visit = (name: string, chain: string[]) => {
      if (done.has(name)) return;
      const at = chain.indexOf(name);
      if (at >= 0) {
        cycles.add([...chain.slice(at), name].map((n) => shownLocalName(n, "recipe name")).join(" → "));
        return;
      }
      const r = get(name);
      if (!r) return;
      for (const parent of r.extends) visit(parent, [...chain, name]);
      done.add(name);
    };
    for (const n of names) visit(n, []);
  };
  walk((n) => root.recipes.get(n), root.recipes.keys());
  for (const layer of locals.values()) walk((n) => layer.recipes.get(n)?.recipe ?? root.recipes.get(n), layer.recipes.keys());
  for (const c of [...cycles].sort()) findings.push(`L5 recipe cycle: ${c}`);

  return findings;
}

/** What one profile sees (spec 51 §4.3): its locals over the root. A plain `Forge` does not satisfy a reader that requires it. */
export type ProfileView = Forge & { readonly view: string };

/**
 * The one answer to "what does this profile see": the root's maps with the profile's locals added. L1, L2 and L9 keep
 * them disjoint, so the order of the merge decides nothing. Without locals the maps are the root's own.
 */
export function forgeFor(forge: Forge, profile: string): ProfileView {
  const seen = (forge as Partial<ProfileView>).view;
  if (seen === profile) return forge as ProfileView;
  if (seen !== undefined) throw new Error(`internal: a view of profile ${seen} asked for profile ${profile}`);
  const layer = forge.locals.get(profile);
  if (!layer || (layer.ingredients.size === 0 && layer.recipes.size === 0)) return { ...forge, view: profile };
  const ingredients = new Map(forge.ingredients);
  for (const [ref, ing] of layer.ingredients) ingredients.set(ref, ing);
  const recipes = new Map(forge.recipes);
  for (const [name, r] of layer.recipes) recipes.set(name, r.recipe);
  return { ...forge, ingredients, recipes, view: profile };
}

/** The profiles that hold `ref` as a local, sorted (spec 51 §4.5). */
export function localOwners(forge: Forge, ref: string): string[] {
  return [...forge.locals].filter(([, l]) => l.ingredients.has(ref as IngredientRef)).map(([p]) => p).sort();
}

/** `<ref> is local to profile <p>` (or `to profiles <p>, <q>`): what a Forge-wide command says of a local (spec 51 §4.5). */
export function isLocalMessage(ref: string, owners: string[]): string {
  return `${shownIngredientRef(ref)} is local to ${owners.length === 1 ? "profile" : "profiles"} ${owners.map((p) => shownLocalName(p, "profile")).join(", ")}`;
}

/**
 * The local recipes that cite one of `refs` (spec 51 §4.5) — or, with `viaExtends`, reach one through `extends` in
 * their profile's view — for every profile, or for `profile` alone. Each is named by its Forge-relative file.
 */
export function localCiters(forge: Forge, refs: readonly string[], opts: { profile?: string; viaExtends?: boolean } = {}): Array<{ profile: string; recipe: string; file: string }> {
  const out: Array<{ profile: string; recipe: string; file: string }> = [];
  const wanted = new Set(refs);
  for (const [p, layer] of forge.locals) {
    if (opts.profile !== undefined && p !== opts.profile) continue;
    const view = forgeFor(forge, p);
    const reaches = (name: string, seen: Set<string>): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const r = view.recipes.get(name);
      if (!r) return false;
      if (r.ingredients.some((i) => wanted.has(i))) return true;
      return opts.viaExtends === true && r.extends.some((parent) => reaches(parent, seen));
    };
    for (const [name, r] of layer.recipes) if (reaches(name, new Set())) out.push({ profile: p, recipe: name, file: r.file });
  }
  return out;
}

/** Whether a recipe name is held as a local by any profile (spec 51 §4.5): a root recipe of that name would be L2. */
export function localRecipeNamed(forge: Forge, name: string): boolean {
  return [...forge.locals.values()].some((l) => l.recipes.has(name));
}
