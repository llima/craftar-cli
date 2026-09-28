import { SECTION_NAME } from "../schema/index.js";
import { substitute } from "./resolve.js";
import { placeholders } from "./extract.js";
import { stripBom, toLf } from "./text.js";

/**
 * Sections (spec 11): a block of an ingredient body between two marker lines whose content is the
 * default, replaced or emptied by a profile or a workspace. Pure — the Forge and import sides call
 * these with text they read themselves.
 *
 *   <!-- craftar:section <name> -->
 *   …default…
 *   <!-- /craftar:section -->
 *
 * The grammar is line-based and not Markdown-aware (Ruling 10): a marker is a whole line starting at
 * column 0, single spaces between its tokens, trailing spaces or tabs tolerated. A line that starts
 * like one and is not one is an error (a near miss); an indented marker is literal text.
 */

const OPEN = /^<!-- craftar:section (\S+) -->[ \t]*$/;
const CLOSE = /^<!-- \/craftar:section -->[ \t]*$/;
const NEAR = /^<!--[ \t]*\/?[ \t]*craftar:section/;

/** What a line is to the grammar: an opener (with its name), a closer, a near miss, or text (null). */
export function markerLine(line: string): { kind: "open"; name: string } | { kind: "close" } | { kind: "near" } | null {
  const l = line.endsWith("\n") ? line.slice(0, -1) : line;
  const open = OPEN.exec(l);
  if (open && SECTION_NAME.test(open[1])) return { kind: "open", name: open[1] };
  if (CLOSE.test(l)) return { kind: "close" };
  if (NEAR.test(l)) return { kind: "near" };
  return null;
}

/** A marker problem, with the Forge-relative file and 1-based line it names. */
export class SectionMarkerError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly problem: string,
  ) {
    super(`section markers in ${file}:${line}: ${problem}`);
    this.name = "SectionMarkerError";
  }
}

export type SectionSegment = { text: string } | { name: string; default: string; line: number };

/** One file parsed: outside text and sections, in order. A file with no marker is one outside segment. */
export interface ParsedSections {
  file: string;
  segments: SectionSegment[];
  /** The sections, in order: name, default, and the line of the opener. */
  sections: Array<{ name: string; default: string; line: number }>;
}

/** Lines that keep their terminator; the last one may have none. */
function linesOf(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * Parse `text` (spec 11 §6.1). `label` is the Forge-relative file the errors name; `ref`, the
 * ingredient the duplicate-name message names (defaults to `label`). Works on `toLf(stripBom(text))`.
 */
export function parseSections(text: string, label: string, ref: string = label): ParsedSections {
  const lines = linesOf(toLf(stripBom(text)));
  const segments: SectionSegment[] = [];
  const sections: ParsedSections["sections"] = [];
  const seen = new Map<string, number>();
  let outside = "";
  let open: { name: string; line: number; body: string } | null = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    const m = markerLine(line);
    if (m === null) {
      if (open) open.body += line;
      else outside += line;
      return;
    }
    if (m.kind === "near") {
      throw new SectionMarkerError(label, n, `malformed section marker — expected "<!-- craftar:section <name> -->" or "<!-- /craftar:section -->"`);
    }
    if (m.kind === "open") {
      if (open) throw new SectionMarkerError(label, n, `section ${m.name} opens inside section ${open.name} (line ${open.line})`);
      const prev = seen.get(m.name);
      if (prev !== undefined) throw new SectionMarkerError(label, n, `section ${m.name} is declared twice in ${ref} (also ${label}:${prev})`);
      seen.set(m.name, n);
      segments.push({ text: outside });
      outside = "";
      open = { name: m.name, line: n, body: "" };
      return;
    }
    if (!open) throw new SectionMarkerError(label, n, "a closing marker with no open section");
    const s = { name: open.name, default: open.body, line: open.line };
    segments.push(s);
    sections.push(s);
    open = null;
  });
  if (open) {
    const o = open as { name: string; line: number };
    throw new SectionMarkerError(label, o.line, `section ${o.name} is never closed`);
  }
  segments.push({ text: outside });
  // Always text, then section and text alternately: O0 [s1] O1 … [sn] On (spec 11 §6.2).
  return { file: label, segments, sections };
}

/** A name declared once per ingredient, across its files too (Ruling 11). Throws naming the second declaration. */
export function checkDeclaredOnce(ref: string, files: ParsedSections[]): void {
  const first = new Map<string, string>();
  for (const f of files) {
    for (const s of f.sections) {
      const prev = first.get(s.name);
      if (prev !== undefined) throw new SectionMarkerError(f.file, s.line, `section ${s.name} is declared twice in ${ref} (also ${prev})`);
      first.set(s.name, `${f.file}:${s.line}`);
    }
  }
}

