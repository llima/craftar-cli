/**
 * Pure helpers for building a new profile's file (spec 38 §5.2).
 * No fs, no process, no console — all validation and generation is deterministic.
 */

import YAML from "yaml";
import { ProfileSchema, WorkspaceConfigSchema, type Profile } from "../schema/index.js";
import type { Forge } from "./forge.js";
import { effectiveProfile } from "./integrations.js";
import { namedForProfile } from "./promote.js";
import { planRecipeEdit } from "./recipe-edit.js";
import { profileNotFoundMessage } from "./resolve.js";
import { parseYamlText } from "./yaml-read.js";

/** Windows device names (spec 38 §5.1 P3). */
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Profile name grammar: lowercase letters and digits, in groups joined by one "-". */
const PROFILE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * YAML-safe a list item: when `YAML.stringify(value).trim()` differs from the plain value,
 * use the stringified form (so `123`, `true`, `null` are quoted).
 */
function yamlSafe(value: string): string {
  const stringified = YAML.stringify(value).trim();
  return stringified !== value ? stringified : value;
}

/**
 * P3: Validates a profile name. Throws with a quoted name on failure.
 * @param name The profile name to validate.
 * @throws When the name is not valid or is a Windows device name.
 */
export function profileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not a profile name — lowercase letters and digits, in groups joined by one "-"`);
  }
  if (DEVICE_NAMES.test(name)) {
    throw new Error(`${JSON.stringify(name)} is a device name on Windows — pick another`);
  }
}

/**
 * Returns the profile of the LOADED Forge that owns the recipe, or null if none.
 * When several match, the longest profile name wins (spec 38 §3).
 * @param forge The loaded Forge.
 * @param recipe The recipe name to check.
 * @returns The profile name that owns the recipe, or null.
 */
export function ownedBy(forge: Forge, recipe: string): string | null {
  const matches = [...forge.profiles.keys()].filter((q) => namedForProfile(recipe, q));
  if (matches.length === 0) return null;
  // When several match, the longest name wins.
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Returns a shallow copy of the Forge with the profile added to its profiles Map.
 * The input Forge is not mutated.
 * @param forge The loaded Forge.
 * @param profile The profile to add.
 * @returns A new Forge with the profile added.
 */
export function withProfile(forge: Forge, profile: Profile): Forge {
  const profiles = new Map(forge.profiles);
  profiles.set(profile.name, profile);
  return { ...forge, profiles };
}

/** P10's one wording (spec 38 §4.2): a recipe named for another profile of the Forge, in a new profile's list. */
export function ownedRecipeRefusal(recipe: string, owner: string): string {
  return `recipe ${recipe} is named for profile ${owner} — a new profile cannot use it; leave it out and add the shared recipe it stands for`;
}

/** Options for newProfile (spec 38 §4.4). */
export interface NewProfileOptions {
  name: string;
  like?: string;
  add?: string[];
  remove?: string[];
  replace?: boolean;
  targets?: string[];
}

/** Result of newProfile (spec 38 §4.4). */
export interface NewProfileResult {
  profile: Profile;
  text: string;
  notes: string[];
  blockNote: string | null;
}

/**
 * Builds a new profile's file from the template's recipes and targets only (spec 38 §4.4, §5.2).
 * Called after the gate (the name is known free).
 *
 * @param forge The loaded Forge.
 * @param o Options: name, like (template), add/remove recipes, replace, targets.
 * @returns The profile, its YAML text, notes from recipe edits, and a note about integrations.
 * @throws P9 when --like names a profile the Forge does not have.
 * @throws P10 when the final list holds an owned recipe.
 * @throws P11 for spec 22's own refusals (unknown recipe, held slot without --replace).
 */
export function newProfile(forge: Forge, o: NewProfileOptions): NewProfileResult {
  const { name, like, add = [], remove = [], replace = false, targets: targetOverride } = o;

  // 1. template: o.like → forge.profiles.get(o.like) or throw P9
  const template = like ? forge.profiles.get(like) : undefined;
  if (like && !template) {
    throw new Error("--like: " + profileNotFoundMessage(like, [...forge.profiles.keys()]));
  }

  // 2. targets = o.targets ?? template's ?? ["claude-code"]
  const targets = targetOverride ?? template?.targets ?? ["claude-code"];

  // 3. draft = ProfileSchema.parse({ name, recipes: template?.recipes ?? [], targets }); copy = withProfile(forge, draft)
  const draft = ProfileSchema.parse({
    name,
    recipes: template?.recipes ?? [],
    targets,
  });
  let copy = withProfile(forge, draft);

  // 4. the edit, as init does (removes first, then adds)
  const notes: string[] = [];
  let config = WorkspaceConfigSchema.parse({
    forge: ".",
    profile: name,
    recipes: { add: [], remove: [] },
  });

  // Process removes first
  if (remove.length > 0) {
    const removeEdit = planRecipeEdit(copy, config, "remove", remove, { replace });
    config = { ...config, recipes: removeEdit.recipes };
    if (removeEdit.reasons.length > 0) {
      notes.push(removeEdit.reasons.join(", "));
    }
  }

  // Then adds
  if (add.length > 0) {
    const addEdit = planRecipeEdit(copy, config, "add", add, { replace });
    config = { ...config, recipes: addEdit.recipes };
    if (addEdit.reasons.length > 0) {
      notes.push(addEdit.reasons.join(", "));
    }
  }

  // 5. final list = draft.recipes minus the edit's resulting remove list, then plus its add list
  const finalRecipes = [
    ...draft.recipes.filter((r) => !config.recipes.remove.includes(r)),
    ...config.recipes.add,
  ];

  // 6. P10: the first recipe of the final list with ownedBy(forge, r) non-null (the LOADED forge, not the copy)
  for (const r of finalRecipes) {
    // Spec 51 §4.5: a recipe local to another profile is that profile's, by location — never copied into a new one.
    const holder = [...forge.locals].find(([, l]) => l.recipes.has(r));
    if (holder) throw new Error(`recipe ${r} is local to profile ${holder[0]} — a new profile cannot use it; leave it out, or move it to the root with craftar forge share`);
    const owner = ownedBy(forge, r);
    if (owner !== null) {
      throw new Error(ownedRecipeRefusal(r, owner));
    }
  }

  // 7. profile = ProfileSchema.parse({ name, recipes: final, targets })
  const profile = ProfileSchema.parse({
    name,
    recipes: finalRecipes,
    targets,
  });

  // Generate text: name: <name>\n + recipes block + targets block
  const lines: string[] = [];
  lines.push(`name: ${yamlSafe(name)}`);
  if (finalRecipes.length === 0) {
    lines.push("recipes: []");
  } else {
    lines.push("recipes:");
    for (const r of finalRecipes) {
      lines.push(`  - ${yamlSafe(r)}`);
    }
  }
  lines.push("targets:");
  for (const t of targets) {
    lines.push(`  - ${yamlSafe(t)}`);
  }
  const text = lines.join("\n") + "\n";

  // Prove that text parses back to the profile — a programming error otherwise
  const parsed = parseYamlText("generated profile", text);
  const parsedProfile = ProfileSchema.parse(parsed);
  if (
    parsedProfile.name !== profile.name ||
    JSON.stringify(parsedProfile.recipes) !== JSON.stringify(profile.recipes) ||
    JSON.stringify(parsedProfile.targets) !== JSON.stringify(profile.targets)
  ) {
    throw new Error(`newProfile: the generated text does not match the profile (programming error)`);
  }

  // 8. blockNote (only with a template)
  let blockNote: string | null = null;
  if (template) {
    try {
      const { selected } = effectiveProfile(forge, template);
      // n = selected recipes not in the final list
      const missing = selected.filter((s) => !finalRecipes.includes(s.recipe));
      if (missing.length >= 1) {
        if (missing.length === 1) {
          blockNote = `integrations of ${like} not copied — 1 recipe it selects is not in ${name}`;
        } else {
          blockNote = `integrations of ${like} not copied — ${missing.length} recipes it selects are not in ${name}`;
        }
      }
    } catch {
      // The block does not read
      blockNote = `integrations of ${like} not copied — the block does not read, so what it selects is not known`;
    }
  }

  return { profile, text, notes, blockNote };
}
