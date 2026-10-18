import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "./forge.js";
import { LockBusyError, withLock, type LockOptions, type LockTiming } from "./home-lock.js";
import { hashNormalized } from "./text.js";
import { execProgram } from "./proc.js";
import { ENV_NAME } from "../schema/index.js";

/** A removal directory's prefix; `~` is a character `cacheKey` never emits (spec 26 §3, §13 item 14). */
export const REMOVING_PREFIX = "~removing-";

/* ------------------------------------------------------------------ */
/* What counts as a URL, and credentials (spec 13 §6.1, §4.3)          */
/* ------------------------------------------------------------------ */

const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** The SCP-like form `<user>@<host>:<path>`; without a user, `host:path` stays a path (a drive letter looks the same). */
const SCP_URL = /^[^\s/\\:@]+@[^\s/\\:]+:/;

/** A scheme and the run of `/` and `\` after it; `credentialFault` reads any run that is not `//` (spec 39 §4.2 A). */
const BACKSLASH_URL = /^([A-Za-z][A-Za-z0-9+.-]*):([/\\]+)/;

/** What is printed in place of a value `credentialFault` flags, where one written or recorded earlier would be shown. */
export const CREDENTIAL_HIDDEN = "(a URL with credentials — not shown)";

/** A `forge:` value is a git URL (a remote Forge) or a path resolved from the workspace root. */
export function classifyForge(value: string): "url" | "path" {
  const v = value.trim();
  return SCHEME_URL.test(v) || SCP_URL.test(v) ? "url" : "path";
}

/* ------------------------------------------------------------------ */
/* urlCredentialIn — spec 34 §4.3 row U, the five steps literally       */
/* ------------------------------------------------------------------ */

/** The http(s), ws(s) schemes and +variants thereof that are findings for a bare user (step 5). */
const HTTP_WS_SCHEMES = ["http", "https", "ws", "wss"];

/** A userinfo made only of `${NAME}` references and `:` is the remedy (step 4). Built from ENV_NAME. */
const REFERENCE_ONLY = new RegExp(`^(\\$\\{${ENV_NAME}\\}|:)*$`);

/**
 * Whether `text` holds, anywhere in it, a URL with credentials (spec 34 §4.3, row U).
 * Not `credentialFault`: that one answers "may this whole value, a Forge URL, be printed" and fails
 * closed; this one looks inside a leaf and must let through `--allow=…` lists, mail addresses and
 * the remedy it prescribes (a userinfo made only of `${NAME}` references).
 */
