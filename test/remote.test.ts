import { describe, expect, it } from "vitest";
import { cacheKey, classifyForge, credentialFault, parseLsRemote, resolveRef } from "../src/core/remote.js";

describe("what counts as a URL (spec 13 §6.1)", () => {
  it("URLs", () => {
    for (const v of ["https://example.com/acme/forge.git", "ssh://git@example.com/acme/forge.git", "git://example.com/forge", "file:///tmp/forge.git", "git@example.com:acme/forge.git", "deploy@example.com:acme/forge"])
      expect(classifyForge(v), v).toBe("url");
  });
  it("paths", () => {
    for (const v of ["../forge", "C:/forge", "C:\\forge", "host:p", "forge", "/abs/forge"]) expect(classifyForge(v), v).toBe("path");
  });
});

describe("credentials (spec 13 §4.3, §6.1)", () => {
  it("refused", () => {
    for (const v of [
      "https://u@example.com/p",
      "https://u:p@example.com/p",
      "https://ghp_TOKEN@example.com/p",
      "http://u:p@example.com/p",
      "ssh://u:p@example.com/p",
      "u:p@host:path",
      // Spellings WHATWG URL cannot parse must still be refused: the check reads the authority itself.
      "https://u:s3cret@example.invalid:bad/r",
      "https://SECRETTOKEN@127.0.0.1:badport/acme/forge.git",
      "ssh://u:s3cret@example.invalid:repo",
      "ssh://u:SECRETPW@127.0.0.1:99999999/x",
      "git://u:s3cret@example.invalid:x/r",
      "HTTPS://tok@example.com/p",
    ])
      expect(credentialFault(v), v).toBe(true);
  });
  it("accepted", () => {
    for (const v of ["ssh://git@example.com/p", "git@example.com:p", "https://example.com/acme/forge.git", "file:///tmp/forge.git", "../forge"])
      expect(credentialFault(v), v).toBe(false);
  });
});

describe("the cache key (spec 13 §6.3)", () => {
  it("is stable across a trailing slash, .git, and scheme/host case", () => {
    const k = cacheKey("https://example.com/acme/forge");
    expect(cacheKey("https://example.com/acme/forge/")).toBe(k);
    expect(cacheKey("https://example.com/acme/forge.git")).toBe(k);
    expect(cacheKey("HTTPS://Example.COM/acme/forge")).toBe(k);
    expect(cacheKey("https://example.com/acme/other")).not.toBe(k);
    expect(k).toMatch(/^example\.com-acme-forge-[0-9a-f]{12}$/);
  });
});

const A = "a".repeat(40), B = "b".repeat(40), T = "c".repeat(40), P = "d".repeat(40), V = "e".repeat(40);
const LS = [
  "ref: refs/heads/main\tHEAD",
  `${A}\tHEAD`,
  `${A}\trefs/heads/main`,
  `${B}\trefs/heads/v1`,
  `${V}\trefs/tags/v1`,
  `${T}\trefs/tags/v2`,
  `${P}\trefs/tags/v2^{}`,
  "",
].join("\n");
const URL1 = "file:///tmp/acme-forge.git";

describe("resolving a ref (spec 13 §6.2)", () => {
  const refs = parseLsRemote(LS);
  it("no ref → the remote's default branch", () => expect(resolveRef(refs, null, URL1)).toEqual({ commit: A, defaultBranch: "main" }));
  it("a branch", () => expect(resolveRef(refs, "main", URL1)).toEqual({ commit: A, defaultBranch: null }));
  it("an annotated tag is peeled", () => expect(resolveRef(refs, "v2", URL1)).toEqual({ commit: P, defaultBranch: null }));
  it("qualified forms", () => {
    expect(resolveRef(refs, "refs/heads/v1", URL1)).toEqual({ commit: B, defaultBranch: null });
    expect(resolveRef(refs, "refs/tags/v1", URL1)).toEqual({ commit: V, defaultBranch: null });
  });
  it("a full SHA", () => expect(resolveRef(refs, B, URL1)).toEqual({ commit: B, defaultBranch: null }));
  it("a name that is both a branch and a tag", () =>
    expect(() => resolveRef(refs, "v1", URL1)).toThrow(`ref "v1" is both a branch and a tag in ${URL1} — write refs/heads/v1 or refs/tags/v1`));
  it("an abbreviated SHA and an unknown name", () => {
    expect(() => resolveRef(refs, "aaaaaaa", URL1)).toThrow(`ref "aaaaaaa" not found in ${URL1}`);
    expect(() => resolveRef(refs, "nope", URL1)).toThrow(`ref "nope" not found in ${URL1}`);
  });
});

import { afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultGit, ensureTree, ForgeFetchError, type GitRunner } from "../src/core/remote.js";
import { profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { git, remoteForge, type RemoteForge } from "./helpers/remote.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(): Promise<{ r: RemoteForge; home: string }> {
  const r = await remoteForge({ ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] });
  const home = await tmpDir("craftar-home-");
  cleanups.push(r.cleanup, () => fs.rm(home, { recursive: true, force: true }));
  return { r, home };
}

