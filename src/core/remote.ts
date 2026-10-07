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

/* ------------------------------------------------------------------ */
/* Resolving a ref (spec 13 §6.2)                                       */
/* ------------------------------------------------------------------ */

/** The refs `git ls-remote --symref` lists: the branch HEAD points to, every branch, every tag (peeled). */
export interface LsRemote {
  head: string | null;
  heads: Map<string, string>;
  tags: Map<string, string>;
}

export function parseLsRemote(stdout: string): LsRemote {
  const out: LsRemote = { head: null, heads: new Map(), tags: new Map() };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line);
    if (symref) {
      out.head = symref[1];
      continue;
    }
    const [sha, name] = line.split("\t");
    if (!sha || !name) continue;
    if (name.startsWith("refs/heads/")) out.heads.set(name.slice("refs/heads/".length), sha);
    else if (name.startsWith("refs/tags/")) {
      const tag = name.slice("refs/tags/".length);
      // An annotated tag's object comes first; its `^{}` line is the commit, which wins.
      if (tag.endsWith("^{}")) out.tags.set(tag.slice(0, -3), sha);
      else if (!out.tags.has(tag)) out.tags.set(tag, sha);
    }
  }
  return out;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit a requested ref names, in the order of spec 13 §6.2. A full SHA is returned as is: the
 * caller checks it exists once the fetch has run. Abbreviated SHAs are refused on purpose — their
 * meaning changes as the repository grows.
 */
export function resolveRef(refs: LsRemote, ref: string | null, url: string): { commit: string; defaultBranch: string | null } {
  if (ref === null) {
    const branch = refs.head;
    const commit = branch === null ? undefined : refs.heads.get(branch);
    if (branch === null || commit === undefined) throw new Error(`${url} has no default branch to follow — set ref in craftar.yaml`);
    return { commit, defaultBranch: branch };
  }
  if (FULL_SHA.test(ref)) return { commit: ref, defaultBranch: null };
  const qualified = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
  if (qualified) {
    const commit = (qualified[1] === "heads" ? refs.heads : refs.tags).get(qualified[2]);
    if (commit === undefined) throw new Error(`ref "${ref}" not found in ${url}`);
    return { commit, defaultBranch: null };
  }
  const branch = refs.heads.get(ref);
  const tag = refs.tags.get(ref);
  if (branch !== undefined && tag !== undefined)
    throw new Error(`ref "${ref}" is both a branch and a tag in ${url} — write refs/heads/${ref} or refs/tags/${ref}`);
  const commit = branch ?? tag;
  if (commit === undefined) throw new Error(`ref "${ref}" not found in ${url}`);
  return { commit, defaultBranch: null };
}
