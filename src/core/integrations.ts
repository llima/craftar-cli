/**
 * The one reader of `profile.integrations` (spec 33 §5.2): below schema 3 the block is ignored;
 * at 3 it selects integration recipes and derives params.
 *
 * This module is pure — it imports types, the schema constant and `findSecrets` only, never
 * resolve.ts (which imports it).
 */

import { FORGE_SCHEMA_INTEGRATIONS, type ForgeManifest, type Profile } from "../schema/index.js";
import { findSecrets } from "./secrets.js";
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

/**
 * What a refused slot or key may be named by: a string shaped like a name and not a token of a
 * known format (`findSecrets`); anything else — a URL pasted where a key goes, say — is named by
 * its position, so a credential in it is never printed (tech-debt 2026-10-11 item 7; the user's
 * ruling of 2026-10-17).
 */
const NAME_LIKE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Whether `name` is shaped like a name: matches the regex and is not a token of a known format.
 * Used by `shownName` here and by `repos.ts` for unknown keys (the 0.30.1 check in one copy).
 */
export function nameShaped(name: string): boolean {
  return NAME_LIKE.test(name) && findSecrets(name).length === 0;
}

/**
 * Returns the name to show in an error message: JSON.stringify(name) when it looks like a name
 * and is not a token of a known format (`findSecrets`), otherwise `#${index + 1}` with the
 * "(not shown: not shaped like a name)" suffix.
 */
function shownName(name: string, index: number): { shown: string; suffix: string } {
  if (nameShaped(name)) {
    return { shown: JSON.stringify(name), suffix: "" };
  }
  return { shown: `#${index + 1}`, suffix: " (not shown: not shaped like a name)" };
}

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
  /** For a profile that extends another (spec 54 §5.4): the family member each param's value came from. */
  owners?: Map<string, string>;
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
  forge: Pick<Forge, "manifest"> & { profiles?: ReadonlyMap<string, Profile> },
  profile: Profile,
): EffectiveProfile {
  // Spec 54 §5.4 (D4): a profile that extends another is computed layer by layer, farthest first — within a layer its own
  // params over its own block, then the nearer layer over the farther — and each integrations slot belongs, whole, to the
  // nearest profile that writes it (D6). Below Forge schema 13 no profile holds `extends`, so this is never taken.
  const chain: Profile[] = [];
  for (let at: Profile | undefined = profile; at && !chain.includes(at); at = at.extends !== undefined ? forge.profiles?.get(at.extends) : undefined) chain.push(at);
  if (chain.length > 1) return familyEffective(forge, chain.reverse());
  return ownEffective(forge, profile);
}

/** A family's `integrations` (spec 54 §5.3, D6), farthest first: per slot, the nearest profile that writes it, whole. */
export function familyIntegrations(layers: Profile[]): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const l of layers) out = { ...out, ...l.integrations };
  return out;
}

/** The layered form of `effectiveProfile` over a family, farthest first. */
function familyEffective(forge: Pick<Forge, "manifest">, layers: Profile[]): EffectiveProfile {
  const slotOwner = new Map<string, string>();
  for (const l of layers) for (const slot of Object.keys(l.integrations)) slotOwner.set(slot, l.name);
  const params: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const fromBlock = new Set<string>();
  const warnings: string[] = [];
  const selected: Selected[] = [];
  const recipes: string[] = [];
  for (const l of layers) {
    for (const r of l.recipes) if (!recipes.includes(r)) recipes.push(r);
    const integrations = Object.fromEntries(Object.entries(l.integrations).filter(([slot]) => slotOwner.get(slot) === l.name));
    const e = ownEffective(forge, { ...l, integrations, recipes: [] });
    warnings.push(...e.warnings);
    selected.push(...e.selected);
    const block = new Set(e.blockKeys);
    for (const [k, v] of Object.entries(e.params)) {
      params[k] = v;
      owners.set(k, l.name);
      if (block.has(k)) fromBlock.add(k);
      else fromBlock.delete(k);
    }
  }
  for (const s of selected) if (!recipes.includes(s.recipe)) recipes.push(s.recipe);
  return { recipes, params, warnings, selected, blockKeys: [...fromBlock], owners };
}

/** One profile's own `effectiveProfile` (spec 33 §5.2). */
function ownEffective(forge: Pick<Forge, "manifest">, profile: Profile): EffectiveProfile {
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
  const slots = Object.keys(block);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    // 1. Validate slot name.
    if (!SLOT_RE.test(slot)) {
      const { shown, suffix } = shownName(slot, i);
      throw new Error(
        `profile ${pName}: integrations key ${shown} is not a slot name — letters, digits and _, starting with a letter${suffix}`,
      );
    }

    const slotValue = block[slot];

    // 2. Validate slot value is a mapping.
    if (slotValue === null || typeof slotValue !== "object" || Array.isArray(slotValue)) {
      throw new Error(`profile ${pName}: ${slotLabel(slot)} is not a mapping`);
    }

    // Now we know slotValue is a plain object.
    const slotObj = slotValue as Record<string, unknown>;

    // Process each key inside the slot, in key order.
    const keys = Object.keys(slotObj);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j];
      // 3. Validate key name.
      if (!KEY_RE.test(key)) {
        const { shown, suffix } = shownName(key, j);
        throw new Error(
          `profile ${pName}: ${slotLabel(slot)} key ${shown} is not a key name — letters, digits and _ only${suffix}`,
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
            `profile ${pName}: ${slotLabel(slot)}.kind is not a kind name — a string of lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit`,
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
          `profile ${pName}: ${slotLabel(slot)}.${key} is not a scalar — not available as a param`,
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
/* slotLabel, integrationOrigin                                         */
/* ------------------------------------------------------------------ */

/** `integrations.<slot>` — the one spelling of a slot's label in a message. */
export function slotLabel(slot: string): string {
  return `integrations.${slot}`;
}

/**
 * `integrations.<slot> of profile <name>` — the origin an unknown integration recipe is
 * reported with.
 */
export function integrationOrigin(slot: string, profile: string): string {
  return `${slotLabel(slot)} of profile ${profile}`;
}

/* ------------------------------------------------------------------ */
/* recipesOrWritten                                                     */
/* ------------------------------------------------------------------ */

/** The warning for a profile whose block does not read: its recipes are read as written (§4.3). */
export function writtenWarning(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return `${message} — its recipes are read as written`;
}

/**
 * For the two whole-Forge walks (§4.3): the effective recipes, or the written ones plus the one
 * warning. Used by the catalogue's `computeProfilesForRecipes` and the prune's search.
 */
export function recipesOrWritten(
  forge: Pick<Forge, "manifest"> & { profiles?: ReadonlyMap<string, Profile> },
  profile: Profile,
): { recipes: string[]; warning: string | null } {
  try {
    return { recipes: effectiveProfile(forge, profile).recipes, warning: null };
  } catch (e) {
    return {
      recipes: profile.recipes,
      warning: writtenWarning(e),
    };
  }
}
