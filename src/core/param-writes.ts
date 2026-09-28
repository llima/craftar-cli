import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { IngredientSchema, ProfileSchema, WorkspaceConfigSchema } from "../schema/index.js";
import { placeholders, substitutedFile, type Extraction } from "./extract.js";
import { exists, listFiles, readIngredientText, type Forge, type LoadedIngredient } from "./forge.js";
import { resolve, sectionKey } from "./resolve.js";
import { stripBom } from "./text.js";
import { editYamlText } from "./yaml-edit.js";
import type { WriteJournal } from "./unify.js";

/**
 * The Forge-level half of a parameter extraction (spec 09 §6.3–§6.5): the rows only the whole
 * Forge can decide (P11–P19), and the two YAML edits — the base's `ingredient.yaml` gains the
 * declarations, profile `<p>` gains the values. Everything is checked and rendered before the
 * first write; `writeParamFile` only puts rendered bytes on disk.
 */

export interface ParamWrites {
  /** The base's `ingredient.yaml`, rendered, or null when every key was already declared as needed. */
  ingredientYaml: { abs: string; content: string } | null;
  /** Profile `<p>`'s `profile.yaml`, rendered, or null when it already holds every value. */
  profile: { abs: string; content: string } | null;
  /** Paths git must hold before anything is written (spec 06 row 17). */
  mustHold: string[];
  /** The keys this run declares in `ingredient.yaml` or sets in the profile; the others were already in place. */
  written: string[];
}


/** The profile file whose `name` field is `name`; last match wins, as `loadForge` keys profiles. */
async function findProfileFile(root: string, name: string): Promise<string | null> {
  const dir = path.join(root, "profiles");
  let found: string | null = null;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of entries) {
    // Directories only, exactly as loadForge reads profiles: a symlinked one is never loaded, so never edited.
    if (!d.isDirectory()) continue;
    const abs = path.join(dir, d.name, "profile.yaml");
    if (!(await exists(abs))) continue;
    try {
      const parsed = YAML.parse(await fs.readFile(abs, "utf8"));
      if (parsed && typeof parsed === "object" && (parsed as { name?: unknown }).name === name) found = abs;
    } catch {
      continue;
    }
  }
  return found;
}

/** The ingredient refs a profile resolves inside the Forge, with no workspace layer (the part decidable here). */
export function resolvedBy(forge: Forge, profile: string): Set<string> {
  const r = resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile }));
  return new Set(r.ingredients.map((i) => i.ref));
}

/** Whether any file an ingredient reads through `ctx.text` cites `{{key}}`. */
async function cites(ing: LoadedIngredient, key: string): Promise<boolean> {
  for (const rel of await listFiles(ing.dir)) {
    if (rel === "ingredient.yaml" || !substitutedFile(ing.meta, rel)) continue;
    if (placeholders(await readIngredientText(ing, rel)).includes(key)) return true;
  }
  return false;
}

/**
 * Spec 11 §6.11: a section value can cite `{{key}}` (sections expand before params), so a scan over
 * ingredient files alone can miss a citation. The first section value of `profile` for `ingKey` that
 * cites `key`, as `section <name> of <ingKey>`, or null.
 */
function citingSection(profile: { sections: Record<string, Record<string, string>> }, ingKey: string, key: string): string | null {
  const values = Object.hasOwn(profile.sections, ingKey) ? profile.sections[ingKey] : {};
  for (const [name, v] of Object.entries(values)) if (placeholders(v).includes(key)) return `section ${name} of ${ingKey}`;
  return null;
}

const same = (a: unknown, b: string) => a !== undefined && String(a) === b;

/** The spec 09 edit of one Forge file, through the shared in-place YAML editor. */
async function editYaml(abs: string, label: string, edit: (doc: YAML.Document) => void): Promise<string> {
  return editYamlText(await fs.readFile(abs, "utf8"), { command: "unify", label, keys: ["params"] }, edit);
}

