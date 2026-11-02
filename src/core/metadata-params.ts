/**
 * Params in an ingredient's metadata (spec 50 Part B): the one place a metadata field is rendered, scanned for
 * placeholders or tested for a value that would break the file it lands in.
 */

import type { Ingredient } from "../schema/index.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../schema/index.js";
import { PLACEHOLDER_RE, paramsFor, substitute, type Resolution, type ResolvedIngredient } from "./resolve.js";

/** Whether this Forge's metadata fields are rendered (spec 50 §5.1: the schema after profile-local, or above). */
export function rendersMetadata(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_METADATA_PARAMS;
}

/** The fields rendered per type (spec 50 §5.2). A skill's and a steering's `description` reach no file. */
export const METADATA_FIELDS = {
  rule: ["frontmatterRaw", "fileMatchPattern", "description"],
  agent: ["frontmatterRaw", "description"],
  command: ["frontmatterRaw", "description", "argumentHint"],
} as const;

export type MetadataField = "frontmatterRaw" | "fileMatchPattern" | "description" | "argumentHint";

/** The fields of §5.2 this ingredient's type has (none for any other type). */
export function metadataFields(meta: Ingredient): readonly MetadataField[] {
  return meta.type === "rule" || meta.type === "agent" || meta.type === "command" ? METADATA_FIELDS[meta.type] : [];
}

/** The texts of one field: a list `fileMatchPattern` is one text per element. */
function texts(meta: Ingredient, field: MetadataField): string[] {
  const v = (meta as Record<string, unknown>)[field];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** The keys this ingredient's metadata fields cite, in order of first appearance (spec 50 §5.3). */
export function metadataCitations(meta: Ingredient): string[] {
  const out = new Set<string>();
  for (const field of metadataFields(meta)) {
    for (const text of texts(meta, field)) for (const m of text.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  }
  return [...out];
}

/** A value that would break the file its field lands in (spec 50 §5.4). Never carries the value. */
export interface MetadataFault {
  field: MetadataField;
  key: string;
  /** Fixed words naming what the value holds, or where the citation stands. */
  why: string;
}

/** The three top-level keys of a raw block a parameter may not change (spec 50 §8). */
const GUARDED_KEYS = new Set(["tools", "allowed-tools", "model"]);
/** Characters that open something other than a plain scalar when they start one (spec 50 §5.4). */
const OPENERS = new Set(['"', "'", "[", "{", "*", "&", "!", "|", ">", "%", "@", "#"]);

/** What in a value breaks a one-line YAML scalar, in the order a message names it; null when nothing does. */
function scalarBreak(value: string, quotes: boolean): string | null {
  if (/[\r\n]/.test(value)) return "a line break";
  if (value.includes(": ")) return "': '";
  if (value.includes(" #")) return "' #'";
  if (value.endsWith(":")) return "a final ':'";
  if (quotes && (value.includes('"') || value.includes("'"))) return "a quote";
  return null;
}

/** The top-level key of a raw block that a given line sits under, or null (a line before any key). */
function topKeyAt(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const m = /^([^\s#'"\-][^:]*?):(?:\s|$)/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * The first value of this ingredient's metadata that would break its file, at the gate, or null. A citation that has
 * no value is not tested: it is left as written and joins `missingParams`. A literal in the Forge is never tested.
 */
export function metadataFault(meta: Ingredient, params: Record<string, unknown>): MetadataFault | null {
  const valueOf = (key: string): string | null => (Object.hasOwn(params, key) ? String(params[key]) : null);
  for (const field of metadataFields(meta)) {
    for (const text of texts(meta, field)) {
      if (field === "frontmatterRaw") {
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const m of line.matchAll(PLACEHOLDER_RE)) {
            const key = m[1];
            const under = topKeyAt(lines, i);
            if (under !== null && GUARDED_KEYS.has(under)) return { field, key, why: `it stands under ${under}, which a parameter may not change` };
            const value = valueOf(key);
            if (value === null) continue;
            const broken = scalarBreak(value, true);
            if (broken) return { field, key, why: `its value holds ${broken}` };
            const prefix = line.slice(0, m.index);
            const opens = /^\s*(?:-\s+)?(?:[^\s"'#\-][^"']*?:\s+)?(?:-\s+)?$/.test(prefix);
            if (opens && value.length > 0 && OPENERS.has(value[0]) && !(value[0] === "*" && under === "paths")) {
              return { field, key, why: "its value starts with a character that opens something other than plain text" };
            }
          }
        }
      } else if (field === "fileMatchPattern") {
        for (const m of text.matchAll(PLACEHOLDER_RE)) {
          const value = valueOf(m[1]);
          if (value !== null && /[\r\n]/.test(value)) return { field, key: m[1], why: "its value holds a line break" };
        }
        const cited = [...text.matchAll(PLACEHOLDER_RE)];
        if (cited.length > 0 && substitute(text, params).trim() === "") return { field, key: cited[0][1], why: "the pattern renders empty" };
      } else if (meta.type === "agent" || meta.type === "command") {
        // An agent's or a command's description and argumentHint are written unquoted into a frontmatter.
        for (const m of text.matchAll(PLACEHOLDER_RE)) {
          const value = valueOf(m[1]);
          if (value === null) continue;
          const broken = scalarBreak(value, false);
          if (broken) return { field, key: m[1], why: `its value holds ${broken}` };
          if (m.index === 0 && value.length > 0 && OPENERS.has(value[0])) {
            return { field, key: m[1], why: "its value starts with a character that opens something other than plain text" };
          }
        }
      }
    }
  }
  return null;
}

/** The plan's refusal for a fault: the ingredient, the field and the key, never the value (spec 50 §5.4). */
export function metadataFaultMessage(ref: string, f: MetadataFault): string {
  return `${ref}: {{${f.key}}} in ${f.field} would break the file it is written to — ${f.why}; set another value or move the citation into the body`;
}

/**
 * The metadata as written below the gate; at the gate a copy with each field of §5.2 through `substitute` with the map a
 * body gets (spec 50 §5.3), after `metadataFault` has passed. `missing` collects the cited keys that have no value.
 * `craftar.rules.index` is never a parameter: `paramsFor` leaves it out, so it stays as written.
 */
export function renderedMeta<M extends Ingredient>(meta: M, params: Record<string, unknown>, ref: string, missing?: Set<string>): M {
  const fault = metadataFault(meta, params);
  if (fault) throw new Error(metadataFaultMessage(ref, fault));
  const fields = metadataFields(meta);
  if (fields.length === 0) return meta;
  const out: Record<string, unknown> = { ...meta };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === "string") out[field] = substitute(v, params, missing);
    else if (Array.isArray(v)) out[field] = v.map((x) => (typeof x === "string" ? substitute(x, params, missing) : x));
  }
  return out as M;
}

/** `renderedMeta` for a reader with a resolution and no plan context (the rules index's builder): as written below the gate. */
export function metaFor<I extends ResolvedIngredient>(ing: I, resolution: Resolution): I["meta"] {
  return resolution.metadataParams ? renderedMeta(ing.meta, paramsFor(ing, resolution), ing.ref) : ing.meta;
}
