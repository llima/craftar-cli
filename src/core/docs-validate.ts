/**
 * `craftar docs validate` (spec 47): the one module of the command — the docs block's one reader, the scanner, the checks.
 * Returns data and throws; it never prints. No finding carries a line of a file, a link's target or a frontmatter value.
 */
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { DocsBlockSchema, type DocsBlock } from "../schema/index.js";
import { TERMINAL_UNSAFE, gitIsRepo, ignoredPaths } from "./forge.js";
import { parseFrontmatter } from "./frontmatter.js";
import { profileRepos } from "./repos.js";
import { classifyForge, type GitRunner } from "./remote.js";
import { loadForgeFor, readLock, readWorkspaceConfig, type MergedConfig, type Workspace } from "./sync.js";
import { climbsOut, isUtf8, stripBom, toLf } from "./text.js";
import { YamlSyntaxError, parseYamlText } from "./yaml-read.js";

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
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An ATX heading's text without its optional closing `#` run (CommonMark), read from the end: no regex backtracks over it. */
function withoutClosingRun(text: string): string {
  const t = text.trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === "#") k--;
  if (k === t.length) return t;
  if (k === 0) return "";
  return t[k - 1] === " " || t[k - 1] === "\t" ? t.slice(0, k).trimEnd() : t;
}

