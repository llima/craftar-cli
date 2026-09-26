import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { fingerprintDir } from "./fingerprint.js";
import { exists, listFiles, loadForge, readIngredientText, type Forge, type LoadedIngredient } from "./forge.js";
import { splitLines, type Hunk } from "./diff.js";
import { detectEol, withEol, type Eol } from "./text.js";
import type { IngredientDiff } from "./variants.js";
import type { Ingredient, IngredientRef, Recipe, UnifyPlan, PlanFile, Take } from "../schema/index.js";

// Spelled out rather than embedded as a raw character: in the one function whose job is byte
// fidelity, correctness should not hinge on a glyph no diff viewer, editor or re-encoding shows.
const BOM = String.fromCharCode(0xfeff);

/** Where a hunk sits, worded exactly as `forge diff` prints it. */
export function hunkAt(h: Hunk): string {
  return h.a.lines.length ? `lines ${h.a.start}–${h.a.start + h.a.lines.length - 1}` : `after line ${h.a.start - 1}`;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Valid UTF-8, BOM included (a BOM is a valid UTF-8 sequence). */
function isUtf8(bytes: Buffer): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Every file of an ingredient but `ingredient.yaml`, as the raw bytes on disk. */
async function rawFilesOf(ing: LoadedIngredient): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const rel of await listFiles(ing.dir)) {
    if (rel === "ingredient.yaml") continue;
    out.set(rel, await fs.readFile(path.join(ing.dir, rel)));
  }
  return out;
}

/**
 * Ruling 31: the merge engine is text-only, and `diffIngredients` decodes every file as UTF-8 —
 * which folds each invalid byte to U+FFFD, so two different non-UTF-8 files can look identical to
 * it (and to every decision built on it). Compare the raw bytes of every file present on both
 * sides instead; when they differ and either side is not valid UTF-8, refuse by name rather than
 * merge or drop what the text view cannot see. `diffIngredients` itself is left alone: it also
 * serves `forge diff` and `forge variants`.
 */
export async function assertTextMergeable(base: LoadedIngredient, variant: LoadedIngredient): Promise<void> {
  const a = await rawFilesOf(base);
  const b = await rawFilesOf(variant);
  for (const [rel, bytes] of a) {
    const other = b.get(rel);
    if (other === undefined || bytes.equals(other)) continue;
    const bad = [!isUtf8(bytes) && "base", !isUtf8(other) && "variant"].filter(Boolean).join(" and ");
    if (bad) {
      throw new Error(
        `unify: "${rel}" differs between the base and the variant and is not valid UTF-8 in the ${bad} — ` +
          `the merge engine is text-only and cannot merge it; resolve it by hand.`,
      );
    }
  }
}

/** A plan with every decision deferred. The human edits it; nothing is assumed. */
export async function planFrom(
  base: LoadedIngredient,
  variant: LoadedIngredient,
  diff: IngredientDiff,
  profile: string,
): Promise<UnifyPlan> {
  await assertTextMergeable(base, variant);
  const files: PlanFile[] = [];
  for (const f of diff.files) {
    files.push({ file: f.file, hunks: f.hunks.map((h, i) => ({ hunk: i + 1, at: hunkAt(h), take: "keep" as const, suggestion: h.suggestion })) });
  }
  for (const file of diff.onlyInBase) files.push({ file, onlyIn: "base", take: "keep" });
  for (const file of diff.onlyInVariant) files.push({ file, onlyIn: "variant", take: "keep" });
  return {
    schema: 1,
    base: base.ref,
    profile,
    variant: variant.ref,
    baseFingerprint: await fingerprintDir(base.dir),
    variantFingerprint: await fingerprintDir(variant.dir),
    files,
  };
}

/** Metadata the two sides may legitimately disagree on: identity and provenance, not behaviour. */
function comparableMeta(meta: Ingredient): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...meta };
  delete rest.name;
  delete rest.as;
  delete rest.origin;
  return rest;
}

/**
 * Ruling 28: the top-level `ingredient.yaml` fields on which base and variant differ, sorted.
 * `diffIngredients` leaves `ingredient.yaml` out, so without this a variant that differs only in
 * its metadata (an MCP `server`, an agent's `model` or `tools`) would resolve with zero decisions
 * and be deleted. Compared on the zod-validated `meta` with a real deep equality, field by field so
 * the differing fields can be named — never through `JSON.stringify(x, keys)`, whose key-array
 * replacer filters at every depth and sees two different nested `server` objects as the same `{}`.
 */
