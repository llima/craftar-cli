import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyHunk, type ClassifiedHunk } from "./classify.js";
import { diffLines, splitLines, type Hunk } from "./diff.js";
import { fingerprintDir } from "./fingerprint.js";
import { listFiles, type Forge, type LoadedIngredient } from "./forge.js";
import type { HunkClass, IngredientRef } from "../schema/index.js";

export interface Distance {
  lines: number;
  hunks: number;
  /** The bodies are equal and the metadata differs — not "the metadata differs". */
  sameBodyDifferentMeta: boolean;
  identicalAfterNormalization: boolean;
}

export interface VariantEntry {
  ref: IngredientRef;
  profile: string;
  distance: Distance;
  /** Hunks by suggested class; a file present on one side only counts as one `block` (spec 08 §4.2). */
  classes: Record<HunkClass, number>;
}

export interface VariantGroup {
  base: IngredientRef;
  variants: VariantEntry[];
}

export interface OrphanVariant {
  ref: IngredientRef;
  profile: string;
  missingBase: IngredientRef;
}

export interface VariantReport {
  groups: VariantGroup[];
  orphans: OrphanVariant[];
}

export interface FileDiff {
  file: string;
  hunks: ClassifiedHunk[];
}

export interface IngredientDiff {
  files: FileDiff[];
  onlyInBase: string[];
  onlyInVariant: string[];
}

/**
 * The profile a variant belongs to. The importer writes `name = "<as>--<profile>"`,
 * so the profile is what follows the base name — never the text after the first `--`,
 * which would mangle a profile called `acme--eu`.
 */
export function profileOf(meta: { name: string; as?: string }): string | null {
  if (!meta.as) return null;
  const prefix = `${meta.as}--`;
  if (!meta.name.startsWith(prefix)) return null;
  const rest = meta.name.slice(prefix.length);
  return rest ? rest : null;
}

async function filesOf(ing: LoadedIngredient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listFiles(ing.dir)) {
    if (rel === "ingredient.yaml") continue;
    out.set(rel, await fs.readFile(path.join(ing.dir, rel), "utf8"));
  }
  return out;
}

export async function diffIngredients(base: LoadedIngredient, variant: LoadedIngredient): Promise<IngredientDiff> {
  const a = await filesOf(base);
  const b = await filesOf(variant);
  const files: FileDiff[] = [];
  for (const rel of [...a.keys()].sort()) {
    const other = b.get(rel);
    if (other === undefined) continue;
    // Classified here and nowhere else, so forge diff, forge variants and --save-plan agree (spec 08 §5.2).
    const hunks = diffLines(a.get(rel)!, other).map((h) => ({ ...h, suggestion: classifyHunk(h) }));
    if (hunks.length) files.push({ file: rel, hunks });
  }
  return {
    files,
    onlyInBase: [...a.keys()].filter((k) => !b.has(k)).sort(),
    onlyInVariant: [...b.keys()].filter((k) => !a.has(k)).sort(),
  };
}

async function measure(base: LoadedIngredient, variant: LoadedIngredient): Promise<{ distance: Distance; classes: Record<HunkClass, number> }> {
  const d = await diffIngredients(base, variant);
  const baseFiles = await filesOf(base);
  const variantFiles = await filesOf(variant);
  // A file present on one side only counts as one hunk carrying all of its lines (spec 04,
  // Ruling 9). Counted directly: diffing against "" mismatches a file with no final newline.
  const oneSidedLines =
    d.onlyInBase.reduce((n, f) => n + splitLines(baseFiles.get(f)!).lines.length, 0) +
    d.onlyInVariant.reduce((n, f) => n + splitLines(variantFiles.get(f)!).lines.length, 0);
  // A hunk whose two sides carry the same lines exists only to carry the final-newline fact
  // (diff.ts' forceTrailingHunk): no line content changed, so it costs 0 lines. It still counts
  // as one hunk — it is a real difference — which keeps a newline-only variant nearer than any
  // variant with a changed line instead of tied with it.
  const sameLines = (h: Hunk) =>
    h.a.lines.length === h.b.lines.length && h.a.lines.every((line, k) => line === h.b.lines[k]);
  const lineCount = (hunks: Hunk[]) =>
    hunks.reduce((k, h) => (sameLines(h) ? k : k + h.a.lines.length + h.b.lines.length), 0);
  const hunks = d.files.reduce((n, f) => n + f.hunks.length, 0) + d.onlyInBase.length + d.onlyInVariant.length;
  const lines = d.files.reduce((n, f) => n + lineCount(f.hunks), 0) + oneSidedLines;
  const bodyDiffers = hunks > 0;
  const sameFingerprint = (await fingerprintDir(base.dir)) === (await fingerprintDir(variant.dir));
  const classes: Record<HunkClass, number> = { evolution: 0, value: 0, block: d.onlyInBase.length + d.onlyInVariant.length };
  for (const f of d.files) for (const h of f.hunks) classes[h.suggestion.class]++;
  return {
    distance: {
      lines,
      hunks,
      sameBodyDifferentMeta: !bodyDiffers && !sameFingerprint,
      identicalAfterNormalization: !bodyDiffers && sameFingerprint,
    },
    classes,
  };
}

const nearest = (x: Distance, y: Distance) => x.lines - y.lines || x.hunks - y.hunks;

/** Bases that have at least one variant, nearest first, plus variants whose base is missing. */
export async function listVariants(forge: Forge): Promise<VariantReport> {
  const groups = new Map<IngredientRef, VariantEntry[]>();
  const orphans: OrphanVariant[] = [];
  for (const ing of forge.ingredients.values()) {
    const profile = profileOf(ing.meta);
    if (!profile || !ing.meta.as) continue;
    const baseRef = `${ing.meta.type}/${ing.meta.as}` as IngredientRef;
    const base = forge.ingredients.get(baseRef);
    if (!base) {
      // A recipe including this still emits it under the base name, so silence would hide a
      // broken Forge — the listing is where that state becomes visible.
      orphans.push({ ref: ing.ref, profile, missingBase: baseRef });
      continue;
    }
    const entry: VariantEntry = { ref: ing.ref, profile, ...(await measure(base, ing)) };
    groups.set(baseRef, [...(groups.get(baseRef) ?? []), entry]);
  }
  return {
    groups: [...groups]
      .map(([base, variants]) => ({
        base,
        variants: variants.sort((x, y) => nearest(x.distance, y.distance) || x.ref.localeCompare(y.ref)),
      }))
      .sort((x, y) => nearest(x.variants[0].distance, y.variants[0].distance) || x.base.localeCompare(y.base)),
    orphans: orphans.sort((x, y) => x.ref.localeCompare(y.ref)),
  };
}
