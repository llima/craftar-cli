import type { Ingredient, PlanParam } from "../schema/index.js";
import { changedRegions } from "./classify.js";
import { TEXT_EXT } from "../emitters/claude-code.js";
import { KIRO_TEXT_EXT } from "../emitters/kiro.js";
import type { Hunk } from "./diff.js";
import { stripBom, toLf } from "./text.js";

/**
 * Parameter extraction (spec 09): turn a `take: param` hunk into a template whose `{{key}}`
 * renders the base's text through the ingredient default and the variant's through the profile.
 * Pure — the Forge-level gates and the YAML edits live in unify.ts.
 */

/** One key the plan extracts: the base's text (the ingredient default) and the variant's (the profile value). */
export interface Extraction {
  key: string;
  default: string;
  value: string;
  sites: { file: string; hunk: number }[];
  /** The base already declared this key and cited `{{key}}` there (spec 09 §6.1, the reuse case). */
  reused: boolean;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Keys `unify` never extracts: a global param an emitter reads directly, or a name `substitute` once resolved to a built-in (P9). */
export function reservedKey(key: string): boolean {
  return key === "kiro.banner" || key in Object.prototype;
}

/**
 * Whether every target that emits `file` reads it through `ctx.text` (P3). A file no target
 * emits is inert and allowed; one a target copies as raw bytes would carry `{{key}}` literally.
 */
export function substitutedFile(meta: Ingredient, file: string): boolean {
  switch (meta.type) {
    case "rule":
    case "agent":
    case "command":
    case "steering":
    case "skill":
      if (meta.type === "skill" && meta.layout === "dir") return KIRO_TEXT_EXT.test(file) && TEXT_EXT.test(file); // both emit skill dirs
      return true;
    case "script":
    case "hook":
      return TEXT_EXT.test(file); // kiro emits neither type
    case "mcp":
      return false;
  }
}

/**
 * Whether any target emits `file` (0.8.2): the body file of a rule, agent, command or steering, `SKILL.md` of a
 * file-layout skill, every file of a dir-layout skill, the listed `files` of a script or hook; nothing for MCP.
 * A file no target emits is never read as the ingredient's body — not for sections, not for {{param}} scans.
 */
export function emittedFile(meta: Ingredient, file: string): boolean {
  switch (meta.type) {
    case "rule":
      return file === (meta.file ?? "rule.md");
    case "agent":
      return file === (meta.file ?? "agent.md");
    case "command":
      return file === (meta.file ?? "command.md");
    case "steering":
      return file === (meta.file ?? "steering.md");
    case "skill":
      if (meta.layout === "file") return file === "SKILL.md";
      return file !== "ingredient.yaml"; // dir layout: every file except ingredient.yaml
    case "script":
    case "hook":
      return meta.files.includes(file);
    case "mcp":
      return false;
  }
}

/** A file read as the ingredient's body: some target emits it and every target that emits it renders it as text. */
export function bodyFile(meta: Ingredient, file: string): boolean {
  return emittedFile(meta, file) && substitutedFile(meta, file);
}

/** `substitute` restricted to `keys`: every other placeholder is left as it is. */
export function substituteKeys(text: string, values: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (m, key: string) => (values.has(key) ? values.get(key)! : m));
}

/** The keys of every `{{…}}` in `text`, in order. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

const normalize = (tokens: string[]) => tokens.join("").replace(/\s+/g, " ").trim();
const hasWord = (tokens: string[]) => tokens.some((t) => !/^\s+$/.test(t));

/**
 * The template lines of one param hunk, and the (key, default, value) pairs it implies.
 * Throws with the P-row's message on anything the plan cannot turn into a parameter.
 */