export function metaDifferences(base: LoadedIngredient, variant: LoadedIngredient): string[] {
  const a = comparableMeta(base.meta);
  const b = comparableMeta(variant.meta);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !isDeepStrictEqual(a[k], b[k])).sort();
}

export interface ApplyOptions {
  /**
   * `--take base`: discarding the variant is what was asked, its metadata included, so a
   * metadata difference does not hold the variant back (Ruling 28).
   */
  discardVariantMeta?: boolean;
}

export interface UnifyResult {
  /**
   * Base-relative path → new content. Only files whose bytes change appear. A one-sided file
   * copied from the variant that is not valid UTF-8 is carried as its raw bytes (Ruling 31).
   */
  write: Record<string, string | Buffer>;
  /** Base-relative paths to delete. */
  remove: string[];
  /** No decision was left at `keep`, and no `ingredient.yaml` difference holds the variant back. */
  resolved: boolean;
  /** Hunks and one-sided files still at `keep`. */
  unresolved: number;
  /**
   * Top-level `ingredient.yaml` fields that differ (`name`, `as`, `origin` aside) and that unify
   * cannot merge; non-empty means not resolved. Always empty under `discardVariantMeta`.
   */
  metaDiffers: string[];
}

/**
 * Rebuild one file by walking the base's lines and swapping in the variant's where chosen.
 *
 * Two things the base decides no matter what wins a hunk: its BOM and its line endings — the
 * base is what survives, so both are read off `baseText` and restored around the merge, the same
 * way `src/emitters/shared.ts` re-prepends a BOM onto a file it replaces.
 *
 * The final newline is the other subtlety: it comes from whichever side won the *last* hunk, and
 * only when that hunk actually reaches the end of the file — i.e. no unchanged base line follows
 * it. That "reaches the end" check has to be taken right after applying the last hunk, before the
 * catch-up loop below copies any remaining base lines: that loop always drives `i` up to
 * `A.lines.length`, so testing position after it would call every last hunk "at the tail" even
 * when a common suffix follows it untouched — silently forcing (or dropping) a trailing newline
 * a hunk in the middle of the file never decided.
 *
 * The decision itself is read off the whole file each side came from (`A.eofNewline` /
 * `B.eofNewline`), not reconstructed from the winning hunk's own `noEofNewline` flag — that flag
 * has nothing to say when the winning side contributes no lines (a pure removal taken as the
 * winner), so `variantText` is passed in alongside the hunks for exactly this reason.
 */
function mergeFile(baseText: string, variantText: string, hunks: Hunk[], takes: Take[]): string {
  const bom = baseText.charCodeAt(0) === BOM.charCodeAt(0);
  const A = splitLines(baseText);
  const B = splitLines(variantText);
  const out: string[] = [];
  let i = 0; // 0-based index into A.lines
  let iAfterLastHunk = 0;
  let lastWinnerIsVariant = false;
  hunks.forEach((h, k) => {
    const start = h.a.start - 1; // a.start is 1-based and marks where the hunk applies
    while (i < start) out.push(A.lines[i++]);
    const takeVariant = takes[k] === "variant";
    const side = takeVariant ? h.b : h.a;
    out.push(...side.lines);
    i += h.a.lines.length; // the base's lines for this hunk are consumed either way
    if (k === hunks.length - 1) {
      iAfterLastHunk = i;
      lastWinnerIsVariant = takeVariant;
    }
  });
  while (i < A.lines.length) out.push(A.lines[i++]);

  // The tail decides the final newline only when the last hunk reaches the end of the file.
  const endsAtTail = hunks.length > 0 && iAfterLastHunk >= A.lines.length;
  const eofNewline = endsAtTail ? (lastWinnerIsVariant ? B.eofNewline : A.eofNewline) : A.eofNewline;
  // An empty result is the empty string, not a lone newline — `out.join("\n")` on an empty array
  // is already "", but the `+ eofNewline` term must not turn that into a false "\n" on its own.
  const body = out.length ? out.join("\n") + (eofNewline ? "\n" : "") : "";
  return (bom ? BOM : "") + withEol(body, detectEol(baseText));
}

/**
 * Turn a plan's per-hunk, per-file decisions into the bytes to write. Only paths whose merged
 * content differs from the base's current bytes appear in `write` — a plan of all-`base`
 * decisions writes nothing, so `unify` never rewrites a file it did not change.
 */
