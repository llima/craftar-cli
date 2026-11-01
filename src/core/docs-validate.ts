/**
 * `craftar docs validate` (spec 47): the one module of the command — the docs block's one reader, the scanner, the checks.
 * Returns data and throws; it never prints. No finding carries a line of a file, a link's target or a frontmatter value.
 */
import { DocsBlockSchema, type DocsBlock } from "../schema/index.js";
import { stripBom, toLf } from "./text.js";

/** A docs block that does not read (spec 47 §5.4): one line, `docs block: <position> — <rule>`, never a value. */
export class DocsBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsBlockError";
  }
}

const position = (p: Array<string | number>) =>
  p.length === 0 ? "docs" : p.map((x, i) => (typeof x === "number" ? `[${x}]` : i === 0 ? x : `.${x}`)).join("");

/** The one reader of `profile.docs` (spec 47 §5.2): `null` when absent or `null`, else the block, else a `DocsBlockError`. */
export function declaredDocs(profile: { docs?: unknown }): DocsBlock | null {
  if (profile.docs === undefined || profile.docs === null) return null;
  const parsed = DocsBlockSchema.safeParse(profile.docs);
  if (parsed.success) return parsed.data;
  // Every issue is custom, with a fixed text of DOCS_RULES (or NO_PROTO_KEY) and a path the schema already vetted.
  const issues = parsed.error.issues;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  throw new DocsBlockError(`docs block: ${position(issues[0].path)} — ${issues[0].message}${more}`);
}

/* ------------------------------------------------------------------ */
/* The scanner (spec 47 §6) — not a CommonMark parser: it finds link   */
/* destinations, anchors and leaked tags outside code, in linear time. */
/* ------------------------------------------------------------------ */

/**
 * The tool-call tags (spec 47 §4.5): data, each a name and the element names it matches, opening or closing, with an
 * optional `prefix:`. A finding names the entry, never the text matched. The names are assembled so that this file holds
 * no literal tool-call markup.
 */
export const LEAKED_TAGS: ReadonlyArray<{ name: string; elements: string[] }> = [
  { name: "function-calls", elements: [["function", "calls"].join("_")] },
  { name: "function-results", elements: [["function", "results"].join("_")] },
  { name: "invoke", elements: [["in", "voke"].join("")] },
  { name: "parameter", elements: [["para", "meter"].join("")] },
  { name: "tool-use", elements: [["tool", "use"].join("_"), ["tool", "result"].join("_")] },
];
const TAG_ELEMENT = new Map(LEAKED_TAGS.flatMap((t) => t.elements.map((e) => [e, t.name] as const)));
const TAG_RE = new RegExp(`</?(?:[A-Za-z]+:)?(${[...TAG_ELEMENT.keys()].join("|")})(?![A-Za-z0-9_-])`, "g");

export interface ScannedLink {
  line: number;
  column: number;
  /** The destination as written, title removed and angle brackets dropped; never printed. */
  dest: string;
  /** A Markdown destination (backslash escapes apply), or an HTML attribute value (they do not). */
  markdown: boolean;
}
export interface TagHit {
  name: string;
  line: number;
  column: number;
}
export interface Scan {
  links: ScannedLink[];
  /** Fragments the file gives: heading slugs (with `-1` repeats) and `<a id>` / `<a name>`. */
  anchors: Set<string>;
  tags: TagHit[];
  /** The frontmatter block's text and the line its first line has in the file; `null` when there is none. */
  frontmatter: { raw: string; firstLine: number } | null;
}

interface SrcLine {
  text: string;
  line: number;
  /** Characters removed before `text` starts on the original line. */
  col0: number;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** GitHub's heading slug (github-slugger's rule): lower case, characters other than letters, marks, numbers, `_`, space and `-` dropped, spaces to `-`. */
export function githubSlug(text: string): string {
  const visible = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .trim()
    .toLowerCase();
  return visible.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** github-slugger's repeat rule: a slug already given gets `-1`, `-2`, … */
class Slugger {
  private occurrences = new Map<string, number>();
  constructor(private anchors: Set<string>) {}
  add(text: string): void {
    const original = githubSlug(text);
    let slug = original;
    while (this.occurrences.has(slug)) {
      const n = this.occurrences.get(original)! + 1;
      this.occurrences.set(original, n);
      slug = `${original}-${n}`;
    }
    this.occurrences.set(slug, 0);
    this.anchors.add(slug);
  }
}

/** Positions after an unescaped backslash that escapes ASCII punctuation. */
function escapes(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && !out[i] && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) out[i + 1] = 1;
  }
  return out;
}

