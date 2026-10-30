import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { IngredientSchema, ProfileSchema, RecipeSchema, WorkspaceConfigSchema, type Ingredient, type IngredientRef } from "../schema/index.js";
import { fingerprintDir } from "./fingerprint.js";
import { assertNoDirLinkIn, assertNoLinkOnPath, copyForgeForProof, exists, listFiles, loadForge, parseYaml, typeFolder, type Forge, type LoadedIngredient } from "./forge.js";
import { effectiveProfile } from "./integrations.js";
import { findProfileFile } from "./param-writes.js";
import { resolve, type Resolution } from "./resolve.js";
import { note, type WriteJournal } from "./unify.js";
import { profileOf } from "./variants.js";
import { editYamlText } from "./yaml-edit.js";

// Spec 29 §4.4 — `forge promote`: a profile's variant becomes the base, and every other profile that resolved the old
// base gets it back as its own variant. Three steps a caller runs in order: the edit set (reads only), the slot proof
// on a scratch copy (reads the Forge only), the writes through a journal.

/**
 * The owned-recipe predicate (spec 38 §3): a recipe named for a profile — `<anything>--<q>` or `<q>-steering`.
 */
export function namedForProfile(name: string, q: string): boolean {
  return name.endsWith(`--${q}`) || name === `${q}-steering`;
}

const COMMAND = "forge promote";

/** One file the promotion writes; `created` when nothing is there today. */
export interface PromotionWrite {
  abs: string;
  content: string | Buffer;
  created: boolean;
}

export interface BasePromotion {
  /** The Forge's root, absolute. */
  root: string;
  /** `X`, `p` and `X--p`. */
  base: IngredientRef;
  profile: string;
  removed: IngredientRef;
  /** The `X--q` created from the old base, sorted. */
  created: IngredientRef[];
  recipes: { edited: string[]; created: Array<{ name: string; from: string }> };
  /** The profiles whose `profile.yaml` is edited, sorted. */
  profiles: string[];
  /** No other profile resolved the old base: its text is in git only. */
  discarded: boolean;
  warnings: string[];
  /** What each recipe and profile edit changes, for the command's lines. */
  detail: {
    recipes: Array<{ name: string; from: string | null; old: string; new: string }>;
    profiles: Array<{ profile: string; file: string; swaps: Array<{ old: string; new: string }> }>;
  };
  /** In write order. */
  writes: PromotionWrite[];
  /** Files to delete, after every write. */
  removes: string[];
  /** Existing paths the run overwrites or deletes — the one `mustHold` (spec 29 §4.4). */
  mustHold: string[];
}

const posix = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const byPath = (a: { abs: string }, b: { abs: string }) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0);

