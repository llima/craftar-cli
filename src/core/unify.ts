import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { fingerprintDir } from "./fingerprint.js";
import { listFiles, loadForge, readIngredientText, type Forge, type LoadedIngredient } from "./forge.js";
import { splitLines, type Hunk } from "./diff.js";
import { detectEol, withEol, type Eol } from "./text.js";
import type { IngredientDiff } from "./variants.js";
import type { IngredientRef, UnifyPlan, PlanFile, Take } from "../schema/index.js";

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
    files.push({ file: f.file, hunks: f.hunks.map((h, i) => ({ hunk: i + 1, at: hunkAt(h), take: "keep" as const })) });
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

export interface UnifyResult {
  /**
   * Base-relative path → new content. Only files whose bytes change appear. A one-sided file
   * copied from the variant that is not valid UTF-8 is carried as its raw bytes (Ruling 31).
   */
  write: Record<string, string | Buffer>;
  /** Base-relative paths to delete. */
  remove: string[];
  /** No decision was left at `keep`. */
  resolved: boolean;
  /** Hunks and one-sided files still at `keep`. */
  unresolved: number;
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

  return { write, remove, resolved: unresolved === 0, unresolved };
}

/**
 * Put a `UnifyResult` on disk: write the merged files, delete the ones the plan resolved away.
 * `ingredient.yaml` can never appear in either list — `diffIngredients` excludes it from both
 * sides of the diff a plan is built from — so this function never touches an ingredient's
 * metadata.
 *
 * Returns every base-relative path touched, written or removed, sorted — what the CLI reports as
 * "what changed."
 */
