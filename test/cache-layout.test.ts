import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockBusyError } from "../src/core/home-lock.js";
import { REMOVING_PREFIX, cacheDir, cacheKey, defaultGit, ensureTree, inspectCache, pruneTrees, removeEntry, removeLeftover, withPruneLock } from "../src/core/remote.js";
import { profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 26 §4.2–§4.3, §5.1: what `craftar cache prune` asks of the module that owns the cache layout.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function home() {
  const h = await tmpDir("craftar-home-");
  cleanups.push(() => fs.rm(h, { recursive: true, force: true }));
  return h;
}
async function cached(h: string) {
  const r = await remoteForge(SPEC);
  cleanups.push(r.cleanup);
  const t = await ensureTree(r.url, null, { home: h });
  return { r, t, key: cacheKey(r.url), entry: path.join(h, "forges", cacheKey(r.url)) };
}
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((res) => setTimeout(res, 10));
  }
}
const ls = (dir: string) => fs.readdir(dir).then((n) => n.sort(), () => null);

describe("inspectCache lists removal directories apart (§5.1)", () => {
  it("a ~removing- directory is never an entry; its bytes count in the total", async () => {
    const h = await home();
    const forges = path.join(h, "forges");
    await writeFiles(forges, { [`${REMOVING_PREFIX}example.com-old-0a1b2c3d4e5f-4242/fetched`]: "abc", "example.com-k-000000000000/fetched": "2026-10-08T00:00:00.000Z\n" });
    const snap = await inspectCache(h);
    expect(snap.entries.map((e) => e.key)).toEqual(["example.com-k-000000000000"]);
    expect(snap.removing).toEqual([{ dir: path.join(forges, `${REMOVING_PREFIX}example.com-old-0a1b2c3d4e5f-4242`), bytes: 3 }]);
    expect(snap.bytes).toBe(3 + 25);
  });

  it("a key that starts .removing- is an entry like any other (§13 item 14)", async () => {
    const h = await home();
    await writeFiles(path.join(h, "forges"), { ".removing-acme-0123456789ab/fetched": "2026-10-08T00:00:00.000Z\n" });
    const snap = await inspectCache(h);
    expect([snap.entries.map((e) => e.key), snap.removing]).toEqual([[".removing-acme-0123456789ab"], []]);
  });

  it("a tree's bytes are its directory plus its .ok and .used", async () => {
    const h = await home();
    await writeFiles(path.join(h, "forges", "k", "trees"), { "c1/x": "xx", "c1.ok": "t\n", "c1.used": "" });
    const [e] = (await inspectCache(h)).entries;
    expect(e.trees.map((t) => [t.commit, t.bytes])).toEqual([["c1", 4]]);
  });
});

describe("pruneTrees (§4.2 step 5)", () => {
  it("removes the trees unused for 14 days, with their stamps, keeps the others, and prunes git's worktree list", async () => {
    const h = await home();
    const { r, t: a, entry } = await cached(h);
    await r.commit({ "README.md": "b\n" });
    const b = await ensureTree(r.url, null, { home: h });
    await fs.utimes(`${a.dir}.used`, ago(15 * DAY), ago(15 * DAY));
    await fs.utimes(`${b.dir}.used`, ago(13 * DAY), ago(13 * DAY));
    const before = (await inspectCache(h)).entries[0].trees.find((x) => x.commit === a.commit)!.bytes;
    expect(before).toBeGreaterThan(0);
    expect(await pruneTrees(entry, {})).toEqual({ removed: [{ commit: a.commit, bytes: before }], busy: null });
    expect(await ls(path.join(entry, "trees"))).toEqual([b.commit, `${b.commit}.ok`, `${b.commit}.used`].sort());
    expect(git(path.join(entry, "repo.git"), "worktree", "list", "--porcelain")).not.toContain(a.commit);
  });

  it("without inUse, even the newest tree goes when it is old", async () => {
    const h = await home();
    const { t, entry } = await cached(h);
    await fs.utimes(`${t.dir}.used`, ago(15 * DAY), ago(15 * DAY));
    expect((await pruneTrees(entry, {})).removed.map((x) => x.commit)).toEqual([t.commit]);
    expect(await ls(path.join(entry, "trees"))).toEqual([]);
  });
});

