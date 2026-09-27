import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { placeholders, reservedKey, substitutedFile } from "../core/extract.js";
import { fingerprintOf } from "../core/fingerprint.js";
import { exists, listFiles, loadForge, readIngredientText, type Forge } from "../core/forge.js";
import { hashNormalized, stripBom, toLf } from "../core/text.js";
import { deepMerge } from "../core/sync.js";
import { citedKeys, infer, readBase, renderMap, renderedFingerprint } from "../core/template-import.js";
import type { DirReader } from "../core/fingerprint.js";
import type { Ingredient } from "../schema/index.js";

/**
 * The decision half of template-aware import (spec 10 §6.1–§6.5): what the importing profile
 * renders, which keys this run has relied on, and whether a source is reused as rendered, reused
 * through inferred values, or left to become a variant.
 */

export interface RunContext {
  /** The importing profile's params, overlaid by every accepted change (`P`). */
  P: Record<string, unknown>;
  /** The workspace layer: overrides.params of craftar.yaml and craftar.local.yaml (`W`). */
  W: Record<string, unknown>;
  /** Keys this run has relied on, with the value (or absence) it relied on (§6.5). */
  pinned: Map<string, string | undefined>;
  /** The Forge as it stood before the run; null for an empty Forge. */
  forge: Forge | null;
}

export type Decision =
  | { kind: "reuse"; rendered?: string[]; inferred?: Record<string, string>; delta?: Array<{ key: string; old: string | null; value: string }> }
  | { kind: "variant"; why?: string }
  | { kind: "literal"; warn: string };

const norm = (s: string) => toLf(stripBom(s));
const textOf = (c: string | Buffer) => norm(typeof c === "string" ? c : c.toString("utf8"));
const valueOf = (m: Record<string, unknown>, k: string) => (Object.hasOwn(m, k) ? String(m[k]) : undefined);

/** The keys a source's admitted files cite literally. */
export function sourceKeys(meta: Ingredient, files: Record<string, string | Buffer>): Set<string> {
  const out = new Set<string>();
  for (const [rel, c] of Object.entries(files)) if (substitutedFile(meta, rel)) for (const k of placeholders(textOf(c))) out.add(k);
  return out;
}

/** Pin every key in `keys` at the value the importing profile renders it with now. */
export function pin(ctx: RunContext, keys: Iterable<string>, map: Record<string, unknown>): void {
  for (const k of keys) if (!ctx.pinned.has(k)) ctx.pinned.set(k, valueOf(map, k));
}

/**
 * Decide an existing base against one source. `others` are the run's other sources, for the
 * literal-citation check (§6.5 (c)); `runBases` are the refs of every source's base, which the
 * Forge-wide check excludes (§6.5 (b)).
 */
