import { FORGE_SCHEMA_LIST_PARAMS, type ForgeManifest, type Ingredient, type Recipe } from "../schema/index.js";

/**
 * Spec 55 Part A: a param declared `type: list` and its filtered placeholder, `{{ key | py }}`. The one module that spells the
 * filter grammar: the existing citation patterns (`PLACEHOLDER_RE`, `extract.ts`, `template-import.ts`) do not change, so an
 * Angular `{{ value | date: 'short' }}` is never a citation. Every reader of a citation reaches the filtered form through here,
 * and only for the keys of `ListKeys`.
 */

/** The one comparison with `FORGE_SCHEMA_LIST_PARAMS` (spec 55 §4.1). */
export function rendersListParams(manifest: Pick<ForgeManifest, "schema">): boolean {
  return manifest.schema >= FORGE_SCHEMA_LIST_PARAMS;
}

/** The keys a resolution declares `type: list`, and where a refusal says the text came from. */
export interface ListContext {
  keys: ReadonlySet<string>;
  /** `<ref> <file>` (or `<ref> <field>`), prefixed to a refusal; absent where nothing renders a list key. */
  where?: string;
}

/** No list key: what every reader passes below the gate, and where no resolution is at hand. */
export const NO_LISTS: ListContext = { keys: new Set<string>() };

/** The loose outer pattern: a key, a `|`, anything with no brace or line break up to `}}` (spec 55 §4.3). */
export const FILTERED_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\|([^{}\r\n]*)\}\}/g;
/** The opening alone: for a list key, one that does not start a `FILTERED_RE` match is a malformed filter. */
export const FILTER_OPEN_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\|/g;
/** `- {{ key | yaml-items }}` alone on a line of a raw block (spec 55 §4.5–§4.6): indent, key. */
export const YAML_ITEMS_LINE = /^([ \t]*)- \{\{\s*([A-Za-z0-9_.]+)\s*\|\s*yaml-items\s*\}\}[ \t]*$/;
/** A list `fileMatchPattern` element that is exactly `{{ key | yaml-items }}` (spec 55 §4.6): key. */
export const YAML_ITEMS_ELEMENT = /^\{\{\s*([A-Za-z0-9_.]+)\s*\|\s*yaml-items\s*\}\}$/;

