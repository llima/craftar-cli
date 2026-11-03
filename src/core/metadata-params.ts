/**
 * Params in an ingredient's metadata (spec 50 Part B): the one place a metadata field is rendered, scanned for
 * placeholders or tested for a value that would break the file it lands in.
 */

import type { Ingredient } from "../schema/index.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../schema/index.js";
import { PLACEHOLDER_RE, listsOf, paramsFor, substitute, type Resolution, type ResolvedIngredient } from "./resolve.js";
import { FILTER_OPEN_RE, FILTERED_RE, NO_LISTS, YAML_ITEMS_ELEMENT, YAML_ITEMS_LINE, filteredCitations, formatList, parseFilter, type ListContext } from "./list-params.js";
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

/** The keys this ingredient's metadata fields cite, in order of first appearance (spec 50 §5.3); a filtered citation of a list key too (spec 55 §4.3). */
export function metadataCitations(meta: Ingredient, lists: ListContext = NO_LISTS): string[] {
  const out = new Set<string>();
  for (const field of metadataFields(meta)) {
    for (const text of texts(meta, field)) {
      for (const m of text.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
      for (const k of filteredCitations(text, lists)) out.add(k);
    }
  }
  return [...out];
}

/**
 * Spec 55 §4.6: a list key in a metadata field, before spec 50's tests. Only two forms are accepted — `yaml-items`, alone after
 * `- ` on a line of a raw block (never under `tools`, `allowed-tools` or `model`; not empty under `paths:`) or as a whole
 * element of a list `fileMatchPattern`, which splices one element per item; and `join`, anywhere a scalar may stand, turned
 * into a key of its own so `metadataFault` tests the joined text as one value. Any other filter, a list key with no filter,
 * or a malformed one, fails, naming the ingredient, the field and the key. Returns the metadata and the map spec 50 renders.
 */
export function listMetadata<M extends Ingredient>(
  meta: M,
  params: Record<string, unknown>,
  lists: ListContext,
  ref: string,
  missing?: Set<string>,
): { meta: M; params: Record<string, unknown> } {
  if (!lists.keys.size) return { meta, params };
  const out: Record<string, unknown> = { ...meta };
  const map: Record<string, unknown> = Object.assign(Object.create(null), params);
  let n = 0;
  const refuse = (field: string, key: string, why: string): never => {
    throw new Error(`${ref}: list param ${key} in ${field} ${why}`);
  };
  /** `{{k | join: "s"}}` → `{{k.__join<n>}}`, valued with the joined items; every other list form refused. */
  const joins = (field: string, text: string): string => {
    for (const m of text.matchAll(FILTER_OPEN_RE)) {
      if (!lists.keys.has(m[1])) continue;
      const whole = [...text.matchAll(FILTERED_RE)].find((w) => w.index === m.index);
      if (!whole) refuse(field, m[1], "has a malformed filter");
    }
    for (const m of text.matchAll(PLACEHOLDER_RE)) if (lists.keys.has(m[1])) refuse(field, m[1], "is cited with no filter — in metadata write join: \"<sep>\" or yaml-items");
    return text.replace(FILTERED_RE, (all, key: string, filterText: string) => {
      if (!lists.keys.has(key)) return all;
      const f = parseFilter(filterText);
      if (f === null || f.kind !== "join") refuse(field, key, `takes ${f === null ? "an unknown filter" : f.kind}, which a metadata field cannot hold — use join: "<sep>" or yaml-items`);
      if (!Object.hasOwn(params, key)) {
        missing?.add(key);
        return all;
      }
      const synthetic = `${key}.__join${n++}`;
      map[synthetic] = formatList(params[key] as string[], f!, (why) => refuse(field, key, why));
      return `{{${synthetic}}}`;
    });
  };
  for (const field of metadataFields(meta)) {
    const v = out[field];
    if (field === "frontmatterRaw" && typeof v === "string") {
      const lines = v.split("\n");
      let under: string | null = null;
      const kept: string[] = [];
      for (const line of lines) {
        const top = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
        if (top) under = top[1];
        const y = YAML_ITEMS_LINE.exec(line);
        if (y && lists.keys.has(y[2])) {
          if (under !== null && GUARDED_KEYS.has(under)) refuse(field, y[2], `stands under ${under}, which a parameter may not change`);
          if (!Object.hasOwn(params, y[2])) {
            missing?.add(y[2]);
            kept.push(line);
            continue;
          }
          const items = params[y[2]] as string[];
          if (items.length === 0 && under === "paths") refuse(field, y[2], "is empty under paths:, which may make a scoped rule load always — give it an item or drop the citation");
          items.forEach((item, i) => {
            if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(item)) refuse(field, y[2], `item ${i} holds a line break or a control character`);
          });
          for (const item of items) kept.push(`${y[1]}- ${JSON.stringify(item)}`);
          continue;
        }
        kept.push(joins(field, line));
      }
      out[field] = kept.join("\n");
    } else if (field === "fileMatchPattern" && Array.isArray(v)) {
      const spliced: unknown[] = [];
      for (const x of v) {
        const y = typeof x === "string" ? YAML_ITEMS_ELEMENT.exec(x) : null;
        if (y && lists.keys.has(y[1])) {
          if (!Object.hasOwn(params, y[1])) {
            missing?.add(y[1]);
            spliced.push(x);
          } else spliced.push(...(params[y[1]] as string[]));
        } else spliced.push(typeof x === "string" ? joins(field, x) : x);
      }
      out[field] = spliced;
    } else if (typeof v === "string") out[field] = joins(field, v);
    else if (Array.isArray(v)) out[field] = v.map((x) => (typeof x === "string" ? joins(field, x) : x));
  }
  return { meta: out as M, params: map };
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
 * The quoting state at the end of `prefix`, in one left-to-right scan. A quote or a `[`/`{` opens something only where a
 * value starts — at the line's start, or after `: `, `- `, `[`, `{` or `,` inside a flow collection — as YAML reads it; in
 * the middle of plain text it is a character. Inside double quotes a `'` means nothing and `\"` does not close; inside
 * single quotes a `"` means nothing. `depth` counts the flow collections open.
 */
function quoteState(prefix: string): { inDouble: boolean; inSingle: boolean; depth: number; start: boolean } {
  let inDouble = false;
  let inSingle = false;
  let depth = 0;
  let start = true;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === " " || c === "\t") continue;
    const next = prefix[i + 1] ?? "";
    if (start && c === '"') inDouble = true;
    else if (start && c === "'") inSingle = true;
    else if (start && (c === "[" || c === "{")) {
      depth++;
      continue;
    } else if ((c === "]" || c === "}") && depth > 0) depth--;
    else if (c === "," && depth > 0) {
      start = true;
      continue;
    } else if (c === ":" && (next === " " || next === "\t" || next === "")) {
      start = true;
      continue;
    } else if (start && c === "-" && (next === " " || next === "\t")) continue;
    start = false;
  }
  return { inDouble, inSingle, depth, start: start && !inDouble && !inSingle };
}

