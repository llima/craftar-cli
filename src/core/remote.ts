import { hashNormalized } from "./text.js";

/* ------------------------------------------------------------------ */
/* What counts as a URL, and credentials (spec 13 §6.1, §4.3)          */
/* ------------------------------------------------------------------ */

const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** The SCP-like form `<user>@<host>:<path>`; without a user, `host:path` stays a path (a drive letter looks the same). */
const SCP_URL = /^[^\s/\\:@]+@[^\s/\\:]+:/;

/** A `forge:` value is a git URL (a remote Forge) or a path resolved from the workspace root. */
export function classifyForge(value: string): "url" | "path" {
  return SCHEME_URL.test(value) || SCP_URL.test(value) ? "url" : "path";
}

/**
 * True when a `forge:` value carries a credential: a user or password in an `http(s)` URL, a password
 * in any other scheme, or a `<x>:<y>@` before the first `/` or `\` whatever the value reads as — so a
 * password never reaches a message that prints the value (spec 13 §6.1, §14 item 11).
 */
export function credentialFault(value: string): boolean {
  const head = value.split(/[/\\]/, 1)[0];
  if (/^[^@]*:[^@]*@/.test(head) && !SCHEME_URL.test(value)) return true;
  if (!SCHEME_URL.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (/^https?:$/i.test(url.protocol)) return url.username !== "" || url.password !== "";
  return url.password !== "";
}

/* ------------------------------------------------------------------ */
/* The cache key (spec 13 §6.3)                                         */
/* ------------------------------------------------------------------ */

/** Scheme and host lowercased; a trailing `/`, then `.git`, dropped. */
function normalizeUrl(url: string): string {
  let u = url.trim();
  const scheme = SCHEME_URL.exec(u);
  if (scheme) {
    const rest = u.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    u = scheme[0].toLowerCase() + host.toLowerCase() + (slash === -1 ? "" : rest.slice(slash));
  } else {
    const at = u.indexOf("@");
    const colon = u.indexOf(":", at);
    if (at !== -1 && colon !== -1) u = u.slice(0, at + 1) + u.slice(at + 1, colon).toLowerCase() + u.slice(colon);
  }
  u = u.replace(/\/+$/, "");
  return u.replace(/\.git$/, "");
}

/** `<readable slug of host and path>-<first 12 hex of sha256(normalized url)>`. The URL holds no credentials (§4.3). */
export function cacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  // The one hash helper (node-cli rule), though a URL has no line endings to normalize.
  const hash = hashNormalized(normalized).slice("sha256:".length, "sha256:".length + 12);
  const withoutScheme = normalized.replace(SCHEME_URL, "").replace(/^[^@/]*@/, "");
  const slug = withoutScheme
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug}-${hash}`;
}
