import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneCache, type PruneOptions } from "../src/core/cache.js";
import { cacheKey, ensureTree } from "../src/core/remote.js";
import { tmpDir, profile, recipe, rule, writeFiles } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// Spec 26 §4.2 step 0, §4.3, §9 — the prune lock, a crash mid-removal, a file held open, leftovers.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };
const RUN: PruneOptions = { dryRun: false, workspace: null, registryOff: false };
const ls = (dir: string) => fs.readdir(dir).then((n) => n.sort(), () => null);
const old = new Date("2020-01-01T00:00:00Z");

async function setup() {
  const home = await tmpDir("craftar-home-");
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const r = await remoteForge(SPEC);
  cleanups.push(r.cleanup);
  await ensureTree(r.url, null, { home });
  const key = cacheKey(r.url);
  return { home, r, key, forges: path.join(home, "forges"), entry: path.join(home, "forges", key) };
}

describe("a crash mid-removal (§4.3)", () => {
  async function crashed() {
    const s = await setup();
    const removal = path.join(s.forges, `~removing-${s.key}-99999`);
    await fs.mkdir(removal);
    await fs.rename(path.join(s.entry, "fetched"), path.join(removal, "fetched"));
    await fs.writeFile(path.join(s.entry, "lock"), "99999 2026-10-08T00:00:00.000Z\n");
    await fs.writeFile(path.join(s.forges, "prune.lock"), "99999 2026-10-08T00:00:00.000Z\n");
    return { ...s, removal };
  }

  it("readers see no copy; a removing prune exits at step 0 while prune.lock is fresh; --dry-run still reports", async () => {
    const c = await crashed();
    await expect(ensureTree(c.r.url, null, { home: c.home, offline: true })).rejects.toThrow(`the Forge ${c.r.url} has no cached copy yet`);
    await expect(pruneCache(c.home, { ...RUN, waitMs: 200, pollMs: 20 })).rejects.toThrow(
      `the Forge cache prune lock ${path.join(c.forges, "prune.lock")} is busy (held by PID 99999)`,
    );
    expect(await ls(c.forges)).toEqual([c.key, `~removing-${c.key}-99999`, "prune.lock"].sort());
    const dry = (await pruneCache(c.home, { ...RUN, dryRun: true })).report;
    expect(dry.removed.map((x) => [x.path, x.kind, x.reason])).toEqual([
      [`forges/${c.key}`, "entry", "incomplete"],
      [`forges/~removing-${c.key}-99999`, "leftover", "interrupted"],
    ]);
  });

  it("once both locks are stale: the prune takes them over, removes the incomplete entry and the leftover", async () => {
    const c = await crashed();
    await fs.utimes(path.join(c.entry, "lock"), old, old);
    await fs.utimes(path.join(c.forges, "prune.lock"), old, old);
    const { report } = await pruneCache(c.home, { ...RUN, staleMs: 1_000 });
    expect(report.removed.map((x) => [x.path, x.kind, x.reason])).toEqual([
      [`forges/${c.key}`, "entry", "incomplete"],
      [`forges/~removing-${c.key}-99999`, "leftover", "interrupted"],
    ]);
    expect([report.kept, report.warnings]).toEqual([[], []]);
    expect(await ls(c.forges)).toEqual([]);
  });

  it("once the entry lock is stale: a fetch restores the entry instead", async () => {
    const c = await crashed();
    await fs.utimes(path.join(c.entry, "lock"), old, old);
    expect((await ensureTree(c.r.url, null, { home: c.home, staleMs: 1_000 })).fetched).toBe(true);
    expect(await ls(c.entry)).toEqual(["fetched", "repo.git", "trees"]);
  });
});

