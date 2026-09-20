import { promises as fs } from "node:fs";
import path from "node:path";
import { diffLines, splitLines, type Hunk } from "./diff.js";
import { fingerprintDir } from "./fingerprint.js";
import { listFiles, type Forge, type LoadedIngredient } from "./forge.js";
import type { IngredientRef } from "../schema/index.js";

export interface Distance {
  lines: number;
  hunks: number;
  metaDiffers: boolean;
  identicalAfterNormalization: boolean;
}

export interface VariantEntry {
  ref: IngredientRef;
  profile: string;
  distance: Distance;
}

export interface VariantGroup {
  base: IngredientRef;
  variants: VariantEntry[];
}

export interface FileDiff {
  file: string;
  hunks: Hunk[];
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
    const hunks = diffLines(a.get(rel)!, other);
    if (hunks.length) files.push({ file: rel, hunks });
  }
  return {
    files,
    onlyInBase: [...a.keys()].filter((k) => !b.has(k)).sort(),
    onlyInVariant: [...b.keys()].filter((k) => !a.has(k)).sort(),
  };
}

async function distanceOf(base: LoadedIngredient, variant: LoadedIngredient): Promise<Distance> {
  const d = await diffIngredients(base, variant);
  const baseFiles = await filesOf(base);
  const variantFiles = await filesOf(variant);
  // A file present on one side only counts as one hunk carrying all of its lines (spec 04,
  // Ruling 9). Counted directly: diffing against "" mismatches a file with no final newline.
  const oneSidedLines =
    d.onlyInBase.reduce((n, f) => n + splitLines(baseFiles.get(f)!).lines.length, 0) +
    d.onlyInVariant.reduce((n, f) => n + splitLines(variantFiles.get(f)!).lines.length, 0);
  const lineCount = (hunks: Hunk[]) => hunks.reduce((k, h) => k + h.a.lines.length + h.b.lines.length, 0);
  const hunks = d.files.reduce((n, f) => n + f.hunks.length, 0) + d.onlyInBase.length + d.onlyInVariant.length;
  const lines = d.files.reduce((n, f) => n + lineCount(f.hunks), 0) + oneSidedLines;
  const bodyDiffers = hunks > 0;
  const sameFingerprint = (await fingerprintDir(base.dir)) === (await fingerprintDir(variant.dir));
  return {
    lines,
    hunks,
    metaDiffers: !bodyDiffers && !sameFingerprint,
    identicalAfterNormalization: !bodyDiffers && sameFingerprint,
  };
}

const nearest = (x: Distance, y: Distance) => x.lines - y.lines || x.hunks - y.hunks;

/** Bases that have at least one variant, nearest first. */
export async function listVariants(forge: Forge): Promise<VariantGroup[]> {
  const groups = new Map<IngredientRef, VariantEntry[]>();
  for (const ing of forge.ingredients.values()) {
    const profile = profileOf(ing.meta);
    if (!profile || !ing.meta.as) continue;
    const baseRef = `${ing.meta.type}/${ing.meta.as}` as IngredientRef;
    const base = forge.ingredients.get(baseRef);
    if (!base) continue;
    const entry: VariantEntry = { ref: ing.ref, profile, distance: await distanceOf(base, ing) };
    groups.set(baseRef, [...(groups.get(baseRef) ?? []), entry]);
  }
  return [...groups]
    .map(([base, variants]) => ({
      base,
      variants: variants.sort((x, y) => nearest(x.distance, y.distance) || x.ref.localeCompare(y.ref)),
    }))
    .sort((x, y) => nearest(x.variants[0].distance, y.variants[0].distance) || x.base.localeCompare(y.base));
}
