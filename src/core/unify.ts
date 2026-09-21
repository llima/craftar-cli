import { fingerprintDir } from "./fingerprint.js";
import type { LoadedIngredient } from "./forge.js";
import type { Hunk } from "./diff.js";
import type { IngredientDiff } from "./variants.js";
import type { UnifyPlan, PlanFile } from "../schema/index.js";

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
