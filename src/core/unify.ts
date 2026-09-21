import { fingerprintDir } from "./fingerprint.js";
import { readIngredientText, type LoadedIngredient } from "./forge.js";
import { splitLines, type Hunk } from "./diff.js";
import { detectEol, withEol } from "./text.js";
import type { IngredientDiff } from "./variants.js";
import type { UnifyPlan, PlanFile, Take } from "../schema/index.js";

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
 */
function mergeFile(baseText: string, hunks: Hunk[], takes: Take[]): string {
  const bom = baseText.charCodeAt(0) === 0xfeff;
  const A = splitLines(baseText);
  const out: string[] = [];
  let i = 0; // 0-based index into A.lines
  let iAfterLastHunk = 0;
  let eofFromWinner: boolean | null = null;
  hunks.forEach((h, k) => {
    const start = h.a.start - 1; // a.start is 1-based and marks where the hunk applies
    while (i < start) out.push(A.lines[i++]);
    const takeVariant = takes[k] === "variant";
    const side = takeVariant ? h.b : h.a;
    out.push(...side.lines);
    i += h.a.lines.length; // the base's lines for this hunk are consumed either way
    if (k === hunks.length - 1) {
      iAfterLastHunk = i;
      if (side.lines.length) eofFromWinner = takeVariant ? !!h.b.noEofNewline : !!h.a.noEofNewline;
    }
  });
  while (i < A.lines.length) out.push(A.lines[i++]);

  // The tail decides the final newline only when the last hunk reaches the end of the file.
  const endsAtTail = hunks.length > 0 && iAfterLastHunk >= A.lines.length;
  const eofNewline = endsAtTail && eofFromWinner !== null ? !eofFromWinner : A.eofNewline;
  const body = out.join("\n") + (eofNewline ? "\n" : "");
  return (bom ? "﻿" : "") + withEol(body, detectEol(baseText));
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
      const takes = pf.hunks.map((h) => h.take);
      unresolved += takes.filter((t) => t === "keep").length;
      const baseText = await readIngredientText(base, pf.file);
      const merged = mergeFile(baseText, hunks, takes);
      if (merged !== baseText) write[pf.file] = merged;
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