/**
 * The paragraph with its code spans, inline HTML comments and inline `<code>` elements blanked (newlines kept), so that
 * no later pass sees them. Code spans pair backtick runs of equal length (CommonMark): each length keeps a forward-only
 * pointer into its runs, so a paragraph of unmatched runs is read once — linear time (§6.2).
 */
export function blankCode(s: string): string {
  const esc = escapes(s);
  const runs: Array<{ start: number; len: number }> = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === "`") j++;
    // An escaped first backtick is literal; the rest of the run still counts.
    const start = esc[i] ? i + 1 : i;
    if (j > start) runs.push({ start, len: j - start });
    i = j;
  }
  const byLen = new Map<number, number[]>();
  runs.forEach((r, idx) => (byLen.get(r.len) ?? byLen.set(r.len, []).get(r.len)!).push(idx));
  const pointer = new Map<number, number>();
  const ranges: Array<[number, number]> = [];
  for (let idx = 0; idx < runs.length; idx++) {
    const r = runs[idx];
    const list = byLen.get(r.len)!;
    let p = pointer.get(r.len) ?? 0;
    while (p < list.length && list[p] <= idx) p++;
    pointer.set(r.len, p);
    if (p >= list.length) continue;
    const close = runs[list[p]];
    ranges.push([r.start, close.start + close.len]);
    idx = list[p];
  }
  const blank = (from: number, to: number, out: string[]) => out.push(s.slice(from, to).replace(/[^\n]/g, " "));
  const parts: string[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    parts.push(s.slice(at, a));
    blank(a, b, parts);
    at = b;
  }
  parts.push(s.slice(at));
  let out = parts.join("");
  // Inline HTML comments and <code> elements, each by indexOf from where the last one ended: linear.
  for (const [open, close] of [
    ["<!--", "-->"],
    ["<code", "</code>"],
  ] as const) {
    const pieces: string[] = [];
    let from = 0;
    const lower = open === "<code" ? out.toLowerCase() : out;
    for (;;) {
      const a = lower.indexOf(open, from);
      if (a === -1) break;
      const b = lower.indexOf(close, a + open.length);
      const end = b === -1 ? out.length : b + close.length;
      pieces.push(out.slice(from, a));
      blank(a, end, pieces);
      from = end;
    }
    pieces.push(out.slice(from));
    out = pieces.join("");
  }
  return out;
}

/** For each index, the next index at or after it holding a character `test` accepts, or `s.length`. */
function nextWhere(s: string, test: (c: string) => boolean): Int32Array {
  const out = new Int32Array(s.length + 1);
  out[s.length] = s.length;
  for (let i = s.length - 1; i >= 0; i--) out[i] = test(s[i]) ? i : out[i + 1];
  return out;
}

const isWs = (c: string) => c === " " || c === "\t" || c === "\n";
const TITLE = /^(?:"[^"]*"|'[^']*'|\([^()]*\))$/s;