describe("removeEntry (§4.3)", () => {
  it("a fetched entry: its contents move out, the entry and the removal directory go", async () => {
    const h = await home();
    const { entry } = await cached(h);
    expect(await removeEntry(entry, async () => true, {})).toEqual({ outcome: "removed", warnings: [] });
    expect(await ls(path.join(h, "forges"))).toEqual([]);
  });

  it("an entry with only trees/, and an empty one, are removed too (missing parts skipped)", async () => {
    const h = await home();
    const forges = path.join(h, "forges");
    await writeFiles(forges, { "example.com-t-000000000000/trees/c1/x": "x" });
    await fs.mkdir(path.join(forges, "example.com-e-000000000000"));
    expect(await removeEntry(path.join(forges, "example.com-t-000000000000"), async () => true, {})).toEqual({ outcome: "removed", warnings: [] });
    expect(await removeEntry(path.join(forges, "example.com-e-000000000000"), async () => true, {})).toEqual({ outcome: "removed", warnings: [] });
    expect(await ls(forges)).toEqual([]);
  });

  it("the re-check under the lock says no: the entry is kept untouched", async () => {
    const h = await home();
    const { entry } = await cached(h);
    let checkedUnderLock = false;
    const out = await removeEntry(entry, async () => {
      checkedUnderLock = (await ls(entry))!.includes("lock");
      return false;
    }, {});
    expect([out, checkedUnderLock]).toEqual([{ outcome: "kept", warnings: [] }, true]);
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
  });

  it("a busy entry lock: kept, the holder named, nothing moved", async () => {
    const h = await home();
    const { entry } = await cached(h);
    await fs.writeFile(path.join(entry, "lock"), "4242 2026-10-08T00:00:00.000Z\n");
    expect(await removeEntry(entry, async () => true, { waitMs: 200, pollMs: 20 })).toEqual({ outcome: "busy", holder: "4242", warnings: [] });
    expect(await ls(entry)).toEqual(["fetched", "lock", "repo.git", "trees"]);
  });

  it("a rename that fails EBUSY: the moved parts move back, held-open with the warning, no removal directory left", async () => {
    const h = await home();
    const { entry, key } = await cached(h);
    const rename = async (from: string, to: string) => {
      if (path.basename(from) === "repo.git" && path.dirname(from) === entry) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.rename(from, to);
    };
    expect(await removeEntry(entry, async () => true, { rename })).toEqual({ outcome: "held-open", code: "EBUSY", warnings: [`${key} is held open (EBUSY) — kept`] });
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
    expect(await ls(path.join(h, "forges"))).toEqual([key]);
  });

  it("a fetch waiting on the lock, waking after the rmdir: it re-creates the entry and fetches a fresh copy", async () => {
    const h = await home();
    const { r, entry } = await cached(h);
    let attempts = 0;
    let waiter: Promise<{ fetched: boolean }> | null = null;
    const out = await removeEntry(entry, async () => {
      waiter = ensureTree(r.url, null, { home: h, pollMs: 20, beforeAttempt: async () => void attempts++ });
      await until(() => attempts >= 1);
      return true;
    }, {});
    expect(out).toEqual({ outcome: "removed", warnings: [] });
    expect((await waiter!).fetched).toBe(true);
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
  });

  it("a fetch waiting on the lock that takes it before the rmdir: the rmdir fails harmlessly, the fetch completes", async () => {
    const h = await home();
    const { r, entry } = await cached(h);
    let attempts = 0;
    let inFetch = false;
    let removed = false;
    let lockAtRmdir: boolean | null = null;
    let waiter: Promise<{ fetched: boolean }> | null = null;
    // The waiter's fetch runs under its lock: held there until the removal has returned, so the rmdir
    // falls while the lock file is in the entry.
    const heldGit: typeof defaultGit = async (args, opts) => {
      if (args.includes("fetch")) {
        inFetch = true;
        await until(() => removed);
      }
      return defaultGit(args, opts);
    };
    const out = await removeEntry(entry, async () => {
      waiter = ensureTree(r.url, null, { home: h, pollMs: 20, git: heldGit, beforeAttempt: async () => void attempts++ });
      await until(() => attempts >= 1);
      return true;
    }, { afterRelease: async () => { await until(() => inFetch); lockAtRmdir = (await ls(entry))?.includes("lock") ?? false; } }).finally(() => { removed = true; });
    expect(lockAtRmdir).toBe(true);
    expect(out).toEqual({ outcome: "removed", warnings: [] });
    expect((await waiter!).fetched).toBe(true);
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
    expect((await ls(path.join(h, "forges")))!.filter((n) => n.startsWith(REMOVING_PREFIX))).toEqual([]);
  });

  it("the rmdir falling between the waiter's mkdir and its write: ENOENT retried, the fetch completes", async () => {
    const h = await home();
    const { r, entry } = await cached(h);
    let attempts = 0;
    let released = false;
    let raced = 0;
    let goneAtWrite: boolean | null = null;
    let waiter: Promise<{ fetched: boolean }> | null = null;
    const beforeAttempt = async () => {
      attempts++;
      // The first attempt finds the pruner's lock (EEXIST). The second is held here, after its mkdir,
      // until the pruner has released — so the waiter cannot take the lock first — and then removes the
      // emptied entry itself, standing in for the pruner's rmdir, which waits for it below.
      if (attempts === 1 || raced === 1) return;
      await until(() => released);
      raced++;
      // The pruner's unlink of its lock may still be landing on Windows: the directory is then not
      // empty yet. The product's own rmdir ignores that; the staged one waits for it.
      await until(() => fs.rmdir(entry).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code !== "ENOTEMPTY" && e.code !== "EPERM") throw e; return false; }));
      goneAtWrite = (await ls(entry)) === null;
    };
    const out = await removeEntry(entry, async () => {
      waiter = ensureTree(r.url, null, { home: h, pollMs: 20, beforeAttempt });
      // Two attempts: the first has failed on the lock, the second is parked in the hook.
      await until(() => attempts >= 2);
      return true;
    }, { afterRelease: async () => { released = true; await until(() => goneAtWrite !== null); } });
    expect(out).toEqual({ outcome: "removed", warnings: [] });
    expect((await waiter!).fetched).toBe(true);
    // The rmdir fell on the second attempt, between its mkdir and its write: that write found no directory.
    expect([raced, goneAtWrite]).toEqual([1, true]);
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
  });

  it("the rmdir arriving after the waiter's fetch refilled the entry: it fails harmlessly, the read completes", async () => {
    const h = await home();
    const { r, entry } = await cached(h);
    let attempts = 0;
    let waiter: Promise<{ fetched: boolean }> | null = null;
    const out = await removeEntry(entry, async () => {
      waiter = ensureTree(r.url, null, { home: h, pollMs: 20, beforeAttempt: async () => void attempts++ });
      await until(() => attempts >= 1);
      return true;
    }, {
      // The pruner's rmdir waits until the waiter's fetch has refilled the entry.
      afterRelease: () => until(async () => (await ls(entry))?.includes("fetched") ?? false),
    });
    expect(out).toEqual({ outcome: "removed", warnings: [] });
    expect((await waiter!).fetched).toBe(true);
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
    expect((await ls(path.join(h, "forges")))!.filter((n) => n.startsWith(REMOVING_PREFIX))).toEqual([]);
  });

  it("a reader waiting to rebuild a tree fails cleanly, leaves an incomplete entry, and the next read fetches again", async () => {
    const h = await home();
    const { r, t, entry } = await cached(h);
    await fs.rm(`${t.dir}.ok`);
    let attempts = 0;
    let reader: Promise<unknown> | null = null;
    await removeEntry(entry, async () => {
      reader = ensureTree(r.url, t.commit, { home: h, pollMs: 20, beforeAttempt: async () => void attempts++ }).catch((e: Error) => e);
      await until(() => attempts >= 1);
      return true;
    }, {});
    expect(((await reader!) as Error).message.startsWith(`cannot create the Forge tree ${t.dir}`)).toBe(true);
    expect((await inspectCache(h)).entries.map((e) => [e.key, e.fetched])).toEqual([[cacheKey(r.url), false]]);
    expect((await ensureTree(r.url, null, { home: h })).fetched).toBe(true);
  });

  it("a leftover removal directory with this run's name is cleared before the move", async () => {
    const h = await home();
    const { entry, key } = await cached(h);
    await writeFiles(path.join(h, "forges", `~removing-${key}-${process.pid}`), { "repo.git/HEAD": "old" });
    expect(await removeEntry(entry, async () => true, {})).toEqual({ outcome: "removed", warnings: [] });
    expect(await ls(path.join(h, "forges"))).toEqual([]);
  });

  it("a move back that fails too: the part stays in the removal directory, a second warning", async () => {
    const h = await home();
    const { entry, key } = await cached(h);
    const removal = path.join(h, "forges", `~removing-${key}-${process.pid}`);
    const rename = async (from: string, to: string) => {
      if (path.basename(from) === "repo.git" && path.dirname(from) === entry) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      if (path.basename(from) === "fetched" && path.dirname(from) === removal) throw Object.assign(new Error("perm"), { code: "EPERM" });
      await fs.rename(from, to);
    };
    expect(await removeEntry(entry, async () => true, { rename })).toEqual({
      outcome: "held-open",
      code: "EBUSY",
      warnings: [`${key} is held open (EBUSY) — kept`, `${key}: fetched left in ${removal} (EPERM) — the next prune removes it`],
    });
    expect([await ls(entry), await ls(removal)]).toEqual([["repo.git", "trees"], ["fetched"]]);
  });
});