export async function applyPlan(
  base: LoadedIngredient,
  variant: LoadedIngredient,
  diff: IngredientDiff,
  plan: UnifyPlan,
  opts: ApplyOptions = {},
): Promise<UnifyResult> {
  await assertTextMergeable(base, variant);
  const write: Record<string, string | Buffer> = {};
  const remove: string[] = [];
  let unresolved = 0;

  const hunksByFile = new Map(diff.files.map((f) => [f.file, f.hunks]));
  const onlyInBase = new Set(diff.onlyInBase);
  const onlyInVariant = new Set(diff.onlyInVariant);

  // Ruling 29 (spec §8 refusal 7, in both directions): the plan must cover every file the diff
  // has — paired, base-only and variant-only — each exactly once. The walk below only visits the
  // plan's own entries, so without this a plan stripped of an entry would apply as "resolved" and
  // the caller would delete the variant together with the one copy of whatever was left out; two
  // entries for the same file would let the last one silently win. Checked before any decision is
  // read, so a contradiction never gets half-applied.
  const planned = new Set<string>();
  for (const pf of plan.files) {
    if (pf.hunks && pf.onlyIn) {
      throw new Error(
        `unify plan: "${pf.file}" carries both hunk decisions and a side ("onlyIn: ${pf.onlyIn}") — the plan no longer matches this diff.`,
      );
    }
    if (planned.has(pf.file)) {
      throw new Error(`unify plan: "${pf.file}" has more than one entry — each file in the diff must be decided exactly once.`);
    }
    planned.add(pf.file);
  }
  for (const file of [...hunksByFile.keys(), ...onlyInBase, ...onlyInVariant]) {
    if (!planned.has(file)) {
      throw new Error(`unify plan: "${file}" differs between the base and the variant but has no entry in the plan — the plan no longer matches this diff.`);
    }
  }

  for (const pf of plan.files) {
    if (pf.hunks) {
      const hunks = hunksByFile.get(pf.file);
      if (!hunks) throw new Error(`unify plan: no diff hunks recorded for paired file "${pf.file}"`);

      // A plan is hand-edited YAML: bind each decision by its own `hunk` field, never by array
      // position, so a reordered entry still lands on the hunk it names. A length mismatch, or a
      // `hunk` value outside 1..n or repeated, means the plan no longer describes this diff —
      // refuse rather than silently misapplying a decision to the wrong hunk or defaulting a gap
      // to "base".
      if (pf.hunks.length !== hunks.length) {
        throw new Error(
          `unify plan: "${pf.file}" carries ${pf.hunks.length} hunk decision(s), but the diff has ${hunks.length} — the plan no longer matches this diff.`,
        );
      }
      const takes: Take[] = new Array(hunks.length);
      const seen = new Set<number>();
      for (const ph of pf.hunks) {
        if (ph.hunk < 1 || ph.hunk > hunks.length || seen.has(ph.hunk)) {
          throw new Error(
            `unify plan: "${pf.file}" hunk index ${ph.hunk} is out of range or duplicated — expected each of 1..${hunks.length} exactly once.`,
          );
        }
        seen.add(ph.hunk);
        takes[ph.hunk - 1] = ph.take;
      }

      unresolved += takes.filter((t) => t === "keep").length;
      // A plan with no `variant` decision cannot change this file's bytes — skip the merge
      // entirely rather than round-tripping the base through `splitLines`/`withEol` for nothing,
      // which would re-terminate a base with mixed line endings even though no decision moved it.
      if (takes.includes("variant")) {
        const baseText = await readIngredientText(base, pf.file);
        const variantText = await readIngredientText(variant, pf.file);
        const merged = mergeFile(baseText, variantText, hunks, takes);
        if (merged !== baseText) write[pf.file] = merged;
      }
      continue;
    }

    // A plan entry with neither `hunks` nor `onlyIn` describes nothing to apply — the schema
    // leaves both optional (a hand-edited plan can drop either), so the engine is where this
    // contradiction is caught, per spec §6: "it throws on contradiction."
    if (!pf.onlyIn) {
      throw new Error(`unify plan: "${pf.file}" has neither hunk decisions nor a side ("onlyIn") — the plan no longer matches this diff.`);
    }

    // One-sided file: present only in the base or only in the variant. Checked against the diff
    // the same way a paired file's hunk count is checked above (spec §8 refusal 7: "names a file
    // ... the diff does not have") — a hand-edited plan can name a file that is shared and
    // identical (so the diff never lists it as one-sided at all, on either side) or has simply
    // moved sides since the plan was saved. Left unchecked, `take: "variant"` on such an entry
    // would fall through to `writeUnified`'s `fs.rm(..., { force: true })`, which deletes or
    // silently no-ops on a path the engine never proposed touching — a Forge with no lock cannot
    // afford that.
    const onlySet = pf.onlyIn === "base" ? onlyInBase : onlyInVariant;
    if (!onlySet.has(pf.file)) {
      throw new Error(
        `unify plan: "${pf.file}" is recorded as present only in the ${pf.onlyIn}, but the diff does not have it there — the plan no longer matches this diff.`,
      );
    }

    const take = pf.take ?? "keep";
    if (take === "keep") {
      unresolved += 1;
      continue;
    }
    if (pf.onlyIn === "base") {
      // take === "base" already matches the base as it stands; take === "variant" means the
      // variant's absence of the file wins, so it comes out of the base.
      if (take === "variant") remove.push(pf.file);
    } else if (pf.onlyIn === "variant") {
      // take === "base" already matches the base's absence of the file; take === "variant"
      // brings the variant's copy in — read without an encoding, so the bytes written are the
      // bytes on disk (Ruling 31). Valid UTF-8 round-trips exactly through a string, BOM
      // included, so it is carried as text; anything else stays a Buffer, which a UTF-8
      // decode/encode would corrupt.
      if (take === "variant") {
        const bytes = await fs.readFile(path.join(variant.dir, pf.file));
        write[pf.file] = isUtf8(bytes) ? bytes.toString("utf8") : bytes;
      }
    }
  }

  const metaDiffers = opts.discardVariantMeta ? [] : metaDifferences(base, variant);
  return { write, remove, resolved: unresolved === 0 && metaDiffers.length === 0, unresolved, metaDiffers };
}

