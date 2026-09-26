import path from "node:path";
import { IngredientSchema, type Ingredient } from "../schema/index.js";
import { placeholders, substitutedFile } from "./extract.js";
import { fingerprintOf, type DirReader } from "./fingerprint.js";
import { parseYaml } from "./forge.js";
import { substitute } from "./resolve.js";
import { stripBom, toLf } from "./text.js";

/**
 * Template-aware import (spec 10): compare a workspace source with the Forge base as sync would
 * render it for the importing profile, and — failing that — infer the values of the base's
 * declared keys from the source. Pure but for the `DirReader` the importer hands in.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const norm = (s: string) => toLf(stripBom(s));

/** The values sync substitutes into `meta`'s files for the importing workspace: declared defaults, then P, then W (spec 10 §6.1). */
export function renderMap(meta: Ingredient, profileParams: Record<string, unknown>, workspaceParams: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(meta.params ?? {})) if (v.default !== undefined) out[k] = v.default;
  for (const [k, v] of Object.entries(profileParams)) out[k] = v;
  for (const [k, v] of Object.entries(workspaceParams)) out[k] = v;
  return out;
}

/** An ingredient directory as the comparison sees it: its validated metadata and its files, admitted ones as normalized text. */
export async function readBase(dir: string, io: DirReader): Promise<{ meta: Ingredient; texts: Map<string, string>; bytes: Map<string, Buffer> }> {
  const metaFile = path.join(dir, "ingredient.yaml");
  const meta = parseYaml(metaFile, await io.readText(metaFile), IngredientSchema);
  const texts = new Map<string, string>();
  const bytes = new Map<string, Buffer>();
  for (const rel of await io.list(dir)) {
    if (rel === "ingredient.yaml") continue;
    if (substitutedFile(meta, rel)) texts.set(rel, norm(await io.readText(path.join(dir, rel))));
    else bytes.set(rel, await io.readBytes(path.join(dir, rel)));
  }
  return { meta, texts, bytes };
}

/** The keys every admitted file of a base cites (`C(X)`). */
export function citedKeys(texts: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts.values()) for (const k of placeholders(t)) out.add(k);
  return out;
}

/**
 * The fingerprint of a base rendered through `map` (spec 10 §6.2): its metadata without `params`
 * (a workspace cannot express a declaration), admitted files substituted exactly as `ctx.text`
 * does, every other file as bytes. With no declaration and nothing set, this is `fingerprintDir`.
 */
export function renderedFingerprint(base: Awaited<ReturnType<typeof readBase>>, map: Record<string, unknown>): string {
  const meta: Record<string, unknown> = { ...base.meta };
  delete meta.params;
  const files: Record<string, string | Buffer> = {};
  for (const [rel, text] of base.texts) files[rel] = substitute(text, map);
  for (const [rel, b] of base.bytes) files[rel] = b;
  return fingerprintOf(meta as Ingredient, files);
}

export type Inference =
  | { values: Record<string, string> }
  | { fallback: "F4" | "F5" | "F6" | "F7"; reason: string };

type Segment = { lit: string } | { hole: string };

/** A template line split into literal text and holes; placeholders that are not holes are fixed first (§6.3 step 1). */
function segments(line: string, holes: Set<string>, map: Record<string, unknown>): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let lit = "";
  for (const m of line.matchAll(PLACEHOLDER)) {
    lit += line.slice(last, m.index);
    last = m.index! + m[0].length;
    const key = m[1];
    if (holes.has(key)) {
      out.push({ lit }, { hole: key });
      lit = "";
    } else {
      lit += Object.hasOwn(map, key) ? String(map[key]) : m[0];
    }
  }
  out.push({ lit: lit + line.slice(last) });
  return out.filter((s, i) => !("lit" in s) || s.lit !== "" || i === 0 || i === out.length - 1);
}

const validValue = (v: string) => v !== "" && !/[\n{}]/.test(v) && v === v.trim();

