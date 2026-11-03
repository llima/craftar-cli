/**
 * Secret detection for `craftar import` (FM-8: a token must never reach the Forge).
 * Findings carry a kind and a location, never the matched value.
 */
export interface SecretFinding {
  kind: string;
  /** 1-based line within the scanned text. */
  line: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "api-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  // Azure DevOps PATs, both formats. `_` bounds both sides so a run inside a snake_case
  // identifier is not read as a standalone token. The legacy 52-char form must hold a digit,
  // so a 52-letter lowercase run is not flagged. The 84-char form (Azure DevOps release notes,
  // sprint 241) carries the fixed signature `AZDO` at 0-based index 76.
  { kind: "azure-devops-pat", re: /(?<![A-Za-z0-9_])(?=[a-z]*[0-9])[a-z0-9]{52}(?![A-Za-z0-9_])/ },
  { kind: "azure-devops-pat", re: /(?<![A-Za-z0-9_])[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}(?![A-Za-z0-9_])/ },
];

/** Scan text line by line with the known token patterns. */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const hit = PATTERNS.find((p) => p.re.test(line));
    if (hit) out.push({ kind: hit.kind, line: i + 1 });
  });
  return out;
}

/** True when the bytes open with a UTF-16 byte-order mark (`FF FE` little-endian, `FE FF` big-endian). */
export function hasUtf16Bom(bytes: Buffer): boolean {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

/**
 * The byte order of UTF-16 text saved without a BOM, or null (spec E2.2 of the tech-debt list). Text in UTF-16 holds a
 * NUL in one byte of nearly every pair for ASCII, and never a pair of NULs; binary holds NULs anywhere. So the bytes
 * must be an even number, hold no pair of NULs, hold their NULs mostly on one side of the pair (`leads`), and decode to text with no control character but tab, line feed, carriage return and form
 * feed, and no unpaired surrogate. Measured on the first 64 KiB.
 */
function bareUtf16(bytes: Buffer): "le" | "be" | null {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return null;
  const n = Math.min(bytes.length, 65536);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    const a = bytes[i] === 0;
    const b = bytes[i + 1] === 0;
    if (a && b) return null;
    if (a) even++;
    if (b) odd++;
  }
  const pairs = n / 2;
  // One side holds the NULs: at least a third of the pairs, and the other side at most a sixteenth of the pairs and a
  // quarter of this side (a character such as U+3000 or U+4E00 puts its NUL on the other side).
  const leads = (a: number, b: number) => a * 3 >= pairs && b * 16 <= pairs && b * 4 <= a;
  const order = leads(odd, even) ? "le" : leads(even, odd) ? "be" : null;
  if (order === null) return null;
  // Cut short of the last code unit when the measure stops inside the bytes: a surrogate pair may straddle the cut.
  const text = decodeUtf16(bytes.subarray(0, n < bytes.length ? n - 2 : n), order);
  return /[\u0000-\u0008\u000b\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text) ? null : order;
}

function decodeUtf16(body: Buffer, order: "le" | "be"): string {
  if (order === "le") return body.toString("utf16le");
  const swapped = Buffer.from(body);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/** True when the bytes are UTF-16 text: they open with a UTF-16 BOM, or they read as UTF-16 saved without one. */
export function isUtf16Text(bytes: Buffer): boolean {
  return hasUtf16Bom(bytes) || bareUtf16(bytes) !== null;
}

/**
 * Text to run the secret scan over, from raw bytes. A UTF-16 BOM is sniffed first and the
 * bytes decoded with the matching encoding — UTF-16 text is full of NUL bytes and would
 * otherwise be taken for binary; UTF-16 saved without a BOM is recognised by where its NULs sit
 * (`bareUtf16`). Otherwise a NUL byte marks the content binary (null), and anything else is read
 * as UTF-8. Used for scanning only: it never changes what is stored.
 */
export function decodeForScan(bytes: Buffer): string | null {
  if (hasUtf16Bom(bytes)) return decodeUtf16(bytes.subarray(2, bytes.length - (bytes.length % 2)), bytes[0] === 0xff ? "le" : "be");
  if (!bytes.includes(0)) return bytes.toString("utf8");
  const order = bareUtf16(bytes);
  return order === null ? null : decodeUtf16(bytes, order);
}

export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const TOKEN_CHARS = /^[A-Za-z0-9+/=_-]+$/;

/** Entropy rule for a single config value (MCP `env` / `args`); never used on markdown bodies. */
export function looksLikeSecretValue(value: string): boolean {
  if (ENV_REF.test(value)) return false;
  return value.length >= 20 && TOKEN_CHARS.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && shannonEntropy(value) >= 4;
}

/** Kind of secret a config value looks like: a known pattern first, then the entropy rule. */
export function secretValueKind(value: string): string | null {
  const hit = findSecrets(value)[0];
  if (hit) return hit.kind;
  return looksLikeSecretValue(value) ? "high-entropy-value" : null;
}