/** GitHub's heading slug (github-slugger's rule): lower case, characters other than letters, marks, numbers, `_`, space and `-` dropped, spaces to `-`. */
export function githubSlug(text: string): string {
  const visible = text
    // Each class excludes its own opener, so a failed attempt stops at the next one: linear on a run of openers.
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/<[^<>]*>/g, "")
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
  // A backslash escapes only an opening backtick: inside a span it is literal, so a run keeps its full length as a closer.
  const runs: Array<{ start: number; len: number; escaped: boolean }> = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === "`") j++;
    runs.push({ start: i, len: j - i, escaped: esc[i] === 1 });
    i = j;
  }
  const byLen = new Map<number, number[]>();
  runs.forEach((r, idx) => (byLen.get(r.len) ?? byLen.set(r.len, []).get(r.len)!).push(idx));
  const pointer = new Map<number, number>();
  const ranges: Array<[number, number]> = [];
  for (let idx = 0; idx < runs.length; idx++) {
    const r = runs[idx];
    // An escaped first backtick is literal; the rest of the run can still open.
    const len = r.escaped ? r.len - 1 : r.len;
    const start = r.escaped ? r.start + 1 : r.start;
    const list = byLen.get(len);
    if (len === 0 || !list) continue;
    let p = pointer.get(len) ?? 0;
    while (p < list.length && list[p] <= idx) p++;
    pointer.set(len, p);
    if (p >= list.length) continue;
    const close = runs[list[p]];
    ranges.push([start, close.start + close.len]);
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
    let search = 0;
    for (;;) {
      const a = lower.indexOf(open, search);
      if (a === -1) break;
      // `<code` names the element only when a space, `>` or the end follows (`<codex>` is another element).
      if (open === "<code" && a + open.length < out.length && !/[\s>]/.test(out[a + open.length])) {
        search = a + 1;
        continue;
      }
      const b = lower.indexOf(close, a + open.length);
      const end = b === -1 ? out.length : b + close.length;
      pieces.push(out.slice(from, a));
      blank(a, end, pieces);
      from = search = end;
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
      if (end === -1 || !titleBetween(s, gt + 1, end)) return null;
      return { link: { dest: s.slice(p + 1, gt), markdown: true, ...at(p + 1) }, end };
    }
    if (close === -1) return null;
    const stop = Math.min(nextWs[p], close);
    if (!titleBetween(s, stop, close)) return null;
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

  // Reference definitions: the paragraph's leading lines (one cannot interrupt a paragraph), each a destination and at most
  // a title; never a footnote or a task box.
  let lineStart = 0;
  for (const line of s.split("\n")) {
    const m = /^ {0,3}\[([^\]\n]{1,999})\]:[ \t]*(<[^>\n]*>|\S+)(.*)$/.exec(line);
    if (!m || m[1].startsWith("^") || /^[ xX]$/.test(m[1]) || !TITLE_OR_EMPTY(m[3])) break;
    const angle = m[2].startsWith("<");
    const col = line.indexOf(m[2], line.indexOf("]:") + 2) + (angle ? 1 : 0);
    scan.links.push({ dest: angle ? m[2].slice(1, -1) : m[2], markdown: true, ...at(lineStart + col) });
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

const TITLE_OR_EMPTY = (rest: string): boolean => titleBetween(rest, 0, rest.length);

/**
 * Whether `s[from, to)` is whitespace and at most one title (`"…"`, `'…'`, `(…)`). Read from both ends, stopping at the first
 * character that decides, so that nested destinations whose `)` is far away are not each read to the end (§6.2).
 */
function titleBetween(s: string, from: number, to: number): boolean {
  let p = from;
  while (p < to && isWs(s[p])) p++;
  if (p >= to) return true;
  const open = s[p];
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return false;
  let q = to - 1;
  while (q > p && isWs(s[q])) q--;
  if (q <= p || s[q] !== close) return false;
  for (let i = p + 1; i < q; i++) if (s[i] === close || (open === "(" && s[i] === "(")) return false;
  return true;
}

/** Scan one Markdown file's text (spec 47 §6.1–§6.3). */
export function scanMarkdown(input: string): Scan {
  const text = toLf(stripBom(input));
  const scan: Scan = { links: [], anchors: new Set(), tags: [], frontmatter: null };
  const slugger = new Slugger(scan.anchors);
  const all = text.split("\n");
  let first = 0;
  // The block is parseFrontmatter's (§5.3), one fence for the emitters and this command; its lines are skipped whole.
  const raw = parseFrontmatter(text, { loose: true }).raw;
  if (raw !== null) {
    scan.frontmatter = { raw, firstLine: 2 };
    first = raw.split("\n").length + 2;
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
      const content = withoutClosingRun(atx[2]);
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

/* ------------------------------------------------------------------ */
/* The command: walk, checks, report (spec 47 §4, §5.3, §7, §8)          */
/* ------------------------------------------------------------------ */

export type DocsLevel = "ok" | "warn" | "error";
/** One line of the report — `docs validate --json`'s `checks[]`, keys in this order (spec 47 §4.6). */
export interface DocsCheck {
  id: string;
  level: DocsLevel;
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
  fix: string | null;
}
/** `docs validate --json`, keys in this order (spec 47 §4.6): a tooling contract. */
export interface DocsReport {
  version: string;
  workspace: string;
  fetch: boolean;
  strict: boolean;
  scanned: number;
  checks: DocsCheck[];
  summary: { ok: number; warn: number; error: number };
}

/** A refusal of §4.1: the command's error, on stderr. Quotes nothing beyond what the person typed. */
export class DocsRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsRefusal";
  }
}

export interface DocsOptions {
  /** The workspace directory. */
  root: string;
  version: string;
  fetch: boolean;
  strict: boolean;
  /** `[path]` as typed, or null. */
  limit: string | null;
  /** False: the current directory with no craftar.yaml — the always-on checks only, no policy line (§4.1). */
  configured: boolean;
  /** `--workspace` as typed, for the doctor fix; null when it was not given (§4.4). */
  typedWorkspace: string | null;
  home?: string;
  git?: GitRunner;
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HIDDEN_NAME = (n: number) => `(a file name — not shown) #${n}`;
const CI_COMMAND = /##vso\[|##\[|::/i;
const GENERATED_FIX = "edit the Forge and run craftar sync";

/** Whether a walked path is printed as itself (spec 47 §7): no control or bidirectional character, no CI log command. */
export function nameShown(rel: string): boolean {
  return !TERMINAL_UNSAFE.test(rel) && !CI_COMMAND.test(rel);
}

const isMd = (name: string) => name.endsWith(".md");

/**
 * The files of §4.2, walked with lstat, following no link, one level at a time: each level's entries are asked of `drop` in
 * one call (git's ignore rules, a repos destination), so an ignored tree is never entered and nothing inside it is named.
 * Each link met and each unreadable directory is a scope warn.
 */
async function walk(
  root: string,
  drop: (rels: string[]) => Promise<Set<string>>,
): Promise<{ files: string[]; scope: Array<{ rel: string; what: "link" | "unreadable" }> }> {
  const files: string[] = [];
  const scope: Array<{ rel: string; what: "link" | "unreadable" }> = [];
  const read = async (rel: string): Promise<Dirent[] | null> => {
    try {
      return await fs.readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      scope.push({ rel: rel === "" ? "." : rel, what: "unreadable" });
      return null;
    }
  };
  const top = (await read("")) ?? [];
  let level: Array<{ rel: string; entry: Dirent }> = top
    .filter((e) => ((e.name === "docs" || e.name === ".claude") && (e.isDirectory() || e.isSymbolicLink())) || (isMd(e.name) && (e.isFile() || e.isSymbolicLink())))
    .map((e) => ({ rel: e.name, entry: e }));
  while (level.length > 0) {
    const dropped = await drop(level.map((x) => x.rel));
    const next: Array<{ rel: string; entry: Dirent }> = [];
    for (const { rel, entry } of level) {
      if (dropped.has(rel)) continue;
      if (entry.isSymbolicLink()) scope.push({ rel, what: "link" });
      else if (entry.isDirectory()) for (const e of (await read(rel)) ?? []) next.push({ rel: `${rel}/${e.name}`, entry: e });
      else if (entry.isFile() && isMd(entry.name)) files.push(rel);
    }
    level = next;
  }
  return { files, scope };
}

type Resolved =
  | { kind: "ok"; rel: string; isDir: boolean }
  | { kind: "missing" }
  | { kind: "case" }
  | { kind: "leaves" }
  | { kind: "link" };

/**
 * Where a workspace path leads (§6.4): lexical `.` and `..`, `climbsOut`, then each segment compared with its directory's
 * listing — never `access`, so the case must match on every platform — and `lstat`ed; a link stops the walk. Nothing
 * outside the workspace is ever asked about.
 */
class Resolver {
  private listings = new Map<string, Promise<Map<string, Dirent> | null>>();
  constructor(private root: string) {}
  private listing(rel: string): Promise<Map<string, Dirent> | null> {
    let p = this.listings.get(rel);
    if (!p) {
      p = fs
        .readdir(path.join(this.root, rel), { withFileTypes: true })
        .then((es) => new Map(es.map((e) => [e.name, e] as const)))
        .catch(() => null);
      this.listings.set(rel, p);
    }
    return p;
  }
  async resolve(fromDir: string, target: string): Promise<Resolved> {
    const anchored = target.startsWith("/");
    const joined = path.posix.normalize(path.posix.join(anchored ? "." : fromDir || ".", target.replace(/^\/+/, "")));
    if (climbsOut(joined) || joined === ".." || joined.startsWith("../")) return { kind: "leaves" };
    const segments = joined.split("/").filter((s) => s !== "" && s !== ".");
    let at = "";
    for (let i = 0; i < segments.length; i++) {
      const list = await this.listing(at || ".");
      if (list === null) return { kind: "missing" };
      const entry = list.get(segments[i]);
      if (!entry) {
        const lower = segments[i].toLowerCase();
        return [...list.keys()].some((k) => k.toLowerCase() === lower) ? { kind: "case" } : { kind: "missing" };
      }
      if (entry.isSymbolicLink()) return { kind: "link" };
      at = at ? `${at}/${segments[i]}` : segments[i];
      if (i < segments.length - 1 && !entry.isDirectory()) return { kind: "missing" };
      if (i === segments.length - 1) return { kind: "ok", rel: at, isDir: entry.isDirectory() };
    }
    return { kind: "ok", rel: "", isDir: true };
  }
}

const FAULT_FINDING: Record<TargetFault, [string, string]> = {
  backslash: ["target holds a backslash", "use / as the separator"],
  nul: ["target holds a NUL character", "remove it from the link"],
  "windows-path": ["target is an absolute Windows path", "link with a path relative to the file"],
  "bad-percent": ["target's percent-encoding does not decode", "correct the encoding in the link"],
};
const RESOLVE_FINDING: Record<Exclude<Resolved["kind"], "ok">, [DocsLevel, string, string]> = {
  missing: ["error", "target does not exist", "correct the link or restore the file"],
  case: ["error", "target's case differs from the file on disk", "match the file name's case exactly"],
  leaves: ["error", "target leaves the workspace", "link to a file inside the workspace"],
  link: ["warn", "target is reached through a symbolic link, not followed", "link to the file itself, not through a link"],
};

interface FileState {
  rel: string;
  index: number;
  scan: Scan | null;
  /** Parsed frontmatter, read only when a check needs it: the value, or the YAML fault, or no block. */
  fm?: { data: unknown } | { fault: { code: string; line: number | null; column: number | null } } | null;
}

/** The frontmatter block read strictly (§5.3): YAML's refusal kept as its code and position, never its message. */
function strictFrontmatter(f: FileState): NonNullable<FileState["fm"]> | null {
  if (f.fm !== undefined) return f.fm;
  const block = f.scan?.frontmatter ?? null;
  if (block === null) return (f.fm = null);
  try {
    f.fm = { data: parseYamlText("frontmatter", block.raw) };
  } catch (e) {
    const m = /^([A-Z_]+)(?: at line (\d+), column (\d+))?$/.exec(e instanceof YamlSyntaxError ? e.fault : "");
    f.fm = {
      fault: {
        code: m ? m[1] : "YAML_ERROR",
        line: m && m[2] ? block.firstLine + Number(m[2]) - 1 : null,
        column: m && m[3] ? Number(m[3]) : null,
      },
    };
  }
  return f.fm;
}

const emptyValue = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

function realDate(y: string, m: string, d: string): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d);
}
const DATED = /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** The `policy` line's words (§4.4): fixed, relaying nothing of the loader. */
export const POLICY = {
  noBlock: "no docs block in this profile",
  notRead: (which: "configuration" | "Forge" | "profile") => `the declared checks did not run: configuration, Forge or profile not read — the ${which}`,
  warned: "the Forge load warned",
  categories: (n: number) => `docs block read: ${n} ${n === 1 ? "category" : "categories"}`,
} as const;