export function deriveHunk(
  file: string,
  n: number,
  h: Hunk,
  params: PlanParam[] | undefined,
  declared: Ingredient["params"],
): { lines: string[]; pairs: Array<{ key: string; default: string; value: string; reused: boolean }> } {
  const where = `unify plan: "${file}" hunk ${n}`;
  if (!params?.length) throw new Error(`${where} is take: param but names no params`);
  if (h.a.lines.length !== h.b.lines.length) {
    throw new Error(`${where} cannot be a parameter: its lines do not pair (line counts differ) — take base or variant`);
  }
  if (Boolean(h.a.noEofNewline) !== Boolean(h.b.noEofNewline)) {
    throw new Error(`${where} cannot be a parameter: its lines do not pair (the final newline differs) — take base or variant`);
  }
  const byToken = new Map<string, PlanParam>();
  for (const p of params) {
    if (byToken.has(p.token)) throw new Error(`${where} names token "${p.token}" twice`);
    if (reservedKey(p.key)) throw new Error(`${where}: key ${p.key} is reserved`);
    byToken.set(p.token, p);
  }

  const used = new Set<string>();
  const pairs: Array<{ key: string; default: string; value: string; reused: boolean }> = [];
  const lines = h.a.lines.map((aLine, k) => {
    const bLine = h.b.lines[k];
    const regions = changedRegions(aLine, bLine);
    if (!regions.length && aLine !== bLine) {
      throw new Error(`${where}, line ${k + 1}: "${aLine}" → "${bLine}" differs in whitespace only, which a parameter cannot reproduce`);
    }
    let out = aLine;
    const linePairs: typeof pairs = [];
    // Right to left, so earlier spans keep their offsets.
    for (const r of [...regions].reverse()) {
      const token = normalize(r.a.tokens);
      const entry = byToken.get(token);
      if (!entry) {
        if (!hasWord(r.a.tokens) && !hasWord(r.b.tokens)) {
          throw new Error(`${where}, line ${k + 1} differs in whitespace only, which a parameter cannot reproduce`);
        }
        throw new Error(
          `${where}, line ${k + 1}: "${normalize(r.a.tokens)}" → "${normalize(r.b.tokens)}" is not covered by params — a param hunk must turn every difference into a parameter`,
        );
      }
      used.add(token);
      const value = bLine.slice(r.b.start, r.b.end);
      const reuse = new RegExp(`^\\{\\{\\s*${entry.key.replace(/\./g, "\\.")}\\s*\\}\\}$`).test(token);
      if (reuse) {
        const d = declared?.[entry.key]?.default;
        if (d === undefined) throw new Error(`${where}: "${token}" is a placeholder the base does not declare with a default`);
        linePairs.push({ key: entry.key, default: String(d), value, reused: true });
        continue;
      }
      const def = aLine.slice(r.a.start, r.a.end);
      if (/[{}]/.test(def) || /[{}]/.test(value)) throw new Error(`${where}: key ${entry.key} would change which {{…}} placeholders the text holds`);
      linePairs.push({ key: entry.key, default: def, value, reused: false });
      out = out.slice(0, r.a.start) + `{{${entry.key}}}` + out.slice(r.a.end);
    }
    // Whitespace runs compare equal in the word diff, so padding that differs is no region;
    // rendering the line back is what catches it, with a message a human can act on (P6).
    // A reused key keeps `{{key}}` on the base side, so only the value side is rendered here;
    // the file-level `prove` still checks both sides.
    const render = (field: "default" | "value") => substituteKeys(out, new Map(linePairs.map((p) => [p.key, p[field]])));
    if (render("value") !== bLine || (!linePairs.some((p) => p.reused) && render("default") !== aLine)) {
      throw new Error(`${where}, line ${k + 1} differs in whitespace only outside its tokens, which a parameter cannot reproduce`);
    }
    pairs.push(...linePairs);
    return out;
  });
  for (const token of byToken.keys()) {
    if (!used.has(token)) throw new Error(`${where}: "${token}" is not a changed region of this hunk`);
  }
  return { lines, pairs };
}

/** Merge the pairs of every param hunk into one extraction per key; one key, one (default, value) (P8). */
export function collect(extractions: Map<string, Extraction>, file: string, hunk: number, pairs: ReturnType<typeof deriveHunk>["pairs"]): void {
  for (const p of pairs) {
    const prev = extractions.get(p.key);
    if (!prev) {
      extractions.set(p.key, { key: p.key, default: p.default, value: p.value, sites: [{ file, hunk }], reused: p.reused });
      continue;
    }
    if (prev.default !== p.default || prev.value !== p.value) {
      throw new Error(
        `unify plan: key ${p.key} would need two values: "${prev.default}" → "${prev.value}" and "${p.default}" → "${p.value}"`,
      );
    }
    // Reused only when every site is: one literal site means the base gains new text under the key,
    // so the layers above the ingredient default (P15, P16) must be checked like for a new key.
    prev.reused = prev.reused && p.reused;
    if (!prev.sites.some((s) => s.file === file && s.hunk === hunk)) prev.sites.push({ file, hunk });
  }
}

/**
 * The equivalence proof (spec 09 §6.2): the template renders the base's merge through the
 * defaults and the variant's merge through the values, and holds no placeholder the two merges
 * would not hold. Throws P20 / P7 naming the file.
 */
export function prove(file: string, template: string, mBase: string, mVar: string, extractions: Extraction[]): void {
  const n = (x: string) => toLf(stripBom(x));
  const defaults = new Map(extractions.map((e) => [e.key, e.default]));
  const values = new Map(extractions.map((e) => [e.key, e.value]));
  if (n(substituteKeys(template, defaults)) !== n(substituteKeys(mBase, defaults))) {
    throw new Error(`unify: extracting ${[...defaults.keys()].join(", ")} would not reproduce the base side of "${file}"`);
  }
  if (n(substituteKeys(template, values)) !== n(substituteKeys(mVar, values))) {
    throw new Error(`unify: extracting ${[...values.keys()].join(", ")} would not reproduce the variant side of "${file}"`);
  }
  const keys = new Set(extractions.map((e) => e.key));
  const others = (t: string) => placeholders(n(t)).filter((k) => !keys.has(k));
  const t = others(template);
  if (JSON.stringify(t) !== JSON.stringify(others(mBase)) || JSON.stringify(t) !== JSON.stringify(others(mVar))) {
    throw new Error(`unify: extracting into "${file}" would change which {{…}} placeholders the text holds`);
  }
}
