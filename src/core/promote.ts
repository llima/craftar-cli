import { promises as fs } from "node:fs";
import { forgeFor, holdsIngredient, isLocalMessage, localCiters, localOwners, localRecipeNamed, overriddenWarnings, shownIngredientRef, skippedLinkWarning } from "./profile-local.js";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { forgeReader, readForgeFile, readForgeText } from "./contain.js";
import { ProfileWrittenSchema, RecipeWrittenSchema, WorkspaceConfigSchema, type IngredientRef } from "../schema/index.js";
import { fingerprintDir } from "./fingerprint.js";
import { ingredientText, occupied, sourceMode, recipeFiles, resolveAll, swapEntry, unreadable, writeEdits, type ForgeWrite } from "./forge-edits.js";
import { assertNoDirLinkIn, assertNoLinkOnPath, copyForgeForProof, removeProofCopy, scratchWriteRefusal, exists, listFiles, loadForge, parseYaml, typeFolder, type Forge, type LoadedIngredient } from "./forge.js";
import { effectiveProfile } from "./integrations.js";
import { familyOf } from "./profile-extends.js";
import { findProfileFile } from "./param-writes.js";
import { recipeOrder, resolve, type Resolution } from "./resolve.js";
import { errorText } from "./schema-fault.js";
import { type WriteJournal } from "./unify.js";
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
export type PromotionWrite = ForgeWrite;

export interface BasePromotion {
  /** The Forge's root, absolute. */
  root: string;
  /** `X`, `p` and `X--p`. */
  base: IngredientRef;
  /** The profile named by `--profile`, or `null` when the variant was named by `--variant` (spec 56 §5.2). */
  profile: string | null;
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
const firstLine = (e: unknown) => errorText(e).split("\n")[0];
const byPath = (a: { abs: string }, b: { abs: string }) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0);

/**
 * The edit set of a promotion (design of spec 29 §4.4): what would be written and removed, and the refusals that need
 * no proof — P1, P3–P6. Reads the Forge only; writes nothing and creates no directory.
 */
