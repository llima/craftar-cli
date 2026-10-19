import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNotCacheTree } from "../src/core/remote.js";
import { tmpDir } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("assertNotCacheTree", () => {
  it("a directory equal to <home>/forges is refused", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    await expect(assertNotCacheTree(path.join(home, "forges"), home)).rejects.toThrow(/is a tree of craftar's Forge cache/);
  });

  it("a directory under <home>/forges is refused", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const nested = path.join(home, "forges", "k", "trees", "c");
    await fs.mkdir(nested, { recursive: true });
    await expect(assertNotCacheTree(nested, home)).rejects.toThrow(/is a tree of craftar's Forge cache/);
  });

  it("a sibling named forges2 is not refused", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    const sibling = path.join(home, "forges2", "x");
    await fs.mkdir(sibling, { recursive: true });
    await expect(assertNotCacheTree(sibling, home)).resolves.toBeUndefined();
  });

  it("a directory outside the home is not refused", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    const outside = await fs.realpath(await tmpDir("craftar-outside-"));
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    await expect(assertNotCacheTree(outside, home)).resolves.toBeUndefined();
  });

  it("a missing <home>/forges passes", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    // home exists but no forges/ subdirectory
    await expect(assertNotCacheTree(home, home)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("a forges that cannot be resolved fails closed", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    // symlink to itself → ELOOP
    const forgesPath = path.join(home, "forges");
    await fs.symlink(forgesPath, forgesPath);
    await expect(assertNotCacheTree(path.join(home, "forges", "x"), home)).rejects.toThrow();
    // The error is NOT the cache-tree message (it's ELOOP or similar)
    try {
      await assertNotCacheTree(path.join(home, "forges", "x"), home);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/is a tree of craftar's Forge cache/);
    }
  });

  it("the message hides the cache entry's name", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const nested = path.join(home, "forges", "k", "trees", "c");
    await fs.mkdir(nested, { recursive: true });
    let message = "";
    try {
      await assertNotCacheTree(nested, home);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      `${path.join(home, "forges", "(a cache entry name — not shown)", "trees", "c")} is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory`,
    );
    expect(message).not.toContain(`${path.sep}k${path.sep}`);
  });

  it("a directory equal to <home>/forges is named as <home>/forges", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    let message = "";
    try {
      await assertNotCacheTree(path.join(home, "forges"), home);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      `${path.join(home, "forges")} is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory`,
    );
  });

  it("a cache tree named through a junction is shown by its real place, not the link", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const nested = path.join(home, "forges", "k", "trees", "c");
    await fs.mkdir(nested, { recursive: true });
    const otherDir = await fs.realpath(await tmpDir("craftar-link-"));
    cleanups.push(() => fs.rm(otherDir, { recursive: true, force: true }));
    const link = path.join(otherDir, "lnk");
    await fs.symlink(nested, link, "junction");
    let message = "";
    try {
      await assertNotCacheTree(link, home);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      `${path.join(home, "forges", "(a cache entry name — not shown)", "trees", "c")} is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory`,
    );
    expect(message).not.toContain(link);
  });

  it("a directory that does not exist yet, under <home>/forges, is refused", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    await expect(assertNotCacheTree(path.join(home, "forges", "k", "new"), home)).rejects.toThrow(
      `${path.join(home, "forges", "(a cache entry name — not shown)", "new")} is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory`,
    );
  });

  it("a directory that does not exist yet, outside the cache, passes", async () => {
    const home = await fs.realpath(await tmpDir("craftar-checktree-"));
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, "forges"), { recursive: true });
    await expect(assertNotCacheTree(path.join(home, "elsewhere", "new"), home)).resolves.toBeUndefined();
  });
});