/** `[path]` as a workspace-relative POSIX path (§4.1), `""` for the whole workspace; a refusal quotes only what was typed. */
export async function resolveLimit(root: string, typed: string): Promise<string> {
  const abs = path.resolve(root, typed);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new DocsRefusal(`${typed} is outside the workspace`);
  const posix = rel.split(path.sep).join("/");
  // Resolved as a link is (§7): a symbolic link on the way counts as something, and nothing beyond it is asked about.
  const r = await new Resolver(path.resolve(root)).resolve(".", posix || ".");
  if (r.kind !== "ok" && r.kind !== "link") throw new DocsRefusal(`${typed} names nothing in the workspace`);
  return posix;
}

/** Run every check of spec 47 over one workspace. Reads only: no file, lock, registry entry or cache layout is written. */
export async function validateDocs(opts: DocsOptions): Promise<DocsReport> {
  const root = path.resolve(opts.root);
  const real = await fs.realpath(root).catch(() => root);
  const limit = opts.limit === null ? "" : await resolveLimit(root, opts.limit);
  const checks: DocsCheck[] = [];
  const add = (c: Omit<DocsCheck, "line" | "column" | "path"> & Partial<Pick<DocsCheck, "line" | "column" | "path">>) =>
    checks.push({ id: c.id, level: c.level, path: c.path ?? null, line: c.line ?? null, column: c.column ?? null, message: c.message, fix: c.fix });

  // The Forge, for the block (§4.4); the always-on checks never depend on it.
  let block: DocsBlock | null = null;
  let declared = false;
  let skipDirs: string[] = [];
  if (opts.configured) {
    const dir = opts.typedWorkspace === null ? "" : ` --workspace ${nameShown(opts.typedWorkspace) ? (/\s/.test(opts.typedWorkspace) ? `"${opts.typedWorkspace}"` : opts.typedWorkspace) : "<dir>"}`;
    const doctor = (extra = "") => `run craftar doctor${dir}${extra}`;
    let merged: MergedConfig | null = null;
    try {
      merged = await readWorkspaceConfig(root);
    } catch {
      add({ id: "policy", level: "error", message: POLICY.notRead("configuration"), fix: opts.fetch ? doctor(" --fetch") : doctor() });
    }
    if (merged !== null) {
      const remote = classifyForge(merged.config.forge) === "url";
      let ws: Workspace | null = null;
      try {
        ws = await loadForgeFor(root, merged, { mode: opts.fetch ? "read" : "no-fetch", home: opts.home, git: opts.git });
      } catch {
        add({
          id: "policy",
          level: "error",
          message: POLICY.notRead("Forge"),
          fix: opts.fetch ? doctor(" --fetch") : remote ? `${doctor()}; with no cached copy, run again with --fetch` : doctor(),
        });
      }
      const profile = ws?.forge.profiles.get(ws.config.profile);
      if (ws && !profile) add({ id: "policy", level: "error", message: POLICY.notRead("profile"), fix: opts.fetch ? doctor(" --fetch") : doctor() });
      if (ws && profile) {
        const o = ws.origin;
        const failedFetch = o.kind === "remote" && opts.fetch && !o.fetched && ws.warnings.some((x) => x.startsWith(`Forge ${o.source} not fetched (`));
        if (ws.warnings.length > 0) add({ id: "policy", level: "warn", message: POLICY.warned, fix: failedFetch ? doctor(" --fetch") : doctor() });
        try {
          skipDirs = profileRepos(profile).map((r) => r.path.replace(/\/+$/, ""));
        } catch {
          skipDirs = [];
        }
        try {
          block = declaredDocs(profile);
          declared = true;
          add({ id: "policy", level: "ok", message: block === null ? POLICY.noBlock : POLICY.categories(block.categories.length), fix: null });
        } catch (e) {
          add({ id: "policy", level: "error", message: e instanceof DocsBlockError ? e.message : "docs block: docs — does not read", fix: "correct the docs block in the profile" });
        }
      }
    }
  }

  // The walk (§4.2).
  // A destination is compared without case on Windows, where the disk folds it.
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const inRepo = await gitIsRepo(root);
  let unchecked = !inRepo;
  const walked = await walk(root, async (rels) => {
    const out = new Set(rels.filter((f) => skipDirs.some((d) => d !== "" && (fold(f) === fold(d) || fold(f).startsWith(`${fold(d)}/`)))));
    if (!inRepo) return out;
    const answer = await ignoredPaths(root, rels.filter((r) => !out.has(r)));
    if (answer.unchecked) unchecked = true;
    for (const i of answer.ignored) out.add(i.path);
    return out;
  });
  for (const s of walked.scope) {
    if (s.what === "link") add({ id: "scope", level: "warn", path: s.rel, message: "symbolic link not followed: not scanned", fix: "link to real files, or ignore it in git" });
    else add({ id: "scope", level: "warn", path: s.rel === "." ? null : s.rel, message: "directory cannot be read: not scanned", fix: "check its permissions" });
  }
  if (unchecked)
    add({
      id: "scope",
      level: "warn",
      message: "git could not say which files it ignores: every file was scanned",
      fix: inRepo ? "check that git runs here; a scanned private file is named, never printed" : "run in a git repository with git on PATH; a scanned private file is named, never printed",
    });
  const files = [...walked.files];
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const state = new Map<string, FileState>();
  let scanned = 0;
  for (const [index, rel] of files.entries()) {
    const f: FileState = { rel, index, scan: null };
    state.set(rel, f);
    let bytes: Buffer;
    try {
      const st = await fs.lstat(path.join(root, rel));
      if (st.size > MAX_FILE_BYTES) {
        add({ id: "encoding", level: "warn", path: rel, message: "over 8 MiB: not scanned", fix: "split the file" });
        continue;
      }
      bytes = await fs.readFile(path.join(root, rel));
    } catch {
      add({ id: "scope", level: "warn", path: rel, message: "file cannot be read: not scanned", fix: "check its permissions" });
      continue;
    }
    const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
    if (utf16 || !isUtf8(bytes)) {
      add({ id: "encoding", level: "warn", path: rel, message: "not valid UTF-8: not scanned", fix: "save the file as UTF-8" });
      continue;
    }
    f.scan = scanMarkdown(bytes.toString("utf8"));
    scanned++;
  }

  // Always-on: links and leaked tags.
  const resolver = new Resolver(root);
  let linkCount = 0;
  for (const f of state.values()) {
    if (!f.scan) continue;
    for (const t of f.scan.tags)
      add({ id: "leaked-tags", level: "error", path: f.rel, line: t.line, column: t.column, message: `tool-call tag outside code (${t.name})`, fix: "remove the leaked tag, or quote it in a code span" });
    for (const l of f.scan.links) {
      const t = readTarget(l.dest, l.markdown);
      if (t.kind === "external" || t.kind === "unchecked") continue;
      linkCount++;
      const at = { path: f.rel, line: l.line, column: l.column };
      if (t.kind === "fault") {
        const [message, fix] = FAULT_FINDING[t.fault];
        add({ id: "links", level: "error", ...at, message, fix });
        continue;
      }
      let targetRel = f.rel;
      if (t.path !== "") {
        const r = await resolver.resolve(path.posix.dirname(f.rel), t.path);
        if (r.kind !== "ok") {
          const [level, message, fix] = RESOLVE_FINDING[r.kind];
          add({ id: "links", level, ...at, message, fix });
          continue;
        }
        targetRel = r.rel;
      }
      if (t.fragment === "" || (t.fragment === null && !t.badFragment)) continue;
      const target = state.get(targetRel);
      // A fragment is checked only against a scanned Markdown file; an encoding-skipped one has its own line (§4.3).
      if (!target?.scan) continue;
      if (t.badFragment) add({ id: "links", level: "warn", ...at, message: "fragment's percent-encoding does not decode", fix: "correct the encoding of the fragment" });
      else if (!target.scan.anchors.has(t.fragment!)) add({ id: "links", level: "warn", ...at, message: "fragment not found in the target", fix: "correct the fragment or the heading" });
    }
  }

  // Declared (§5.3).
  if (declared && block !== null) await declaredChecks(block, state, resolver, add);

  // `[path]` limits the findings about a file; a `path: null` one always counts (§4.1).
  const inLimit = (p: string | null) => p === null || limit === "" || p === limit || p.startsWith(`${limit}/`);
  let kept = checks.filter((c) => inLimit(c.path));

  // A generated file's fix is the Forge's (§8).
  let recorded = new Set<string>();
  try {
    recorded = new Set((await readLock(root))?.files.map((e) => e.path) ?? []);
  } catch {
    recorded = new Set();
  }
  kept = kept.map((c) => (c.path !== null && c.id !== "scope" && recorded.has(c.path) && c.level !== "ok" ? { ...c, fix: GENERATED_FIX } : c));

  // One ok for a check that has nothing to report (§4.3).
  const has = (id: string) => kept.some((c) => c.id === id);
  if (!has("links")) kept.push({ id: "links", level: "ok", path: null, line: null, column: null, message: `${linkCount} ${linkCount === 1 ? "link" : "links"} in ${filesWord(scanned)}`, fix: null });
  if (!has("leaked-tags")) kept.push({ id: "leaked-tags", level: "ok", path: null, line: null, column: null, message: filesWord(scanned), fix: null });
  if (declared && block !== null) {
    const on: Array<[string, boolean]> = [
      ["categories", true],
      ["frontmatter", block.categories.some((c) => c.frontmatter.length > 0)],
      ["names", block.categories.some((c) => c.name === "dated")],
      ["related", block.related !== "off"],
    ];
    for (const [id, active] of on) if (active && !has(id)) kept.push({ id, level: "ok", path: null, line: null, column: null, message: "nothing to report", fix: null });
  }

  // Sorted by the file's place in the walk, then line and column; lines with no path last, in their order (§4.6).
  // Every path the walk met — files, ignored or not, and the links and directories it did not enter — sorted once (§7).
  const met = [...new Set([...walked.files, ...walked.scope.map((x) => x.rel)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const place = new Map(met.map((p, i) => [p, i] as const));
  const order = (c: DocsCheck) => (c.path === null ? met.length + 1 + ID_ORDER.indexOf(c.id) : place.get(c.path) ?? met.length);
  const indexed = kept.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => order(a.c) - order(b.c) || (a.c.path === b.c.path ? (a.c.line ?? 0) - (b.c.line ?? 0) || (a.c.column ?? 0) - (b.c.column ?? 0) : cmp(a.c.path, b.c.path)) || a.i - b.i);
  const ordered = indexed.map(({ c }) => c);

  // A name not shown is replaced whole by its label, numbered by its place in the sorted walk (§7).
  const labelled = ordered.map((c) => (c.path !== null && !nameShown(c.path) ? { ...c, path: HIDDEN_NAME((place.get(c.path) ?? met.length) + 1) } : c));

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const c of labelled) summary[c.level]++;
  return { version: opts.version, workspace: real, fetch: opts.fetch, strict: opts.strict, scanned, checks: labelled, summary };
}

const filesWord = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** The order of the lines with no path, after every finding on a file (§4.6). */
const ID_ORDER = ["links", "leaked-tags", "encoding", "scope", "policy", "categories", "frontmatter", "names", "related"];
const cmp = (a: string | null, b: string | null) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);

