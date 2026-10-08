import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneCache, type PruneOptions } from "../src/core/cache.js";
import { prune as pruneRegistry, register } from "../src/core/registry.js";
import { cacheKey, ensureTree, inspectCache } from "../src/core/remote.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { makeWorkspace, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// Spec 26 §4.2–§4.5, §6, §9 — `pruneCache` on synthetic homes, remote Forges and workspaces.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const RUN: PruneOptions = { dryRun: false, workspace: null, registryOff: false };
const ls = (dir: string) => fs.readdir(dir).then((n) => n.sort(), () => null);

async function setup() {
  const root = await tmpDir("craftar-prune-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const r = await remoteForge(SPEC);
  cleanups.push(r.cleanup);
  const key = cacheKey(r.url);
  const ws = async (name: string, config: Record<string, unknown> = { profile: "acme", forge: r.url }) => {
    const dir = path.join(root, name);
    await makeWorkspace(dir, root, { config });
    return fs.realpath(dir);
  };
  const syncAndRegister = async (dir: string) => {
    const w = await loadWorkspace(dir, { home });
    const p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(w.root)));
    await register(home, w, p);
  };
  const entryBytes = async (k: string) => (await inspectCache(home)).entries.find((e) => e.key === k)!.bytes;
  return { root, home, r, key, entry: path.join(home, "forges", key), ws, syncAndRegister, entryBytes };
}

describe("whole entries (§4.2 steps 2–4)", () => {
  it("an orphan entry is removed, its bytes freed; forges/ is left empty, the prune lock released", async () => {
    const s = await setup();
    await ensureTree(s.r.url, null, { home: s.home });
    const bytes = await s.entryBytes(s.key);
    const { report, header } = await pruneCache(s.home, RUN);
    expect(report).toEqual({
      home: s.home,
      dryRun: false,
      removed: [{ path: `forges/${s.key}`, kind: "entry", reason: "orphan", bytes }],
      kept: [],
      freedBytes: bytes,
      warnings: [],
    });
    expect(header).toEqual({ forges: path.join(s.home, "forges"), entries: 1, bytes });
    expect(await ls(path.join(s.home, "forges"))).toEqual([]);
  });

  it("an entry named by a registry entry is kept, with who names it", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    const { report } = await pruneCache(s.home, RUN);
    expect([report.removed, report.kept, report.warnings]).toEqual([[], [{ path: `forges/${s.key}`, reason: "named", namedBy: [dir] }], []]);
  });

  it("named by a missing registry entry: kept; after workspaces prune: removed", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await fs.rm(dir, { recursive: true, force: true });
    expect((await pruneCache(s.home, RUN)).report.kept).toEqual([{ path: `forges/${s.key}`, reason: "named", namedBy: [dir] }]);
    expect(await pruneRegistry(s.home)).toEqual([dir]);
    expect((await pruneCache(s.home, RUN)).report.removed.map((x) => [x.path, x.reason])).toEqual([[`forges/${s.key}`, "orphan"]]);
  });

  it("named only by the current, unregistered workspace: kept; from another directory: removed", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await loadWorkspace(dir, { home: s.home });
    expect((await pruneCache(s.home, { ...RUN, workspace: dir })).report.kept).toEqual([{ path: `forges/${s.key}`, reason: "named", namedBy: [dir] }]);
    expect((await pruneCache(s.home, RUN)).report.removed.map((x) => [x.path, x.kind, x.reason])).toEqual([[`forges/${s.key}`, "entry", "orphan"]]);
  });

  it("registry off: no whole entry removed, every one unchecked, the warning; old trees still go", async () => {
    const s = await setup();
    const t = await ensureTree(s.r.url, null, { home: s.home });
    await fs.utimes(`${t.dir}.used`, ago(15 * DAY), ago(15 * DAY));
    const { report } = await pruneCache(s.home, { ...RUN, registryOff: true });
    expect(report.kept).toEqual([{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }]);
    expect(report.removed.map((x) => [x.path, x.kind, x.reason])).toEqual([[`forges/${s.key}/trees/${t.commit}`, "tree", "unused"]]);
    expect(report.warnings).toEqual(["whole entries kept: CRAFTAR_NO_REGISTRY is set — nothing can tell which ones are used"]);
    expect(await ls(path.join(s.entry, "trees"))).toEqual([]);
  });

  it("registry unreadable: no whole entry removed, the warning", async () => {
    const s = await setup();
    await ensureTree(s.r.url, null, { home: s.home });
    await fs.writeFile(path.join(s.home, "registry.json"), "{");
    const { report } = await pruneCache(s.home, RUN);
    expect([report.removed, report.kept, report.warnings]).toEqual([
      [],
      [{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }],
      ["whole entries kept: the registry cannot be read — nothing can tell which ones are used"],
    ]);
  });

  it("the current craftar.yaml does not read: no whole entry removed, the warning", async () => {
    const s = await setup();
    await ensureTree(s.r.url, null, { home: s.home });
    const dir = await s.ws("acme-api");
    await fs.writeFile(path.join(dir, "craftar.yaml"), "profile: [\n");
    const { report } = await pruneCache(s.home, { ...RUN, workspace: dir });
    expect([report.removed, report.kept, report.warnings]).toEqual([
      [],
      [{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }],
      ["whole entries kept: the checked craftar.yaml does not read — nothing can tell which ones are used"],
    ]);
  });

  it("an incomplete entry named by the registry and the current workspace, its lock free: removed as incomplete", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await fs.rm(path.join(s.entry, "fetched"));
    const bytes = await s.entryBytes(s.key);
    const { report } = await pruneCache(s.home, { ...RUN, workspace: dir });
    expect([report.removed, report.kept]).toEqual([[{ path: `forges/${s.key}`, kind: "entry", reason: "incomplete", bytes }], []]);
  });

  it("the same incomplete entry with its lock held: kept busy, the warning, exit data intact", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await fs.rm(path.join(s.entry, "fetched"));
    await fs.writeFile(path.join(s.entry, "lock"), "4242 2026-10-08T00:00:00.000Z\n");
    const { report } = await pruneCache(s.home, { ...RUN, workspace: dir, waitMs: 200, pollMs: 20 });
    expect([report.removed, report.kept, report.warnings]).toEqual([
      [],
      [{ path: `forges/${s.key}`, reason: "busy", namedBy: [dir] }],
      [`${s.key} is in use (held by PID 4242) — kept`],
    ]);
  });

  it("the same incomplete entry with the registry off: kept unchecked", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await fs.rm(path.join(s.entry, "fetched"));
    expect((await pruneCache(s.home, { ...RUN, workspace: dir, registryOff: true })).report.kept).toEqual([{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }]);
  });

  it("no forges/ directory: nothing to prune, and forges/ is not created", async () => {
    const s = await setup();
    expect(await pruneCache(s.home, RUN)).toEqual({
      report: { home: s.home, dryRun: false, removed: [], kept: [], freedBytes: 0, warnings: [] },
      header: null,
    });
    expect(await ls(s.home)).toEqual([]);
  });
});

