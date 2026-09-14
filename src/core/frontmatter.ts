import YAML from "yaml";
import { toLf, stripBom } from "./text.js";

export interface Parsed<T = Record<string, unknown>> {
  data: T;
  /** Body without the frontmatter block; LF-normalized; leading blank line after `---` removed. */
  body: string;
  /** Raw frontmatter text between the fences (LF), or null when absent. */
  raw: string | null;
}

const FENCE = /^---\n([\s\S]*?)\n---\n?/;

/** Parse a YAML frontmatter block at the very start of a markdown document. */
export function parseFrontmatter<T = Record<string, unknown>>(input: string, opts: { loose?: boolean } = {}): Parsed<T> {
  const text = toLf(stripBom(input));
  const m = FENCE.exec(text);
  if (!m) return { data: {} as T, body: text, raw: null };
  let data: T;
  if (opts.loose) return { data: looseParse(m[1]) as T, body: text.slice(m[0].length), raw: m[1] };
  try {
    data = (YAML.parse(m[1]) ?? {}) as T;
  } catch {
    // Claude Code frontmatter is often "loose" (unquoted colons, commas). Fall back to line parsing.
    data = looseParse(m[1]) as T;
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

/** Line-based `key: value` parser for frontmatter YAML would reject (e.g. "tools: Read, Grep"). */
export function looseParse(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (m) {
      lastKey = m[1];
      out[lastKey] = m[2];
    } else if (lastKey && /^\s+\S/.test(line)) {
      out[lastKey] = (out[lastKey] + "\n" + line.trim()).trim();
    }
  }
  return out;
}

/** Serialize frontmatter + body. Values are emitted verbatim (no quoting) to round-trip Claude Code files byte-for-byte. */
export function serializeFrontmatter(data: Record<string, unknown>, body: string, opts: { raw?: string | null } = {}): string {
  if (opts.raw != null) return `---\n${opts.raw}\n---\n${body}`;
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