describe("the prune lock (§4.2 step 0, §13 item 15)", () => {
  it("a second prune while one holds prune.lock: waits, then exits with withLock's message, nothing removed", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.forges, "prune.lock"), `${process.pid} ${new Date().toISOString()}\n`);
    await expect(pruneCache(s.home, { ...RUN, waitMs: 300, pollMs: 20 })).rejects.toThrow(
      `the Forge cache prune lock ${path.join(s.forges, "prune.lock")} is busy (held by PID ${process.pid})`,
    );
    expect(await ls(s.forges)).toEqual([s.key, "prune.lock"].sort());
  });

  it("a second prune started while the first waits on its prune.lock completes after it", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let steps = 0;
    const first = pruneCache(s.home, { ...RUN, beforeStep: async () => { if (steps++ === 0) await gate; } });
    while (!(await ls(s.forges))!.includes("prune.lock")) await new Promise((r) => setTimeout(r, 10));
    const second = pruneCache(s.home, { ...RUN, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 200));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.report.removed.map((x) => x.reason), b.report.removed]).toEqual([["orphan"], []]);
  });

  it("the run refreshes prune.lock's mtime as it goes, so a prune started past the stale bound still waits", async () => {
    const s = await setup();
    for (const n of ["globex", "initech"]) {
      const extra = await remoteForge(SPEC);
      cleanups.push(extra.cleanup);
      await ensureTree(extra.url, null, { home: s.home });
      void n;
    }
    const slow = () => new Promise<void>((r) => setTimeout(r, 400));
    const first = pruneCache(s.home, { ...RUN, staleMs: 600, beforeStep: slow });
    await new Promise((r) => setTimeout(r, 900));
    const second = await pruneCache(s.home, { ...RUN, staleMs: 600, waitMs: 100, pollMs: 20 }).catch((e: Error) => e);
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toBe(`the Forge cache prune lock ${path.join(s.forges, "prune.lock")} is busy (held by PID ${process.pid})`);
    expect((await first).report.removed.map((x) => x.kind)).toEqual(["entry", "entry", "entry"]);
  });
});

describe("a file held open, leftovers, and a key shaped like a removal directory", () => {
  it("a rename that fails EBUSY: kept held-open, its parts moved back, the warning; exit data", async () => {
    const s = await setup();
    const rename = async (from: string, to: string) => {
      if (path.basename(from) === "repo.git" && path.dirname(from) === s.entry) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.rename(from, to);
    };
    const { report } = await pruneCache(s.home, { ...RUN, rename });
    expect([report.removed, report.kept, report.warnings]).toEqual([
      [],
      [{ path: `forges/${s.key}`, reason: "held-open", namedBy: [] }],
      [`${s.key} is held open (EBUSY) — kept`],
    ]);
    expect(await ls(s.entry)).toEqual(["fetched", "repo.git", "trees"]);
    expect(await ls(s.forges)).toEqual([s.key]);
  });

  it("a leftover ~removing- directory: removed, its bytes freed, never listed as an entry", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.home, "registry.json"), JSON.stringify({ schema: 1, workspaces: [] }));
    await writeFiles(s.forges, { "~removing-example.com-old-0a1b2c3d4e5f-4242/repo.git/HEAD": "12345" });
    const { report } = await pruneCache(s.home, { ...RUN, registryOff: true });
    expect(report.removed).toEqual([{ path: "forges/~removing-example.com-old-0a1b2c3d4e5f-4242", kind: "leftover", reason: "interrupted", bytes: 5 }]);
    expect(report.kept).toEqual([{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }]);
    expect(report.freedBytes).toBe(5);
    expect(await ls(s.forges)).toEqual([s.key]);
  });

  it("an entry whose key starts .removing-, cached and named: kept, never taken for a removal directory", async () => {
    const s = await setup();
    const odd = ".removing-acme-0123456789ab";
    await writeFiles(path.join(s.forges, odd), { fetched: "2026-10-08T00:00:00.000Z\n", "repo.git/HEAD": "x" });
    const entry = (key: string, name: string) => ({
      path: path.join(s.home, name),
      profile: "acme",
      forge: { kind: "remote", source: "https://example.com/acme.git", key, ref: null, commit: null, fromLocalFile: false },
      recipes: ["base"],
      stack: {},
      targets: ["claude-code"],
      lastSync: "2026-10-08T00:00:00.000Z",
    });
    await fs.writeFile(path.join(s.home, "registry.json"), JSON.stringify({ schema: 1, workspaces: [entry(odd, "ws-odd"), entry(s.key, "ws-acme")] }));
    const { report } = await pruneCache(s.home, RUN);
    expect(report.removed).toEqual([]);
    expect(report.kept.map((k) => [k.path, k.reason])).toEqual([[`forges/${odd}`, "named"], [`forges/${s.key}`, "named"]]);
    expect(await ls(s.forges)).toEqual([odd, s.key].sort());
  });
});
