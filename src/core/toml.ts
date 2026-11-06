/**
 * The one TOML writer (spec 61 §8, slice 2). craftar writes TOML — Codex's `.codex/agents/<name>.toml` — and never reads a user's,
 * so this covers only the shapes needed: a basic string, a multi-line basic string, an array of strings and one flat table of them
 * (TOML 1.0). Text is built with LF; the caller's `textFile` applies the file's own line ending. No dependency.
 */

/** A control character TOML does not allow raw in a basic string: U+0000–U+001F and U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/g;

const SHORT_ESCAPES: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

const unicodeEscape = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** A basic string, `"…"`: backslash and quote escaped, every control character escaped. */
export function tomlString(value: string): string {
  const body = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(CONTROL, (ch) => SHORT_ESCAPES[ch] ?? unicodeEscape(ch));
  return `"${body}"`;
}

/**
 * A multi-line basic string. It opens with `"""` and a line feed, which a reader trims, so the value starts on the next line; line
 * feeds and tabs stay literal, every other control character — a carriage return included, so CRLF in the value is kept as written —
 * is escaped, every backslash is escaped (so a line ending in one is no line continuation), every quote in a run of three or more is
 * escaped, and a quote just before the closing `"""` is escaped so the delimiter is not read early.
 */
export function tomlMultiline(value: string): string {
  let body = value
    .replace(/\\/g, "\\\\")
    .replace(CONTROL, (ch) => (ch === "\n" || ch === "\t" ? ch : (SHORT_ESCAPES[ch] ?? unicodeEscape(ch))))
    .replace(/"{3,}/g, (run) => run.replace(/"/g, '\\"'));
  // A trailing run shorter than three was left raw; escape its last quote so it does not run into the closing delimiter.
  const trailing = /"*$/.exec(value)![0].length;
  if (trailing > 0 && trailing < 3) body = `${body.slice(0, -1)}\\"`;
  return `"""\n${body}"""`;
}

/** A key: bare when it is letters, digits, `_` and `-`; quoted otherwise. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A value of a flat table: a string, an array of strings, or a string written in the multi-line form. */
export type TomlValue = string | readonly string[] | { multiline: string };

/** One flat table, keys in the order given, LF, ending in a newline. A key given twice is refused. */
export function tomlDocument(entries: ReadonlyArray<readonly [string, TomlValue]>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (seen.has(key)) throw new Error(`internal: TOML key ${key} is given twice`);
    seen.add(key);
    const text =
      typeof value === "string"
        ? tomlString(value)
        : "multiline" in value
          ? tomlMultiline(value.multiline)
          : `[${(value as readonly string[]).map(tomlString).join(", ")}]`;
    lines.push(`${tomlKey(key)} = ${text}`);
  }
  return lines.map((l) => `${l}\n`).join("");
}