/** Every link, anchor and tag of one paragraph (code already blanked). */
function scanParagraph(s: string, at: (pos: number) => { line: number; column: number }, scan: Scan): void {
  const esc = escapes(s);

  for (const m of s.matchAll(TAG_RE)) scan.tags.push({ name: TAG_ELEMENT.get(m[1])!, ...at(m.index!) });

  // Parentheses paired once over the paragraph, so a destination's close is found without rescanning.
  const matchParen = new Int32Array(s.length).fill(-1);
  const parens: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (esc[i]) continue;
    if (s[i] === "(") parens.push(i);
    else if (s[i] === ")" && parens.length) matchParen[parens.pop()!] = i;
  }
  const nextWs = nextWhere(s, isWs);
  const nextGt = nextWhere(s, (c) => c === ">" || c === "\n" || c === "<");

  /** An inline destination opening at `open` (the `(`): its link, or null when it is not one. Returns the `)` too. */
  const inline = (open: number): { link: ScannedLink; end: number } | null => {
    const close = matchParen[open];
    let p = open + 1;
    let newlines = 0;
    while (p < s.length && isWs(s[p])) if (s[p++] === "\n" && ++newlines > 1) return null;
    if (s[p] === "<") {
      const gt = nextGt[p + 1];
      if (gt >= s.length || s[gt] !== ">") return null;
      const end = close > gt ? close : -1;
      if (end === -1 || !TITLE_OR_EMPTY(s.slice(gt + 1, end))) return null;
      return { link: { dest: s.slice(p + 1, gt), markdown: true, ...at(p + 1) }, end };
    }
    if (close === -1) return null;
    const stop = Math.min(nextWs[p], close);
    if (!TITLE_OR_EMPTY(s.slice(stop, close))) return null;
    return { link: { dest: s.slice(p, stop), markdown: true, ...at(p) }, end: close };
  };

  const brackets: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (esc[i]) continue;
    if (s[i] === "[") brackets.push(i);
    else if (s[i] === "]" && brackets.length) {
      brackets.pop();
      if (s[i + 1] === "(" && !esc[i + 1]) {
        const found = inline(i + 1);
        if (found) {
          scan.links.push(found.link);
          i = found.end;
        }
      }
    }
  }

  // Reference definitions: at a line's start, a destination and at most a title; never a footnote or a task box.
  let lineStart = 0;
  for (const line of s.split("\n")) {
    const m = /^ {0,3}\[([^\]\n]{1,999})\]:[ \t]*(<[^>\n]*>|\S+)(.*)$/.exec(line);
    if (m && !m[1].startsWith("^") && !/^[ xX]$/.test(m[1]) && TITLE_OR_EMPTY(m[3])) {
      const angle = m[2].startsWith("<");
      const col = line.indexOf(m[2], line.indexOf("]:") + 2) + (angle ? 1 : 0);
      scan.links.push({ dest: angle ? m[2].slice(1, -1) : m[2], markdown: true, ...at(lineStart + col) });
    }
    lineStart += line.length + 1;
  }

  // HTML: <a href>, <img src> and <a id> / <a name> with a quoted value; an unquoted one is left unseen (§6.3).
  for (const m of s.matchAll(/<(a|img)\b([^<>]*)>/gi)) {
    const element = m[1].toLowerCase();
    const attrsAt = m.index! + 1 + m[1].length;
    for (const a of m[2].matchAll(/(?:^|\s)(href|src|id|name)[ \t\n]*=[ \t\n]*(?:"([^"]*)"|'([^']*)')/gi)) {
      const attr = a[1].toLowerCase();
      const value = a[2] ?? a[3];
      const valueAt = attrsAt + a.index! + a[0].length - value.length - 1;
      if (element === "a" && (attr === "id" || attr === "name")) scan.anchors.add(value);
      else if ((element === "a" && attr === "href") || (element === "img" && attr === "src")) scan.links.push({ dest: value, markdown: false, ...at(valueAt) });
    }
  }
}

const TITLE_OR_EMPTY = (rest: string): boolean => {
  const t = rest.trim();
  return t === "" || TITLE.test(t);
};

