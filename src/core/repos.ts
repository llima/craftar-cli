/**
 * Reads and validates `profile.repos` — the one reader of that field (spec 37 §5.2).
 * `ProfileSchema.repos` stays open (§13.1 item 15) — this module checks each entry's
 * shape and every cross-entry rule.
 *
 * PURE: no fs, no process, no console.
 */

import type { Profile } from "../schema/index.js";
import { classifyForge, credentialFault } from "./remote.js";
import { findSecrets } from "./secrets.js";
import { climbsOut } from "./text.js";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface RepoEntry {
  name: string;
  url: string;
  path: string;
  ref: string | null;
}

/* ------------------------------------------------------------------ */
/* Validation rules                                                     */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const URL_CHARS_RE = /^[A-Za-z0-9._~:/@+-]+$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;
const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA64_RE = /^[0-9a-f]{64}$/i;
const KEY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const CRAFTAR_RESERVED = new Set(["agents.md", "craftar.yaml", "craftar.local.yaml", "craftar.lock"]);
const KNOWN_KEYS = new Set(["name", "url", "path", "ref"]);

/* ------------------------------------------------------------------ */
/* Error messages (match test constants exactly)                        */
/* ------------------------------------------------------------------ */

const NAME_RULE = `name is not a repository name — letters, digits, ".", "_" and "-", starting with a letter or a digit`;
const URL_CHAR = "url holds a character a git URL here may not — letters, digits and . _ ~ : / @ + -";
const URL_KIND = "url is not an https or ssh git URL";
const URL_CRED = "url holds credentials — remove them and let git authenticate";
const PATH_PLAIN = "path is not a relative path of plain names";
const REF_RULE = "ref is not a branch or tag name";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function refuse(profile: string, index: number, what: string): never {
  throw new Error(`profile ${profile}: repos[${index}]: ${what}`);
}

function isValidNameSegment(s: string): boolean {
  if (!s || !NAME_RE.test(s)) return false;
  if (s.endsWith(".")) return false;
  if (DEVICE_RE.test(s)) return false;
  return true;
}

function isValidPathSegment(s: string): boolean {
  // Same rules as name, plus no ., .., \, :, ~, leading -
  if (!s) return false;
  if (s === "." || s === "..") return false;
  if (s.includes("\\") || s.includes(":") || s.includes("~")) return false;
  if (s.startsWith("-")) return false;
  if (!NAME_RE.test(s)) return false;
  if (s.endsWith(".")) return false;
  if (DEVICE_RE.test(s)) return false;
  return true;
}

/**
 * Checks if one path is a prefix of the other (or equal) for collision detection.
 * Both paths are already lower-cased.
 */
function pathsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  // Check if one is a prefix of the other followed by /
  if (a.startsWith(b + "/") || b.startsWith(a + "/")) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* URL validation helpers                                               */
/* ------------------------------------------------------------------ */

function startsWithLetterOrDigit(s: string): boolean {
  if (!s) return false;
  const c = s[0];
  return /[A-Za-z0-9]/.test(c);
}

function extractHostAfterLastAt(authorityOrPrefix: string): string {
  const atIndex = authorityOrPrefix.lastIndexOf("@");
  return atIndex >= 0 ? authorityOrPrefix.slice(atIndex + 1) : authorityOrPrefix;
}

