import type { HunkSuggestion } from "../schema/index.js";
import { lcsOps, type Hunk } from "./diff.js";

/**
 * Suggests a class for one hunk (spec 08 §6): `evolution` (one side is a newer text), `value`
 * (a short client token swapped inside shared prose) or `block` (lines only one side has).
 * Pure and deterministic. A suggestion never decides anything; `forge unify` still asks.
 */

export type ClassifiedHunk = Hunk & { suggestion: HunkSuggestion };

/** A token longer than this is not a client identifier (spec 08 §6.2). */
const MAX_TOKEN_CHARS = 40;
/** Bounds the O(n·m) token LCS; no real rule line comes near it. */
const MAX_LINE_TOKENS = 400;
/** Integers this short are step numbers and list markers, not client data. */
const NUMBERING = /^[0-9]{1,2}$/;

const TOKEN = /\s+|[\p{L}\p{N}_@-]+(?:[./:]+[\p{L}\p{N}_@-]+)*|\S/gu;
const WORD = /^[\p{L}\p{N}_@-]+(?:[./:]+[\p{L}\p{N}_@-]+)*$/u;
const WHITESPACE = /^\s+$/;

/** A line split into whitespace runs, words (which may hold `.`, `/`, `:` between word characters) and single other characters. */
export function tokenize(line: string): string[] {
  return line.match(TOKEN) ?? [];
}

/** A word short enough, not a step number, and shaped like a name, path, version or port (spec 08 §6.2). */
export function isIdentifierLike(token: string): boolean {
  if (!WORD.test(token) || token.length > MAX_TOKEN_CHARS || NUMBERING.test(token)) return false;
  return /[-./@:]/.test(token) || /[0-9]/.test(token) || /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(token) || /\p{Ll}\p{Lu}/u.test(token);
}

/** `param.<slug>` of a token's base-side text; `_`-separated because `substitute` keys are `[A-Za-z0-9_.]` (spec 08 §6.4). */
export function paramSlug(text: string): string {
  let slug = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  slug = slug.slice(0, MAX_TOKEN_CHARS).replace(/_+$/, "");
  return `param.${slug || "value"}`;
}

const evolution = (reason: string): HunkSuggestion => ({ class: "evolution", reason });

interface Region {
  a: string[];
  b: string[];
}

/** One side of a changed region: its raw tokens and its character span in the line. */
export interface RegionSide {
  tokens: string[];
  start: number;
  end: number;
}

/** A maximal run of changed tokens between two lines, with where it sits on each side (spec 09 §6.1). */
export interface ChangedRegion {
  a: RegionSide;
  b: RegionSide;
}

/** Maximal runs of changed tokens between two tokenized lines; whitespace runs compare equal whatever their length. */
function spannedRegions(a: string[], b: string[]): ChangedRegion[] {
  const key = (t: string) => (WHITESPACE.test(t) ? " " : t);
  const out: ChangedRegion[] = [];
  let current: ChangedRegion | null = null;
  let i = 0;
  let j = 0;
  let ai = 0; // character offset of a[i]
  let bj = 0; // character offset of b[j]
  for (const op of lcsOps(a.map(key), b.map(key))) {
    if (op.kind === "same") {
      current = null;
      ai += a[i++].length;
      bj += b[j++].length;
      continue;
    }
    if (!current) out.push((current = { a: { tokens: [], start: ai, end: ai }, b: { tokens: [], start: bj, end: bj } }));
    if (op.kind === "del") {
      current.a.tokens.push(a[i]);
      ai += a[i++].length;
      current.a.end = ai;
    } else {
      current.b.tokens.push(b[j]);
      bj += b[j++].length;
      current.b.end = bj;
    }
  }
  return out;
}

/** The changed regions of one line pair, with their spans (the shape `classifyHunk` reasons about). */
export function changedRegions(aLine: string, bLine: string): ChangedRegion[] {
  return spannedRegions(tokenize(aLine), tokenize(bLine));
}

function regions(a: string[], b: string[]): Region[] {
  return spannedRegions(a, b).map((r) => ({ a: r.a.tokens, b: r.b.tokens }));
}

const text = (tokens: string[]) => tokens.join("").replace(/\s+/g, " ").trim();
const words = (tokens: string[]) => tokens.filter((t) => !WHITESPACE.test(t));

export function classifyHunk(h: Hunk): HunkSuggestion {
  // 1. Drop equal lines at both ends: the context line `forceTrailingHunk` adds, nothing else.
  let a = h.a.lines;
  let b = h.b.lines;
  while (a.length && b.length && a[0] === b[0]) [a, b] = [a.slice(1), b.slice(1)];
  while (a.length && b.length && a[a.length - 1] === b[b.length - 1]) [a, b] = [a.slice(0, -1), b.slice(0, -1)];

  if (!a.length && !b.length) return evolution("final newline only");
  if (!a.length) return { class: "block", reason: "only in the variant" };
  if (!b.length) return { class: "block", reason: "only in the base" };
  if (Boolean(h.a.noEofNewline) !== Boolean(h.b.noEofNewline)) return evolution("final newline differs");
  if (a.length !== b.length) return evolution("line counts differ");

  const changed: Array<{ a: string; b: string }> = [];
  for (let k = 0; k < a.length; k++) {
    const ta = tokenize(a[k]);
    const tb = tokenize(b[k]);
    if (ta.length > MAX_LINE_TOKENS || tb.length > MAX_LINE_TOKENS) return evolution("line too long to compare");
    for (const r of regions(ta, tb)) {
      const wa = words(r.a);
      const wb = words(r.b);
      if (!wa.length && !wb.length) continue; // whitespace only
      if (!wa.length || !wb.length) return evolution("words added or removed");
      const odd = [...wa, ...wb].filter((t) => !isIdentifierLike(t));
      if (odd.length) return evolution(odd.every((t) => NUMBERING.test(t)) ? "numbering differs" : "prose differs");
      changed.push({ a: text(r.a), b: text(r.b) });
    }
  }
  if (!changed.length) return evolution("whitespace only");

  const seen = new Set<string>();
  const used = new Set<string>();
  const tokens: NonNullable<HunkSuggestion["tokens"]> = [];
  for (const c of changed) {
    const id = JSON.stringify([c.a, c.b]);
    if (seen.has(id)) continue;
    seen.add(id);
    // A suffixed name can equal another token's natural slug (`acme_api` → `_2` vs `acme_api_2`),
    // so the suffix grows until the name is free: every distinct pair gets its own parameter.
    const slug = paramSlug(c.a);
    let param = slug;
    for (let n = 2; used.has(param); n++) param = `${slug}_${n}`;
    used.add(param);
    tokens.push({ a: c.a, b: c.b, param });
  }
  return { class: "value", reason: tokens.length === 1 ? "1 token differs" : `${tokens.length} tokens differ`, tokens };
}