/**
 * A `#` or `: ` the value forms with the text beside it (spec 50 §5.4): a comment opened by a value starting with `#`
 * after a space, or by a value ending in a space before `#`; a key separator made by a value starting with a space or a
 * tab after `:`. Null when none.
 */
function boundaryBreak(before: string, value: string, after: string): string | null {
  if (value.startsWith("#") && /[ \t]$/.test(before)) return "' #'";
  if (/[ \t]$/.test(value) && after.startsWith("#")) return "' #'";
  if (/^[ \t]/.test(value) && before.endsWith(":")) return "': '";
  return null;
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
 * The line checks of spec 50 §5.4 for one valued citation at `index` (of `length`) in `line`, or null: a value that
 * breaks a one-line scalar, a backslash inside double quotes, a `#` or `: ` formed with the text beside it, and an opener
 * where a value starts. Where a value starts, and the quoting around it, are read from the line rendered up to the
 * citation, so an empty or whitespace neighbour hides nothing. `quotes`: a quote in the value breaks it (a raw block).
 * `under`: the top-level key the line sits under, for the `paths:` glob exemption.
 */
function valueFault(line: string, index: number, length: number, value: string, params: Record<string, unknown>, quotes: boolean, under: string | null): string | null {
  const broken = scalarBreak(value, quotes);
  if (broken) return `its value holds ${broken}`;
  const before = substitute(line.slice(0, index), params, NO_LISTS);
  const after = substitute(line.slice(index + length), params, NO_LISTS);
  const q = quoteState(before);
  // Inside a double-quoted scalar a backslash starts an escape YAML may refuse.
  if (q.inDouble && value.includes("\\")) return "its value holds a backslash inside double quotes";
  // A quote that matches the one the text opened closes it, whether the quotes are the Forge's or the value's.
  if ((q.inDouble && value.includes('"')) || (q.inSingle && value.includes("'"))) return "its value holds a quote";
  if (q.inDouble || q.inSingle) return null;
  const across = boundaryBreak(before, value, after);
  if (across) return `its value forms ${across} with the text beside it`;
  // A flow element: after `[` or `,` with a `[` or `{` open. `*` is let through for a paths: block value or item only.
  const flow = q.depth > 0 && /[[,]\s*$/.test(before);
  // Inside a flow collection a flow indicator in the value ends or splits the element.
  if (q.depth > 0 && /[,[\]{}]/.test(value)) return "its value holds a flow indicator inside a flow collection";
  const lead = value.replace(/^[ \t]+/, "");
  if (q.start && opensOther(lead) && !(lead[0] === "*" && under === "paths" && !flow)) {
    return "its value starts with a character that opens something other than plain text";
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
            const why = valueFault(line, m.index, m[0].length, value, params, true, under);
            if (why) return { field, key, why };
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
        if (cited.length > 0 && substitute(text, params, NO_LISTS).trim() === "") return { field, key: cited[0][1], why: "the pattern renders empty" };
      } else if (meta.type === "agent" || meta.type === "command") {
        // An agent's or a command's description and argumentHint are written unquoted into a frontmatter: checked as the
        // one line the emitter writes, with the raw block's line checks.
        const line = `${field === "argumentHint" ? "argument-hint" : "description"}: ${text}`;
        for (const m of line.matchAll(PLACEHOLDER_RE)) {
          const value = valueOf(m[1]);
          if (value === null) continue;
          const why = valueFault(line, m.index, m[0].length, value, params, false, null);
          if (why) return { field, key: m[1], why };
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
export function renderedMeta<M extends Ingredient>(meta: M, params: Record<string, unknown>, ref: string, lists: ListContext, missing?: Set<string>): M {
  const l = listMetadata(meta, params, lists, ref, missing);
  const fault = metadataFault(l.meta, l.params);
  // A joined list is tested under a key of its own; the refusal names the list key (spec 55 §4.6).
  if (fault) throw new Error(metadataFaultMessage(ref, { ...fault, key: fault.key.replace(/\.__join\d+$/, "") }));
  return substituteMetadata(l.meta, l.params, missing);
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
    // List forms were rendered by `listMetadata` first; what is left is scalars.
    if (typeof v === "string") out[field] = substitute(v, params, NO_LISTS, missing);
    else if (Array.isArray(v)) out[field] = v.map((x) => (typeof x === "string" ? substitute(x, params, NO_LISTS, missing) : x));
  }
  return out as M;
}

/** `renderedMeta` for a reader with a resolution and no plan context (the rules index's builder): as written below the gate. */
export function metaFor<I extends ResolvedIngredient>(ing: I, resolution: Resolution): I["meta"] {
  return resolution.metadataParams ? renderedMeta(ing.meta, paramsFor(ing, resolution), ing.ref, listsOf(resolution)) : ing.meta;
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
