import path from "node:path";
import { placeholders, reservedKey, bodyFile } from "../core/extract.js";
import { parseWorkspaceYaml } from "../core/workspace-yaml.js";
import { fingerprintOf } from "../core/fingerprint.js";
import { exists, listFiles, loadForge, readIngredientText, type Forge } from "../core/forge.js";
import { hashNormalized, stripBom, toLf } from "../core/text.js";
import { deepMerge } from "../core/merge.js";
import { citedKeys, expandedTexts, infer, readBase, renderMap, renderedFingerprint, sectionNames, type ImportBase } from "../core/template-import.js";
import { canonicalValue, inferSections } from "../core/sections.js";
import { errorText } from "../core/schema-fault.js";
import { sectionKey } from "../core/resolve.js";
import type { DirReader } from "../core/fingerprint.js";
import { OverridesParamsSchema, SectionsSchema, stripForgeOnlyKeys, type Ingredient, type Sections } from "../schema/index.js";

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
  /** The importing profile's `sections`, overlaid by every accepted section change (`PS`, spec 11 §6.7). */
  PS: Sections;
  /** The workspace layer's sections: overrides.sections of craftar.yaml and craftar.local.yaml (`WS`). */
  WS: Sections;
  /**
   * Keys this run has relied on, with the first value (or absence) it relied on (§6.5). Decisions read only
   * membership; the value is kept for a later relaxation (every reliance at one value).
   */
  pinned: Map<string, string | undefined>;
  /** The Forge as it stood before the run; null for an empty Forge. */
  forge: Forge | null;
  /** Whether a source was decided against a base holding a section marker — the run then needs `schema: 2` (spec 11 §6.14, Ruling 22). */
  markedBase: boolean;
}

/** One entry of a section change `Δs` (spec 11 §3); `old` is the profile's value before, or null when it did not set it. */
export interface SectionChange {
  key: string;
  name: string;
  old: string | null;
  value: string;
}

export type Decision =
  | {
      kind: "reuse";
      rendered?: string[];
      /** Sections the render filled with a value rather than the default (spec 11 §4.3). */
      renderedSections?: string[];
      inferred?: Record<string, string>;
      delta?: Array<{ key: string; old: string | null; value: string }>;
      /** Every open section a section inference assigned, in declaration order (spec 11 §6.8). */
      sectioned?: string[];
      sectionDelta?: SectionChange[];
    }
  | { kind: "variant"; why?: string; authEnv?: string[] }
  | { kind: "literal"; warn: string };

const norm = (s: string) => toLf(stripBom(s));
const textOf = (c: string | Buffer) => norm(typeof c === "string" ? c : c.toString("utf8"));
const valueOf = (m: Record<string, unknown>, k: string) => (Object.hasOwn(m, k) ? String(m[k]) : undefined);

/** The keys a source's body files cite literally. */
export function sourceKeys(meta: Ingredient, files: Record<string, string | Buffer>): Set<string> {
  const out = new Set<string>();
  // the importer builds meta and file keys itself, with canonical names
  for (const [rel, c] of Object.entries(files)) if (bodyFile(meta, rel, null)) for (const k of placeholders(textOf(c))) out.add(k);
  return out;
}

/** Pin every key in `keys` at the value the importing profile renders it with now. */
export function pin(ctx: RunContext, keys: Iterable<string>, map: Record<string, unknown>): void {
  for (const k of keys) if (!ctx.pinned.has(k)) ctx.pinned.set(k, valueOf(map, k));
}