export async function planBasePromotion(forge: Forge, ref: string, who: string | { variant: string }): Promise<BasePromotion> {
  const base = forge.ingredients.get(ref as IngredientRef);
  const owners = localOwners(forge, ref);
  if (!base && owners.length) throw new Error(`${COMMAND}: ${isLocalMessage(ref, owners)} — promote works on the root's ingredients`);
  if (!base) throw new Error(`${COMMAND}: ${ref} is not an ingredient of this Forge`);
  if (base.meta.as) throw new Error(`${COMMAND}: ${ref} is a variant — name its base, ${base.meta.type}/${base.meta.as}, with --profile`);
  const type = base.meta.type;
  const X = base.ref;
  const variantOf = (q: string): LoadedIngredient | undefined =>
    [...forge.ingredients.values()].find((i) => i.meta.type === type && i.meta.as === base.meta.name && profileOf(i.meta) === q);
  // `--variant <ref>` names the variant itself (spec 56 §5.2); `<base>--<p>` is the same run as `--profile <p>`.
  let profile: string | null;
  let variant: LoadedIngredient | undefined;
  if (typeof who === "string") {
    profile = who;
    variant = variantOf(profile);
    if (!variant) throw new Error(`${COMMAND}: ${ref} has no variant for profile ${profile}`);
  } else {
    const named = forge.ingredients.get(who.variant as IngredientRef);
    if (!named || named.meta.type !== type || named.meta.as !== base.meta.name) throw new Error(`${COMMAND}: ${shownIngredientRef(who.variant)} is not a variant of ${X}`);
    variant = named;
    const owner = profileOf(named.meta);
    profile = owner !== null && named === variantOf(owner) ? owner : null;
  }

  // Spec 51 §4.5: a local recipe that cites the base or the variant would be left naming what promote renames.
  const citers = localCiters(forge, [X, variant.ref]);
  if (citers.length) throw new Error(`${COMMAND}: ${citers.map((c) => c.file).join(", ")} cites ${X} or ${variant.ref} — promote does not edit a profile's local recipe; edit it by hand, commit, and re-run`);

  // Check for symlinks to directories inside the base and variant directories before reading their files.
  await assertNoDirLinkIn(forge.root, base.dir, COMMAND);
  await assertNoDirLinkIn(forge.root, variant.dir, COMMAND);

  const warnings: string[] = [...overriddenWarnings(forge, X)];
  const before = resolveAll(forge);
  const holds = (q: string, r: string) => {
    const res = before.get(q);
    const ing = forge.ingredients.get(r as IngredientRef);
    return res !== undefined && !(res instanceof Error) && ing !== undefined && holdsIngredient(res, ing);
  };
  for (const [q, res] of before) if (res instanceof Error) warnings.push(`profile ${q} does not resolve today (${firstLine(res)}) — promote could not check it`);
  // The profiles on the variant: the named one, or — under `--variant` — every one that resolves it (by scope).
  const onVariant = profile !== null ? [profile] : [...before.keys()].filter((q) => holds(q, variant.ref));
  for (const q of onVariant) {
    if (holds(q, X)) {
      throw new Error(
        `${COMMAND}: profile ${q} resolves ${X} itself — the Forge is inconsistent (it would write one file from two ingredients); remove one from its recipes by hand, commit, and re-run`,
      );
    }
  }
  const Q = [...before.keys()].filter((q) => !onVariant.includes(q) && holds(q, X));
  const variantRef = (q: string) => `${type}/${base.meta.name}--${q}` as IngredientRef;

  const folder = path.join(forge.root, "ingredients", typeFolder(type));
  const ingredientWrites = async (from: LoadedIngredient, toDir: string, yaml: string): Promise<PromotionWrite[]> => {
    const out: PromotionWrite[] = [];
    for (const rel of await listFiles(from.dir)) {
      if (rel === "ingredient.yaml") continue;
      const abs = path.join(toDir, rel);
      const src = path.join(from.dir, rel);
      out.push({ abs, content: await readForgeFile(from.forgeRoot, src), created: !(await exists(abs)), mode: await sourceMode(src) });
    }
    const abs = path.join(toDir, "ingredient.yaml");
    return [...out.sort(byPath), { abs, content: yaml, created: !(await exists(abs)) }];
  };
  const metaText = (ing: LoadedIngredient) => readForgeText(ing.forgeRoot, path.join(ing.dir, "ingredient.yaml"));
  const label = (abs: string) => posix(forge.root, abs);

  /* ---- X--q for every profile on the old base ---- */
  const createdWrites: PromotionWrite[] = [];
  for (const q of Q) {
    const dir = path.join(folder, `${base.meta.name}--${q}`);
    const variantLabel = `ingredients/${typeFolder(type)}/${base.meta.name}--${q}`;
    // An empty directory is no ingredient: a late failure undone with git leaves one behind, and the re-run must pass.
    if (variantOf(q) || forge.ingredients.has(variantRef(q)) || (await occupied(dir, variantLabel, COMMAND))) {
      throw new Error(
        `${COMMAND}: ${variantRef(q)} already exists, and profile ${q} also resolves ${X} — the Forge is inconsistent (both would write one file); remove one by hand, commit, and re-run`,
      );
    }
    const yaml = ingredientText(await metaText(base), label(path.join(base.dir, "ingredient.yaml")), base.meta, `${base.meta.name}--${q}`, base.meta.name, COMMAND);
    createdWrites.push(...(await ingredientWrites(base, dir, yaml)));
  }

  /* ---- the base takes the variant's directory ---- */
  const baseYaml = ingredientText(await metaText(variant), label(path.join(variant.dir, "ingredient.yaml")), variant.meta, base.meta.name, null, COMMAND);
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
    // As written against as written (spec 54 §4.4), so a `{ file: }` section value compares unchanged.
    const was = parseYaml(where, raw, RecipeWrittenSchema);
    const expected = { ...was, name, ingredients: was.ingredients.map((i) => (i === old ? value : i)) };
    if (!isDeepStrictEqual(parseYaml(where, text, RecipeWrittenSchema), expected)) throw unreadable(where, `${old} replaced by ${value}`, COMMAND);
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
      // The written list (the file promote would edit), never the family's merged one (spec 54 §5.10).
      const written = forge.profiles.get(q)!;
      // A recipe a parent reaches — listed, selected by its integrations block, or extended — is the family's, the child
      // listing it too or not (spec 54 §5.10); the one predicate drift promote uses. A parent that does not resolve fails closed.
      const parent = familyOf(forge, q).slice(1).find((p) => {
        try {
          return recipeOrder(forgeFor(forge, q), effectiveProfile(forge, forge.profiles.get(p)!).recipes, `profile ${p}`).includes(name);
        } catch (e) {
          throw new Error(`${COMMAND}: the recipes of profile ${p}, which ${q} extends, do not resolve (${errorText(e)}) — fix the Forge and re-run`);
        }
      });
      if (parent) {
        throw new Error(`${COMMAND}: profile ${q} reaches recipe ${name} (which names ${X}) through ${parent}, which it extends — no command writes a parent: edit the Forge by hand`);
      }
      if (!written.recipes.includes(name)) {
        const eff = effectiveProfile(forge, written);
        const sel = eff.selected.find((s) => s.recipe === name);
        if (sel) {
          throw new Error(`${COMMAND}: profile ${q} selects recipe ${name} (which names ${X}) through integrations.${sel.slot} — promote cannot repoint a recipe a block selects by editing a recipes list; edit the Forge by hand`);
        }
        throw new Error(`${COMMAND}: profile ${q} reaches recipe ${name} (which names ${X}) through ${chainTo(forgeFor(forge, q), eff.recipes, name)} — promote would have to copy that chain; edit the Forge by hand`);
      }
      const copy = `${name}--${q}`;
      const abs = path.join(forge.root, "recipes", `${copy}.yaml`);
      if (forge.recipes.has(copy) || localRecipeNamed(forge, copy) || (await exists(abs)) || (await exists(path.join(forge.root, "recipes", `${copy}.yml`)))) {
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
    // Spec 55 §5.2: as written against as written, so a `{ file: }` section value compares unchanged.
    const was = parseYaml(where, await fs.readFile(abs, "utf8"), ProfileWrittenSchema);
    const expected = { ...was, recipes: was.recipes.map((r) => list.find((s) => s.old === r)?.new ?? r) };
    if (!isDeepStrictEqual(parseYaml(where, text, ProfileWrittenSchema), expected)) throw unreadable(where, `recipes ${list.map((s) => `${s.old} replaced by ${s.new}`).join(", ")}`, COMMAND);
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
    throw new Error(`${COMMAND}: cannot make the scratch copy in the temporary directory (${code}) — nothing was written`);
  }
  try {
    await copyForgeForProof(forge.root, scratch);
    try {
      await writeEdits(promotion.root, scratch, promotion);
    } catch (e) {
      // The copy carries each file's mode, so what cannot be written there cannot be written in the Forge either.
      throw scratchWriteRefusal(COMMAND, scratch, e);
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
        if (forgeFor(edited, q).recipes.get(now.recipes[i])!.slot !== forgeFor(forge, q).recipes.get(was.recipes[i])!.slot) throw refused(q, `recipe ${now.recipes[i]} changes slot`);
      }
      for (const k of new Set([...Object.keys(was.params), ...Object.keys(now.params)])) {
        if (!isDeepStrictEqual(was.params[k], now.params[k])) throw refused(q, `its parameters differ (${k})`);
      }
      if (!isDeepStrictEqual(was.sections, now.sections)) throw refused(q, "its sections differ");
      if (!isDeepStrictEqual(was.targets, now.targets)) throw refused(q, "its targets differ");
      const said = (w: string) => [...split].reduce((t, [old, value]) => t.split(`recipe "${old}"`).join(`recipe "${value}"`), w);
      // A skipped linked folder (E39.2) is said of the whole Forge, and the scratch copy drops the link: its line is on
      // one side only, and is not the promotion's to prove.
      const linkLines = new Set([...(forge.skippedLinks ?? []), ...(edited.skippedLinks ?? [])].map(skippedLinkWarning));
      const own = (ws: string[]) => ws.filter((w) => !linkLines.has(w));
      if (!isDeepStrictEqual(own(was.warnings.map(said)), own(now.warnings))) throw refused(q, "its warnings differ");
      // Each renamed entry holds the files of the one it replaces (`name` and `as` are outside the fingerprint).
      for (const i of was.ingredients) {
        const to = rename(i.ref);
        if (to === i.ref) continue;
        const renamed = edited.ingredients.get(to)!;
        if ((await fingerprintDir(renamed.dir, forgeReader(renamed.forgeRoot))) !== (await fingerprintDir(i.dir, forgeReader(i.forgeRoot)))) throw refused(q, `${to} would not hold the same files`);
      }
    }
  } finally {
    await removeProofCopy(scratch);
  }
}

/** Write a promotion into its Forge: every write, then every removal, each noted in `journal` before it is touched. */
export async function applyBasePromotion(promotion: BasePromotion, journal: WriteJournal): Promise<void> {
  await assertNoLinkOnPath(promotion.root, [...promotion.writes.map((w) => w.abs), ...promotion.removes]);
  await writeEdits(promotion.root, promotion.root, promotion, journal);
}