export async function checkParamWrites(
  forge: Forge,
  base: LoadedIngredient,
  variant: LoadedIngredient,
  profile: string,
  extractions: Extraction[],
): Promise<ParamWrites> {
  const profileAbs = await findProfileFile(forge.root, profile);
  const current = forge.profiles.get(profile);
  if (!profileAbs || !current) throw new Error(`unify: no profile named ${profile} — the variant's values have nowhere to go`);

  // P12: every other profile resolving the variant would lose its text.
  for (const q of forge.profiles.keys()) {
    if (q !== profile && resolvedBy(forge, q).has(variant.ref)) {
      throw new Error(`unify: ${variant.ref} is also used by profile ${q} — its text would change there`);
    }
  }

  const declare: Extraction[] = [];
  const assign: Extraction[] = [];
  for (const e of extractions) {
    const decl = base.meta.params?.[e.key];
    // P13: a declaration must already say what the base's text says.
    if (decl && !same(decl.default, e.default)) {
      throw new Error(`unify: ${base.ref} already declares ${e.key} (default ${decl.default === undefined ? "none" : JSON.stringify(decl.default)})`);
    }
    if (!decl) declare.push(e);
    // P14: an undeclared {{key}} already in the base, or any in the variant, would start resolving.
    if (!decl && (await cites(base, e.key))) throw new Error(`unify: ${base.ref} already uses {{${e.key}}}`);
    // …and so would one in any profile's section value for the base's key: the default reaches every profile (spec 11 §6.11).
    for (const [q, p] of decl ? [] : forge.profiles) {
      const where = citingSection(p, sectionKey(base.meta), e.key);
      if (where) throw new Error(`unify: profile ${q} ${where} already uses {{${e.key}}}`);
    }
    if (await cites(variant, e.key)) throw new Error(`unify: ${variant.ref} already uses {{${e.key}}}`);
    // P15, P16: a stronger layer that sets the key would override the base's default. Not for a
    // reused key: the base already renders {{key}} through every layer, so nothing it sees moves.
    for (const [name, r] of e.reused ? [] : forge.recipes) {
      const d = r.params[e.key]?.default;
      if (d !== undefined && !same(d, e.default)) {
        throw new Error(`unify: recipe ${name} declares ${e.key} (default ${JSON.stringify(d)}), which would override ${base.ref}'s default`);
      }
    }
    for (const [q, p] of e.reused ? [] : forge.profiles) {
      if (q === profile) continue;
      const v = p.params[e.key];
      if (v !== undefined && !same(v, e.default)) {
        throw new Error(`unify: profile ${q} sets ${e.key} to ${JSON.stringify(v)}, which would override ${base.ref}'s default`);
      }
    }
    // P17: never overwrite a profile value.
    const own = current.params[e.key];
    if (own !== undefined) {
      if (!same(own, e.value)) throw new Error(`unify: profile ${profile} already sets ${e.key} to ${JSON.stringify(own)}`);
      continue;
    }
    // P18: the new profile value would reach every other ingredient citing the key (checked Forge-wide, spec 09 Q3).
    for (const ing of forge.ingredients.values()) {
      if (ing.ref === base.ref || ing.ref === variant.ref) continue;
      if (await cites(ing, e.key)) throw new Error(`unify: ${ing.ref} also uses {{${e.key}}} under profile ${profile} — its text would change`);
    }
    // …and so would the profile's own section values (spec 11 §6.11). Every key a Forge ingredient
    // has, the base's included: a value of this profile for the base that cites the key renders
    // literally today and would start rendering the new value (conservative, toward a refusal).
    for (const k of new Set([...forge.ingredients.values()].map((i) => sectionKey(i.meta)))) {
      const where = citingSection(current, k, e.key);
      if (where) throw new Error(`unify: profile ${profile} ${where} also uses {{${e.key}}} — its text would change`);
    }
    assign.push(e);
  }

  let ingredientYaml: ParamWrites["ingredientYaml"] = null;
  if (declare.length) {
    const abs = path.join(base.dir, "ingredient.yaml");
    const label = path.relative(forge.root, abs).split(path.sep).join("/");
    const content = await editYaml(abs, label, (doc) => {
      for (const e of declare) doc.setIn(["params", e.key, "default"], e.default);
    });
    const before = IngredientSchema.parse(YAML.parse(await fs.readFile(abs, "utf8")));
    const after = parseOr(label, () => IngredientSchema.parse(YAML.parse(stripBom(content))));
    const expected = { ...before, params: { ...(before.params ?? {}), ...Object.fromEntries(declare.map((e) => [e.key, { default: e.default }])) } };
    if (!isDeepStrictEqual(after, expected) || declare.some((e) => !same(after.params?.[e.key]?.default, e.default))) {
      throw new Error(`unify: cannot edit ${label} in place (the edit does not read back as exactly the new declarations)`);
    }
    ingredientYaml = { abs, content };
  }

  let profileWrite: ParamWrites["profile"] = null;
  if (assign.length) {
    const label = path.relative(forge.root, profileAbs).split(path.sep).join("/");
    const content = await editYaml(profileAbs, label, (doc) => {
      for (const e of assign) doc.setIn(["params", e.key], e.value);
    });
    const before = ProfileSchema.parse(YAML.parse(await fs.readFile(profileAbs, "utf8")));
    const after = parseOr(label, () => ProfileSchema.parse(YAML.parse(stripBom(content))));
    const expected = { ...before, params: { ...before.params, ...Object.fromEntries(assign.map((e) => [e.key, e.value])) } };
    if (!isDeepStrictEqual(after, expected) || assign.some((e) => !same(after.params[e.key], e.value))) {
      throw new Error(`unify: cannot edit ${label} in place (the edit does not read back as exactly the new values)`);
    }
    profileWrite = { abs: profileAbs, content };
  }

  const written = new Set([...declare, ...assign].map((e) => e.key));
  return { ingredientYaml, profile: profileWrite, mustHold: profileWrite ? [profileWrite.abs] : [], written: extractions.map((e) => e.key).filter((k) => written.has(k)) };
}

function parseOr<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    throw new Error(`unify: cannot edit ${label} in place (the edit no longer loads: ${(e as Error).message})`);
  }
}

/** Put one rendered file on disk, journaled first so a late failure can name it. */
export async function writeParamFile(w: { abs: string; content: string }, journal?: WriteJournal): Promise<void> {
  if (journal) journal.push({ abs: w.abs, created: !(await exists(w.abs)) });
  await fs.writeFile(w.abs, w.content);
}
