/**
 * Params in an ingredient's metadata (spec 50 Part B): the one place a metadata field is rendered, scanned for
 * placeholders or tested for a value that would break the file it lands in.
 */

import type { Ingredient } from "../schema/index.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../schema/index.js";
import { PLACEHOLDER_RE, paramsFor, substitute, type Resolution, type ResolvedIngredient } from "./resolve.js";
import { looseParse, parseFrontmatter } from "./frontmatter.js";
import { parseYamlText } from "./yaml-read.js";
import { RULES_INDEX_KEY } from "./rules-index.js";

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
const OPENERS = new Set(['"', "'", "[", "{", "*", "&", "!", "|", ">", "%", "@", "#", ",", "]", "}"]);

/**
 * Spec 50 §8, by structure rather than by spelling: the raw block with every valued placeholder replaced by a neutral
 * token, against the block with one key rendered at a time (the others neutral). A different set of top-level keys, or a
 * different `tools`, `allowed-tools` or `model`, means that key reaches what a parameter may not change — whatever
 * spelling (a tab, an alias, a merge key, an explicit or a flow key) carried it there. The block is read as strict YAML
 * with merge keys; only when the neutral block itself is not strict YAML (an unquoted `**` the Forge wrote under
 * `paths:`) are both sides read by lines. When the neutral block reads and a render does not, the value is refused: a
 * reader craftar does not control would decide what it means. A citation that is a whole `paths:` value or item and
 * whose value starts with `*` stays neutral, as §5.4 lets it through.
 */
export function guardedKeyMoved(text: string, params: Record<string, unknown>): { key: string; why: string } | null {
  const lf = text.replace(/\r\n?/g, "\n");
  const valued: string[] = [];
  for (const m of lf.matchAll(PLACEHOLDER_RE)) if (Object.hasOwn(params, m[1]) && !valued.includes(m[1])) valued.push(m[1]);
  if (valued.length === 0) return null;
  const lines = lf.split("\n");
  // Whether one citation, at `offset` in the block, is a whole `paths:` value or item whose value starts with `*`.
  const pathsGlob = (key: string, offset: number): boolean => {
    if (!String(params[key]).startsWith("*")) return false;
    const i = lf.slice(0, offset).split("\n").length - 1;
    const re = new RegExp(`^\\s*(?:paths:\\s+|-\\s+)(["']?)\\{\\{\\s*${key.replace(/\./g, "\\.")}\\s*\\}\\}\\1\\s*$`);
    return re.test(lines[i]) && (/^\s*paths:/.test(lines[i]) || topKeyAt(lines, i) === "paths");
  };
  const tokens = new Map(valued.map((k, i) => [k, `craftarparam${i}x`]));
  const render = (only: string | null) =>
    lf.replace(PLACEHOLDER_RE, (all: string, key: string, offset: number) => {
      if (!tokens.has(key)) return all;
      return key === only && !pathsGlob(key, offset) ? String(params[key]) : tokens.get(key)!;
    });
  const strict = (t: string): Record<string, unknown> | null => {
    try {
      const v = parseYamlText("frontmatterRaw", t, { merge: true });
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return null;
    }
  };
  const neutral = render(null);
  const strictNeutral = strict(neutral);
  const read = strictNeutral === null ? (t: string) => looseParse(t) as Record<string, unknown> : strict;
  const a = strictNeutral ?? looseParse(neutral);
  const moved = (b: Record<string, unknown>): string | null => {
    if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) return "it changes which keys the block holds, which a parameter may not do";
    for (const g of GUARDED_KEYS) if (JSON.stringify(a[g]) !== JSON.stringify(b[g])) return `it reaches ${g}, which a parameter may not change`;
    return null;
  };
  for (const key of valued) {
    const b = read(render(key));
    if (b === null) return { key, why: "its value makes the block unreadable as YAML" };
    const why = moved(b);
    if (why) return { key, why };
  }
  return null;
}

/**
 * Whether the end of `prefix` sits inside a double-quoted scalar: one left-to-right scan, where a `'` means nothing
 * inside double quotes, a `"` means nothing inside single quotes, and `\"` does not close a double-quoted value.
 */
function insideDoubleQuotes(prefix: string): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
    } else if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (c === '"') inDouble = true;
    else if (c === "'") inSingle = true;
  }
  return inDouble;
}