describe("withPruneLock and removeLeftover (§4.2 steps 0 and 6)", () => {
  it("holds forges/prune.lock for the body; refresh advances its mtime; released after", async () => {
    const h = await home();
    await fs.mkdir(path.join(h, "forges"));
    const lock = path.join(h, "forges", "prune.lock");
    const seen = await withPruneLock(h, {}, async ({ refresh, bytes }) => {
      await fs.utimes(lock, ago(DAY), ago(DAY));
      const old = (await fs.stat(lock)).mtimeMs;
      await refresh();
      return [(await fs.readFile(lock, "utf8")).split(" ")[0], (await fs.stat(lock)).mtimeMs > old + DAY / 2, bytes === (await fs.stat(lock)).size];
    });
    expect(seen).toEqual([String(process.pid), true, true]);
    expect(await ls(path.join(h, "forges"))).toEqual([]);
  });

  it("a held prune lock: a LockBusyError after the wait; a missing forges/ is not created", async () => {
    const h = await home();
    await fs.mkdir(path.join(h, "forges"));
    const lock = path.join(h, "forges", "prune.lock");
    await fs.writeFile(lock, "4242 2026-10-08T00:00:00.000Z\n");
    const err = await withPruneLock(h, { waitMs: 200, pollMs: 20 }, async () => "ran").catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect((err as Error).message).toBe(`the Forge cache prune lock ${lock} is busy (held by PID 4242)`);
    const bare = await home();
    await expect(withPruneLock(bare, {}, async () => "ran")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ls(bare)).toEqual([]);
  });

  it("removeLeftover deletes a removal directory and returns null", async () => {
    const h = await home();
    const dir = path.join(h, "forges", `${REMOVING_PREFIX}k-1`);
    await writeFiles(dir, { "repo.git/HEAD": "x", fetched: "y" });
    expect(await removeLeftover(dir)).toBeNull();
    expect(await ls(path.join(h, "forges"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("removeLeftover that cannot delete returns the warning", async () => {
    const h = await home();
    const dir = path.join(h, "forges", `${REMOVING_PREFIX}k-1`);
    await writeFiles(dir, { "sub/file": "x" });
    await fs.chmod(path.join(dir, "sub"), 0o500);
    cleanups.push(() => fs.chmod(path.join(dir, "sub"), 0o700));
    expect(await removeLeftover(dir)).toBe(`cannot remove ${dir}: EACCES — the next prune retries it`);
  });
});

// Review round 1: the layout stays in remote.ts.
describe("review round 1: the layout stays in remote.ts", () => {
  it("cacheDir: absent, present, or a refusal naming the path", async () => {
    const h = await home();
    expect(await cacheDir(h)).toBe("absent");
    await fs.mkdir(path.join(h, "forges"));
    expect(await cacheDir(h)).toBe("present");
    await fs.rm(path.join(h, "forges"), { recursive: true });
    await fs.writeFile(path.join(h, "forges"), "x");
    await expect(cacheDir(h)).rejects.toThrow(`cannot read ${path.join(h, "forges")}: not a directory`);
  });

  it("the re-check is handed the fetched stamp as read under the lock", async () => {
    const h = await home();
    const { entry } = await cached(h);
    const seen: boolean[] = [];
    await removeEntry(entry, async (now) => { seen.push(now.fetched); return false; }, {});
    await fs.rm(path.join(entry, "fetched"));
    await removeEntry(entry, async (now) => { seen.push(now.fetched); return false; }, {});
    expect(seen).toEqual([true, false]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("cacheDir throws on EACCES when parent is unreadable", async () => {
    const h = await home();
    await fs.mkdir(path.join(h, "forges"));
    await fs.chmod(h, 0o000);
    cleanups.push(() => fs.chmod(h, 0o700));
    await expect(cacheDir(h)).rejects.toThrow(/EACCES/);
  });
});

describe("pruneTrees with the entry lock taken midway (§7: every removal is listed)", () => {
  it("returns the trees already removed and the busy holder", async () => {
    const h = await home();
    const { r, t: a, entry } = await cached(h);
    await r.commit({ "README.md": "b\n" });
    const b = await ensureTree(r.url, null, { home: h });
    for (const t of [a, b]) await fs.utimes(`${t.dir}.used`, ago(15 * DAY), ago(15 * DAY));
    let attempts = 0;
    const out = await pruneTrees(entry, {
      waitMs: 200,
      pollMs: 20,
      beforeAttempt: async () => {
        attempts++;
        if (attempts === 2) await fs.writeFile(path.join(entry, "lock"), "4242 2026-10-08T00:00:00.000Z\n");
      },
    });
    const [first, second] = [a.commit, b.commit].sort();
    expect([out.removed.map((x) => x.commit), out.busy?.holder]).toEqual([[first], "4242"]);
    expect((await ls(path.join(entry, "trees")))!.filter((n) => !n.includes("."))).toEqual([second]);
  });
});

// Review round 2: two should-fixes in src/core/remote.ts.
describe("review round 2", () => {
  it("cacheDir follows a symlinked forges/ to a directory: present", async () => {
    const h = await home();
    const real = path.join(h, "real-forges");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(h, "forges"), process.platform === "win32" ? "junction" : "dir");
    expect(await cacheDir(h)).toBe("present");
  });

  it("a rename failing with another code (ENOTEMPTY): held-open too, parts moved back, nothing thrown", async () => {
    const h = await home();
    const { entry, key } = await cached(h);
    const rename = async (from: string, to: string) => {
      if (path.basename(from) === "repo.git" && path.dirname(from) === entry) throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
      await fs.rename(from, to);
    };
    expect(await removeEntry(entry, async () => true, { rename })).toEqual({ outcome: "held-open", code: "ENOTEMPTY", warnings: [`${key} is held open (ENOTEMPTY) — kept`] });
    expect(await ls(entry)).toEqual(["fetched", "repo.git", "trees"]);
    expect(await ls(path.join(h, "forges"))).toEqual([key]);
  });
});
