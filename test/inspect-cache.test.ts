import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKey, ensureTree, inspectCache } from "../src/core/remote.js";
import { profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// Spec 24 §5.1: a read-only snapshot of the Forge cache.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

describe("inspectCache", () => {
  it("no forges directory → an empty snapshot", async () => {
    const home = await tmpDir();
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    expect(await inspectCache(home)).toEqual({ forges: path.join(home, "forges"), entries: [], removing: [], bytes: 0 });
  });

  it("an entry after a fetch: fetched, its tree complete, its size summed; an incomplete entry apart; the total counts loose files too", async () => {
    const home = await tmpDir();
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const t = await ensureTree(r.url, null, { home });
    await writeFiles(path.join(home, "forges", "example.com-half-000000000000"), { "repo.git/HEAD": "ref: refs/heads/main\n" });
    await fs.writeFile(path.join(home, "forges", "stray.txt"), "12345");
    const snap = await inspectCache(home);
    expect(snap.entries.map((e) => e.key).sort()).toEqual([cacheKey(r.url), "example.com-half-000000000000"].sort());
    expect(snap.bytes).toBe(snap.entries.reduce((n, e) => n + e.bytes, 0) + 5);
    const byKey = Object.fromEntries(snap.entries.map((e) => [e.key, e]));
    const full = byKey[cacheKey(r.url)];
    expect(full.fetched).toBe(true);
    expect(full.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(full.bytes).toBeGreaterThan(0);
    expect(full.trees).toEqual([{ commit: t.commit, complete: true, lastUse: expect.any(Number), bytes: expect.any(Number) }]);
    expect(byKey["example.com-half-000000000000"]).toMatchObject({ fetched: false, fetchedAt: null, trees: [] });
  });

  it("a tree's last use falls back to .ok, then to the directory, when .used is gone", async () => {
    const home = await tmpDir();
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const trees = path.join(home, "forges", "k", "trees");
    await writeFiles(trees, { "c1/x": "x", "c1.ok": "t\n", "c2/x": "x" });
    const old = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(path.join(trees, "c1.ok"), old, old);
    const dirTime = new Date("2021-01-01T00:00:00Z");
    await fs.utimes(path.join(trees, "c2"), dirTime, dirTime);
    const [e] = (await inspectCache(home)).entries;
    expect(e.trees).toEqual([
      { commit: "c1", complete: true, lastUse: old.getTime(), bytes: 3 },
      { commit: "c2", complete: false, lastUse: dirTime.getTime(), bytes: 1 },
    ]);
  });
});