/** The plain placeholder, as `PLACEHOLDER_RE` spells it, joined to the filtered form for the one pass. */
const BOTH_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}|\{\{\s*([A-Za-z0-9_.]+)\s*\|([^{}\r\n]*)\}\}/g;
const FORMAT_RE = /^\s*(py|ps|sh|json|yaml-items)\s*$/;
const JOIN_RE = /^\s*join\s*:\s*"((?:[^"\\{}\r\n]|\\["\\nt])*)"\s*$/;
const NAME_SHAPED = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export type ListFilter = { kind: "py" | "ps" | "sh" | "json" | "yaml-items" } | { kind: "join"; sep: string };

/** The filter a placeholder's text after `|` names, or `null` when it is not one craftar has. */
export function parseFilter(text: string): ListFilter | null {
  const f = FORMAT_RE.exec(text);
  if (f) return { kind: f[1] as "py" | "ps" | "sh" | "json" | "yaml-items" };
  const j = JOIN_RE.exec(text);
  if (j) return { kind: "join", sep: j[1].replace(/\\(["\\nt])/g, (_m, c: string) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\" })[c]!) };
  return null;
}

/** C0 but tab, DEL and C1 — a line break among them (spec 55 §4.4). */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** A refusal that names where, the key and the item's index — never an item (spec 55 §8). */
export class ListParamError extends Error {}

const shownFilter = (text: string) => {
  const t = text.trim();
  return NAME_SHAPED.test(t) ? `"${t}"` : "a filter not shaped like a name";
};

/** One list written in one format, a complete literal (spec 55 §4.4). `yaml-items` is a line's, never inline. */
export function formatList(items: readonly string[], filter: ListFilter, refuse: (msg: string) => never): string {
  if (filter.kind !== "json") {
    items.forEach((item, i) => {
      if (CONTROL.test(item)) refuse(`item ${i} holds a line break or a control character, which ${filter.kind} cannot write`);
    });
  }
  switch (filter.kind) {
    case "py":
      return `[${items.map((i) => `"${i.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
    case "ps":
      // PowerShell reads each of ' ‘ ’ ‚ ‛ as a single quote inside a single-quoted string: each is doubled.
      return `@(${items.map((i) => `'${i.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`).join(", ")})`;
    case "sh":
      return items.map((i) => `'${i.replace(/'/g, "'\\''")}'`).join(" ");
    case "json":
      return JSON.stringify(items);
    case "join":
      return items.join(filter.sep);
    case "yaml-items":
      return refuse("yaml-items stands alone after \"- \" on its own line");
  }
}

/** The line a character offset falls on, 1-based. */
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * `- {{ key | yaml-items }}` alone on its line (spec 55 §4.5): one line per item, `<indent>- "<item>"`, each keeping the line's
 * own ending; an empty list removes the line. Runs before the one pass, so its output holds no placeholder of ours.
 */
export function expandYamlItems(text: string, params: Record<string, unknown>, lists: ListContext, missing?: Set<string>): string {
  if (!lists.keys.size || !text.includes("yaml-items")) return text;
  return text.replace(/^([ \t]*)- \{\{\s*([A-Za-z0-9_.]+)\s*\|\s*yaml-items\s*\}\}[ \t]*(\r?\n|$)/gm, (all, indent: string, key: string, eol: string, offset: number) => {
    if (!lists.keys.has(key)) return all;
    if (!Object.hasOwn(params, key)) {
      missing?.add(key);
      return all;
    }
    const items = params[key] as string[];
    const refuse = (msg: string): never => {
      throw new ListParamError(`${lists.where ? `${lists.where}: ` : ""}line ${lineAt(text, offset)}: list param ${key}: ${msg}`);
    };
    items.forEach((item, i) => {
      if (CONTROL.test(item)) refuse(`item ${i} holds a line break or a control character, which yaml-items cannot write`);
    });
    return items.map((item) => `${indent}- ${JSON.stringify(item)}${eol || ""}`).join("");
  });
}

/**
 * The one pass (spec 55 §4.3, E2): the plain and the filtered forms replaced together, so substituted text — an item holding
 * `{{y}}` included — is never substituted again. A filtered form whose key is not a list key is left as written (Angular).
 * For a list key: no filter, an unknown filter, a malformed one, or `yaml-items` inline, fails, naming where, the line and the
 * key, never a value.
 */
export function renderFiltered(text: string, params: Record<string, unknown>, lists: ListContext, missing?: Set<string>): string {
  const refuseAt = (offset: number, key: string) => (msg: string): never => {
    throw new ListParamError(`${lists.where ? `${lists.where}: ` : ""}line ${lineAt(text, offset)}: list param ${key}: ${msg}`);
  };
  assertWellFormed(text, lists, refuseAt);
  return text.replace(BOTH_RE, (all, plain: string | undefined, key: string | undefined, filterText: string | undefined, offset: number) => {
    if (plain !== undefined) {
      if (lists.keys.has(plain)) refuseAt(offset, plain)("cited with no filter — write {{ " + plain + " | py }}, ps, sh, json, yaml-items or join: \"<sep>\"");
      if (Object.hasOwn(params, plain)) return String(params[plain]);
      missing?.add(plain);
      return all;
    }
    if (!lists.keys.has(key!)) return all;
    const filter = parseFilter(filterText!);
    if (filter === null) refuseAt(offset, key!)(`${shownFilter(filterText!)} is not a filter craftar has (py, ps, sh, json, yaml-items, join: "<sep>")`);
    if (!Object.hasOwn(params, key!)) {
      missing?.add(key!);
      return all;
    }
    return formatList(params[key!] as string[], filter!, refuseAt(offset, key!));
  });
}

/** A list key's opening that does not start a whole filtered placeholder fails: a brace or a line break inside the filter. */
function assertWellFormed(text: string, lists: ListContext, refuseAt: (offset: number, key: string) => (msg: string) => never): void {
  if (!lists.keys.size) return;
  const whole = new Set<number>();
  for (const m of text.matchAll(FILTERED_RE)) whole.add(m.index!);
  for (const m of text.matchAll(FILTER_OPEN_RE)) {
    if (lists.keys.has(m[1]) && !whole.has(m.index!)) refuseAt(m.index!, m[1])("its filter is malformed — a separator holds no brace and no line break");
  }
}

/** The keys of every filtered citation of a list key in `text`, in order (spec 55 §4.3): the scan the citation readers add. */
export function filteredCitations(text: string, lists: ListContext): string[] {
  if (!lists.keys.size) return [];
  return [...text.matchAll(FILTERED_RE)].map((m) => m[1]).filter((k) => lists.keys.has(k));
}

/** The keys `ingredients` (their own `params`) and `recipes` declare `type: list` (spec 55 §4.2). */
export function declaredListKeys(ingredients: ReadonlyArray<{ meta: Ingredient }>, recipes: ReadonlyArray<Recipe>): Set<string> {
  const out = new Set<string>();
  for (const ing of ingredients) for (const [k, v] of Object.entries(ing.meta.params ?? {})) if (v.type === "list") out.add(k);
  for (const r of recipes) for (const [k, v] of Object.entries(r.params)) if (v.type === "list") out.add(k);
  return out;
}

/** A key printed only when shaped like a param name, else by its position among the keys (spec 33 Ruling 1). */
const KEY_SHAPED = /^[A-Za-z0-9_.-]{1,64}$/;
const shownKey = (key: string, all: readonly string[]) => (KEY_SHAPED.test(key) ? key : `#${all.indexOf(key) + 1} (a key not shown)`);

/**
 * Spec 55 §4.2: what fails the plan in the list keys' declarations and values, or `null`. A key declared `list` by one and
 * without it by another; a value at any layer that is not a sequence, or an item that is not a string — named by key, layer
 * and index, never a value. `layers` are the global layers in `paramLayers`' order, each with its name.
 */
export function listParamFault(
  lists: ReadonlySet<string>,
  ingredients: ReadonlyArray<{ ref: string; meta: Ingredient }>,
  recipes: ReadonlyArray<Recipe>,
  layers: ReadonlyArray<{ name: string; values: Record<string, unknown> }>,
): string | null {
  if (!lists.size) return null;
  const all = [...lists];
  for (const key of all) {
    const declarers: Array<{ who: string; list: boolean }> = [];
    for (const ing of ingredients) {
      const d = ing.meta.params?.[key];
      if (d && Object.hasOwn(ing.meta.params!, key)) declarers.push({ who: ing.ref, list: d.type === "list" });
    }
    for (const r of recipes) if (Object.hasOwn(r.params, key)) declarers.push({ who: `recipe ${r.name}`, list: r.params[key].type === "list" });
    const yes = declarers.find((d) => d.list);
    const no = declarers.find((d) => !d.list);
    if (yes && no) return `list param ${shownKey(key, all)}: ${yes.who} declares it type: list and ${no.who} declares it without — declare it the same way in both`;
    const values: Array<{ name: string; value: unknown }> = layers.filter((l) => Object.hasOwn(l.values, key)).map((l) => ({ name: l.name, value: l.values[key] }));
    for (const r of recipes) if (Object.hasOwn(r.params, key) && r.params[key].default !== undefined) values.push({ name: `recipe ${r.name}`, value: r.params[key].default });
    for (const v of values) {
      if (!Array.isArray(v.value)) return `list param ${shownKey(key, all)}: ${v.name} gives it a value that is not a sequence — give a YAML list of strings`;
      const bad = v.value.findIndex((x) => typeof x !== "string");
      if (bad !== -1) return `list param ${shownKey(key, all)}: ${v.name} gives item ${bad}, which is not a string — every item of a list param is a string`;
    }
  }
  return null;
}

/** A YAML list given to a key no ingredient or recipe declares `type: list` (spec 55 §4.2, A4): the keys, for one warning each. */
export function undeclaredLists(lists: ReadonlySet<string>, params: Record<string, unknown>): string[] {
  return Object.keys(params).filter((k) => Array.isArray(params[k]) && !lists.has(k));
}

export function undeclaredListWarning(key: string): string {
  const shown = KEY_SHAPED.test(key) ? key : "a key not shaped like a name";
  return `params: ${shown} is a list but no ingredient or recipe declares it type: list — it renders as the items joined by ","`;
}

/**
 * The list keys an import renders a base with (spec 55 §4.8): the base's own `type: list` declarations and every recipe's of
 * the Forge — a superset of what a resolution holds, so a filtered citation renders whenever some recipe could make it a list.
 */
export function importLists(forge: { manifest: Pick<ForgeManifest, "schema">; recipes: Map<string, Recipe> } | null | undefined, meta: Ingredient): ListContext {
  if (!forge || !rendersListParams(forge.manifest)) return NO_LISTS;
  return { keys: declaredListKeys([{ meta }], [...forge.recipes.values()]) };
}

/** The near miss below the gate (spec 55 §4.1): a `type: list` declaration names its file, the key and the schema. */
export function listDeclarationNearMiss(file: string, params: Record<string, { type?: string }> | undefined): string | null {
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v.type === "list") return `${file}: params.${KEY_SHAPED.test(k) ? k : "(a key not shaped like a name)"}: type: list needs schema: ${FORGE_SCHEMA_LIST_PARAMS} in craftar.forge.yaml`;
  }
  return null;
}

/**
 * Spec 55 §4.7 (A11): a list key cited in an MCP `server` or a hook's `registration`, with or without a filter, fails the plan,
 * naming the ingredient, the field path and the key, never a value — so no list item reaches `credentialIn`.
 */
export function assertNoListLeaf(value: unknown, lists: ListContext, ref: string, field: string): void {
  if (!lists.keys.size) return;
  const seen = new Set<object>();
  const walk = (v: unknown, at: string): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(BOTH_RE)) {
        const key = m[1] ?? m[2];
        if (lists.keys.has(key)) throw new ListParamError(`${ref}: list param ${key} in ${at} — an MCP server or a hook registration cannot take a list in this version; cite it in a body`);
      }
      return;
    }
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else for (const [k, x] of Object.entries(v)) walk(x, KEY_SHAPED.test(k) ? `${at}.${k}` : `${at}.(a key not shaped like a name)`);
  };
  walk(value, field);
}