/** Every assignment of the holes that makes `segs` spell `line`, up to `limit`; `strict` applies the value rules. */
function solve(segs: Segment[], line: string, strict: boolean, limit: number): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = [];
  const walk = (i: number, pos: number, assigned: Record<string, string>) => {
    if (found.length >= limit) return;
    if (i === segs.length) {
      if (pos === line.length) found.push({ ...assigned });
      return;
    }
    const s = segs[i];
    if ("lit" in s) {
      if (line.startsWith(s.lit, pos)) walk(i + 1, pos + s.lit.length, assigned);
      return;
    }
    const next = segs[i + 1];
    const nextLit = next && "lit" in next ? next.lit : "";
    const lastHole = i + 1 >= segs.length || (i + 2 === segs.length && nextLit === "");
    for (let end = pos; end <= line.length; end++) {
      if (lastHole && end !== line.length - nextLit.length) continue;
      if (nextLit && !line.startsWith(nextLit, end)) continue;
      const v = line.slice(pos, end);
      if (strict && !validValue(v)) continue;
      if (assigned[s.hole] !== undefined && assigned[s.hole] !== v) continue;
      const had = assigned[s.hole];
      assigned[s.hole] = v;
      walk(i + 1, end, assigned);
      if (had === undefined) delete assigned[s.hole];
      if (found.length >= limit) return;
    }
  };
  walk(0, 0, {});
  return found;
}

/**
 * Infer the holes' values from the source files (spec 10 §6.3): line by line, every line with a
 * hole must have exactly one solution, and every occurrence of a key must agree across lines and
 * files. Not proved here — the caller renders with the result and compares fingerprints (§6.4).
 */
export function infer(templates: Map<string, string>, sources: Map<string, string>, holes: Set<string>, map: Record<string, unknown>): Inference {
  const values: Record<string, string> = {};
  const where: Record<string, string> = {};
  for (const [file, template] of templates) {
    const source = sources.get(file);
    if (source === undefined) return { fallback: "F5", reason: `${file} differs` };
    const tLines = template.split("\n");
    const sLines = norm(source).split("\n");
    if (tLines.length !== sLines.length) return { fallback: "F5", reason: `the template does not match ${file} (line counts differ)` };
    for (let n = 0; n < tLines.length; n++) {
      const segs = segments(tLines[n], holes, map);
      const hasHole = segs.some((s) => "hole" in s);
      if (!hasHole) {
        const lit = segs.map((s) => ("lit" in s ? s.lit : "")).join("");
        if (lit !== sLines[n]) return { fallback: "F5", reason: `the template does not match line ${n + 1} of ${file}` };
        continue;
      }
      for (let i = 1; i < segs.length; i++) {
        if ("hole" in segs[i] && "hole" in segs[i - 1]) {
          const a = (segs[i - 1] as { hole: string }).hole;
          const b = (segs[i] as { hole: string }).hole;
          return { fallback: "F4", reason: `inference ambiguous: {{${a}}}{{${b}}} are adjacent on line ${n + 1} of ${file}` };
        }
      }
      const sols = solve(segs, sLines[n], true, 2);
      if (sols.length > 1) return { fallback: "F6", reason: `inference ambiguous on line ${n + 1} of ${file}` };
      if (sols.length === 0) {
        const [loose] = solve(segs, sLines[n], false, 1);
        const bad = loose && Object.entries(loose).find(([, v]) => !validValue(v));
        if (bad) return { fallback: "F7", reason: `${bad[0]} would be ${JSON.stringify(bad[1])}, which a parameter cannot carry` };
        return { fallback: "F5", reason: `the template does not match line ${n + 1} of ${file}` };
      }
      for (const [k, v] of Object.entries(sols[0])) {
        if (values[k] !== undefined && values[k] !== v) {
          return { fallback: "F5", reason: `${k} is ${JSON.stringify(values[k])} in ${where[k]} but ${JSON.stringify(v)} on line ${n + 1} of ${file}` };
        }
        values[k] = v;
        where[k] ??= `line ${n + 1} of ${file}`;
      }
    }
  }
  return { values };
}
