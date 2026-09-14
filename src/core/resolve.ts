import type { Forge, LoadedIngredient } from "./forge.js";
import type { IngredientRef, Profile, Target, WorkspaceConfig } from "../schema/index.js";

export interface ResolvedIngredient extends LoadedIngredient {
  /** Recipe chain that brought this ingredient in (last one wins). */
  via: string[];
}

export interface Resolution {
  profile: Profile;
  recipes: string[]; // in application order
  targets: Target[];
  params: Record<string, unknown>;
  ingredients: ResolvedIngredient[];
  disabled: IngredientRef[];
  warnings: string[];
}

/**
 * Layer order (weak → strong): base recipes → stack recipes → profile → workspace → local.
 * Recipes are expanded depth-first through `extends`, each recipe applied once.
 */
export function resolve(forge: Forge, ws: WorkspaceConfig): Resolution {
  const profile = forge.profiles.get(ws.profile);
  if (!profile) throw new Error(`profile "${ws.profile}" not found in Forge (${[...forge.profiles.keys()].join(", ") || "none"})`);

  const warnings: string[] = [];
  const wanted = [...profile.recipes, ...ws.recipes.add].filter((r) => !ws.recipes.remove.includes(r));

  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string, chain: string[]) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) throw new Error(`recipe cycle: ${[...chain, name].join(" → ")}`);
    const r = forge.recipes.get(name);
    if (!r) throw new Error(`recipe "${name}" not found (referenced by ${chain.at(-1) ?? "profile " + profile.name})`);
    visiting.add(name);
    for (const parent of r.extends) visit(parent, [...chain, name]);
    visiting.delete(name);
    order.push(name);
  };
  for (const r of wanted) visit(r, []);

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
  for (const name of order) {
    for (const [k, v] of Object.entries(forge.recipes.get(name)!.params)) if (v.default !== undefined) params[k] = v.default;
  }
  Object.assign(params, profile.params, ws.overrides.params);

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

  const targets = (ws.targets ?? profile.targets) as Target[];
  return { profile, recipes: order, targets, params, ingredients: [...picked.values()], disabled, warnings };
}

/** Substitute `{{param}}` placeholders. Unknown placeholders are left untouched (and reported by the caller). */
export function substitute(text: string, params: Record<string, unknown>, missing?: Set<string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key: string) => {
    if (key in params) return String(params[key]);
    missing?.add(key);
    return m;
  });
}