async function declaredChecks(
  block: DocsBlock,
  state: Map<string, FileState>,
  resolver: Resolver,
  add: (c: Omit<DocsCheck, "line" | "column" | "path"> & Partial<Pick<DocsCheck, "line" | "column" | "path">>) => void,
): Promise<void> {
  // A declared directory that is not there: by position, with no path (§5.3).
  // Resolved as a link is (§7): a symbolic link on the way stops it, so nothing outside the workspace is asked about.
  for (const [i, c] of block.categories.entries()) {
    const r = await resolver.resolve(".", `docs/${c.path}`);
    if (r.kind !== "ok" || !r.isDir) add({ id: "categories", level: "error", message: `categories[${i}]: no such directory under docs/`, fix: "create the directory, or remove the entry from the docs block" });
  }
  const covering = (sub: string) =>
    block.categories.filter((c) => sub.startsWith(`${c.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;

  const yamlReported = new Set<string>();
  const yamlFinding = (f: FileState, id: string): boolean => {
    const fm = strictFrontmatter(f);
    if (fm === null || !("fault" in fm)) return false;
    if (!yamlReported.has(f.rel)) {
      yamlReported.add(f.rel);
      add({ id, level: "error", path: f.rel, line: fm.fault.line, column: fm.fault.column, message: `frontmatter is not valid YAML (${fm.fault.code})`, fix: "correct the frontmatter block" });
    }
    return true;
  };

  for (const f of state.values()) {
    if (!f.rel.startsWith("docs/")) continue;
    const sub = f.rel.slice("docs/".length);
    const base = path.posix.basename(f.rel);
    const category = covering(sub);
    if (category === null) {
      if (block.uncovered === "error")
        add({ id: "categories", level: "error", path: f.rel, message: "file is in no declared category", fix: "move it into a category, or declare its directory in the docs block" });
      continue;
    }
    if (base === "README.md") continue;
    if (category.name === "dated") {
      const m = DATED.exec(base);
      if (!m || !realDate(m[1], m[2], m[3])) add({ id: "names", level: "error", path: f.rel, message: "file name does not fit dated (YYYY-MM-DD-<kebab-case>.md, a real date)", fix: "rename the file" });
    }
    if (category.frontmatter.length === 0 || !f.scan) continue;
    const fm = strictFrontmatter(f);
    if (fm === null) {
      add({ id: "frontmatter", level: "error", path: f.rel, message: "no frontmatter block", fix: `add a frontmatter block with ${category.frontmatter.join(", ")}` });
      continue;
    }
    if (yamlFinding(f, "frontmatter")) continue;
    const data = (fm as { data: unknown }).data;
    const record = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    for (const key of category.frontmatter)
      if (!Object.hasOwn(record, key) || emptyValue(record[key])) add({ id: "frontmatter", level: "error", path: f.rel, message: `required frontmatter key ${key} is missing or empty`, fix: `give ${key} a value` });
  }

  if (block.related === "off") return;
  /** A file's `related:` entries resolved from its own directory; null when it has none to read. */
  const relatedOf = async (f: FileState, report: boolean): Promise<Map<string, number> | null> => {
    if (!f.scan?.frontmatter) return null;
    const fm = strictFrontmatter(f);
    if (fm === null) return null;
    if ("fault" in fm) {
      if (report) yamlFinding(f, "related");
      return null;
    }
    const data = fm.data;
    if (data === null || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "related")) return null;
    const list = (data as Record<string, unknown>).related;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
      if (report) add({ id: "related", level: "error", path: f.rel, message: "related: is not a list of strings", fix: "write related: as a list of paths" });
      return null;
    }
    const out = new Map<string, number>();
    for (const [j, entry] of (list as string[]).entries()) {
      const fail = (message: string, fix: string, level: DocsLevel = "error") => report && add({ id: "related", level, path: f.rel, message: `related[${j}]: ${message}`, fix });
      if (entry === "" || entry.includes("\0")) {
        fail("empty, or holds a NUL character", "remove the entry or name a file");
        continue;
      }
      if (WINDOWS_PATH.test(entry)) {
        fail("an absolute Windows path", "use a path relative to the file");
        continue;
      }
      if (SCHEME.test(entry) || entry.startsWith("//")) {
        fail("has a scheme: related: names files of the workspace", "name a file of the workspace");
        continue;
      }
      if (entry.includes("\\")) {
        fail("holds a backslash", "use / as the separator");
        continue;
      }
      const r = await resolver.resolve(path.posix.dirname(f.rel), entry);
      if (r.kind !== "ok") {
        const [level, message, fix] = RESOLVE_FINDING[r.kind];
        fail(message.replace(/^target/, "the entry"), fix.replace(/^correct the link/, "correct the entry").replace(/^link to/, "name"), level);
        continue;
      }
      if (!out.has(r.rel)) out.set(r.rel, j);
    }
    return out;
  };

  const cache = new Map<string, Map<string, number> | null>();
  for (const f of state.values()) {
    if (!f.rel.startsWith("docs/")) continue;
    const mine = await relatedOf(f, true);
    cache.set(f.rel, mine);
    if (mine === null || block.related !== "symmetric") continue;
    for (const [target, j] of mine) {
      const t = state.get(target);
      // Only a scanned Markdown file under docs/ can list anything back (§5.3).
      if (!t?.scan || !target.startsWith("docs/") || target === f.rel) continue;
      if (!cache.has(target)) cache.set(target, await relatedOf(t, false));
      if (!cache.get(target)?.has(f.rel))
        add({ id: "related", level: "error", path: f.rel, message: `related[${j}]: the target does not list this file back`, fix: "add this file to the target's related:" });
    }
  }
}