export async function decide(
  ctx: RunContext,
  dir: string,
  reader: DirReader,
  ref: string,
  meta: Ingredient,
  files: Record<string, string | Buffer>,
  fingerprint: string,
  others: Array<{ ref: string; meta: Ingredient; files: Record<string, string | Buffer> }>,
  runBases: Set<string>,
): Promise<Decision> {
  const base = await readBase(dir, reader);
  const cited = citedKeys(base.texts);

  // G1: a recipe default the render cannot see — compare literally, as 0.5.0 did.
  if (ctx.forge) {
    for (const k of cited) {
      if (Object.hasOwn(ctx.P, k) || Object.hasOwn(ctx.W, k)) continue;
      for (const [name, r] of ctx.forge.recipes) {
        if (r.params[k]?.default !== undefined) return { kind: "literal", warn: `${ref} cites {{${k}}}, which recipe ${name} defaults — compared literally` };
      }
    }
  }

  const map = renderMap(base.meta, ctx.P, ctx.W);
  if (renderedFingerprint(base, map) === fingerprint) {
    pin(ctx, cited, map);
    const changed = [...cited].filter((k) => Object.hasOwn(map, k));
    return { kind: "reuse", rendered: changed.length ? changed.sort() : undefined };
  }

  // Holes (§3): declared, not reserved, not set by the workspace layer, and not pinned — a key this run already relied
  // on renders at its current value, like any fixed key (§6.5, §14 Q13).
  const inferable = [...cited].filter((k) => base.meta.params?.[k] !== undefined && !reservedKey(k) && !Object.hasOwn(ctx.W, k));
  const holes = new Set(inferable.filter((k) => !ctx.pinned.has(k)));
  const pinnedHoles = inferable.filter((k) => ctx.pinned.has(k));
  if (!holes.size && !pinnedHoles.length) return { kind: "variant" };

  // F1, F2: what no value can explain.
  const metaOnly = { ...base.meta } as Record<string, unknown>;
  delete metaOnly.params;
  if (fingerprintOf(metaOnly as Ingredient, {}) !== fingerprintOf(meta, {})) return { kind: "variant", why: "metadata differs" };
  const baseFiles = [...base.texts.keys(), ...base.bytes.keys()].sort();
  const srcFiles = Object.keys(files).sort();
  const missing = baseFiles.find((f) => !srcFiles.includes(f)) ?? srcFiles.find((f) => !baseFiles.includes(f));
  if (missing) return { kind: "variant", why: `${missing} differs` };
  for (const [rel, b] of base.bytes) if (hashNormalized(b) !== hashNormalized(files[rel])) return { kind: "variant", why: `${rel} differs` };

  const fixed: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(map)) if (!holes.has(k)) fixed[k] = v;
  const sources = new Map([...base.texts.keys()].map((rel) => [rel, textOf(files[rel])]));
  const r = infer(base.texts, sources, holes, fixed);
  if ("fallback" in r) {
    // F8 (Ruling 5): when the source matches only with another value for a pinned key, name that key rather than the
    // line. The value it keeps is the one this base renders — P's or W's, which the run relied on, or, when neither
    // sets the key, this base's own default: an inference may not set it, or an earlier reuse at its default would move.
    if (pinnedHoles.length) {
      const open = new Set([...holes, ...pinnedHoles]);
      const wide = infer(base.texts, sources, open, Object.fromEntries(Object.entries(fixed).filter(([k]) => !open.has(k))));
      if (!("fallback" in wide)) {
        const k = pinnedHoles.find((x) => wide.values[x] !== valueOf(map, x));
        if (k !== undefined) {
          const is = valueOf(map, k);
          return { kind: "variant", why: `${k} is ${is === undefined ? "unset" : JSON.stringify(is)} in this import; ${ref} implies ${JSON.stringify(wide.values[k])}` };
        }
      }
    }
    return { kind: "variant", why: r.reason };
  }
  const sigma = r.values;
  const delta = Object.entries(sigma)
    .filter(([k, v]) => valueOf(map, k) !== v)
    .map(([key, value]) => ({ key, old: valueOf(ctx.P, key) ?? null, value }));

  // F10: the proof, through the same substitution ctx.text uses.
  if (renderedFingerprint(base, { ...map, ...sigma }) !== fingerprint) return { kind: "variant", why: `inference not proved for ${ref}` };

  // F9: a profile change must not move anything else the profile renders.
  for (const { key } of delta) {
    if (ctx.forge) {
      for (const ing of ctx.forge.ingredients.values()) {
        if (ing.ref === ref || runBases.has(ing.ref)) continue;
        for (const rel of await listAdmitted(ing)) {
          if (placeholders(norm(await readIngredientText(ing, rel))).includes(key)) return { kind: "variant", why: `setting ${key} would change ${ing.ref}` };
        }
      }
    }
    for (const o of others) {
      if (sourceKeys(o.meta, o.files).has(key)) return { kind: "variant", why: `setting ${key} would change ${o.ref}` };
    }
  }

  for (const d of delta) ctx.P[d.key] = d.value;
  pin(ctx, cited, { ...map, ...sigma });
  return { kind: "reuse", inferred: sigma, delta };
}

async function listAdmitted(ing: { dir: string; meta: Ingredient }): Promise<string[]> {
  return (await listFiles(ing.dir)).filter((rel) => rel !== "ingredient.yaml" && substitutedFile(ing.meta, rel));
}

const OverridesParams = z.record(z.unknown());

/** `W`: overrides.params of craftar.yaml and craftar.local.yaml, merged as loadWorkspace merges them (I6). */
export async function workspaceParams(ws: string, read: (abs: string) => Promise<string>): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = {};
  for (const f of ["craftar.yaml", "craftar.local.yaml"]) {
    const abs = path.join(ws, f);
    if (!(await exists(abs))) continue;
    try {
      const doc = YAML.parse(stripBom(await read(abs))) ?? {};
      const params = OverridesParams.parse(doc?.overrides?.params ?? {});
      out = deepMerge(out, params);
    } catch (e) {
      throw new Error(`import: ${f} does not load (${(e as Error).message})`);
    }
  }
  return out;
}

/** The Forge as it stood before the run, or null when it has no manifest yet (I5). */
export async function forgeBefore(root: string, manifest: string): Promise<Forge | null> {
  if (!(await exists(manifest))) return null;
  try {
    return await loadForge(root);
  } catch (e) {
    throw new Error(`import: the Forge does not load (${(e as Error).message})`);
  }
}