export async function writeUnified(base: LoadedIngredient, result: UnifyResult): Promise<string[]> {
  for (const [rel, content] of Object.entries(result.write)) {
    const abs = path.join(base.dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  for (const rel of result.remove) await fs.rm(path.join(base.dir, rel), { force: true });
  return [...Object.keys(result.write), ...result.remove].sort();
}

export interface RecipeCascadeResult {
  /** Recipes whose `ingredients` referenced the variant and were repointed at the base. */
  rewritten: string[];
  /** Suffixed recipes deleted because they became duplicates of their unsuffixed sibling. */
  deleted: string[];
  /** One `"<r>--<profile> -> <r>"` per deleted recipe, however many profiles it was repointed in. */
  profileRepointed: string[];
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
 * Find the profile file under `profiles/` whose `name` field matches, by scanning rather than
 * assuming `profiles/<name>/profile.yaml` — `loadForge` keys `forge.profiles` by the `name` field
 * *inside* `profile.yaml`, not by the directory name (`src/core/forge.ts`'s profile-loading loop
 * reads every `profiles/<dir>/profile.yaml` and sets by `p.name`), so a profile can legally live
 * in a directory named after something else. Last match wins, matching `loadForge` the same way
 * `findRecipeFile` does for recipes.
 */
async function findProfileFile(profilesRoot: string, name: string): Promise<string> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(profilesRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  let found: string | undefined;
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const abs = path.join(profilesRoot, d.name, "profile.yaml");
    let parsed: unknown;
    try {
      parsed = YAML.parse(await fs.readFile(abs, "utf8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && (parsed as { name?: unknown }).name === name) found = abs;
  }
  if (!found) throw new Error(`profile "${name}" not found under ${profilesRoot}`);
  return found;
}

/**
 * Read a YAML file for an in-place edit, capturing the EOL and BOM of the bytes on disk so the
 * edit can restore them — `YAML.parseDocument` / `doc.toString()` always emit LF without a BOM,
 * so a one-token change would otherwise turn into a whole-file diff in the git repo the user
 * reviews. The BOM check mirrors the one `mergeFile` already does on `baseText` in this file:
 * `charCodeAt(0)` against `﻿`, rather than reading the file again as a `Buffer` for
 * `hasBom`.
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

/**
 * Follow the recipe cascade a resolved variant causes (spec §7.2 items 2–4).
 *
 * Pass 1 rewrites every recipe whose `ingredients` holds `variantRef` to hold `baseRef` instead,
 * writing each file back through `YAML.parseDocument` so only that one sequence entry changes —
 * `RecipeSchema` materializes defaults (`extends`, `ingredients`, `params`) that a re-serialized
 * schema object would write into a file that may have had far fewer keys, dropping comments too.
 * `loadForge` already said this recipe's `ingredients` contains `variantRef`; if the sequence edit
 * still replaces nothing (an alias/anchor, for instance), that is a Forge unify cannot safely
 * rewrite — throw rather than record a rewrite that did not happen, since a caller trusting
 * `rewritten` would otherwise remove the variant's directory next (spec §7.2 step 1) and leave a
 * live reference to a deleted ingredient on disk. This function itself has deleted nothing by the
 * time it throws — but that is a fact about this function, not a safety guarantee about the whole
 * operation. The guarantee the caller must hold up is ordering: run this cascade *before* removing
 * the variant's directory, so a throw here still leaves an orphan variant (visible to `forge
 * variants`, resolvable by a re-run) rather than a base already merged, a variant already gone, and
 * a recipe still naming it — a state only `git checkout` can undo. The clean-git-tree refusal
 * (spec §8 rule 2) is still the documented undo for whatever the caller had already written to the
 * base by the time this throws.
 *
 * Pass 2 runs against a *reload* of the Forge, so it sees pass 1's writes on disk. The importer
 * suffixes a recipe `--<profile>` when any of its ingredients is a variant; once the variant is
 * gone, a suffixed recipe `<r>--<profile>` may now be identical to its unsuffixed sibling `<r>` —
 * compared as `ingredients` (sorted), `extends`, `slot` and `params`, never `description`, which
 * is prose. On a match, every profile that lists the suffixed recipe is repointed at `<r>` (not
 * only the `profile` argument — another profile may still reference it) *before* the suffixed
 * recipe's file is removed: if the profile scan fails, nothing has been deleted yet either.
 * A suffixed recipe with no matching sibling is left alone: spec §7.2 item 4, never rename.
 */
export async function rewriteRecipes(
  forge: Forge,
  baseRef: IngredientRef,
  variantRef: IngredientRef,
  profile: string,
): Promise<RecipeCascadeResult> {
  const recipesDir = path.join(forge.root, "recipes");
  const rewritten: string[] = [];

  for (const [name, r] of forge.recipes) {
    if (!r.ingredients.includes(variantRef)) continue;
    const file = await findRecipeFile(recipesDir, name);
    const { doc, eol, bom } = await readYamlEdit(file);
    const count = replaceSeqEntry(doc, "ingredients", variantRef, baseRef);
    if (count === 0) {
      throw new Error(
        `unify: recipe "${name}" (${file}) is recorded as referencing ${variantRef} in its "ingredients", ` +
          `but no matching entry was found to rewrite (it may reach "ingredients" through a YAML alias/anchor) — refusing to report it as rewritten.`,
      );
    }
    await fs.writeFile(file, serializeYamlEdit(doc, eol, bom));
    rewritten.push(name);
  }

  const deleted: string[] = [];
  const profileRepointed: string[] = [];
  if (rewritten.length === 0) return { rewritten, deleted, profileRepointed };

  const reloaded = await loadForge(forge.root);
  const profilesRoot = path.join(reloaded.root, "profiles");
  const suffix = `--${profile}`;

  for (const rn of rewritten) {
    if (!rn.endsWith(suffix)) continue;
    const r = rn.slice(0, -suffix.length);
    const suffixed = reloaded.recipes.get(rn);
    const sibling = reloaded.recipes.get(r);
    if (!suffixed || !sibling) continue;

    const same =
      isDeepStrictEqual([...suffixed.ingredients].sort(), [...sibling.ingredients].sort()) &&
      isDeepStrictEqual(suffixed.extends, sibling.extends) &&
      suffixed.slot === sibling.slot &&
      isDeepStrictEqual(suffixed.params, sibling.params);
    if (!same) continue;

    // Repoint every profile that lists the suffixed recipe before removing its file (Ruling 12):
    // if the profile scan throws, nothing has been deleted yet.
    for (const [pname, p] of reloaded.profiles) {
      if (!p.recipes.includes(rn)) continue;
      const profileFile = await findProfileFile(profilesRoot, pname);
      const { doc: pdoc, eol: peol, bom: pbom } = await readYamlEdit(profileFile);
      replaceSeqEntry(pdoc, "recipes", rn, r);
      await fs.writeFile(profileFile, serializeYamlEdit(pdoc, peol, pbom));
    }

    const suffixedFile = await findRecipeFile(path.join(reloaded.root, "recipes"), rn);
    await fs.rm(suffixedFile, { force: true });
    deleted.push(rn);
    profileRepointed.push(`${rn} -> ${r}`);
  }

  return { rewritten, deleted, profileRepointed };
}
