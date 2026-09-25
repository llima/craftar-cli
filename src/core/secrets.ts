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
 * Text to run the secret scan over, from raw bytes. A UTF-16 BOM is sniffed first and the
 * bytes decoded with the matching encoding — UTF-16 text is full of NUL bytes and would
 * otherwise be taken for binary. Without a BOM, a NUL byte marks the content binary (null);
 * anything else is read as UTF-8. Used for scanning only: it never changes what is stored.
 */
export function decodeForScan(bytes: Buffer): string | null {
  if (hasUtf16Bom(bytes)) {
    const body = bytes.subarray(2, bytes.length - (bytes.length % 2));
    if (bytes[0] === 0xff) return body.toString("utf16le");
    const swapped = Buffer.from(body);
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.includes(0) ? null : bytes.toString("utf8");
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