/**
 * Decide an existing base against one source. `others` are the run's other sources that may be
 * decided, for the literal-citation check (§6.5 (c)); `runBases` are the refs of the sources it
 * will certainly decide, which the Forge-wide check excludes (§6.5 (b)). See the F9 comment in
 * `importClaudeCode` for how each set errs on its safe side.
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
  // The Forge root, for the file an I12 names: every base lives at <forge>/ingredients/<folder>/<name>.
  const base = await readBase(dir, reader, path.resolve(dir, "..", "..", ".."));
  // The base's authEnv, to carry into the variant answer (spec 27 §5.3).
  const baseAuthEnv = base.meta.type === "mcp" ? base.meta.authEnv : undefined;
  const key = sectionKey(base.meta);
  const PSk = valuesAt(ctx.PS, key);
  const WSk = valuesAt(ctx.WS, key);
  // S(X): the profile's values under the workspace's, at (key, name) granularity (spec 11 §6.3, §6.7).
  const S: Record<string, string> = { ...PSk, ...WSk };
  const names = sectionNames(base);
  // Whatever the outcome — reuse, section inference, variant or a G1 literal comparison — the Forge holds these markers after the run.
  if (names.length) ctx.markedBase = true;
  const cited = citedKeys(expandedTexts(base, S));

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
  if (renderedFingerprint(base, map, S) === fingerprint) {
    pin(ctx, cited, map);
    const changed = [...cited].filter((k) => Object.hasOwn(map, k));
    const filled = names.filter((n) => Object.hasOwn(S, n));
    return { kind: "reuse", rendered: changed.length ? changed.sort() : undefined, renderedSections: filled.length ? filled : undefined };
  }

  // Param inference first (Ruling 16): the narrower claim. A base with no open section stops there, as in 0.6.2.
  const param = await inferParams(ctx, base, S, map, cited, ref, meta, files, fingerprint, others, runBases);
  const open = names.filter((n) => !Object.hasOwn(WSk, n));
  // Augment a variant decision with the base's authEnv for the importer to carry (spec 27 §5.3).
  const withAuthEnv = (d: Decision): Decision => (d.kind === "variant" && baseAuthEnv ? { ...d, authEnv: baseAuthEnv } : d);
  if (param.kind === "reuse" || !open.length) return withAuthEnv(param);
  return withAuthEnv(inferSectionValues(ctx, base, key, PSk, WSk, map, ref, meta, files, fingerprint));
}

/** A key's section values in a layer, or none. */
const valuesAt = (layer: Sections, key: string): Record<string, string> => (Object.hasOwn(layer, key) ? layer[key] : {});

/** F1, F2 (spec 10 §6.3): what no value can explain — metadata, the file set, a file compared as bytes. */
function shapeDiffers(base: ImportBase, meta: Ingredient, files: Record<string, string | Buffer>): string | null {
  const metaOnly = stripForgeOnlyKeys({ ...base.meta });
  if (fingerprintOf(metaOnly as Ingredient, {}) !== fingerprintOf(meta, {})) return "metadata differs";
  const baseFiles = [...base.texts.keys(), ...base.bytes.keys()].sort();
  const srcFiles = Object.keys(files).sort();
  const missing = baseFiles.find((f) => !srcFiles.includes(f)) ?? srcFiles.find((f) => !baseFiles.includes(f));
  if (missing) return `${missing} differs`;
  for (const [rel, b] of base.bytes) if (hashNormalized(b) !== hashNormalized(files[rel])) return `${rel} differs`;
  return null;
}

