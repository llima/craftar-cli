/**
 * The one reader of `profile.integrations` (spec 33 §5.2): below schema 3 the block is ignored;
 * at 3 it selects integration recipes and derives params.
 *
 * This module is pure — it imports types and the schema constant only, never resolve.ts (which
 * imports it).
 */

import { FORGE_SCHEMA_INTEGRATIONS, type ForgeManifest, type Profile } from "../schema/index.js";
import type { Forge } from "./forge.js";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** The prefix of every param the block gives; no other file spells it. */
export const INTEGRATIONS_PREFIX = "integrations.";

/* ------------------------------------------------------------------ */
/* Grammar (spec 33 §4.1)                                               */
/* ------------------------------------------------------------------ */

/** Slot name: `^[A-Za-z][A-Za-z0-9_]*$`. */
const SLOT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Key inside a slot: `^[A-Za-z0-9_]+$`. */
const KEY_RE = /^[A-Za-z0-9_]+$/;

/** Kind: a string matching `^[a-z0-9][a-z0-9._-]*$`. */
const KIND_RE = /^[a-z0-9][a-z0-9._-]*$/;

/* ------------------------------------------------------------------ */
/* Gate                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether this Forge's `integrations` blocks are read (spec 33 §4.2).
 * Written `>= FORGE_SCHEMA_INTEGRATIONS` from day one, so spec 34's schema 4 includes it.
 */
export function readsIntegrations(manifest: Pick<ForgeManifest, "schema">): boolean {
  return manifest.schema >= FORGE_SCHEMA_INTEGRATIONS;
}

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** One integration with a `kind` selected a recipe (spec 33 §3). */
export interface Selected {
  slot: string;
  kind: string;
  /** `${slot}-${kind}` */
  recipe: string;
}

/** The effective recipes and params once integrations are applied (spec 33 §3). */
export interface EffectiveProfile {
  /** The profile's own `recipes`, then each selected recipe not already listed, in block order. */
  recipes: string[];
  /** The block's scalars under the profile's own `params`. */
  params: Record<string, unknown>;
  /** One per non-scalar value. */
  warnings: string[];
  /** Every integration with a `kind`, in block order — also one the profile lists. */
  selected: Selected[];
  /** The `integrations.*` keys whose value comes from the block (no `params` entry of that key). */
  blockKeys: string[];
}

/* ------------------------------------------------------------------ */
/* effectiveProfile                                                     */
/* ------------------------------------------------------------------ */

/**
 * The ONLY reader of `profile.integrations`. Throws on a malformed block (schema 3+ only).
 *
 * Below the gate: returns the profile's own `recipes` and `params` objects by reference, the
 * block not even enumerated.
 *
 * At the gate: validates in the order design.md gives and throws on the first fault.
 */
export function effectiveProfile(
  forge: Pick<Forge, "manifest">,
  profile: Profile,
): EffectiveProfile {
  // Below the gate: the profile's own two objects, by reference, the block not even enumerated.
  if (!readsIntegrations(forge.manifest)) {
    return {
      recipes: profile.recipes,
      params: profile.params,
      warnings: [],
      selected: [],
      blockKeys: [],
    };
  }

  // At the gate: validate and process the block.
  const pName = profile.name;
  const block = profile.integrations;
  const warnings: string[] = [];
  const selected: Selected[] = [];
  const fromBlock: Record<string, unknown> = {};
  const blockKeys: string[] = [];

  // Process each slot in block order.
  for (const slot of Object.keys(block)) {
    // 1. Validate slot name.
    if (!SLOT_RE.test(slot)) {
      throw new Error(
        `profile ${pName}: integrations key ${JSON.stringify(slot)} is not a slot name — letters, digits and _, starting with a letter`,
      );
    }

    const slotValue = block[slot];

    // 2. Validate slot value is a mapping.
    if (slotValue === null || typeof slotValue !== "object" || Array.isArray(slotValue)) {
      throw new Error(`profile ${pName}: integrations.${slot} is not a mapping`);
    }

    // Now we know slotValue is a plain object.
    const slotObj = slotValue as Record<string, unknown>;

    // Process each key inside the slot, in key order.
    for (const key of Object.keys(slotObj)) {
      // 3. Validate key name.
      if (!KEY_RE.test(key)) {
        throw new Error(
          `profile ${pName}: integrations.${slot} key ${JSON.stringify(key)} is not a key name — letters, digits and _ only`,
        );
      }

      const val = slotObj[key];

      // 4. null / undefined is absent (skipped), kind: null included.
      if (val === null || val === undefined) {
        continue;
      }

      // 5. Validate kind if this is the kind key.
      if (key === "kind") {
        if (typeof val !== "string" || !KIND_RE.test(val)) {
          throw new Error(
            `profile ${pName}: integrations.${slot}.kind is not a kind name — a string of lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit`,
          );
        }
        // kind is a param like any other scalar, and also selects a recipe.
        selected.push({ slot, kind: val, recipe: `${slot}-${val}` });
        // Add as param.
        const paramKey = `${INTEGRATIONS_PREFIX}${slot}.${key}`;
        fromBlock[paramKey] = val;
        if (!Object.hasOwn(profile.params, paramKey)) {
          blockKeys.push(paramKey);
        }
        continue;
      }

      // 6. Scalar (string, number, boolean) becomes a param; mapping or list is a warning.
      const paramKey = `${INTEGRATIONS_PREFIX}${slot}.${key}`;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        fromBlock[paramKey] = val;
        if (!Object.hasOwn(profile.params, paramKey)) {
          blockKeys.push(paramKey);
        }
      } else {
        // A mapping or list: warn and skip.
        warnings.push(
          `profile ${pName}: integrations.${slot}.${key} is not a scalar — not available as a param`,
        );
      }
    }
  }

  // Build recipes: the profile's own, then each selected recipe not already listed.
  const recipes = [...profile.recipes];
  for (const s of selected) {
    if (!recipes.includes(s.recipe)) {
      recipes.push(s.recipe);
    }
  }

  // Build params: block's scalars under the profile's own params.
  // `{ ...fromBlock, ...profile.params }` — the profile's explicit entry wins.
  const params: Record<string, unknown> = { ...fromBlock, ...profile.params };

  return { recipes, params, warnings, selected, blockKeys };
}

/* ------------------------------------------------------------------ */
/* integrationOrigin                                                    */
/* ------------------------------------------------------------------ */

/**
 * `integrations.<slot> of profile <name>` — the origin an unknown integration recipe is
 * reported with.
 */
export function integrationOrigin(slot: string, profile: string): string {
  return `integrations.${slot} of profile ${profile}`;
}

/* ------------------------------------------------------------------ */
/* recipesOrWritten                                                     */
/* ------------------------------------------------------------------ */

/**
 * For the two whole-Forge walks (§4.3): the effective recipes, or the written ones plus the one
 * warning. Used by the catalogue's `computeProfilesForRecipes` and the prune's search.
 */
export function recipesOrWritten(
  forge: Pick<Forge, "manifest">,
  profile: Profile,
): { recipes: string[]; warning: string | null } {
  try {
    return { recipes: effectiveProfile(forge, profile).recipes, warning: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      recipes: profile.recipes,
      warning: `${message} — its recipes are read as written`,
    };
  }
}
