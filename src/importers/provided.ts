/**
 * What the profile's `integrations` block alone brings in (spec 33 §5.3). A source whose every
 * resolved ingredient matches a key here is not scanned, not compared, not inferred from, not
 * written, not placed in any recipe list.
 *
 * This module needs `resolve()` and `recipeOrder`, which `integrations.ts` must not import.
 */

import { WorkspaceConfigSchema, type IngredientRef } from "../schema/index.js";
import { effectiveProfile } from "../core/integrations.js";
import { recipeOrder, resolve } from "../core/resolve.js";
import type { Forge } from "../core/forge.js";
import { outName } from "../emitters/shared.js";

/** One entry of `leftToRecipes`: a recipe of the integration set, with the refs it holds. */
export interface Provided {
  recipe: string;
  slot: string;
  refs: string[];
}

/**
 * What the profile's block alone brings in (spec 33 §3), keyed `<type>/<outName>`. Empty below the
 * gate, for a block with no `kind`, and for a key some ingredient outside the integration set also
 * writes.
 *
 * Throws what `effectiveProfile` and `resolve` throw.
 */
export function providedByBlock(forge: Forge, profileName: string): Map<string, Provided> {
  const profile = forge.profiles.get(profileName);
  if (!profile) return new Map();

  const eff = effectiveProfile(forge, profile);
  // Below the gate or no kind selected: nothing is provided by the block alone.
  if (!eff.selected.length) return new Map();

  // The resolution is the profile's alone: no workspace overrides.
  const ws = WorkspaceConfigSchema.parse({ forge: ".", profile: profileName });
  const resolution = resolve(forge, ws);

  // The profile's written recipes: what the profile lists and extends brings, without the block.
  const writtenRecipes = new Set(recipeOrder(forge, profile.recipes, `profile ${profileName}`));

  // The integration set: recipes the block alone adds, in block order — each `selected` entry's
  // `extends` walk minus what the profile's written recipes cover.
  const integrationSet = new Set<string>();
  const recipeToSlot = new Map<string, string>(); // recipe → the slot whose closure holds it first
  for (const s of eff.selected) {
    // A recipe two slots reach belongs to the first.
    const walk = recipeOrder(forge, [s.recipe], `integrations.${s.slot} of profile ${profileName}`);
    for (const r of walk) {
      if (!writtenRecipes.has(r) && !integrationSet.has(r)) {
        integrationSet.add(r);
        recipeToSlot.set(r, s.slot);
      }
    }
  }

  // If the integration set is empty, nothing is provided by the block alone.
  if (!integrationSet.size) return new Map();

  // Build a map of outputName → { ingredients with their via, refs }.
  // A key is provided when **every** resolved ingredient under it has **every** `via` entry in the set.
  const byKey = new Map<string, Array<{ via: string[]; ref: string }>>();
  for (const ing of resolution.ingredients) {
    const key = `${ing.meta.type}/${outName(ing.meta)}`;
    const entry = byKey.get(key) ?? [];
    entry.push({ via: ing.via, ref: ing.ref });
    byKey.set(key, entry);
  }

  // Filter: a key is provided when **every** ingredient under it has **every** `via` entry in the integration set.
  const result = new Map<string, Provided>();
  for (const [key, ingredients] of byKey) {
    const allProvided = ingredients.every((ing) => ing.via.every((v) => integrationSet.has(v)));
    if (allProvided) {
      // `recipe` is the first `via` entry of the first such ingredient, `slot` the slot holding that recipe.
      const firstVia = ingredients[0].via[0];
      const slot = recipeToSlot.get(firstVia)!;
      const refs = ingredients.map((ing) => ing.ref);
      result.set(key, { recipe: firstVia, slot, refs });
    }
  }

  return result;
}
