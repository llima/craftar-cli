import YAML from "yaml";
import { detectEol, stripBom, toLf, withEol } from "./text.js";

/**
 * Edit a YAML document in place (spec 09 §6.4, generalized by spec 10 §6.6): refuse one that
 * does not round-trip byte for byte — an edit never reformats a line it did not decide — apply
 * `edit`, and restore the EOL and BOM. The width the file was written with decides the width of
 * the edit: `unify` writes with no folding, `import` with yaml's default 80 columns, so both are
 * tried, and the first that reproduces the text is the one the edit is serialized with. Both set
 * `flowCollectionPadding: false`, so a file that spells a flow collection `[a, b]`, the common
 * hand-written form, still round-trips; yaml's default would write it back as `[ a, b ]`.
 */

const BOM = String.fromCharCode(0xfeff);
const WIDTHS = [
  { flowCollectionPadding: false, lineWidth: 0 },
  { flowCollectionPadding: false },
] as const;

export interface YamlEditOptions {
  /** The command the message names (`unify`, `import`). */
  command: string;
  /** The file as the message names it, Forge- or workspace-relative. */
  label: string;
  /** Top-level keys the edit touches: an alias there is refused, an empty flow map becomes a block map. */
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
  if (!width) throw refuse("it does not round-trip unchanged through the YAML writer");
  for (const key of o.keys) {
    const node = doc.get(key, true);
    if (YAML.isAlias(node)) throw refuse(`${key} is an alias`, "expand it by hand, commit, and re-run");
    if ((YAML.isMap(node) || YAML.isSeq(node)) && node.flow && node.items.length === 0) node.flow = false;
  }
  edit(doc);
  return (bom ? BOM : "") + withEol(doc.toString(width), eol);
}
