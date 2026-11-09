import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGit, ensureTree, fetchFaultHint, FETCH_NO_ACCESS, type GitRunner } from "../src/core/remote.js";
import { loadForgeSource } from "../src/core/sync.js";
import { profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { remoteForge } from "./helpers/remote.js";

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("fetchFaultHint", () => {
  it.each([
    "remote: Repository not found.",
    "ERROR: Repository not found.",
    "remote: The project you were looking for could not be found or you don't have permission to view it.",
    "could not read Username for 'https://example.invalid': terminal prompts disabled",
    "Authentication failed for 'https://example.invalid/acme/forge.git/'",
    "git@example.invalid: Permission denied (publickey).",
    "remote: Access denied",
    "unable to access 'https://example.invalid/acme/forge.git/': The requested URL returned error: 403",
    "unable to access 'https://example.invalid/acme/forge.git/': The requested URL returned error: 401",
    "unable to get password from user",
    "could not read Password for 'https://example.invalid': terminal prompts disabled",
  ])("names a missing repository or a missing access for %s", (msg) => {
    expect(fetchFaultHint(msg)).toBe(FETCH_NO_ACCESS);
  });

  it.each([
    "Could not resolve host: example.invalid",
    "unable to access 'https://example.invalid/': Failed to connect to example.invalid port 443",
    "'/tmp/nowhere' does not appear to be a git repository",
    "the remote does not answer",
    "",
  ])("says nothing for %s", (msg) => {
    expect(fetchFaultHint(msg)).toBeNull();
  });

  it("is fixed words: it carries nothing of git's message", () => {
    expect(FETCH_NO_ACCESS).not.toMatch(/example|acme|https?:/);
    expect(FETCH_NO_ACCESS).not.toMatch(/[—–]/);
  });
});

describe("a fetch git refuses as not found or no access", () => {
  const denied: GitRunner = async (args) => {
    if (args.includes("ls-remote")) throw new Error("remote: Repository not found.");
    return "";
  };
  const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: unknown) => (e as Error).message);

  it("with no cached copy, read and sync say so before the tail", async () => {
    const root = await tmpDir("craftar-hint-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const url = "https://example.invalid/acme/forge.git";
    for (const mode of ["read", "sync"] as const) {
      const message = await messageOf(loadForgeSource(root, url, null, { home, git: denied, mode }));
      expect(message).toBe(`cannot fetch the Forge ${url}: remote: Repository not found.; ${FETCH_NO_ACCESS} — and there is no cached copy to fall back on`);
    }
  });

  it("with a cached copy, sync's error and read's warning say so before the tail", async () => {
    const root = await tmpDir("craftar-hint-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home });
    // The remote refuses; the cache is read by the real git.
    const deniedRemote: GitRunner = async (args, opts) => {
      if (args.includes("ls-remote")) throw new Error("remote: Repository not found.");
      return defaultGit(args, opts);
    };

    const sync = await messageOf(loadForgeSource(root, r.url, null, { home, git: deniedRemote, mode: "sync" }));
    expect(sync.startsWith(`cannot fetch the Forge ${r.url}: remote: Repository not found.; ${FETCH_NO_ACCESS} — run with --offline to use the cached copy (`)).toBe(true);

    const read = await loadForgeSource(root, r.url, null, { home, git: deniedRemote, mode: "read" });
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0].startsWith(`Forge ${r.url} not fetched (remote: Repository not found.; ${FETCH_NO_ACCESS}) — using the cached copy at `)).toBe(true);
    expect(read.fetchFallback).toBe(read.warnings[0]);
  });

  it("a failure that is not about access keeps the words it had", async () => {
    const root = await tmpDir("craftar-hint-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const url = "https://example.invalid/acme/forge.git";
    const offline: GitRunner = async (args) => {
      if (args.includes("ls-remote")) throw new Error("Could not resolve host: example.invalid");
      return "";
    };
    const message = await messageOf(loadForgeSource(root, url, null, { home, git: offline, mode: "read" }));
    expect(message).toBe(`cannot fetch the Forge ${url}: Could not resolve host: example.invalid — and there is no cached copy to fall back on`);
  });
});