describe("the Forge cache (spec 13 §6.3)", () => {
  it("fetches the default branch into one entry per URL, and reuses its tree", async () => {
    const { r, home } = await setup();
    const head = git(r.src, "rev-parse", "HEAD");
    const first = await ensureTree(r.url, null, { home });
    expect([first.commit, first.defaultBranch, first.fetched]).toEqual([head, "main", true]);
    expect(await fs.readFile(path.join(first.dir, "craftar.forge.yaml"), "utf8")).toBe(await fs.readFile(path.join(r.src, "craftar.forge.yaml"), "utf8"));
    const again = await ensureTree(r.url + "/", null, { home });
    expect([again.dir, again.fetched]).toEqual([first.dir, true]);
    expect(await fs.readdir(path.join(home, "forges"))).toHaveLength(1);
  });

  it("a full SHA already cached is not fetched; offline follows the recorded default branch", async () => {
    const { r, home } = await setup();
    const sha = (await ensureTree(r.url, null, { home })).commit;
    const remoteCalls: string[][] = [];
    const counting: GitRunner = (args, opts) => {
      if (opts?.remote) remoteCalls.push(args);
      return defaultGit(args, opts);
    };
    const pinned = await ensureTree(r.url, sha, { home, git: counting });
    expect([pinned.commit, pinned.fetched, remoteCalls]).toEqual([sha, false, []]);
    const offline = await ensureTree(r.url, null, { home, offline: true, git: counting });
    expect([offline.commit, offline.defaultBranch, offline.fetched, remoteCalls]).toEqual([sha, "main", false, []]);
  });

  it("a tag does not move when the branch does; a branch does", async () => {
    const { r, home } = await setup();
    const tagged = git(r.src, "rev-parse", "HEAD");
    git(r.src, "tag", "-a", "v1", "-m", "v1");
    git(r.src, "push", "-q", "origin", "v1");
    const next = await r.commit({ "README.md": "more\n" });
    expect((await ensureTree(r.url, "v1", { home })).commit).toBe(tagged);
    expect((await ensureTree(r.url, "main", { home })).commit).toBe(next);
  });

  it("a failed tree creation leaves no tree behind", async () => {
    const { r, home } = await setup();
    // The tree is really created, then the call fails: what is left behind is what the cleanup must remove.
    const failing: GitRunner = async (args, opts) => {
      const out = await defaultGit(args, opts);
      if (args.includes("worktree") && args.includes("add")) throw new Error("boom");
      return out;
    };
    await expect(ensureTree(r.url, null, { home, git: failing })).rejects.toThrow("boom");
    const entry = (await fs.readdir(path.join(home, "forges")))[0];
    const trees = await fs.readdir(path.join(home, "forges", entry, "trees")).catch(() => [] as string[]);
    expect(trees.filter((t) => !t.endsWith(".used"))).toEqual([]);
  });

  it("a busy entry is waited for and then refused; a stale lock is taken over", async () => {
    const { r, home } = await setup();
    await ensureTree(r.url, null, { home });
    const entry = path.join(home, "forges", (await fs.readdir(path.join(home, "forges")))[0]);
    await fs.writeFile(path.join(entry, "lock"), `4242 ${new Date().toISOString()}\n`);
    await r.commit({ "README.md": "x\n" });
    await expect(ensureTree(r.url, null, { home, waitMs: 300, pollMs: 50 })).rejects.toThrow(`the Forge cache entry ${path.join(entry, "lock")} is busy (held by PID 4242)`);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(entry, "lock"), old, old);
    expect((await ensureTree(r.url, null, { home, waitMs: 300, pollMs: 50, staleMs: 1000 })).fetched).toBe(true);
  });

  it("cleanup removes a tree unused for too long, and keeps the one in use", async () => {
    const { r, home } = await setup();
    const a = await ensureTree(r.url, null, { home });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(`${a.dir}.used`, old, old);
    await r.commit({ "README.md": "y\n" });
    const b = await ensureTree(r.url, null, { home, cleanupMs: 1000 });
    expect(b.commit).not.toBe(a.commit);
    const trees = (await fs.readdir(path.dirname(b.dir))).filter((t) => !t.endsWith(".used"));
    expect(trees).toEqual([b.commit]);
  });

  it("an unreachable remote is a ForgeFetchError that says what the cache holds", async () => {
    const { r, home } = await setup();
    const sha = (await ensureTree(r.url, null, { home })).commit;
    await fs.rename(r.bare, r.bare + ".gone");
    const err = await ensureTree(r.url, null, { home }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeFetchError);
    expect((err as ForgeFetchError).cached?.commit).toBe(sha);
    const empty = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    const none = await ensureTree(r.url, null, { home: empty }).catch((e) => e);
    expect((none as ForgeFetchError).cached).toBeNull();
  });
});

describe("the Forge cache, hardened (review of spec 13)", () => {
  it("a tree left half-made (a directory without git's .git) is removed and made again", async () => {
    const { r, home } = await setup();
    const first = await ensureTree(r.url, null, { home });
    await fs.rm(first.dir, { recursive: true, force: true });
    await fs.mkdir(first.dir);
    const again = await ensureTree(r.url, null, { home });
    expect(again.dir).toBe(first.dir);
    expect(await fs.readFile(path.join(again.dir, "craftar.forge.yaml"), "utf8")).toBe(await fs.readFile(path.join(r.src, "craftar.forge.yaml"), "utf8"));
  });

  it("a first fetch that fails leaves no cache entry behind", async () => {
    const { r, home } = await setup();
    await fs.rename(r.bare, r.bare + ".gone");
    await expect(ensureTree(r.url, null, { home })).rejects.toBeInstanceOf(ForgeFetchError);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("offline, a full SHA the cache does not hold is 'not found', not a tree failure", async () => {
    const { r, home } = await setup();
    await ensureTree(r.url, null, { home });
    await expect(ensureTree(r.url, "f".repeat(40), { home, offline: true })).rejects.toThrow(`ref "${"f".repeat(40)}" not found in ${r.url}`);
  });
});
