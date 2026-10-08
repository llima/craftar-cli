import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { IngredientSchema, ProfileSchema, WorkspaceConfigSchema } from "../schema/index.js";
import { placeholders, bodyFile, type Extraction } from "./extract.js";
import { exists, listFiles, readIngredientText, FORGE_MANIFEST, type Forge, type LoadedIngredient } from "./forge.js";
import { manifestWithSections } from "./manifest-edit.js";
import { resolve, sectionKey } from "./resolve.js";
import { canonicalValue } from "./sections.js";
import { stripBom } from "./text.js";
import type { SectionExtraction, WriteJournal } from "./unify.js";
import { editYamlText } from "./yaml-edit.js";
import { deepMerge } from "./merge.js";

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
  /** `craftar.forge.yaml` with `schema: 2`, or null (already 2, or no new section). */
  manifest: { abs: string; content: string } | null;
  /** Paths git must hold before anything is written (spec 06 row 17). */
  mustHold: string[];
  /** The keys this run declares in `ingredient.yaml` or sets in the profile; the others were already in place. */
  written: string[];
  /** The section names this run writes into the profile (not listed when already in place). */
  sectionsWritten: string[];
}


/** The profile file whose `name` field is `name`; last match wins, as `loadForge` keys profiles. */
export async function findProfileFile(root: string, name: string): Promise<string | null> {
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

/** Whether any body file an ingredient reads through `ctx.text` cites `{{key}}`. */
async function cites(ing: LoadedIngredient, key: string): Promise<boolean> {
  for (const rel of await listFiles(ing.dir)) {
    if (rel === "ingredient.yaml" || !bodyFile(ing.meta, rel, ing.dir)) continue;
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

/** Equality of canonical section values (spec 12 §6.6). */
const eq = (a: string, b: string) => canonicalValue(a) === canonicalValue(b);

export async function checkParamWrites(
  forge: Forge,
  base: LoadedIngredient,
  variant: LoadedIngredient,
  profile: string,
  extractions: Extraction[],
  sections: SectionExtraction[] = [],
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

  // Section checks (spec 12 §6.6): S13–S16
  const sectionAssign: SectionExtraction[] = [];
  for (const s of sections) {
    // S15: check that a value citing {{k}} where base declares k with a default and variant doesn't is refused
    for (const k of placeholders(s.value)) {
      const baseDecl = base.meta.params?.[k]?.default;
      const variantDecl = variant.meta.params?.[k];
      if (baseDecl !== undefined && variantDecl === undefined) {
        throw new Error(`unify: section ${s.name} would render {{${k}}} through ${base.ref}'s default, where ${variant.ref} renders it without`);
      }
    }

    // Get the profile's current value for this section (if any)
    const profileSections = Object.hasOwn(current.sections, s.key) ? current.sections[s.key] : {};
    const profileValue = Object.hasOwn(profileSections, s.name) ? profileSections[s.name] : undefined;

    if (!s.existing) {
      // New section: check S13 — no other profile sets this section
      for (const [q, prof] of forge.profiles) {
        const otherSections = Object.hasOwn(prof.sections, s.key) ? prof.sections[s.key] : {};
        if (!Object.hasOwn(otherSections, s.name)) continue;
        const v = otherSections[s.name];
        if (q === profile) {
          // The unifying profile: if equal, nothing to write; if different, S14
          if (eq(v, s.value)) continue; // already in place, skip assign
          throw new Error(`unify: profile ${profile} already sets section ${s.name} of ${s.key} to other content`);
        } else {
          // Another profile: S13
          throw new Error(`unify: profile ${q} already sets section ${s.name} of ${s.key} — it names no marker today and would start to apply`);
        }
      }
      // If we get here and the profile already has exactly the value, skip assign
      if (profileValue !== undefined && eq(profileValue, s.value)) continue;
      sectionAssign.push(s);
    } else {
      // Existing section: only check the unifying profile
      if (profileValue !== undefined) {
        if (eq(profileValue, s.value)) continue; // already in place
        throw new Error(`unify: profile ${profile} already sets section ${s.name} of ${s.key} to other content`);
      }
      // Undefined → write
      sectionAssign.push(s);
    }
  }

  let ingredientYaml: ParamWrites["ingredientYaml"] = null;
  if (declare.length) {
    const abs = path.join(base.dir, "ingredient.yaml");
    const label = path.relative(forge.root, abs).split(path.sep).join("/");
    const content = await editYamlText(await fs.readFile(abs, "utf8"), { command: "unify", label, keys: ["params"] }, (doc) => {
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

  // Profile edit: ONE editYamlText call with both params and sections (spec 12 §6.7 step 4)
  let profileWrite: ParamWrites["profile"] = null;
  if (assign.length || sectionAssign.length) {
    const label = path.relative(forge.root, profileAbs).split(path.sep).join("/");
    const content = await editYamlText(await fs.readFile(profileAbs, "utf8"), { command: "unify", label, keys: ["params", "sections"] }, (doc) => {
      for (const e of assign) doc.setIn(["params", e.key], e.value);
      for (const s of sectionAssign) doc.setIn(["sections", s.key, s.name], s.value);
    });
    const before = ProfileSchema.parse(YAML.parse(await fs.readFile(profileAbs, "utf8")));
    const after = parseOr(label, () => ProfileSchema.parse(YAML.parse(stripBom(content))));
    // Build expected sections: deep-merge the before sections with the new ones
    const expectedSections = deepMerge(
      before.sections,
      Object.fromEntries(sectionAssign.map((s) => [s.key, { [s.name]: s.value }]))
    );
    const expected = {
      ...before,
      params: { ...before.params, ...Object.fromEntries(assign.map((e) => [e.key, e.value])) },
      sections: expectedSections,
    };
    if (!isDeepStrictEqual(after, expected)) {
      throw new Error(`unify: cannot edit ${label} in place (the edit does not read back as exactly the new values)`);
    }
    // Also verify each value reads back exactly (string equality)
    if (assign.some((e) => !same(after.params[e.key], e.value))) {
      throw new Error(`unify: cannot edit ${label} in place (the edit does not read back as exactly the new values)`);
    }
    // For sections, verify each value reads back exactly
    for (const s of sectionAssign) {
      const afterVal = after.sections[s.key]?.[s.name];
      if (afterVal !== s.value) {
        throw new Error(`unify: cannot edit ${label} in place (the edit does not read back as exactly the new values)`);
      }
    }
    profileWrite = { abs: profileAbs, content };
  }

  // Manifest edit (spec 12 §6.7 step 1): when at least one section is NEW and schema is 1
  // Use the full `sections` list, not `sectionAssign`: a new section adds markers to the body
  // even when its value is already in place in the profile, so the Forge needs schema: 2.
  let manifestWrite: ParamWrites["manifest"] = null;
  const hasNewSection = sections.some((s) => !s.existing);
  if (hasNewSection && forge.manifest.schema === 1) {
    const manifestAbs = path.join(forge.root, FORGE_MANIFEST);
    const raw = await fs.readFile(manifestAbs, "utf8");
    const content = manifestWithSections(raw, "unify");
    if (content !== null) {
      manifestWrite = { abs: manifestAbs, content };
    }
  }

  const written = new Set([...declare, ...assign].map((e) => e.key));
  const sectionsWritten = sectionAssign.map((s) => s.name);
  const mustHold: string[] = [];
  if (profileWrite) mustHold.push(profileWrite.abs);
  if (manifestWrite) mustHold.push(manifestWrite.abs);

  return {
    ingredientYaml,
    profile: profileWrite,
    manifest: manifestWrite,
    mustHold,
    written: extractions.map((e) => e.key).filter((k) => written.has(k)),
    sectionsWritten,
  };
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
