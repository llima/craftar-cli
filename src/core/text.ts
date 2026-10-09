import { createHash } from "node:crypto";
import path from "node:path";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Valid UTF-8, BOM included (a BOM is a valid UTF-8 sequence). */
export function isUtf8(bytes: Buffer): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a relative path climbs out of the directory it is joined under (0.17.3): after its `..` segments are
 * resolved, it is `..` or starts with `../`. A backslash counts as a separator, as it is one on Windows, and a
 * leading separator anchors nothing — `path.join(dir, "/../x")` is beside `dir` — so it is dropped first.
 * `./x`, `/x` and `a/../x` do not climb out.
 */
export function climbsOut(rel: string): boolean {
  const n = path.posix.normalize(rel.replace(/\\/g, "/").replace(/^\/+/, ""));
  return n === ".." || n.startsWith("../");
}

/** Strip a leading UTF-8 BOM, if any. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Normalize CRLF and lone CR to LF. */
export function toLf(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Convert LF to CRLF (input is normalized first, so CRLF is never doubled). */
export function toCrlf(s: string): string {
  return toLf(s).replace(/\n/g, "\r\n");
}

/**
 * Content hash that is stable across Windows/Unix checkouts.
 * This is the lesson from the previous generator: hashing raw bytes while git
 * rewrites CRLF on checkout made every managed file look hand-edited.
 *
 * For valid UTF-8 content (strings or buffers), EOL and BOM are normalized so
 * CRLF checkouts on Windows do not read as hand edits.
 *
 * For a buffer that is not valid UTF-8, EOL and a UTF-8 BOM are normalized at
 * byte level (latin1 round-trips every byte), so CRLF checkouts still match —
 * but the invalid bytes are preserved, so é (0xe9) and è (0xe8) hash differently.
 */
export function hashNormalized(content: string | Buffer): string {
  // A string is always valid UTF-8 in JS; normalize and hash.
  if (!Buffer.isBuffer(content)) {
    return "sha256:" + createHash("sha256").update(toLf(stripBom(content)), "utf8").digest("hex");
  }
  // A buffer that is not valid UTF-8: normalize EOL and BOM at byte level, then hash.
  if (!isUtf8(content)) {
    const stripped = hasBom(content) ? content.subarray(3) : content;
    const normalized = Buffer.from(toLf(stripped.toString("latin1")), "latin1");
    return "sha256:" + createHash("sha256").update(normalized).digest("hex");
  }
  // A valid UTF-8 buffer: decode, normalize, hash — exactly as before.
  const text = content.toString("utf8");
  return "sha256:" + createHash("sha256").update(toLf(stripBom(text)), "utf8").digest("hex");
}

/**
 * The pre-0.17.4 hash formula: decodes every buffer as UTF-8 (invalid bytes become U+FFFD),
 * normalizes EOL and BOM, then hashes. This exists only to recognise a lock entry written
 * before 0.17.4 for a file that is not valid UTF-8 — it is never written.
 */
export function legacyHash(bytes: Buffer): string {
  return "sha256:" + createHash("sha256").update(toLf(stripBom(bytes.toString("utf8"))), "utf8").digest("hex");
}

export type Eol = "lf" | "crlf";

export function detectEol(s: string): Eol {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "crlf" : "lf";
}

export function withEol(s: string, eol: Eol): string {
  return eol === "crlf" ? toCrlf(s) : toLf(s);
}

export function hasBom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}
