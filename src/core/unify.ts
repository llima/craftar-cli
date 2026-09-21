import { fingerprintDir } from "./fingerprint.js";
import { readIngredientText, type LoadedIngredient } from "./forge.js";
import { splitLines, type Hunk } from "./diff.js";
import { detectEol, withEol } from "./text.js";
import type { IngredientDiff } from "./variants.js";
import type { UnifyPlan, PlanFile, Take } from "../schema/index.js";

// Spelled out rather than embedded as a raw character: in the one function whose job is byte
// fidelity, correctness should not hinge on a glyph no diff viewer, editor or re-encoding shows.
const BOM = String.fromCharCode(0xfeff);

/** Where a hunk sits, worded exactly as `forge diff` prints it. */
export function hunkAt(h: Hunk): string {
  return h.a.lines.length ? `lines ${h.a.start}–${h.a.start + h.a.lines.length - 1}` : `after line ${h.a.start - 1}`;
}

/** A plan with every decision deferred. The human edits it; nothing is assumed. */
export async function planFrom(
  base: LoadedIngredient,
  variant: LoadedIngredient,
  diff: IngredientDiff,
  profile: string,
): Promise<UnifyPlan> {
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
  /** Base-relative path → new content. Only files whose bytes change appear. */
  write: Record<string, string>;
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
  const write: Record<string, string> = {};
  const remove: string[] = [];
  let unresolved = 0;

  const hunksByFile = new Map(diff.files.map((f) => [f.file, f.hunks]));

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

    // One-sided file: present only in the base or only in the variant.
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
      // brings the variant's copy in.
      if (take === "variant") write[pf.file] = await readIngredientText(variant, pf.file);
    }
  }

  return { write, remove, resolved: unresolved === 0, unresolved };
}