describe("trees (§4.2 step 5)", () => {
  it("in a kept entry: a tree unused for 15 days goes, one used 13 days ago stays; a later read rebuilds the removed one", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    const a = await ensureTree(s.r.url, null, { home: s.home });
    await s.r.commit({ "README.md": "b\n" });
    const b = await ensureTree(s.r.url, null, { home: s.home });
    await fs.utimes(`${a.dir}.used`, ago(15 * DAY), ago(15 * DAY));
    await fs.utimes(`${b.dir}.used`, ago(13 * DAY), ago(13 * DAY));
    const treeBytes = (await inspectCache(s.home)).entries[0].trees.find((t) => t.commit === a.commit)!.bytes;
    const { report } = await pruneCache(s.home, RUN);
    expect(report.removed).toEqual([{ path: `forges/${s.key}/trees/${a.commit}`, kind: "tree", reason: "unused", bytes: treeBytes }]);
    expect(report.kept).toEqual([{ path: `forges/${s.key}`, reason: "named", namedBy: [dir] }]);
    expect(await ls(path.join(s.entry, "trees"))).toEqual([b.commit, `${b.commit}.ok`, `${b.commit}.used`].sort());
    const again = await ensureTree(s.r.url, a.commit, { home: s.home });
    expect([again.dir, again.fetched]).toEqual([a.dir, false]);
  });
});