function validateUrl(url: unknown, profile: string, index: number): void {
  // Missing
  if (url === undefined) {
    refuse(profile, index, "url is missing");
  }

  // Not a string
  if (typeof url !== "string") {
    refuse(profile, index, URL_KIND);
  }

  // Character check
  if (!URL_CHARS_RE.test(url)) {
    refuse(profile, index, URL_CHAR);
  }

  // classifyForge check
  if (classifyForge(url) !== "url") {
    refuse(profile, index, URL_KIND);
  }

  // Scheme check (only https or ssh when there's ://)
  const schemeMatch = url.indexOf("://");
  if (schemeMatch >= 0) {
    const scheme = url.slice(0, schemeMatch);
    if (scheme !== "https" && scheme !== "ssh") {
      refuse(profile, index, URL_KIND);
    }
  }

  // Credential check
  if (credentialFault(url)) {
    refuse(profile, index, URL_CRED);
  }

  // "Starts with a letter or digit" checks
  if (schemeMatch >= 0) {
    // Scheme form: check first char after ://, and host's first char
    const afterScheme = url.slice(schemeMatch + 3);
    if (!startsWithLetterOrDigit(afterScheme)) {
      refuse(profile, index, URL_KIND);
    }

    // Authority is up to the next /
    const slashIndex = afterScheme.indexOf("/");
    const authority = slashIndex >= 0 ? afterScheme.slice(0, slashIndex) : afterScheme;
    const host = extractHostAfterLastAt(authority);
    if (!startsWithLetterOrDigit(host)) {
      refuse(profile, index, URL_KIND);
    }
  } else {
    // SCP form: user@host:path — must have a colon
    const colonIndex = url.indexOf(":");
    if (colonIndex < 0) {
      // No colon means classifyForge would have caught it as a path
      refuse(profile, index, URL_KIND);
    }

    // Check URL's first character
    if (!startsWithLetterOrDigit(url)) {
      refuse(profile, index, URL_KIND);
    }

    // Host is the part before the colon, after the last @
    const beforeColon = url.slice(0, colonIndex);
    const host = extractHostAfterLastAt(beforeColon);
    if (!startsWithLetterOrDigit(host)) {
      refuse(profile, index, URL_KIND);
    }

    // Check first character after the colon
    const afterColon = url.slice(colonIndex + 1);
    if (!startsWithLetterOrDigit(afterColon)) {
      refuse(profile, index, URL_KIND);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry validation                                                     */
/* ------------------------------------------------------------------ */

function validateEntry(
  entry: Record<string, unknown>,
  profile: string,
  index: number,
  seenNames: Map<string, number>,
  seenPaths: Map<string, number>,
): RepoEntry {
  // --- name ---
  const name = entry.name;
  if (name === undefined) {
    refuse(profile, index, "name is missing");
  }
  if (typeof name !== "string" || !name || !NAME_RE.test(name)) {
    refuse(profile, index, NAME_RULE);
  }
  if (name.endsWith(".")) {
    refuse(profile, index, NAME_RULE);
  }
  if (DEVICE_RE.test(name)) {
    refuse(profile, index, "name is a device name on Windows");
  }

  // --- url ---
  validateUrl(entry.url, profile, index);
  const url = entry.url as string;

  // --- path (use name if absent) ---
  const pathFromName = entry.path === undefined;
  const rawPath = pathFromName ? name : entry.path;
  const pathLabel = pathFromName ? "path (from name)" : "path";

  if (typeof rawPath !== "string" || !rawPath) {
    refuse(profile, index, PATH_PLAIN);
  }

  // Check climbsOut
  if (climbsOut(rawPath)) {
    refuse(profile, index, PATH_PLAIN);
  }

  // Validate each segment
  const segments = rawPath.split("/");
  for (const seg of segments) {
    if (!isValidPathSegment(seg)) {
      refuse(profile, index, PATH_PLAIN);
    }
  }

  // Check reserved paths
  const firstSegmentLower = segments[0].toLowerCase();
  if (CRAFTAR_RESERVED.has(firstSegmentLower)) {
    refuse(profile, index, `${pathLabel} is a place craftar writes`);
  }

  // --- ref ---
  let ref: string | null = null;
  if (entry.ref !== undefined) {
    const rawRef = entry.ref;
    if (typeof rawRef !== "string" || !rawRef || !REF_RE.test(rawRef)) {
      refuse(profile, index, REF_RULE);
    }
    // 40-char or 64-char hex is a commit SHA, not a ref
    if (SHA40_RE.test(rawRef) || SHA64_RE.test(rawRef)) {
      refuse(profile, index, REF_RULE);
    }
    ref = rawRef;
  }

  // --- unknown keys ---
  // This departs from spec 37 §5.1 ("quotes an unrecognized key") on the 0.30.1 integrations
  // ruling's model — a key is printed only when shaped like a name.
  const keys = Object.keys(entry);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex];
    if (!KNOWN_KEYS.has(key)) {
      // Check if key is shaped like a name: matches the regex and has no secrets
      if (KEY_NAME_RE.test(key) && findSecrets(key).length === 0) {
        refuse(profile, index, `${key} is not a key of a repository entry — name, url, path, ref`);
      } else {
        // 1-based position among the entry's keys
        refuse(profile, index, `key #${keyIndex + 1} (not shown: not shaped like a name) is not a key of a repository entry — name, url, path, ref`);
      }
    }
  }

  // --- cross-entry: name repeat (against earlier entries) ---
  const nameLower = name.toLowerCase();
  const existingNameIndex = seenNames.get(nameLower);
  if (existingNameIndex !== undefined) {
    refuse(profile, index, `name repeats repos[${existingNameIndex}]`);
  }

  // --- cross-entry: path collision (against earlier entries) ---
  const pathLower = rawPath.toLowerCase();
  for (const [existingPath, existingIndex] of seenPaths) {
    if (pathsCollide(pathLower, existingPath)) {
      refuse(profile, index, `${pathLabel} collides with repos[${existingIndex}]`);
    }
  }

  // Record for later entries
  seenNames.set(nameLower, index);
  seenPaths.set(pathLower, index);

  return { name, url, path: rawPath, ref };
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * The one reader of `profile.repos` (spec 37 §5.2). Validates every entry and
 * returns them in the profile's order, with `path` defaulted to `name` and
 * `ref` defaulted to `null`.
 *
 * @throws On the first fault found — entries in order, fields in order within an entry.
 */
export function profileRepos(profile: Pick<Profile, "name" | "repos">): RepoEntry[] {
  const repos = profile.repos;
  const result: RepoEntry[] = [];
  const seenNames = new Map<string, number>();
  const seenPaths = new Map<string, number>();

  for (let i = 0; i < repos.length; i++) {
    const entry = repos[i] as Record<string, unknown>;
    result.push(validateEntry(entry, profile.name, i, seenNames, seenPaths));
  }

  return result;
}

/**
 * Returns the arguments for `git clone` (after the program name).
 * `--` separates options from the URL to prevent option injection.
 */
export function cloneArgs(entry: RepoEntry): string[] {
  const args = ["clone", "--no-recurse-submodules"];
  if (entry.ref !== null) {
    args.push(`--branch=${entry.ref}`);
  }
  args.push("--", entry.url, entry.path);
  return args;
}

/**
 * Returns a shell command string for cloning, with URL and path in double quotes.
 */
export function byHand(entry: RepoEntry): string {
  const args = cloneArgs(entry);
  // Quote the last two arguments (url and path)
  const quoted = args.map((a, i) => (i >= args.length - 2 ? `"${a}"` : a));
  return "git " + quoted.join(" ");
}
