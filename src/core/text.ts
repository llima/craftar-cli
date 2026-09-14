import { createHash } from "node:crypto";


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
 */
export function hashNormalized(content: string | Buffer): string {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  return "sha256:" + createHash("sha256").update(toLf(stripBom(text)), "utf8").digest("hex");
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
