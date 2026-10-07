import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists } from "./forge.js";
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
  const scheme = SCHEME_URL.exec(value);
  if (!scheme) return false;
  // Read the authority as written, never through a parser: a spelling WHATWG URL rejects
  // (`host:badport`) must not slip through and be printed later. Fail closed.
  const rest = value.slice(scheme[0].length);
  const authority = rest.slice(0, rest.search(/[/?#]|$/));
  const at = authority.lastIndexOf("@");
  if (at === -1) return false;
  const userinfo = authority.slice(0, at);
  if (/^https?:\/\/$/i.test(scheme[0])) return userinfo !== "";
  return userinfo.includes(":");
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

/* ------------------------------------------------------------------ */
/* The Forge cache (spec 13 §6.3) — the one place Craftar writes        */
/* outside a workspace and a Forge on its own initiative                */
/* ------------------------------------------------------------------ */

/** Runs git and resolves its stdout; `remote` marks a call that reaches the remote (prompts off without a TTY). */
export type GitRunner = (args: string[], opts?: { remote?: boolean }) => Promise<string>;

export interface CacheOptions {
  /** `$CRAFTAR_HOME` (default `~/.craftar`), resolved by the caller. */
  home: string;
  /** Resolve against the cache only; never reach the remote. */
  offline?: boolean;
  git?: GitRunner;
  /** How long a busy entry is waited for (60 s), how often it is polled, when a lock is stale (10 min), when an unused tree goes (14 days). */
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
  cleanupMs?: number;
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
    readonly cached: { commit: string; fetchedAt: string | null } | null,
  ) {
    super(`cannot fetch the Forge ${url}: ${gitMessage}`);
  }
}

const execFileP = promisify(execFile);

export const defaultGit: GitRunner = async (args, opts = {}) => {
  const env = { ...process.env };
  // CI fails fast instead of hanging on a credential prompt; a terminal may still prompt (spec 13 §14 item 4).
  if (opts.remote && !process.stdin.isTTY) env.GIT_TERMINAL_PROMPT = "0";
  try {
    const { stdout } = await execFileP("git", args, { env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const line = (err.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? err.message;
    throw new Error(line.replace(/^fatal:\s*/, ""));
  }
};

/** The tree for `ref` of the remote Forge at `url`, fetching first unless offline or the ref is a full SHA already cached. */
export async function ensureTree(url: string, ref: string | null, opts: CacheOptions): Promise<CachedTree> {
  const git = opts.git ?? defaultGit;
  const entry = path.join(opts.home, "forges", cacheKey(url));
  const repo = path.join(entry, "repo.git");
  try {
    await fs.mkdir(entry, { recursive: true });
  } catch (e) {
    throw new Error(`cannot write the Forge cache in ${opts.home}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const haveRepo = await exists(path.join(repo, "HEAD"));
  const fetchedAt = async () => ((await exists(path.join(entry, "fetched"))) ? (await fs.readFile(path.join(entry, "fetched"), "utf8")).trim() : null);

  // A full SHA already in the cache names the same commit whatever the remote does: no fetch (§14 item 3).
  const cachedSha = ref !== null && FULL_SHA.test(ref) && haveRepo && (await hasCommit(git, repo, ref));

  let resolved: { commit: string; defaultBranch: string | null };
  let fetched = false;
  if (opts.offline || cachedSha) {
    if (!haveRepo) throw new Error(`the Forge ${url} has no cached copy yet — run without --offline once to fetch it`);
    resolved = cachedSha ? { commit: ref!, defaultBranch: null } : resolveRef(await cachedRefs(git, repo), ref, url);
  } else {
    let refs: LsRemote;
    try {
      refs = parseLsRemote(await git(["ls-remote", "--symref", url], { remote: true }));
    } catch (e) {
      throw new ForgeFetchError(url, (e as Error).message, await cachedFallback(git, repo, haveRepo, ref, url, await fetchedAt()));
    }
    resolved = resolveRef(refs, ref, url);
    await withLock(entry, opts, async () => {
      if (!(await exists(path.join(repo, "HEAD")))) await git(["init", "--quiet", "--bare", repo]);
      try {
        await git(["-C", repo, "fetch", "--quiet", "--prune", url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { remote: true });
      } catch (e) {
        throw new ForgeFetchError(url, (e as Error).message, await cachedFallback(git, repo, haveRepo, ref, url, await fetchedAt()));
      }
      // A bare repository filled by fetch does not keep the remote's HEAD; --offline without a ref needs it.
      if (refs.head) await git(["-C", repo, "symbolic-ref", "HEAD", `refs/heads/${refs.head}`]);
      await fs.writeFile(path.join(entry, "fetched"), new Date().toISOString() + "\n");
    });
    fetched = true;
    if (!(await hasCommit(git, repo, resolved.commit))) throw new Error(`ref "${ref}" not found in ${url}`);
  }

  const dir = await treeFor(git, entry, repo, resolved.commit, opts);
  if (fetched) await cleanup(git, entry, repo, resolved.commit, opts);
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
  if (!(await exists(dir))) {
    await withLock(entry, opts, async () => {
      if (await exists(dir)) return;
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        await git(["-C", repo, "worktree", "add", "--quiet", "--detach", dir, commit]);
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

/** Trees unused for `cleanupMs` go, except the one in use; `repo.git` is left to git. */
async function cleanup(git: GitRunner, entry: string, repo: string, inUse: string, opts: CacheOptions): Promise<void> {
  const trees = path.join(entry, "trees");
  const limit = Date.now() - (opts.cleanupMs ?? 14 * 24 * 60 * 60 * 1000);
  let removed = false;
  for (const name of await fs.readdir(trees).catch(() => [] as string[])) {
    if (!name.endsWith(".used")) continue;
    const commit = name.slice(0, -".used".length);
    if (commit === inUse) continue;
    const stat = await fs.stat(path.join(trees, name)).catch(() => null);
    if (!stat || stat.mtimeMs >= limit) continue;
    await withLock(entry, opts, async () => {
      await git(["-C", repo, "worktree", "remove", "--force", path.join(trees, commit)]).catch(() => {});
      await fs.rm(path.join(trees, commit), { recursive: true, force: true });
      await fs.rm(path.join(trees, name), { force: true });
    });
    removed = true;
  }
  if (removed) await git(["-C", repo, "worktree", "prune"]).catch(() => {});
}

/** The entry's lock: created exclusively, holding the PID and a timestamp; waited for, then refused; taken over when stale. */
async function withLock<T>(entry: string, opts: CacheOptions, body: () => Promise<T>): Promise<T> {
  const file = path.join(entry, "lock");
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 200;
  const staleMs = opts.staleMs ?? 10 * 60 * 1000;
  const start = Date.now();
  for (;;) {
    try {
      await fs.writeFile(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() - start >= waitMs) {
        const held = (await fs.readFile(file, "utf8").catch(() => "")).split(/\s+/)[0] || "unknown";
        throw new Error(`the Forge cache entry ${entry}/lock is busy (held by PID ${held})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await body();
  } finally {
    await fs.rm(file, { force: true });
  }
}