/** Every profile's resolution with no workspace layer — the part decidable in the Forge; a profile that does not resolve maps to its error. */
function resolveAll(forge: Forge): Map<string, Resolution | Error> {
  const out = new Map<string, Resolution | Error>();
  for (const q of [...forge.profiles.keys()].sort()) {
    try {
      out.set(q, resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile: q })));
    } catch (e) {
      out.set(q, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
}

/** The recipe files of a Forge by declared name, as `loadForge` keys them (last file wins). */
async function recipeFiles(root: string): Promise<Map<string, { abs: string; stem: string; raw: string }>> {
  const dir = path.join(root, "recipes");
  const out = new Map<string, { abs: string; stem: string; raw: string }>();
  if (!(await exists(dir))) return out;
  for (const f of await fs.readdir(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const abs = path.join(dir, f);
    const raw = await fs.readFile(abs, "utf8");
    out.set(parseYaml(abs, raw, RecipeSchema).name, { abs, stem: f.replace(/\.ya?ml$/, ""), raw });
  }
  return out;
}

/**
 * Whether something stands where a new directory would go: anything but nothing, or a directory holding no file.
 * Throws on lstat errors other than ENOENT (fail-closed).
 */
async function occupied(dir: string): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (e) {
    // Only ENOENT means "not occupied"; other errors (EACCES, EIO, etc.) fail closed.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  return !stat.isDirectory() || (await listFiles(dir)).length > 0;
}

/** Replace the plain scalar entries equal to `old` in the sequence under `key`; says how many it replaced. */
function swapEntry(doc: YAML.Document, key: string, old: string, value: string): number {
  const seq = doc.get(key, true);
  if (!YAML.isSeq(seq)) return 0;
  let n = 0;
  for (const item of seq.items) {
    if (YAML.isScalar(item) && item.value === old) {
      item.value = value;
      n++;
    }
  }
  return n;
}

const unreadable = (label: string, what: string) =>
  new Error(`${COMMAND}: cannot edit ${label} in place (the edit does not read back as exactly ${what}) — reformat it by hand, commit, and re-run`);

/** An `ingredient.yaml` with `name` set and `as` set or removed, in place; read back through the schema. */
function ingredientText(raw: string, label: string, meta: Ingredient, name: string, as: string | null): string {
  const text = editYamlText(raw, { command: COMMAND, label, keys: ["name", "as"] }, (doc) => {
    doc.set("name", name);
    if (as === null) doc.delete("as");
    else doc.set("as", as);
  });
  const { as: _dropped, ...rest } = meta as Ingredient & { as?: string };
  const expected = as === null ? { ...rest, name } : { ...rest, name, as };
  if (!isDeepStrictEqual(parseYaml(label, text, IngredientSchema), IngredientSchema.parse(expected))) {
    throw unreadable(label, as === null ? "name set and as removed" : "name and as set");
  }
  return text;
}

/**
 * The edit set of a promotion (design of spec 29 §4.4): what would be written and removed, and the refusals that need
 * no proof — P1, P3–P6. Reads the Forge only; writes nothing and creates no directory.
 */
export async function planBasePromotion(forge: Forge, ref: string, profile: string): Promise<BasePromotion> {
  const base = forge.ingredients.get(ref as IngredientRef);
  if (!base) throw new Error(`${COMMAND}: ${ref} is not an ingredient of this Forge`);
  if (base.meta.as) throw new Error(`${COMMAND}: ${ref} is a variant — name its base, ${base.meta.type}/${base.meta.as}, with --profile`);
  const type = base.meta.type;
  const X = base.ref;
  const variantOf = (q: string): LoadedIngredient | undefined =>
    [...forge.ingredients.values()].find((i) => i.meta.type === type && i.meta.as === base.meta.name && profileOf(i.meta) === q);
  const variant = variantOf(profile);
  if (!variant) throw new Error(`${COMMAND}: ${ref} has no variant for profile ${profile}`);

  // Check for symlinks to directories inside the base and variant directories before reading their files.
  await assertNoDirLinkIn(forge.root, base.dir, COMMAND);
  await assertNoDirLinkIn(forge.root, variant.dir, COMMAND);

  const warnings: string[] = [];
  const before = resolveAll(forge);
  const holds = (q: string, r: string) => {
    const res = before.get(q);
    return res !== undefined && !(res instanceof Error) && res.ingredients.some((i) => i.ref === r);
  };
  for (const [q, res] of before) if (res instanceof Error) warnings.push(`profile ${q} does not resolve today (${firstLine(res)}) — promote could not check it`);
  if (holds(profile, X)) {
    throw new Error(
      `${COMMAND}: profile ${profile} resolves ${X} itself — the Forge is inconsistent (it would write one file from two ingredients); remove one from its recipes by hand, commit, and re-run`,
    );
  }
  const Q = [...before.keys()].filter((q) => q !== profile && holds(q, X));
  const variantRef = (q: string) => `${type}/${base.meta.name}--${q}` as IngredientRef;

  const folder = path.join(forge.root, "ingredients", typeFolder(type));
  const ingredientWrites = async (from: LoadedIngredient, toDir: string, yaml: string): Promise<PromotionWrite[]> => {
    const out: PromotionWrite[] = [];
    for (const rel of await listFiles(from.dir)) {
      if (rel === "ingredient.yaml") continue;
      const abs = path.join(toDir, rel);
      out.push({ abs, content: await fs.readFile(path.join(from.dir, rel)), created: !(await exists(abs)) });
    }
    const abs = path.join(toDir, "ingredient.yaml");
    return [...out.sort(byPath), { abs, content: yaml, created: !(await exists(abs)) }];
  };
  const metaText = (ing: LoadedIngredient) => fs.readFile(path.join(ing.dir, "ingredient.yaml"), "utf8");
  const label = (abs: string) => posix(forge.root, abs);

  /* ---- X--q for every profile on the old base ---- */
  const createdWrites: PromotionWrite[] = [];
  for (const q of Q) {
    const dir = path.join(folder, `${base.meta.name}--${q}`);
    // An empty directory is no ingredient: a late failure undone with git leaves one behind, and the re-run must pass.
    if (variantOf(q) || forge.ingredients.has(variantRef(q)) || (await occupied(dir))) {
      throw new Error(
        `${COMMAND}: ${variantRef(q)} already exists, and profile ${q} also resolves ${X} — the Forge is inconsistent (both would write one file); remove one by hand, commit, and re-run`,
      );
    }
    const yaml = ingredientText(await metaText(base), label(path.join(base.dir, "ingredient.yaml")), base.meta, `${base.meta.name}--${q}`, base.meta.name);
    createdWrites.push(...(await ingredientWrites(base, dir, yaml)));
  }

  /* ---- the base takes the variant's directory ---- */
  const baseYaml = ingredientText(await metaText(variant), label(path.join(variant.dir, "ingredient.yaml")), variant.meta, base.meta.name, null);
  const baseWrites = await ingredientWrites(variant, base.dir, baseYaml);
  const kept = new Set(baseWrites.map((w) => w.abs));
  const removes = [
    ...(await listFiles(base.dir)).map((rel) => path.join(base.dir, rel)).filter((abs) => !kept.has(abs)),
    ...(await listFiles(variant.dir)).map((rel) => path.join(variant.dir, rel)),
  ];

  /* ---- recipes ---- */
  const files = await recipeFiles(forge.root);
  const fileOf = (name: string) => {
    const f = files.get(name);
    if (!f) throw new Error(`${COMMAND}: recipe ${name} has no file under recipes/`);
    // P6, as import's I10: the file promote would edit or copy must be the one named after the recipe.
    if (f.stem !== name) throw new Error(`${COMMAND}: recipe ${name} is ${label(f.abs)} — ${COMMAND} writes recipes/${name}.yaml`);
    return f;
  };
  const detail: BasePromotion["detail"] = { recipes: [], profiles: [] };
  const editedRecipes: PromotionWrite[] = [];
  const createdRecipes: PromotionWrite[] = [];
  const swaps = new Map<string, Array<{ old: string; new: string }>>();
  const recipeEdit = (raw: string, where: string, source: string, name: string, old: string, value: string): string => {
    const text = editYamlText(raw, { command: COMMAND, label: where, keys: ["name", "ingredients"] }, (doc) => {
      if (name !== source) doc.set("name", name);
      swapEntry(doc, "ingredients", old, value);
    });
    const was = forge.recipes.get(source)!;
    const expected = { ...was, name, ingredients: was.ingredients.map((i) => (i === old ? value : i)) };
    if (!isDeepStrictEqual(parseYaml(where, text, RecipeSchema), expected)) throw unreadable(where, `${old} replaced by ${value}`);
    return text;
  };
  for (const name of [...forge.recipes.keys()].sort()) {
    const R = forge.recipes.get(name)!;
    const namesVariant = R.ingredients.includes(variant.ref);
    const namesBase = R.ingredients.includes(X);
    if (namesVariant && namesBase) {
      throw new Error(`${COMMAND}: recipe ${name} names both ${X} and ${variant.ref} — the Forge is inconsistent (both would write one file); remove one by hand, commit, and re-run`);
    }
    if (namesVariant) {
      const f = fileOf(name);
      editedRecipes.push({ abs: f.abs, content: recipeEdit(f.raw, label(f.abs), name, name, variant.ref, X), created: false });
      detail.recipes.push({ name, from: null, old: variant.ref, new: X });
      continue;
    }
    if (!namesBase) continue;
    const owner = Q.find((q) => namedForProfile(name, q));
    if (owner) {
      const f = fileOf(name);
      editedRecipes.push({ abs: f.abs, content: recipeEdit(f.raw, label(f.abs), name, name, X, variantRef(owner)), created: false });
      detail.recipes.push({ name, from: null, old: X, new: variantRef(owner) });
      continue;
    }
    for (const q of Q) {
      const res = before.get(q) as Resolution;
      if (!res.recipes.includes(name)) continue;
      if (!res.profile.recipes.includes(name)) {
        const eff = effectiveProfile(forge, res.profile);
        const sel = eff.selected.find((s) => s.recipe === name);
        if (sel) {
          throw new Error(`${COMMAND}: profile ${q} selects recipe ${name} (which names ${X}) through integrations.${sel.slot} — promote cannot repoint a recipe a block selects by editing a recipes list; edit the Forge by hand`);
        }
        throw new Error(`${COMMAND}: profile ${q} reaches recipe ${name} (which names ${X}) through ${chainTo(forge, eff.recipes, name)} — promote would have to copy that chain; edit the Forge by hand`);
      }
      const copy = `${name}--${q}`;
      const abs = path.join(forge.root, "recipes", `${copy}.yaml`);
      if (forge.recipes.has(copy) || (await exists(abs)) || (await exists(path.join(forge.root, "recipes", `${copy}.yml`)))) {
        throw new Error(`${COMMAND}: recipe ${copy} already exists — promote would create it for profile ${q} from ${name}; remove or rename it by hand, commit, and re-run`);
      }
      const f = fileOf(name);
      createdRecipes.push({ abs, content: recipeEdit(f.raw, label(f.abs), name, copy, X, variantRef(q)), created: true });
      detail.recipes.push({ name: copy, from: name, old: X, new: variantRef(q) });
      swaps.set(q, [...(swaps.get(q) ?? []), { old: name, new: copy }]);
    }
  }

  /* ---- profiles: one edit per file, however many of its recipes were split ---- */
  const profileWrites: PromotionWrite[] = [];
  for (const q of [...swaps.keys()].sort()) {
    const abs = await findProfileFile(forge.root, q);
    if (!abs) throw new Error(`${COMMAND}: profile ${q} has no profile.yaml under profiles/`);
    const where = label(abs);
    const list = swaps.get(q)!;
    const text = editYamlText(await fs.readFile(abs, "utf8"), { command: COMMAND, label: where, keys: ["recipes"] }, (doc) => {
      for (const s of list) swapEntry(doc, "recipes", s.old, s.new);
    });
    const was = forge.profiles.get(q)!;
    const expected = { ...was, recipes: was.recipes.map((r) => list.find((s) => s.old === r)?.new ?? r) };
    if (!isDeepStrictEqual(parseYaml(where, text, ProfileSchema), expected)) throw unreadable(where, `recipes ${list.map((s) => `${s.old} replaced by ${s.new}`).join(", ")}`);
    profileWrites.push({ abs, content: text, created: false });
    detail.profiles.push({ profile: q, file: where, swaps: list });
  }

  const writes = [...createdWrites, ...baseWrites, ...createdRecipes.sort(byPath), ...editedRecipes.sort(byPath), ...profileWrites.sort(byPath)];
  // Never through a link: checked here with the other refusals, and again before the first write.
  await assertNoLinkOnPath(forge.root, [...writes.map((w) => w.abs), ...removes]);
  return {
    root: forge.root,
    base: X,
    profile,
    removed: variant.ref,
    created: Q.map(variantRef),
    recipes: {
      edited: detail.recipes.filter((r) => r.from === null).map((r) => r.name),
      created: detail.recipes.filter((r) => r.from !== null).map((r) => ({ name: r.name, from: r.from! })),
    },
    profiles: detail.profiles.map((p) => p.profile),
    discarded: Q.length === 0,
    warnings,
    detail,
    writes,
    removes,
    mustHold: [...writes.filter((w) => !w.created).map((w) => w.abs), ...removes],
  };
}

/** `a → b → R`: the first `extends` path from one of a profile's own recipes down to `target`. */
function chainTo(forge: Forge, own: string[], target: string): string {
  const walk = (name: string, seen: string[]): string[] | null => {
    if (name === target) return [...seen, name];
    if (seen.includes(name)) return null;
    for (const parent of forge.recipes.get(name)?.extends ?? []) {
      const found = walk(parent, [...seen, name]);
      if (found) return found;
    }
    return null;
  };
  for (const r of own) {
    const found = walk(r, []);
    if (found) return found.join(" → ");
  }
  return target;
}

/** Put a promotion's files under `root` (the Forge, or its scratch copy), deleting what it removes and the directories that leaves empty. */
async function writeInto(root: string, promotion: BasePromotion, journal?: WriteJournal): Promise<void> {
  const at = (abs: string) => path.join(root, path.relative(promotion.root, abs));
  for (const w of promotion.writes) {
    const abs = at(w.abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await note(journal, abs);
    await fs.writeFile(abs, w.content);
  }
  for (const r of promotion.removes) {
    const abs = at(r);
    journal?.push({ abs, created: false });
    await fs.rm(abs);
  }
  // Deepest first, and never above the ingredient's own type folder.
  const dirs = [...new Set(promotion.removes.map((r) => path.dirname(at(r))))].sort((a, b) => b.length - a.length);
  for (let dir of dirs) {
    while (path.relative(root, dir).split(path.sep).length > 2 && (await exists(dir)) && (await fs.readdir(dir)).length === 0) {
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    }
  }
}

const refused = (q: string, what: string) => new Error(`${COMMAND}: profile ${q} would not resolve the same after the promotion — ${what}; nothing written`);

/**
 * The slot proof (P7): on a scratch copy holding the promotion's edits, every profile that resolves today must resolve
 * the same ingredients in the same order — the promoted profile's variant now the base, the old base now each other
 * profile's own variant, each holding the files of the one it replaces — through recipes on the same slots, with the
 * same parameters, sections, targets and warnings. Reads the Forge only; the scratch copy is always removed.
 */
export async function proveBasePromotion(forge: Forge, promotion: BasePromotion): Promise<void> {
  const before = resolveAll(forge);
  let scratch: string;
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-forge-promote-"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    throw new Error(`${COMMAND}: could not create a temporary directory for the proof (${code}) — nothing written`);
  }
  try {
    await copyForgeForProof(forge.root, scratch);
    try {
      await writeInto(scratch, promotion);
    } catch (e) {
      // The copy carries each file's mode, so what cannot be written there cannot be written in the Forge either.
      const at = (e as NodeJS.ErrnoException).path;
      const code = (e as NodeJS.ErrnoException).code ?? "the write failed";
      throw new Error(`${COMMAND}: ${at ? posix(scratch, at) : "a file"} could not be written on the scratch copy the edit is proved on (${code}) — it cannot be written in the Forge either; nothing written`);
    }
    const edited = await loadForge(scratch);
    const mine = (q: string) => promotion.created.find((c) => c === `${promotion.base}--${q}`);
    for (const [q, was] of before) {
      if (was instanceof Error) continue;
      let now: Resolution;
      try {
        now = resolve(edited, WorkspaceConfigSchema.parse({ forge: ".", profile: q }));
      } catch (e) {
        throw refused(q, firstLine(e));
      }
      const split = new Map((promotion.detail.profiles.find((p) => p.profile === q)?.swaps ?? []).map((s) => [s.old, s.new]));
      const rename = (r: IngredientRef): IngredientRef => (r === promotion.removed ? promotion.base : r === promotion.base ? (mine(q) ?? r) : r);
      const wantRefs = was.ingredients.map((i) => rename(i.ref));
      const gotRefs = now.ingredients.map((i) => i.ref);
      for (let i = 0; i < Math.max(wantRefs.length, gotRefs.length); i++) {
        if (wantRefs[i] !== gotRefs[i]) throw refused(q, `its ingredients differ at position ${i + 1} (${gotRefs[i] ?? "nothing"} ≠ ${wantRefs[i] ?? "nothing"})`);
      }
      const wantRecipes = was.recipes.map((r) => split.get(r) ?? r);
      for (let i = 0; i < Math.max(wantRecipes.length, now.recipes.length); i++) {
        if (wantRecipes[i] !== now.recipes[i]) throw refused(q, `its recipes differ at position ${i + 1} (${now.recipes[i] ?? "nothing"} ≠ ${wantRecipes[i] ?? "nothing"})`);
        if (edited.recipes.get(now.recipes[i])!.slot !== forge.recipes.get(was.recipes[i])!.slot) throw refused(q, `recipe ${now.recipes[i]} changes slot`);
      }
      for (const k of new Set([...Object.keys(was.params), ...Object.keys(now.params)])) {
        if (!isDeepStrictEqual(was.params[k], now.params[k])) throw refused(q, `its parameters differ (${k})`);
      }
      if (!isDeepStrictEqual(was.sections, now.sections)) throw refused(q, "its sections differ");
      if (!isDeepStrictEqual(was.targets, now.targets)) throw refused(q, "its targets differ");
      const said = (w: string) => [...split].reduce((t, [old, value]) => t.split(`recipe "${old}"`).join(`recipe "${value}"`), w);
      if (!isDeepStrictEqual(was.warnings.map(said), now.warnings)) throw refused(q, "its warnings differ");
      // Each renamed entry holds the files of the one it replaces (`name` and `as` are outside the fingerprint).
      for (const i of was.ingredients) {
        const to = rename(i.ref);
        if (to === i.ref) continue;
        if ((await fingerprintDir(edited.ingredients.get(to)!.dir)) !== (await fingerprintDir(i.dir))) throw refused(q, `${to} would not hold the same files`);
      }
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Write a promotion into its Forge: every write, then every removal, each noted in `journal` before it is touched. */
export async function applyBasePromotion(promotion: BasePromotion, journal: WriteJournal): Promise<void> {
  await assertNoLinkOnPath(promotion.root, [...promotion.writes.map((w) => w.abs), ...promotion.removes]);
  await writeInto(promotion.root, promotion, journal);
}
