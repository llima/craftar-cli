import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { nameShaped } from "./integrations.js";
import { detectEol, stripBom, toLf, withEol } from "./text.js";

/**
 * Edit a YAML document in place (spec 09 §6.4, generalized by spec 10 §6.6): refuse one that
 * does not round-trip byte for byte — an edit never reformats a line it did not decide — apply
 * `edit`, and restore the EOL and BOM. The width the file was written with decides the width of
 * the edit: `unify` writes with no folding, `import` with yaml's default 80 columns, so both are
 * tried, and the first that reproduces the text is the one the edit is serialized with. Both set
 * `flowCollectionPadding: false`, so a file that spells a flow collection `[a, b]`, the common
 * hand-written form, still round-trips; yaml's default would write it back as `[ a, b ]`.
 * The last two options (spec 50 Part C) keep a double-quoted string with a `\n` on one line: yaml's default breaks one
 * over 40 characters. They come after the first two, so a document that passed before keeps the options it had.
 */

const BOM = String.fromCharCode(0xfeff);
const WIDTHS = [
  { flowCollectionPadding: false, lineWidth: 0 },
  { flowCollectionPadding: false },
  { flowCollectionPadding: false, lineWidth: 0, doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER },
  { flowCollectionPadding: false, doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER },
] as const;

/**
 * A key of a document as a message may print it, or its position: a pasted token or sentence is not a key (spec 50 §6.2).
 * `nameShaped` per `/`-separated segment, since a section key is `<type>/<name>`.
 */
const shownKey = (key: unknown, position: number): string =>
  typeof key === "string" && key.split("/").every(nameShaped) ? key : `#${position}`;

/** Where a text first differs from what the writer gives: the 1-based line, the keys above it, and whether it holds a double-quoted value. */
function whereItDiffers(raw: string, text: string, doc: YAML.Document): { line: number; keys: string[]; quoted: boolean } {
  const lines = text.split("\n");
  const firstDiff = (w: (typeof WIDTHS)[number]) => {
    const out = doc.toString(w).split("\n");
    const i = lines.findIndex((l, n) => l !== out[n]);
    return i === -1 ? lines.length - 1 : i;
  };
  // The serialization nearest to the text: the one that follows it for the most lines.
  const index = Math.max(...WIDTHS.map(firstDiff));
  const starts = [0];
  for (const m of raw.matchAll(/\r\n|\r|\n/g)) starts.push(m.index + m[0].length);
  const lineStart = starts[index] ?? raw.length;
  const offset = lineStart + (/^[\ufeff \t-]*/.exec(raw.slice(lineStart))?.[0].length ?? 0);
  const keys: string[] = [];
  let quoted = false;
  let node: unknown = doc.contents;
  for (;;) {
    if (YAML.isMap(node)) {
      const at: number = node.items.findIndex((p) => {
        const k = p.key as YAML.Node | null;
        const v = p.value as YAML.Node | null;
        const end = v?.range?.[2] ?? k?.range?.[2];
        return k?.range != null && end != null && offset >= k.range[0] && offset < end;
      });
      if (at === -1) break;
      const pair = node.items[at];
      keys.push(shownKey(YAML.isScalar(pair.key) ? pair.key.value : undefined, at + 1));
      node = pair.value;
    } else if (YAML.isSeq(node)) {
      const at: number = node.items.findIndex((i) => {
        const r = (i as YAML.Node | null)?.range;
        return r != null && offset >= r[0] && offset < r[2];
      });
      if (at === -1) break;
      keys.push(`#${at + 1}`);
      node = node.items[at];
    } else {
      quoted = YAML.isScalar(node) && node.type === "QUOTE_DOUBLE";
      break;
    }
  }
  return { line: index + 1, keys, quoted };
}

/**
 * The first place `after` differs from `expected`, as a message may print it — keys and a kind, never a value and no
 * length of one (spec 50 §6.2). Null when they are equal.
 */
export function readBackDifference(after: unknown, expected: unknown): string | null {
  const walk = (a: unknown, b: unknown, at: string[]): string | null => {
    const say = (where: string[], kind: string) => `${where.length ? where.join(" › ") : "the document"} reads back ${kind}`;
    const seqs = Array.isArray(a) && Array.isArray(b);
    const maps = !seqs && a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    if (seqs || maps) {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const names = [...Object.keys(y), ...Object.keys(x).filter((k) => !Object.hasOwn(y, k))];
      for (const [i, k] of names.entries()) {
        const here = [...at, seqs ? `#${Number(k) + 1}` : shownKey(k, i + 1)];
        if (!Object.hasOwn(x, k)) return say(here, "missing");
        if (!Object.hasOwn(y, k)) return say(here, "added");
        const found = walk(x[k], y[k], here);
        if (found) return found;
      }
      return null;
    }
    if (isDeepStrictEqual(a, b)) return null;
    const blank = (v: string) => v.replace(/\s+/g, "");
    return say(at, typeof a === "string" && typeof b === "string" && blank(a) === blank(b) ? "changed, whitespace only" : "changed");
  };
  return walk(after, expected, []);
}

export interface YamlEditOptions {
  /** The command the message names (`unify`, `import`). */
  command: string;
  /** The file as the message names it, Forge- or workspace-relative. */
  label: string;
  /**
   * Top-level keys the edit may touch: an alias there is refused, and an empty flow collection
   * (`{}` / `[]`) the edit fills becomes block form. One the edit leaves empty keeps its bytes.
   */
  keys: string[];
}

export function editYamlText(raw: string, o: YamlEditOptions, edit: (doc: YAML.Document) => void): string {
  const refuse = (why: string, fix = "reformat it by hand, commit, and re-run") =>
    new Error(`${o.command}: cannot edit ${o.label} in place (${why}) — ${fix}`);
  const eol = detectEol(raw);
  const bom = raw.charCodeAt(0) === BOM.charCodeAt(0);
  const doc = YAML.parseDocument(raw);
  const text = toLf(stripBom(raw));
  const width = doc.errors.length ? undefined : WIDTHS.find((w) => doc.toString(w) === text);
  if (!width) {
    const WHY = "it does not round-trip unchanged through the YAML writer";
    if (doc.errors.length) throw refuse(WHY);
    const { line, keys, quoted } = whereItDiffers(raw, text, doc);
    const under = keys.length ? `, under ${keys.join(" › ")}` : "";
    throw quoted
      ? refuse(`${WHY}: line ${line}${under}`, "write that value as a | block or without its escape, commit, and re-run")
      : refuse(`${WHY}: line ${line}${under}`);
  }
  const emptyFlow: Array<[string, YAML.YAMLMap | YAML.YAMLSeq]> = [];
  for (const key of o.keys) {
    const node = doc.get(key, true);
    if (YAML.isAlias(node)) throw refuse(`${key} is an alias`, "expand it by hand, commit, and re-run");
    if ((YAML.isMap(node) || YAML.isSeq(node)) && node.flow && node.items.length === 0) emptyFlow.push([key, node]);
  }
  edit(doc);
  // Only a collection the edit filled changes form; an untouched `params: {}` stays on its line.
  for (const [key, node] of emptyFlow) if (doc.get(key, true) === node && node.items.length > 0) node.flow = false;
  return (bom ? BOM : "") + withEol(doc.toString(width), eol);
}