/** Spec 10 §6.3–§6.5, over the template expanded with `S` (spec 11 §6.7). */
async function inferParams(
  ctx: RunContext,
  base: ImportBase,
  S: Record<string, string>,
  map: Record<string, unknown>,
  cited: Set<string>,
  ref: string,
  meta: Ingredient,
  files: Record<string, string | Buffer>,
  fingerprint: string,
  others: Array<{ ref: string; meta: Ingredient; files: Record<string, string | Buffer> }>,
  runBases: Set<string>,
): Promise<Decision> {
  // Holes (§3): declared, not reserved, not set by the workspace layer, and not pinned — a key this run already relied
  // on renders at its current value, like any fixed key (§6.5, §14 Q13).
  const inferable = [...cited].filter((k) => base.meta.params?.[k] !== undefined && !reservedKey(k) && !Object.hasOwn(ctx.W, k));
  const holes = new Set(inferable.filter((k) => !ctx.pinned.has(k)));
  const pinnedHoles = inferable.filter((k) => ctx.pinned.has(k));
  if (!holes.size && !pinnedHoles.length) return { kind: "variant" };

  const shape = shapeDiffers(base, meta, files);
  if (shape) return { kind: "variant", why: shape };

  const fixed: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(map)) if (!holes.has(k)) fixed[k] = v;
  const templates = expandedTexts(base, S);
  const sources = new Map([...base.texts.keys()].map((rel) => [rel, textOf(files[rel])]));
  const r = infer(templates, sources, holes, fixed);
  if ("fallback" in r) {
    // F8 (Ruling 5): when the source matches only with another value for a pinned key, name that key rather than the
    // line. The value it keeps is the one this base renders — P's or W's, which the run relied on, or, when neither
    // sets the key, this base's own default: an inference may not set it, or an earlier reuse at its default would move.
    if (pinnedHoles.length) {
      const open = new Set([...holes, ...pinnedHoles]);
      const wide = infer(templates, sources, open, Object.fromEntries(Object.entries(fixed).filter(([k]) => !open.has(k))));
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

  // F10: the proof, through the same expansion and substitution ctx.text uses.
  if (renderedFingerprint(base, { ...map, ...sigma }, S) !== fingerprint) return { kind: "variant", why: `inference not proved for ${ref}` };

  // F9: a profile change must not move anything else the profile renders — its files, or a section value
  // that applies to it under this profile or workspace (spec 11 §6.11).
  const values = deepMerge(ctx.PS, ctx.WS) as Sections;
  for (const { key } of delta) {
    if (ctx.forge) {
      for (const ing of ctx.forge.ingredients.values()) {
        if (ing.ref === ref || runBases.has(ing.ref)) continue;
        for (const rel of await listAdmitted(ing)) {
          if (placeholders(norm(await readIngredientText(ing, rel))).includes(key)) return { kind: "variant", why: `setting ${key} would change ${ing.ref}` };
        }
        for (const v of Object.values(valuesAt(values, sectionKey(ing.meta)))) {
          if (placeholders(v).includes(key)) return { kind: "variant", why: `setting ${key} would change ${ing.ref}` };
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

/**
 * Section inference (spec 11 §6.8, §6.9): the unique assignment of the base's open sections that
 * spells the source, proved by rendering the base with it. `Δs` holds each value that differs from
 * what the profile, or the default, gave; it goes into `PS` for the rest of the run.
 */
function inferSectionValues(
  ctx: RunContext,
  base: ImportBase,
  key: string,
  PSk: Record<string, string>,
  WSk: Record<string, string>,
  map: Record<string, unknown>,
  ref: string,
  meta: Ingredient,
  files: Record<string, string | Buffer>,
  fingerprint: string,
): Decision {
  const shape = shapeDiffers(base, meta, files);
  if (shape) return { kind: "variant", why: shape };
  const sigma: Record<string, string> = {};
  const defaults = new Map<string, string>();
  for (const [rel, parsed] of base.parsed) {
    const r = inferSections(parsed, textOf(files[rel]), WSk, map);
    if ("fallback" in r) return { kind: "variant", why: r.reason };
    Object.assign(sigma, r.values);
    for (const s of parsed.sections) defaults.set(s.name, s.default);
  }
  const S = { ...PSk, ...WSk, ...sigma };
  // F14: the proof, through the same expansion and substitution ctx.text uses.
  if (renderedFingerprint(base, map, S) !== fingerprint) return { kind: "variant", why: `section inference not proved for ${ref}` };

  const assigned = sectionNames(base).filter((n) => Object.hasOwn(sigma, n));
  const sectionDelta: SectionChange[] = [];
  for (const name of assigned) {
    const given = Object.hasOwn(PSk, name) ? canonicalValue(PSk[name]) : defaults.get(name);
    if (sigma[name] !== given) sectionDelta.push({ key, name, old: Object.hasOwn(PSk, name) ? PSk[name] : null, value: sigma[name] });
  }
  if (sectionDelta.length) {
    const next = { ...valuesAt(ctx.PS, key) };
    for (const d of sectionDelta) next[d.name] = d.value;
    ctx.PS[key] = next;
  }
  pin(ctx, citedKeys(expandedTexts(base, S)), map);
  return { kind: "reuse", sectioned: assigned, sectionDelta };
}

async function listAdmitted(ing: { dir: string; meta: Ingredient }): Promise<string[]> {
  return (await listFiles(ing.dir)).filter((rel) => rel !== "ingredient.yaml" && bodyFile(ing.meta, rel, ing.dir));
}

/** `W`: overrides.params of craftar.yaml and craftar.local.yaml, merged as loadWorkspace merges them (I6). */
export async function workspaceParams(ws: string, read: (abs: string) => Promise<string>, command = "import"): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = {};
  for (const f of ["craftar.yaml", "craftar.local.yaml"]) {
    const abs = path.join(ws, f);
    if (!(await exists(abs))) continue;
    try {
      const doc = (parseWorkspaceYaml(f, await read(abs)) ?? {}) as { overrides?: { params?: unknown; sections?: unknown } };
      const params = OverridesParamsSchema.parse(doc?.overrides?.params ?? {});
      out = deepMerge(out, params);
    } catch (e) {
      throw new Error(`${command}: ${f} does not load (${errorText(e)})`);
    }
  }
  return out;
}

/** `WS`: overrides.sections of craftar.yaml and craftar.local.yaml, merged as loadWorkspace merges them (I6, spec 11 §6.7). */
export async function workspaceSections(ws: string, read: (abs: string) => Promise<string>, command = "import"): Promise<Sections> {
  let out: Sections = {};
  for (const f of ["craftar.yaml", "craftar.local.yaml"]) {
    const abs = path.join(ws, f);
    if (!(await exists(abs))) continue;
    try {
      const doc = (parseWorkspaceYaml(f, await read(abs)) ?? {}) as { overrides?: { params?: unknown; sections?: unknown } };
      out = deepMerge(out, SectionsSchema.parse(doc?.overrides?.sections ?? {}));
    } catch (e) {
      throw new Error(`${command}: ${f} does not load (${errorText(e)})`);
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