export function urlCredentialIn(text: string): boolean {
  // A run of tab / LF / CR among the `:` and the two `/` of a scheme separator is removed, so the
  // separator is found (spec 39 §5.2).
  const leaf = text.replace(/:[\t\n\r]*\/[\t\n\r]*\//g, "://");
  // Step 1: For every occurrence of `://` in the leaf (occurrences are independent; none hides another).
  let pos = 0;
  while (true) {
    const sep = leaf.indexOf("://", pos);
    if (sep === -1) break;
    pos = sep + 3; // Move past this `://` for the next iteration

    // Step 1: The scheme is the run of [A-Za-z0-9+.-] directly before it; it may be empty.
    let schemeStart = sep;
    while (schemeStart > 0 && /[A-Za-z0-9+.-]/.test(leaf[schemeStart - 1])) schemeStart--;
    const scheme = leaf.slice(schemeStart, sep).toLowerCase();

    // Spec 39 §5.2: also walk back including tab / LF / CR, then remove them and lower-case.
    let schemeLooseStart = sep;
    while (schemeLooseStart > 0 && /[A-Za-z0-9+.\-\t\n\r]/.test(leaf[schemeLooseStart - 1])) schemeLooseStart--;
    const schemeLoose = leaf.slice(schemeLooseStart, sep).replace(/[\t\n\r]/g, "").toLowerCase();

    // Step 2: The authority is the text after it, up to the first of `/`, `?`, `#`, white space (\s), `"`, `'`, `,`, `;` or the end.
    // An empty authority is not the end of it: curl takes up to three slashes after the scheme and reads what
    // follows as the authority, so `https:///<userinfo>@host/…` reaches the host with the userinfo. Every scheme
    // but `file` (where an empty authority is the norm and the rest is a path) is read past the leading
    // separators. White space among them is read past too: a URL parser drops a tab or a newline,
    // percent-encodes a space, and still reads the userinfo that follows.
    const rest = leaf.slice(sep + 3);
    const afterScheme = scheme === "file" ? rest : rest.replace(/^[/\\\s]+/, "");
    // White space ends the authority — except a run of tab, line feed and carriage return directly before an
    // `@`: a URL parser deletes those three from a URL, so `https://<token><LF>@host/` reaches the host with the
    // token (a YAML block scalar ends in a line feed). A space before the `@` still ends it. A loop, not a
    // lookahead: a long run of line breaks is walked once.
    let authorityEnd = -1;
    for (let i = 0; i < afterScheme.length; i++) {
      const c = afterScheme[i];
      if (!/[/?#\s"',;]/.test(c)) continue;
      if (c === "\t" || c === "\n" || c === "\r") {
        let j = i + 1;
        while (afterScheme[j] === "\t" || afterScheme[j] === "\n" || afterScheme[j] === "\r") j++;
        if (afterScheme[j] === "@") {
          i = j - 1;
          continue;
        }
      }
      authorityEnd = i;
      break;
    }
    const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);

    // Step 3: The userinfo is the authority before its last `@`, without the tab / line-break run that step 2
    // read past; no `@`, no finding.
    const at = authority.lastIndexOf("@");
    if (at === -1) continue;
    let userEnd = at;
    while (userEnd > 0 && (authority[userEnd - 1] === "\t" || authority[userEnd - 1] === "\n" || authority[userEnd - 1] === "\r")) userEnd--;
    const userinfo = authority.slice(0, userEnd);

    // Step 4: A userinfo made only of `${NAME}` references and `:` is no finding.
    // An empty userinfo is also no finding.
    if (userinfo === "" || REFERENCE_ONLY.test(userinfo)) continue;

    // Step 5: When the scheme is http, https, ws or wss, or ends in + followed by one of them,
    // any other non-empty userinfo is a finding; for any other scheme, the empty one included,
    // only a userinfo holding `:` is. Spec 39 §5.2: isHttpWs is true when EITHER reading
    // (scheme or schemeLoose) matches.
    const isHttpWs =
      HTTP_WS_SCHEMES.includes(scheme) || HTTP_WS_SCHEMES.some((s) => scheme.endsWith("+" + s)) ||
      HTTP_WS_SCHEMES.includes(schemeLoose) || HTTP_WS_SCHEMES.some((s) => schemeLoose.endsWith("+" + s));

    if (isHttpWs) {
      // Any non-empty userinfo (not made of references only) is a finding
      return true;
    } else {
      // For other schemes, only a userinfo holding `:` is a finding
      if (userinfo.includes(":")) return true;
    }
  }
  return false;
}

/**
 * True when a `forge:` value carries a credential: a user or password in an `http(s)` URL, a password
 * in any other scheme, or a `<x>:<y>@` before the first `/` or `\` whatever the value reads as — so a
 * password never reaches a message that prints the value (spec 13 §6.1, §14 item 11). An empty
 * authority (`https:///…`) is read past, for every scheme but `file`: what follows the extra
 * separators is the authority some clients use — curl past up to three slashes, a WHATWG parser
 * past a `\` too. A scheme followed by any run of `/` and `\` that is not `//` (`https:/…`,
 * `https:\\…`, `https:/\…`) is read the same way: a WHATWG parser takes each `\` for a `/`, while
 * `classifyForge` reads the value as a path — and a path is printed.
 */
export function credentialFault(raw: string): boolean {
  // A URL parser removes tab, line feed and carriage return before it reads, so `https:<TAB>//…`
  // and `ht<TAB>tps://…` reach a host with their userinfo — spec 39 §4.2 B.
  const value = raw.replace(/[\t\n\r]/g, "").trim();
  const head = value.split(/[/\\]/, 1)[0];
  if (/^[^@]*:[^@]*@/.test(head) && !SCHEME_URL.test(value)) return true;
  const scheme = SCHEME_URL.exec(value);
  if (!scheme) {
    // No `://`: any run of `/` and `\` after the scheme that is not `//` has its authority read by
    // the same rules (spec 39 §4.2 A). The authority ends at the first `/` or `\`; a drive path
    // (`C:\dir`) has no `@` there.
    const loose = BACKSLASH_URL.exec(value);
    if (!loose || loose[2] === "//" || /^file$/i.test(loose[1])) return false;
    const tail = value.slice(loose[0].length);
    const looseAuthority = tail.slice(0, tail.search(/[/\\]|$/));
    const looseAt = looseAuthority.lastIndexOf("@");
    if (looseAt === -1) return false;
    const looseUser = looseAuthority.slice(0, looseAt);
    return /^https?$/i.test(loose[1]) ? looseUser !== "" : looseUser.includes(":");
  }
  // Read the authority as written, never through a parser: a spelling WHATWG URL rejects
  // (`host:badport`) must not slip through and be printed later. It runs to the first `/`, as git
  // reads an ssh URL — a `?` or `#` in a password stays inside it. Fail closed.
  // An empty authority is not the end of it: curl takes up to three slashes after the scheme and
  // reads what follows as the authority, so `https:///<userinfo>@host/…` reaches the host with the
  // userinfo. Every scheme but `file` (where an empty authority is the norm and the rest is a path)
  // is read past the leading separators.
  const after = value.slice(scheme[0].length);
  const rest = /^file:\/\/$/i.test(scheme[0]) ? after : after.replace(/^[/\\]+/, "");
  const authority = rest.slice(0, rest.search(/\/|$/));
  const at = authority.lastIndexOf("@");
  if (at === -1) return false;
  const userinfo = authority.slice(0, at);
  if (/^https?:\/\/$/i.test(scheme[0])) return userinfo !== "";
  return userinfo.includes(":");
}

/** Whether a `ref:` holds a URL with credentials — as the whole value, or anywhere in it (`refs/heads/<url>`). */
export const refHoldsCredentials = (ref: string): boolean => credentialFault(ref) || urlCredentialIn(ref);

/**
 * A `ref:` as a message names it: quoted — or, when it holds a URL with credentials (typed into
 * `ref:` by mistake), the fixed label and never the value.
 */
export function shownRef(ref: string): string {
  return refHoldsCredentials(ref) ? `ref ${CREDENTIAL_HIDDEN}` : `ref "${ref}"`;
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

export const FULL_SHA = /^[0-9a-f]{40}$/;

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
    if (commit === undefined) throw new Error(`${shownRef(ref)} not found in ${url}`);
    return { commit, defaultBranch: null };
  }
  const branch = refs.heads.get(ref);
  const tag = refs.tags.get(ref);
  if (branch !== undefined && tag !== undefined)
    throw new Error(`${shownRef(ref)} is both a branch and a tag in ${url}${refHoldsCredentials(ref) ? "" : ` — write refs/heads/${ref} or refs/tags/${ref}`}`);
  const commit = branch ?? tag;
  if (commit === undefined) throw new Error(`${shownRef(ref)} not found in ${url}`);
  return { commit, defaultBranch: null };
}

/* ------------------------------------------------------------------ */
/* The Forge cache (spec 13 §6.3) — the one place Craftar writes        */
/* outside a workspace and a Forge on its own initiative                */
/* ------------------------------------------------------------------ */

/** Runs git and resolves its stdout; `remote` marks a call that reaches the remote (prompts off without a TTY). */
export type GitRunner = (args: string[], opts?: { remote?: boolean }) => Promise<string>;

export interface CacheOptions extends LockTiming {
  /** `$CRAFTAR_HOME` (default `~/.craftar`), resolved by the caller. */
  home: string;
  /** Resolve against the cache only; never reach the remote. */
  offline?: boolean;
  git?: GitRunner;
  /** When an unused tree goes (14 days); the lock's timing comes from `LockTiming`. */
  cleanupMs?: number;
  /** Test hook, passed to the entry lock (spec 26 §9). */
  beforeAttempt?: () => Promise<void>;
}

export interface CachedTree {
  /** The tree to load the Forge from. */
  dir: string;
  commit: string;
  /** The followed branch when no ref was requested, else null. */
  defaultBranch: string | null;
  /** True only when this call fetched from the remote. */
  fetched: boolean;
  /** ISO time of the entry's last successful fetch. */
  fetchedAt: string | null;
}

/** The remote could not be reached; `cached` says what the cache could still offer. */
export class ForgeFetchError extends Error {
  constructor(
    readonly url: string,
    readonly gitMessage: string,
    /** A completed fetch left a copy, whether or not it can resolve the ref. */
    readonly haveCopy: boolean,
    readonly cached: { commit: string; fetchedAt: string | null } | null,
  ) {
    super(`cannot fetch the Forge ${url}: ${gitMessage}`);
  }
}

/** Reading the cache only (`--offline`, `targets`) found no copy of this Forge. */
export class NoCachedCopyError extends Error {
  constructor(readonly url: string) {
    super(`the Forge ${url} has no cached copy yet`);
  }
}

export const defaultGit: GitRunner = async (args, opts = {}) => {
  const env = { ...process.env };
  // CI fails fast instead of hanging on a credential prompt; a terminal may still prompt (spec 13 §14 item 4).
  if (opts.remote && !process.stdin.isTTY) env.GIT_TERMINAL_PROMPT = "0";
  try {
    const { stdout } = await execProgram("git", args, { env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const line = (err.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? err.message;
    throw new Error(line.replace(/^fatal:\s*/, ""));
  }
};

/** The tree for `ref` of the remote Forge at `url`, fetching first unless offline or the ref is a full SHA already cached. */
export async function ensureTree(written: string, ref: string | null, opts: CacheOptions): Promise<CachedTree> {
  // As classifyForge reads it: git would choke on a stray leading space.
  const url = written.trim();
  const git = opts.git ?? defaultGit;
  // Absolute once: `git -C repo.git worktree add <dir>` would read a relative dir from inside repo.git.
  const home = path.resolve(opts.home);
  const entry = path.join(home, "forges", cacheKey(url));
  const repo = path.join(entry, "repo.git");
  const stamp = path.join(entry, "fetched");
  // A copy exists once a fetch completed: an init whose fetch then failed leaves no stamp.
  const haveCopy = await exists(stamp);
  const fetchedAt = async () => ((await exists(stamp)) ? readFetchedStamp(stamp) : null);
  const label = ref === null ? `ref "the default branch"` : shownRef(ref);

  // A full SHA already in the cache names the same commit whatever the remote does: no fetch (§14 item 3).
  const cachedSha = ref !== null && FULL_SHA.test(ref) && haveCopy && (await hasCommit(git, repo, ref));

  let resolved: { commit: string; defaultBranch: string | null };
  let fetched = false;
  if (opts.offline || cachedSha) {
    if (!haveCopy) throw new NoCachedCopyError(url);
    resolved = cachedSha ? { commit: ref!, defaultBranch: null } : resolveRef(await cachedRefs(git, repo), ref, url);
    if (!(await hasCommit(git, repo, resolved.commit))) throw new Error(`${label} not found in ${url}`);
  } else {
    let refs: LsRemote;
    try {
      refs = parseLsRemote(await git(["ls-remote", "--symref", url], { remote: true }));
    } catch (e) {
      throw new ForgeFetchError(url, (e as Error).message, haveCopy, await cachedFallback(git, repo, haveCopy, ref, url, await fetchedAt()));
    }
    resolved = resolveRef(refs, ref, url);
    try {
      await fs.mkdir(entry, { recursive: true });
    } catch (e) {
      throw new Error(`cannot write the Forge cache in ${home}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    await withEntryLock(entry, opts, async () => {
      if (!(await exists(path.join(repo, "HEAD")))) await git(["init", "--quiet", "--bare", repo]);
      try {
        await git(["-C", repo, "fetch", "--quiet", "--prune", url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { remote: true });
      } catch (e) {
        throw new ForgeFetchError(url, (e as Error).message, haveCopy, await cachedFallback(git, repo, haveCopy, ref, url, await fetchedAt()));
      }
      // A bare repository filled by fetch does not keep the remote's HEAD; --offline without a ref needs it.
      if (refs.head) await git(["-C", repo, "symbolic-ref", "HEAD", `refs/heads/${refs.head}`]);
      await fs.writeFile(stamp, new Date().toISOString() + "\n");
    });
    fetched = true;
    if (!(await hasCommit(git, repo, resolved.commit))) throw new Error(`${label} not found in ${url}`);
  }

  const dir = await treeFor(git, entry, repo, resolved.commit, opts);
  if (fetched) {
    const { busy } = await pruneTrees(entry, { ...opts, git, inUse: resolved.commit });
    if (busy) throw busy;
  }
  return { dir, commit: resolved.commit, defaultBranch: resolved.defaultBranch, fetched, fetchedAt: await fetchedAt() };
}

async function hasCommit(git: GitRunner, repo: string, sha: string): Promise<boolean> {
  try {
    await git(["-C", repo, "cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The refs as the last fetch left them in the bare repository, in `ls-remote`'s shape. */
async function cachedRefs(git: GitRunner, repo: string): Promise<LsRemote> {
  const lines: string[] = [];
  try {
    lines.push(`ref: ${(await git(["-C", repo, "symbolic-ref", "HEAD"])).trim()}\tHEAD`);
  } catch {
    // no recorded default branch
  }
  const listed = await git(["-C", repo, "for-each-ref", "--format=%(objectname)\t%(refname)\t%(*objectname)", "refs/heads", "refs/tags"]);
  for (const line of listed.split(/\r?\n/)) {
    const [sha, name, peeled] = line.split("\t");
    if (!sha || !name) continue;
    lines.push(`${sha}\t${name}`);
    if (peeled) lines.push(`${peeled}\t${name}^{}`);
  }
  return parseLsRemote(lines.join("\n"));
}

async function cachedFallback(
  git: GitRunner,
  repo: string,
  haveRepo: boolean,
  ref: string | null,
  url: string,
  fetchedAt: string | null,
): Promise<{ commit: string; fetchedAt: string | null } | null> {
  if (!haveRepo) return null;
  try {
    const { commit } = ref !== null && FULL_SHA.test(ref) ? { commit: ref } : resolveRef(await cachedRefs(git, repo), ref, url);
    return (await hasCommit(git, repo, commit)) ? { commit, fetchedAt } : null;
  } catch {
    return null;
  }
}

/** One worktree per resolved commit; never written to after creation. A failure leaves no half-made tree. */
async function treeFor(git: GitRunner, entry: string, repo: string, commit: string, opts: CacheOptions): Promise<string> {
  const dir = path.join(entry, "trees", commit);
  // Complete once Craftar wrote `<commit>.ok` under the lock, after `worktree add` returned. Git's own
  // `.git` file comes before the checkout, so a run cut short — or one still checking out in another
  // process — leaves a tree without the marker: it is removed and made again, never loaded half.
  const marker = `${dir}.ok`;
  const complete = async () => (await exists(marker)) && (await exists(path.join(dir, ".git")));
  if (!(await complete())) {
    await withEntryLock(entry, opts, async () => {
      if (await complete()) return;
      if (await exists(dir)) {
        await git(["-C", repo, "worktree", "remove", "--force", dir]).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
      await git(["-C", repo, "worktree", "prune"]).catch(() => {});
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        // The commit's bytes, the same on every platform (spec 13 §8): no host setting rewrites the
        // checkout — not core.autocrlf, not core.eol (native CRLF on Git for Windows, applied to a
        // Forge's `text=auto`), not a global attributes file. A Forge's own `eol=` still applies: that
        // is the Forge author's choice.
        await git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.attributesFile=", "-C", repo, "worktree", "add", "--quiet", "--detach", dir, commit]);
        await fs.writeFile(marker, `${new Date().toISOString()}\n`);
      } catch (e) {
        await git(["-C", repo, "worktree", "remove", "--force", dir]).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
        await git(["-C", repo, "worktree", "prune"]).catch(() => {});
        throw new Error(`cannot create the Forge tree ${dir}: ${(e as Error).message}`);
      }
    });
  }
  const used = `${dir}.used`;
  const now = new Date();
  await fs.writeFile(used, "").catch(() => {});
  await fs.utimes(used, now, now).catch(() => {});
  return dir;
}

/**
 * The entry's lock (`<entry>/lock`), through the one helper the registry shares (spec 21 §5.4).
 * Passes `createDir: true` so a waiter on an entry another process removed re-creates it (spec 26 §4.3).
 */
function withEntryLock<T>(entry: string, opts: LockOptions, body: () => Promise<T>): Promise<T> {
  return withLock(path.join(entry, "lock"), "the Forge cache entry", { ...opts, createDir: true }, body);
}

/**
 * `withLock` on `forges/prune.lock` for the whole prune run (spec 26 §4.2 step 0). No `createDir`:
 * it never creates `forges/`. The body receives `refresh` to advance the lock's mtime and `bytes`
 * (the lock file's size just after acquisition, 0 when unreadable).
 */
export async function withPruneLock<T>(home: string, opts: LockTiming, body: (lock: { refresh: () => Promise<void>; bytes: number }) => Promise<T>): Promise<T> {
  const lockFile = path.join(path.resolve(home), "forges", "prune.lock");
  return withLock(lockFile, "the Forge cache prune lock", opts, async () => {
    const bytes = await fs.lstat(lockFile).then((s) => s.size, () => 0);
    const refresh = async () => {
      const now = new Date();
      await fs.utimes(lockFile, now, now).catch(() => {});
    };
    return body({ refresh, bytes });
  });
}

/**
 * Whether `$CRAFTAR_HOME/forges` exists (spec 26 §4.2 step 0, §4.6). Returns `"absent"` when ENOENT,
 * `"present"` when it is a directory, throws when it exists but is not a directory or on any other error.
 */
export async function cacheDir(home: string): Promise<"absent" | "present"> {
  const forges = path.join(path.resolve(home), "forges");
  const st = await fs.stat(forges).catch((e: NodeJS.ErrnoException) => {
    const code = e.code;
    if (code === "ENOENT") return null;
    throw new Error(`cannot read ${forges}: ${code ?? e.message}`);
  });
  if (st === null) return "absent";
  if (!st.isDirectory()) throw new Error(`cannot read ${forges}: not a directory`);
  return "present";
}

/* ------------------------------------------------------------------ */
/* Pruning trees (spec 26 §4.2 step 5)                                  */
/* ------------------------------------------------------------------ */

export interface PruneTreesOptions extends LockOptions {
  git?: GitRunner;
  /** The tree in use (never removed); when absent, every old tree goes. */
  inUse?: string;
  /** When an unused tree goes (default 14 days). */
  cleanupMs?: number;
}

/**
 * Trees unused for `cleanupMs` go (default 14 days), except `inUse`; returns each removed tree with its
 * bytes measured under the lock just before removal. `repo.git` is left to git.
 * A `LockBusyError` from any lock take stops the pass and is returned in `busy` with everything removed so far.
 */
export async function pruneTrees(entry: string, opts: PruneTreesOptions): Promise<{ removed: Array<{ commit: string; bytes: number }>; busy: LockBusyError | null }> {
  const git = opts.git ?? defaultGit;
  const repo = path.join(entry, "repo.git");
  const trees = path.join(entry, "trees");
  const limit = Date.now() - (opts.cleanupMs ?? 14 * 24 * 60 * 60 * 1000);
  const lastUse = (commit: string) => treeLastUse(trees, commit);
  const removed: Array<{ commit: string; bytes: number }> = [];
  let busy: LockBusyError | null = null;
  // Names sorted, so the order of removal is deterministic.
  for (const name of (await fs.readdir(trees).catch(() => [] as string[])).sort()) {
    if (name.includes(".") || name === opts.inUse) continue;
    const used = await lastUse(name);
    if (used === null || used >= limit) continue;
    try {
      await withEntryLock(entry, opts, async () => {
        // Again under the lock: a reader may have touched the stamp since (readers take no lock).
        const again = await lastUse(name);
        if (again === null || again >= limit) return;
        const dir = path.join(trees, name);
        const bytes = (await sizeOf(dir)) + (await sizeOf(`${dir}.ok`)) + (await sizeOf(`${dir}.used`));
        await git(["-C", repo, "worktree", "remove", "--force", dir]).catch(() => {});
        for (const p of [name, `${name}.used`, `${name}.ok`]) await fs.rm(path.join(trees, p), { recursive: true, force: true });
        removed.push({ commit: name, bytes });
      });
    } catch (e) {
      if (e instanceof LockBusyError) { busy = e; break; }
      throw e;
    }
  }
  // A stamp or marker whose tree is gone (a reader stamped it as cleanup took the tree) goes too — under
  // the lock, so it never races a rebuild between its `rm` of the tree and the `.ok` it then writes.
  if (busy === null) {
    try {
      await withEntryLock(entry, opts, async () => {
        for (const name of await fs.readdir(trees).catch(() => [] as string[])) {
          const m = /^(.+)\.(used|ok)$/.exec(name);
          if (m && !(await exists(path.join(trees, m[1])))) await fs.rm(path.join(trees, name), { force: true });
        }
      });
    } catch (e) {
      if (e instanceof LockBusyError) busy = e;
      else throw e;
    }
  }
  if (removed.length > 0) await git(["-C", repo, "worktree", "prune"]).catch(() => {});
  return { removed, busy };
}

/* ------------------------------------------------------------------ */
/* Removing a whole entry (spec 26 §4.3)                                */
/* ------------------------------------------------------------------ */

export type RemoveOutcome =
  | { outcome: "removed"; warnings: string[] }
  | { outcome: "kept"; warnings: string[] }
  | { outcome: "busy"; holder: string; warnings: string[] }
  | { outcome: "held-open"; code: string; warnings: string[] };

export interface RemoveEntryOptions extends LockOptions {
  /** Test hook: the rename used to move an entry's parts (default `fs.rename`). */
  rename?: (from: string, to: string) => Promise<void>;
  /** Test hook: awaited after the entry lock is released, before the `rmdir` of the entry (spec 26 §4.3's orderings). */
  afterRelease?: () => Promise<void>;
}

/**
 * Removes a cache entry's contents under its lock (spec 26 §4.3): re-checks through `stillPrunable`,
 * moves the parts out (`fetched` first, then `repo.git`, then `trees`), releases, `rmdir`s the entry,
 * removes the moved contents. A busy lock → `busy`; a failed rename → `held-open`, parts moved back.
 */
export async function removeEntry(entry: string, stillPrunable: (now: { fetched: boolean }) => Promise<boolean>, opts: RemoveEntryOptions): Promise<RemoveOutcome> {
  const key = path.basename(entry);
  const removalDir = path.join(path.dirname(entry), `${REMOVING_PREFIX}${key}-${process.pid}`);
  const rename = opts.rename ?? fs.rename;
  const parts = ["fetched", "repo.git", "trees"];
  const moved: string[] = [];

  let outcome: RemoveOutcome;
  try {
    outcome = await withEntryLock(entry, opts, async () => {
      // Re-check under the lock, passing the fetched state as read now.
      const fetched = await exists(path.join(entry, "fetched"));
      if (!(await stillPrunable({ fetched }))) return { outcome: "kept" as const, warnings: [] };

      // Clear a leftover removal directory with this run's name (same PID) before the move,
      // so it never blocks the move.
      const preMoveWarn = await removeLeftover(removalDir);

      // Move parts out in order: fetched first (so a reader from then on sees no copy).
      for (const part of parts) {
        const src = path.join(entry, part);
        const dst = path.join(removalDir, part);
        try {
          await fs.mkdir(removalDir, { recursive: true });
          await rename(src, dst);
          moved.push(part);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
          if (code === "ENOENT") continue; // Part not there — skip.
          // Any other error: move back in reverse order.
          const warnings: string[] = preMoveWarn ? [preMoveWarn] : [];
          warnings.push(`${key} is held open (${code}) — kept`);
          for (const p of [...moved].reverse()) {
            try {
              await rename(path.join(removalDir, p), path.join(entry, p));
            } catch (e2) {
              const code2 = (e2 as NodeJS.ErrnoException).code ?? (e2 as Error).message;
              warnings.push(`${key}: ${p} left in ${removalDir} (${code2}) — the next prune removes it`);
            }
          }
          return { outcome: "held-open" as const, code, warnings };
        }
      }
      return { outcome: "removed" as const, warnings: [] };
    });
  } catch (e) {
    if (e instanceof LockBusyError) return { outcome: "busy", holder: e.holder, warnings: [] };
    throw e;
  }

  // After the lock is released.
  if (opts.afterRelease) await opts.afterRelease();

  if (outcome.outcome === "removed") {
    // rmdir the entry — fails harmlessly (ENOTEMPTY) if another process created its lock there.
    await fs.rmdir(entry).catch(() => {});
    // Remove the removal directory.
    const warn = await removeLeftover(removalDir);
    if (warn) outcome.warnings.push(warn);
  } else if (outcome.outcome === "held-open") {
    // Remove the removal directory only if it's empty (the parts moved back).
    const isEmpty = (await fs.readdir(removalDir).catch(() => null))?.length === 0;
    if (isEmpty) {
      const warn = await removeLeftover(removalDir);
      if (warn) outcome.warnings.push(warn);
    }
  }

  return outcome;
}

/**
 * Removes a leftover removal directory (spec 26 §4.2 step 6). Returns null on success, else a warning
 * with the code — the next prune retries it.
 */
export async function removeLeftover(dir: string): Promise<string | null> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return `cannot remove ${dir}: ${code} — the next prune retries it`;
  }
}

/* ------------------------------------------------------------------ */
/* Reading the cache (spec 24 §5.1, extended by spec 26 §5.1)          */
/* ------------------------------------------------------------------ */

/**
 * When a tree was last used: its `.used` stamp, else its completion marker, else the directory — so a
 * tree whose run died before stamping it still ages out. The one rule cleanup and the readers share.
 */
async function treeLastUse(trees: string, commit: string): Promise<number | null> {
  for (const p of [`${commit}.used`, `${commit}.ok`, commit]) {
    const st = await fs.stat(path.join(trees, p)).catch(() => null);
    if (st) return st.mtimeMs;
  }
  return null;
}

export interface CacheTreeInfo {
  commit: string;
  /** The tree holds its completion marker. */
  complete: boolean;
  /** `treeLastUse`, in ms since the epoch; null when nothing of the tree is left. */
  lastUse: number | null;
  /** Summed file sizes of the tree directory plus its `.ok` and `.used` stamps. */
  bytes: number;
}

export interface CacheEntryInfo {
  /** The entry's directory name: `cacheKey(url)`. */
  key: string;
  dir: string;
  /** Summed file sizes under the entry, `repo.git` included; links are not followed. */
  bytes: number;
  /** A fetch completed (the `fetched` stamp exists). */
  fetched: boolean;
  /** The stamp's time, when it reads as one. */
  fetchedAt: string | null;
  trees: CacheTreeInfo[];
}

export interface CacheSnapshot {
  /** `$CRAFTAR_HOME/forges`. */
  forges: string;
  entries: CacheEntryInfo[];
  /** Removal directories (`~removing-*`) left by an interrupted prune (spec 26 §5.1). */
  removing: Array<{ dir: string; bytes: number }>;
  /** Summed file sizes under `forges/`, whatever lies there; links are not followed. */
  bytes: number;
}

/** The `fetched` stamp's time, when it reads as one: the one parse `ensureTree` and the snapshot share. Throws when the stamp cannot be read. */
async function readFetchedStamp(stamp: string): Promise<string | null> {
  const text = (await fs.readFile(stamp, "utf8")).trim();
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(text) ? text : null;
}

/** Bytes of every file under `dir`, without following links; 0 for anything unreadable. */
async function sizeOf(dir: string): Promise<number> {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) total += await sizeOf(path.join(dir, name));
  return total;
}

/** A read-only snapshot of the Forge cache (spec 24 §5.1): the one reader of the layout outside `ensureTree`. */
export async function inspectCache(home: string): Promise<CacheSnapshot> {
  const forges = path.join(path.resolve(home), "forges");
  const entries: CacheEntryInfo[] = [];
  const removing: Array<{ dir: string; bytes: number }> = [];
  const names = (await fs.readdir(forges, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const dir = path.join(forges, d.name);
    // A directory starting with ~removing- is a removal directory, never an entry (spec 26 §5.1).
    if (d.name.startsWith(REMOVING_PREFIX)) {
      removing.push({ dir, bytes: await sizeOf(dir) });
      continue;
    }
    const stamp = path.join(dir, "fetched");
    const fetched = await exists(stamp);
    const trees = path.join(dir, "trees");
    const treeInfo: CacheTreeInfo[] = [];
    for (const name of (await fs.readdir(trees).catch(() => [] as string[])).sort()) {
      if (name.includes(".")) continue;
      const treeDir = path.join(trees, name);
      const bytes = (await sizeOf(treeDir)) + (await sizeOf(`${treeDir}.ok`)) + (await sizeOf(`${treeDir}.used`));
      treeInfo.push({ commit: name, complete: await exists(path.join(trees, `${name}.ok`)), lastUse: await treeLastUse(trees, name), bytes });
    }
    entries.push({
      key: d.name,
      dir,
      bytes: await sizeOf(dir),
      fetched,
      fetchedAt: fetched ? await readFetchedStamp(stamp).catch(() => null) : null,
      trees: treeInfo,
    });
  }
  return { forges, entries, removing, bytes: await sizeOf(forges) };
}
