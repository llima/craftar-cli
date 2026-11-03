/**
 * Sections at the recipe layer (spec 54 Part A): the gate, the near miss below it, and the recipe layer itself.
 * Pure: `loadForge` reads the recipe files, `resolve()` hands in the application order.
 */
import type { Recipe, Sections } from "../schema/index.js";
import { FORGE_SCHEMA_RECIPE_SECTIONS } from "../schema/index.js";
import { deepMerge } from "./merge.js";

/** Whether the Forge reads a recipe's `sections` (spec 54 §4.1). The ONE comparison with that constant. */
export function readsRecipeSections(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_RECIPE_SECTIONS;
}

/** The near miss below the gate (spec 54 §4.1): names the recipe's Forge-relative file and the schema, never a value. */
export function recipeSectionsNearMiss(file: string): string {
  return `${file}: sections in a recipe needs schema: ${FORGE_SCHEMA_RECIPE_SECTIONS} in craftar.forge.yaml`;
}

/** The recipe layer (spec 54 §4.2): each recipe's `sections` folded in application order, the last one winning per name. */
export interface RecipeSectionLayer {
  sections: Sections;
  /** The recipe that set each value, keyed `<key>\0<name>`. */
  setBy: Map<string, string>;
}

/** Fold `order` (resolve()'s application order) into one layer; `{}` when the Forge is below the gate. */
export function recipeSectionLayer(order: string[], recipeOf: (name: string) => Recipe | undefined, reads: boolean): RecipeSectionLayer {
  if (!reads) return { sections: {}, setBy: new Map() };
  let sections: Sections = {};
  const setBy = new Map<string, string>();
  for (const name of order) {
    const own = recipeOf(name)?.sections;
    if (!own) continue;
    sections = deepMerge(sections, own) as Sections;
    for (const [key, values] of Object.entries(own)) for (const n of Object.keys(values)) setBy.set(`${key}\0${n}`, name);
  }
  return { sections, setBy };
}