/** What in a value breaks a one-line YAML scalar, in the order a message names it; null when nothing does. */
function scalarBreak(value: string, quotes: boolean): string | null {
  if (/[\r\n]/.test(value)) return "a line break";
  if (/:[ \t]/.test(value)) return "': '";
  if (/[ \t]#/.test(value)) return "' #'";
  if (value.endsWith(":")) return "a final ':'";
  if (quotes && (value.includes('"') || value.includes("'"))) return "a quote";
  return null;
}

/** The top-level key of a raw block that a given line sits under, or null (a line before any key). */
function topKeyAt(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    // A key may be quoted (`"model": x` reads as `model`).
    const m = /^(?:"([^"]*)"|'([^']*)'|([^\s#'"\-][^:]*?)):(?:\s|$)/.exec(lines[i]);
    if (m) return (m[1] ?? m[2] ?? m[3]).trim();
  }
  return null;
}

/** A value that opens something other than plain text when it starts a scalar (spec 50 §5.4, and `- `, `? `, a backtick). */
function opensOther(value: string): boolean {
  return value.length > 0 && (OPENERS.has(value[0]) || value.startsWith("- ") || value === "-" || value.startsWith("? ") || value === "?" || value[0] === "`");
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
          // A comment line can break nothing.
          if (/^\s*#/.test(line)) continue;
          for (const m of line.matchAll(PLACEHOLDER_RE)) {
            const key = m[1];
            const under = topKeyAt(lines, i);
            if (under !== null && GUARDED_KEYS.has(under)) return { field, key, why: `it stands under ${under}, which a parameter may not change` };
            // A citation that could name a key, or that sits in a flow mapping, could reach tools, allowed-tools or model (§8).
            const colon = line.search(/:[ \t]/);
            if (colon === -1 ? /:\s*$/.test(line.slice(m.index)) : m.index < colon) return { field, key, why: "it stands where a key is written, which a parameter may not set" };
            if (/^\s*(?:-\s+)?\{(?!\{)/.test(line)) return { field, key, why: "it stands in a flow mapping, which a parameter may not change" };
            const value = valueOf(key);
            if (value === null) continue;
            const broken = scalarBreak(value, true);
            if (broken) return { field, key, why: `its value holds ${broken}` };
            // Inside a double-quoted scalar a backslash starts an escape YAML may refuse.
            // Quotes inside a single-quoted span do not open a double-quoted one.
            if (insideDoubleQuotes(line.slice(0, m.index)) && value.includes("\\")) return { field, key, why: "its value holds a backslash inside double quotes" };
            const prefix = line.slice(0, m.index);
            // At the start of a value or an item — or of a flow element, after `[` or `,`.
            const flow = /[[,]\s*$/.test(prefix) && !insideDoubleQuotes(prefix);
            const opens = /^\s*(?:-\s+)?(?:[^\s"'#\-][^"']*?:\s+)?(?:-\s+)?$/.test(prefix) || flow;
            // `*` is let through for a paths: block value or item, never a flow element.
            if (opens && opensOther(value) && !(value[0] === "*" && under === "paths" && !flow)) {
              return { field, key, why: "its value starts with a character that opens something other than plain text" };
            }
          }
        }
        // Whatever spelling the lines above do not catch (spec 50 §8).
        const moved = guardedKeyMoved(text, params);
        if (moved) return { field, key: moved.key, why: moved.why };
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
          if (m.index === 0 && opensOther(value)) {
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
  return substituteMetadata(meta, params, missing);
}

/**
 * The fields of §5.2 through `substitute`, with no fault test: what `renderedMeta` returns once the test passed, and
 * what import compares a base with (spec 50 §5.6), where a value that would break a file makes a variant, not a refusal.
 */
export function substituteMetadata<M extends Ingredient>(meta: M, params: Record<string, unknown>, missing?: Set<string>): M {
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

/** The spelling of a metadata field in `forge diff` and a unify plan (spec 50 §5.5, §15 item 11). */
export const METADATA_ENTRY_PREFIX = "ingredient.yaml#";

/** `ingredient.yaml#<field>`. */
export function metadataEntry(field: MetadataField): string {
  return `${METADATA_ENTRY_PREFIX}${field}`;
}

/** The field a plan entry names, or null when the entry is an ordinary file. */
export function metadataEntryField(file: string): MetadataField | null {
  if (!file.startsWith(METADATA_ENTRY_PREFIX)) return null;
  const field = file.slice(METADATA_ENTRY_PREFIX.length);
  return field === "frontmatterRaw" || field === "fileMatchPattern" || field === "description" || field === "argumentHint" ? field : null;
}

/**
 * The text `forge diff` compares for a field (spec 50 §5.5): `frontmatterRaw` with LF line endings, a list
 * `fileMatchPattern` one element per line, any other field as written; an absent field is "".
 */
export function metadataText(meta: Ingredient, field: MetadataField): string {
  const v = (meta as Record<string, unknown>)[field];
  if (typeof v === "string") return field === "frontmatterRaw" ? v.replace(/\r\n?/g, "\n") : v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join("\n");
  return "";
}

/**
 * Back from a merged text to the field's value: "" is no field; a `fileMatchPattern` is a list when it holds more
 * than one line or the base held a list, a string otherwise.
 */
export function metadataValue(text: string, field: MetadataField, base: Ingredient): string | string[] | undefined {
  if (text === "") return undefined;
  if (field !== "fileMatchPattern") return text;
  const lines = text.split("\n");
  return lines.length > 1 || Array.isArray((base as Record<string, unknown>).fileMatchPattern) ? lines : text;
}

/**
 * The refusal for a real file of an ingredient spelled as a metadata entry, at the gate (spec 50 §15 item 11), or
 * null. Names the ingredient and the file, which the Forge's author chose.
 */
export function metadataFileClash(ref: string, files: Iterable<string>): string | null {
  for (const rel of files) {
    if (rel.startsWith(METADATA_ENTRY_PREFIX)) {
      return `${ref}: ${rel} is a file named as forge diff names a metadata field at Forge schema ${FORGE_SCHEMA_METADATA_PARAMS} — rename it`;
    }
  }
  return null;
}

/** Whether a field's text cites a key; the rules index's token is never a parameter. */
function citesIn(meta: Ingredient, field: MetadataField): boolean {
  return texts(meta, field).some((t) => [...t.matchAll(PLACEHOLDER_RE)].some((m) => m[1] !== RULES_INDEX_KEY));
}

/**
 * Spec 50 §5.6: the first field of §5.2 that the resolved ingredient's metadata cites a key in and that a hand edit of
 * its `claude-code` file changed, or null. Compares only what that file carries: a raw block whole (it replaces the
 * typed fields, §15 item 6), else an agent's or a command's `description` and `argument-hint`; a rule's `description`
 * and a `fileMatchPattern` with no raw block reach no `.claude/` file. Pure; never returns a value.
 */
export function templatedMetadataEdit(meta: Ingredient, planned: string, disk: string): MetadataField | null {
  const a = parseFrontmatter(planned, { loose: true });
  const b = parseFrontmatter(disk, { loose: true });
  for (const field of metadataFields(meta)) {
    if (!citesIn(meta, field)) continue;
    const raw = (meta as { frontmatterRaw?: string }).frontmatterRaw;
    if (field === "frontmatterRaw") {
      if (a.raw !== b.raw) return field;
      continue;
    }
    if (meta.type === "rule" || raw !== undefined) continue;
    const key = field === "argumentHint" ? "argument-hint" : "description";
    if ((a.data as Record<string, string>)[key] !== (b.data as Record<string, string>)[key]) return field;
  }
  return null;
}

/**
 * Spec 50 §5.6, for `drift promote`: the source's fields of §5.2 that read exactly as the base renders them (`rendered`)
 * take the base's own text back, so an outcome built from a body edit keeps the Forge's `{{key}}` in its metadata.
 */
export function withTemplatedFields<M extends Ingredient>(source: M, base: Ingredient, rendered: Ingredient): M {
  const out: Record<string, unknown> = { ...source };
  for (const field of metadataFields(base)) {
    if (metadataText(source, field) !== metadataText(rendered, field)) continue;
    const v = (base as Record<string, unknown>)[field];
    if (v === undefined) delete out[field];
    else out[field] = v;
  }
  return out as M;
}