/**
 * One path unify is about to write or remove in the Forge (Ruling 33). Entries are recorded
 * *before* each operation, so a failure midway still names the path it was working on; `created`
 * says the path did not exist before — git restores what it tracks with `checkout`, but a file
 * unify created can only be deleted.
 */
export interface JournalEntry {
  abs: string;
  created: boolean;
}
export type WriteJournal = JournalEntry[];

async function note(journal: WriteJournal | undefined, abs: string): Promise<void> {
  if (journal) journal.push({ abs, created: !(await exists(abs)) });
}

/**
 * Put a `UnifyResult` on disk: write the merged files, delete the ones the plan resolved away.
 * `ingredient.yaml` can never appear in either list — `diffIngredients` excludes it from both
 * sides of the diff a plan is built from — so this function never touches an ingredient's
 * metadata. Every path is noted in `journal`, when given, before it is touched.
 *
 * Returns every base-relative path touched, written or removed, sorted — what the CLI reports as
 * "what changed."
 */
export async function writeUnified(base: LoadedIngredient, result: UnifyResult, journal?: WriteJournal): Promise<string[]> {
  for (const [rel, content] of Object.entries(result.write)) {
    const abs = path.join(base.dir, rel);
    await note(journal, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  for (const rel of result.remove) {
    const abs = path.join(base.dir, rel);
    await note(journal, abs);
    await fs.rm(abs, { force: true });
  }
  return [...Object.keys(result.write), ...result.remove].sort();
}

export interface RecipeCascadeResult {
  /** Recipes whose `ingredients` referenced the variant and now reference the base instead. */
  rewritten: string[];
  /**
   * Ruling 42: rewritten recipes `<r>--<profile>` that are now identical to their unsuffixed
   * sibling `<r>`. Reported, never deleted — see `identicalToSibling`.
   */
  identicalToSibling: string[];
}

/**
 * Find the recipe file under `recipes/` whose `name` field matches, by scanning rather than
 * assuming `<name>.yaml` — `loadForge` keys `forge.recipes` by the `name` field *inside* the
 * YAML, never by filename, so a recipe can legally live in a file named after something else.
 * When two files declare the same `name`, the *last* one `readdir` returns wins — matching
 * `loadForge`'s `recipes.set(r.name, r)`, which overwrites on every later match in the same
 * directory order. There is no duplicate-name refusal for recipes the way there is for
 * ingredients, so agreeing with `loadForge` is the only consistency this can offer.
 */
async function findRecipeFile(recipesDir: string, name: string): Promise<string> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(recipesDir);
  } catch {
    entries = [];
  }
  let found: string | undefined;
  for (const f of entries) {
    if (!/\.ya?ml$/.test(f)) continue;
    const abs = path.join(recipesDir, f);
    let parsed: unknown;
    try {
      parsed = YAML.parse(await fs.readFile(abs, "utf8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && (parsed as { name?: unknown }).name === name) found = abs;
  }
  if (!found) throw new Error(`recipe "${name}" not found under ${recipesDir}`);
  return found;
}

/**
 * Read a YAML file for an in-place edit, capturing the EOL and BOM of the bytes on disk so the
 * edit can restore them — `YAML.parseDocument` / `doc.toString()` always emit LF without a BOM,
 * so a one-token change would otherwise turn into a whole-file diff in the git repo the user
 * reviews. The BOM check mirrors the one `mergeFile` already does on `baseText` in this file:
 * `charCodeAt(0)` against the BOM code point, rather than reading the file again as a `Buffer`
 * for `hasBom`.
 */
async function readYamlEdit(file: string): Promise<{ doc: ReturnType<typeof YAML.parseDocument>; eol: Eol; bom: boolean }> {
  const raw = await fs.readFile(file, "utf8");
  return { doc: YAML.parseDocument(raw), eol: detectEol(raw), bom: raw.charCodeAt(0) === BOM.charCodeAt(0) };
}

/** Serialize an edited document back with the original file's EOL and BOM, flow collections unpadded. */
function serializeYamlEdit(doc: ReturnType<typeof YAML.parseDocument>, eol: Eol, bom: boolean): string {
  return (bom ? BOM : "") + withEol(doc.toString({ flowCollectionPadding: false }), eol);
}

/**
 * Replace every scalar entry equal to `from` with `to` inside the sequence at `key`, matched by
 * value — never by rebuilding the sequence, so untouched entries, comments and formatting survive
 * the round trip. Returns how many entries were replaced, so a caller that expected at least one
 * (because the schema-parsed value it read off `loadForge` already contained `from`) can tell a
 * no-op apart from a real edit — e.g. `key` resolving to an alias/anchor node rather than a plain
 * `YAMLSeq`, which this function cannot rewrite safely and reports as zero.
 */
function replaceSeqEntry(doc: ReturnType<typeof YAML.parseDocument>, key: string, from: string, to: string): number {
  const seq = doc.get(key, true);
  if (!(seq instanceof YAML.YAMLSeq)) return 0;
  let count = 0;
  seq.items.forEach((item, i) => {
    const value = item instanceof YAML.Scalar ? item.value : item;
    if (value === from) {
      seq.set(i, to);
      count++;
    }
  });
  return count;
}

/** One recipe's `ingredients` edit: the variant's ref becomes the base's, in one file. */
interface IngredientEdit {
  name: string;
  file: string;
  from: IngredientRef;
  to: IngredientRef;
}

/**
 * Render an edit without writing it. `loadForge` already said the recipe's `ingredients` holds
 * `from`; if the sequence edit still replaces nothing (an alias/anchor, for instance), that is a
 * file unify cannot safely rewrite — throw rather than record a rewrite that did not happen
 * (Ruling 14).
 */
async function renderIngredientEdit(e: IngredientEdit): Promise<string> {
  const { doc, eol, bom } = await readYamlEdit(e.file);
  if (replaceSeqEntry(doc, "ingredients", e.from, e.to) === 0) {
    throw new Error(
      `unify: recipe "${e.name}" (${e.file}) is recorded as naming ${e.from} in its "ingredients", ` +
        `but no matching entry was found to rewrite (it may reach "ingredients" through a YAML alias/anchor) — refusing to report it as rewritten.`,
    );
  }
  return serializeYamlEdit(doc, eol, bom);
}

/** Every recipe whose `ingredients` holds the variant, found by its `name` field (Ruling 9). */
async function ingredientEdits(forge: Forge, baseRef: IngredientRef, variantRef: IngredientRef): Promise<IngredientEdit[]> {
  const recipesDir = path.join(forge.root, "recipes");
  const out: IngredientEdit[] = [];
  for (const [name, r] of forge.recipes) {
    if (!r.ingredients.includes(variantRef)) continue;
    out.push({ name, file: await findRecipeFile(recipesDir, name), from: variantRef, to: baseRef });
  }
  return out;
}

/**
 * Ruling 42: among the rewritten recipes, each `<r>--<profile>` that is now identical to its
 * unsuffixed sibling `<r>` — compared as `ingredients` (sorted), `extends`, `slot` and `params`,
 * never `description`, which is prose. It is only reported: deleting it and repointing the lists
 * that name it is safe only if `<r>` takes part in no other resolution — a transitive `extends`, a
 * workspace's `recipes.add` — and param defaults are last-wins while recipes apply at their first
 * occurrence, so either could shift. That cannot be proven from inside the Forge.
 */
function identicalToSibling(recipes: Map<string, Recipe>, rewritten: string[], profile: string): string[] {
  const suffix = `--${profile}`;
  const out: string[] = [];
  for (const rn of rewritten) {
    if (!rn.endsWith(suffix)) continue;
    const suffixed = recipes.get(rn);
    const sibling = recipes.get(rn.slice(0, -suffix.length));
    if (!suffixed || !sibling) continue;
    const same =
      isDeepStrictEqual([...suffixed.ingredients].sort(), [...sibling.ingredients].sort()) &&
      isDeepStrictEqual(suffixed.extends, sibling.extends) &&
      suffixed.slot === sibling.slot &&
      isDeepStrictEqual(suffixed.params, sibling.params);
    if (same) out.push(rn);
  }
  return out;
}

/**
 * The cascade's dry pass (Ruling 33): render every `ingredients` rewrite `rewriteRecipes` will
 * make and check that each one lands — alias checks included — writing nothing. A caller runs it
 * before the first write of the whole operation, so a refusal found here leaves the Forge exactly
 * as it was.
 *
 * Returns the recipe files the cascade will rewrite, absolute — the set the caller checks git
 * actually holds before writing (Ruling 37). Since Ruling 42 that is all the cascade ever touches:
 * it deletes no recipe and edits no profile or `extends`.
 */
export async function checkRecipeCascade(forge: Forge, baseRef: IngredientRef, variantRef: IngredientRef): Promise<string[]> {
  const files: string[] = [];
  for (const edit of await ingredientEdits(forge, baseRef, variantRef)) {
    await renderIngredientEdit(edit);
    files.push(edit.file);
  }
  return files;
}

/**
 * Follow the recipe cascade a resolved variant causes. Since Ruling 42 (a product decision) it is
 * one pass: every recipe whose `ingredients` holds `variantRef` is rewritten to hold `baseRef`,
 * which is required because the variant ingredient is about to be removed. It never deletes a
 * recipe and never edits a profile or an `extends` list.
 *
 * It starts with `checkRecipeCascade`, the dry pass, so a rewrite that would not land throws with
 * nothing written (Ruling 33). A caller that writes before calling this — the merged base, in
 * `forge unify` — runs the dry pass itself first, for the same guarantee over the whole
 * operation. What a dry pass cannot foresee (an I/O error, a file locked on Windows) can still
 * fail midway; every path is noted in `journal`, when given, before it is touched.
 *
 * Each file is written back through `YAML.parseDocument` so only that one sequence entry changes
 * (Ruling 10) — `RecipeSchema` materializes defaults a re-serialized schema object would write
 * into a file that may have had far fewer keys, dropping comments too — with its EOL and BOM kept
 * (Ruling 13). The caller orders this cascade *before* removing the variant's directory, so a late
 * failure leaves the variant in place rather than a recipe naming a directory that no longer
 * exists.
 *
 * Afterwards, against a reload of the Forge, it reports each rewritten `<r>--<profile>` now
 * identical to its sibling `<r>` (see `identicalToSibling`) for a human to remove.
 */
export async function rewriteRecipes(
  forge: Forge,
  baseRef: IngredientRef,
  variantRef: IngredientRef,
  profile: string,
  journal?: WriteJournal,
): Promise<RecipeCascadeResult> {
  await checkRecipeCascade(forge, baseRef, variantRef);

  const rewritten: string[] = [];
  for (const edit of await ingredientEdits(forge, baseRef, variantRef)) {
    const content = await renderIngredientEdit(edit);
    await note(journal, edit.file);
    await fs.writeFile(edit.file, content);
    rewritten.push(edit.name);
  }
  if (rewritten.length === 0) return { rewritten, identicalToSibling: [] };

  const reloaded = await loadForge(forge.root);
  return { rewritten, identicalToSibling: identicalToSibling(reloaded.recipes, rewritten, profile) };
}