describe("--dry-run (§6 case 7)", () => {
  it("reports the set a run removes, removes nothing, takes no lock, and runs beside a held prune lock", async () => {
    const s = await setup();
    const t = await ensureTree(s.r.url, null, { home: s.home });
    await fs.rm(`${t.dir}.used`);
    await fs.utimes(`${t.dir}.ok`, ago(15 * DAY), ago(15 * DAY));
    await writeFiles(path.join(s.home, "forges"), { "~removing-example.com-old-0a1b2c3d4e5f-4242/fetched": "abc" });
    const lock = path.join(s.home, "forges", "prune.lock");
    await fs.writeFile(lock, "4242 2026-10-08T00:00:00.000Z\n");
    const bytes = await s.entryBytes(s.key);
    const before = await ls(path.join(s.home, "forges"));
    const dry = (await pruneCache(s.home, { ...RUN, dryRun: true, registryOff: true })).report;
    expect(dry).toEqual({
      home: s.home,
      dryRun: true,
      removed: [
        { path: `forges/${s.key}/trees/${t.commit}`, kind: "tree", reason: "unused", bytes: expect.any(Number) },
        { path: "forges/~removing-example.com-old-0a1b2c3d4e5f-4242", kind: "leftover", reason: "interrupted", bytes: 3 },
      ],
      kept: [{ path: `forges/${s.key}`, reason: "unchecked", namedBy: [] }],
      freedBytes: dry.removed[0].bytes + 3,
      warnings: ["whole entries kept: CRAFTAR_NO_REGISTRY is set — nothing can tell which ones are used"],
    });
    expect(await ls(path.join(s.home, "forges"))).toEqual(before);
    expect(await fs.readFile(lock, "utf8")).toBe("4242 2026-10-08T00:00:00.000Z\n");
    expect(await s.entryBytes(s.key)).toBe(bytes);
    await fs.rm(lock);
    const run = (await pruneCache(s.home, { ...RUN, registryOff: true })).report;
    expect({ ...run, dryRun: true }).toEqual(dry);
  });

  it("an orphan entry: would remove, and the run removes the same", async () => {
    const s = await setup();
    await ensureTree(s.r.url, null, { home: s.home });
    const dry = (await pruneCache(s.home, { ...RUN, dryRun: true })).report;
    expect(dry.removed.map((x) => [x.path, x.kind, x.reason])).toEqual([[`forges/${s.key}`, "entry", "orphan"]]);
    expect(await ls(path.join(s.home, "forges"))).toEqual([s.key]);
    expect({ ...(await pruneCache(s.home, RUN)).report, dryRun: true }).toEqual(dry);
  });
});

describe("the report (§4.5) and what is never touched (§7)", () => {
  it("--json keys in the contract's order, for a run and a --dry-run", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await ensureTree((await remoteForge(SPEC).then((x) => (cleanups.push(x.cleanup), x))).url, null, { home: s.home });
    for (const dryRun of [true, false]) {
      const { report } = await pruneCache(s.home, { ...RUN, dryRun });
      expect(Object.keys(report)).toEqual(["home", "dryRun", "removed", "kept", "freedBytes", "warnings"]);
      expect(report.removed.map((x) => Object.keys(x))).toEqual([["path", "kind", "reason", "bytes"]]);
      expect(report.kept.map((x) => Object.keys(x))).toEqual([["path", "reason", "namedBy"]]);
    }
  });

  it("a workspace, its lock and the registry are byte-identical before and after", async () => {
    const s = await setup();
    const dir = await s.ws("acme-api");
    await s.syncAndRegister(dir);
    await ensureTree((await remoteForge(SPEC).then((x) => (cleanups.push(x.cleanup), x))).url, null, { home: s.home });
    const digest = async () => {
      const out: string[] = [];
      const walk = async (d: string) => {
        for (const n of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const p = path.join(d, n.name);
          if (n.isDirectory()) await walk(p);
          else out.push(`${path.relative(s.root, p)} ${createHash("sha256").update(await fs.readFile(p)).digest("hex")}`);
        }
      };
      await walk(dir);
      out.push(`registry ${createHash("sha256").update(await fs.readFile(path.join(s.home, "registry.json"))).digest("hex")}`);
      return out;
    };
    const before = await digest();
    const { report } = await pruneCache(s.home, { ...RUN, workspace: dir });
    expect(report.removed.map((x) => x.kind)).toEqual(["entry"]);
    expect(await digest()).toEqual(before);
  });
});