/** A section value as it is inserted (spec 11 §6.2): LF, and one final newline unless it is empty. */
export function canonicalValue(v: string): string {
  const lf = toLf(v);
  return lf !== "" && !lf.endsWith("\n") ? lf + "\n" : lf;
}

/**
 * The file with every section replaced by its value in `values`, or by its default when `values`
 * has none, and every marker line removed (spec 11 §6.2). Substitution comes after, by the caller.
 */
export function expandSections(parsed: ParsedSections, values: Record<string, string> | undefined): string {
  let out = "";
  for (const s of parsed.segments) {
    if ("text" in s) out += s.text;
    else out += values && Object.hasOwn(values, s.name) ? canonicalValue(values[s.name]) : s.default;
  }
  return out;
}

/** The 1-based line of the first column-0 marker or near miss in `text`, or null (the output guard, §6.6). */
export function firstMarkerLine(text: string): number | null {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) if (markerLine(lines[i]) !== null) return i + 1;
  return null;
}

export type SectionInference =
  | { values: Record<string, string> }
  | { fallback: "F11" | "F12" | "F13"; reason: string };

type Piece = { fixed: string; ws?: string } | { gap: string };

/**
 * Infer the open sections of one file from the source (spec 11 §6.8). Outside text is rendered
 * with `map`; a section `fixed` sets (the workspace's value) is fixed text too; every other section
 * is a gap that starts at a line start and is empty or ends with a newline. Exactly one assignment
 * must spell the source. Not proved here — the caller renders with the result and compares.
 */
export function inferSections(parsed: ParsedSections, source: string, fixed: Record<string, string>, map: Record<string, unknown>): SectionInference {
  const src = toLf(stripBom(source));
  const pieces: Piece[] = [];
  for (const s of parsed.segments) {
    if ("text" in s) pieces.push({ fixed: substitute(s.text, map) });
    else if (Object.hasOwn(fixed, s.name)) pieces.push({ fixed: substitute(canonicalValue(fixed[s.name]), map), ws: s.name });
    else pieces.push({ gap: s.name });
  }
  const atLineStart = (pos: number) => pos === 0 || src[pos - 1] === "\n";

  const found: Array<Record<string, string>> = [];
  const dead = new Set<string>();
  let far = { pos: -1, ws: undefined as string | undefined };
  const walk = (i: number, pos: number, assigned: Record<string, string>): boolean => {
    if (found.length >= 2) return true;
    const key = `${i}:${pos}`;
    if (dead.has(key)) return false;
    let ok = false;
    if (i === pieces.length) {
      if (pos === src.length) {
        found.push({ ...assigned });
        ok = true;
      } else if (pos > far.pos) far = { pos, ws: undefined };
    } else {
      const p = pieces[i];
      if ("fixed" in p) {
        if (src.startsWith(p.fixed, pos)) ok = walk(i + 1, pos + p.fixed.length, assigned);
        else {
          let common = 0;
          while (common < p.fixed.length && src[pos + common] === p.fixed[common]) common++;
          if (pos + common > far.pos) far = { pos: pos + common, ws: p.ws };
        }
      } else if (atLineStart(pos)) {
        for (let end = pos; end <= src.length; end++) {
          if (end !== pos && src[end - 1] !== "\n") continue;
          assigned[p.gap] = src.slice(pos, end);
          if (walk(i + 1, end, assigned)) ok = true;
          delete assigned[p.gap];
          if (found.length >= 2) break;
        }
      }
    }
    if (!ok) dead.add(key);
    return ok;
  };
  walk(0, 0, {});

  if (found.length === 0) {
    if (far.ws !== undefined) return { fallback: "F11", reason: `section ${far.ws} of ${parsed.file} is set by the workspace and the source differs there` };
    const line = src.slice(0, Math.max(0, far.pos)).split("\n").length;
    return { fallback: "F11", reason: `the text outside the sections of ${parsed.file} differs (line ${line})` };
  }
  if (found.length > 1) {
    const [a, b] = found;
    const differ = Object.keys(a).filter((k) => a[k] !== b[k]);
    return { fallback: "F12", reason: `section inference ambiguous in ${parsed.file}: ${differ.join(", ")}` };
  }
  const values = found[0];
  for (const s of parsed.sections) {
    if (!Object.hasOwn(values, s.name)) continue;
    if (firstMarkerLine(values[s.name]) !== null) return { fallback: "F13", reason: `section ${s.name} would hold a section marker` };
    const k = placeholders(values[s.name]).find((x) => Object.hasOwn(map, x));
    if (k !== undefined) return { fallback: "F13", reason: `section ${s.name} would cite {{${k}}}, which this profile renders` };
  }
  return { values };
}