/** Scan one Markdown file's text (spec 47 §6.1–§6.3). */
export function scanMarkdown(input: string): Scan {
  const text = toLf(stripBom(input));
  const scan: Scan = { links: [], anchors: new Set(), tags: [], frontmatter: null };
  const slugger = new Slugger(scan.anchors);
  const all = text.split("\n");
  let first = 0;
  const fm = FRONTMATTER.exec(text);
  if (fm) {
    scan.frontmatter = { raw: fm[1], firstLine: 2 };
    first = fm[0].replace(/\n$/, "").split("\n").length;
  }

  let paragraph: SrcLine[] = [];
  let fence: { char: string; len: number } | null = null;
  let htmlBlock: string | null = null;
  let inList = false;
  let afterBlank = true;

  const flush = (heading = false) => {
    if (paragraph.length === 0) return;
    const lines = paragraph;
    paragraph = [];
    const starts: number[] = [];
    let n = 0;
    for (const l of lines) {
      starts.push(n);
      n += l.text.length + 1;
    }
    const at = (pos: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return { line: lines[lo].line, column: lines[lo].col0 + (pos - starts[lo]) + 1 };
    };
    const joined = lines.map((l) => l.text).join("\n");
    const blanked = blankCode(joined);
    // GitHub slugs a heading from its rendered text, so a code span's content counts there.
    if (heading) slugger.add(joined.replace(/\n/g, " "));
    scanParagraph(blanked, at, scan);
  };

  for (let i = first; i < all.length; i++) {
    const lineNo = i + 1;
    let raw = all[i];
    let col0 = 0;
    // Block quote markers first, so that a fence inside a quote is a fence.
    const quote = /^(?: {0,3}> ?)+/.exec(raw);
    if (quote) {
      col0 = quote[0].length;
      raw = raw.slice(col0);
    }

    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.len},}[ \\t]*$`);
      if (close.test(raw)) fence = null;
      continue;
    }
    if (htmlBlock) {
      if (raw.toLowerCase().includes(htmlBlock)) htmlBlock = null;
      continue;
    }

    const blank = raw.trim() === "";
    if (blank) {
      flush();
      afterBlank = true;
      continue;
    }

    const open = FENCE_OPEN.exec(raw);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flush();
      fence = { char: open[1][0], len: open[1].length };
      afterBlank = false;
      continue;
    }

    const trimmed = raw.trimStart().toLowerCase();
    for (const [tag, closeTag] of [
      ["<!--", "-->"],
      ["<pre", "</pre>"],
      ["<code", "</code>"],
    ] as const) {
      if (trimmed.startsWith(tag) && (tag === "<!--" || /^<(?:pre|code)(?:[\s>]|$)/.test(trimmed))) {
        const rest = raw.toLowerCase().slice(raw.toLowerCase().indexOf(tag) + tag.length);
        if (!rest.includes(closeTag)) {
          flush();
          htmlBlock = closeTag;
          break;
        }
      }
    }
    if (htmlBlock) {
      afterBlank = false;
      continue;
    }

    const indented = /^(?: {4}|\t)/.test(raw);
    if (indented && paragraph.length === 0 && !inList) continue;

    const listItem = LIST_ITEM.exec(raw);
    if (listItem && !indented) {
      flush();
      inList = true;
      paragraph.push({ text: raw.slice(listItem[0].length), line: lineNo, col0: col0 + listItem[0].length });
      afterBlank = false;
      continue;
    }
    if (afterBlank && !indented) inList = false;

    const atx = ATX.exec(raw);
    if (atx && !indented) {
      flush();
      const content = atx[2].replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "");
      paragraph.push({ text: content, line: lineNo, col0: col0 + raw.length - atx[2].length });
      flush(true);
      afterBlank = false;
      continue;
    }
    if (SETEXT.test(raw) && paragraph.length > 0 && !indented) {
      flush(true);
      afterBlank = false;
      continue;
    }

    if (raw.trimStart().startsWith("|")) {
      flush();
      paragraph.push({ text: raw, line: lineNo, col0 });
      flush();
      afterBlank = false;
      continue;
    }

    paragraph.push({ text: raw, line: lineNo, col0 });
    afterBlank = false;
  }
  flush();
  return scan;
}

/* ------------------------------------------------------------------ */
/* A destination, read in §6.4's order                                  */
/* ------------------------------------------------------------------ */

export type TargetFault = "backslash" | "nul" | "windows-path" | "bad-percent";
export type ReadTarget =
  | { kind: "external" }
  | { kind: "unchecked" }
  | { kind: "fault"; fault: TargetFault }
  | { kind: "path"; path: string; fragment: string | null; badFragment: boolean };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

const decoded = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/**
 * One destination as §6.4 reads it: escapes (Markdown only), `&amp;`, external or not, the cut at `#` / `?`, then
 * percent-decoding of the path and the fragment apart, then the faults a portable tree must not hold. An empty path is
 * the file itself (`path: ""`).
 */
export function readTarget(dest: string, markdown: boolean): ReadTarget {
  let t = dest;
  if (t.includes("{{")) return { kind: "unchecked" };
  if (markdown) t = t.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  t = t.replace(/&amp;/g, "&");
  if (WINDOWS_PATH.test(t)) return { kind: "fault", fault: "windows-path" };
  if (SCHEME.test(t) || t.startsWith("//")) return { kind: "external" };
  const hash = t.indexOf("#");
  const cut = [hash, t.indexOf("?")].filter((x) => x !== -1);
  const pathPart = cut.length ? t.slice(0, Math.min(...cut)) : t;
  const fragmentRaw = hash === -1 ? null : t.slice(hash + 1);
  const p = decoded(pathPart);
  if (p === null) return { kind: "fault", fault: "bad-percent" };
  if (p.includes("\0")) return { kind: "fault", fault: "nul" };
  if (p.includes("\\")) return { kind: "fault", fault: "backslash" };
  if (WINDOWS_PATH.test(p)) return { kind: "fault", fault: "windows-path" };
  if (fragmentRaw === null) return { kind: "path", path: p, fragment: null, badFragment: false };
  const f = decoded(fragmentRaw);
  return { kind: "path", path: p, fragment: f, badFragment: f === null };
}
