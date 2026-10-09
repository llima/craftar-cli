import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, assertInsideWorkspace, loadWorkspace, plan, readLock, status, type ApplyOptions } from "../src/core/sync.js";
import { exists } from "../src/core/forge.js";
import { hashNormalized, legacyHash, stripBom, toLf } from "../src/core/text.js";
import { makeForge, makeWorkspace, profile, recipe, rule, scenario, tmpDir } from "./helpers/forge.js";

const A = ".claude/rules/a.md";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function oneRule(files?: Record<string, string>) {
  const s = await scenario(
    { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(s.cleanup);
  return s;
}
async function sync(wsRoot: string, opts: ApplyOptions = {}) {
  const w = await loadWorkspace(wsRoot);
  const p = await plan(w);
  return apply(w, p, await status(w, p, await readLock(w.root)), opts);
}
const read = (wsRoot: string, rel: string) => fs.readFile(path.join(wsRoot, rel), "utf8");
const dropFromRecipe = (forgeRoot: string) => fs.writeFile(path.join(forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", [])));

describe("apply", () => {
  it("writes a new file and records its normalized hash in the lock", async () => {
    const s = await oneRule();
    const r = await sync(s.wsRoot);
    expect(r.written).toEqual([A]);
    expect(await read(s.wsRoot, A)).toBe("# A\n");
    expect((await readLock(s.wsRoot))!.files).toEqual([{ path: A, hash: hashNormalized("# A\n"), target: "claude-code", ingredient: "rule/a" }]);
  });

  it("skips drift and keeps the old lock entry so it stays visible", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    const before = (await readLock(s.wsRoot))!.files[0].hash;
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    const r = await sync(s.wsRoot);
    expect(r.skipped.map((x) => x.path)).toEqual([A]);
    expect(await read(s.wsRoot, A)).toContain("hand edit");
    expect((await readLock(s.wsRoot))!.files[0].hash).toBe(before);
  });

  it("overwrites drift only with overwriteDrift", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    const r = await sync(s.wsRoot, { overwriteDrift: true });
    expect(r.written).toEqual([A]);
    expect(await read(s.wsRoot, A)).toBe("# A\n");
  });

  it("removes an orphan and drops it from the lock", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await dropFromRecipe(s.forgeRoot);
    const r = await sync(s.wsRoot);
    expect(r.removed).toEqual([A]);
    expect(await exists(path.join(s.wsRoot, A))).toBe(false);
    expect((await readLock(s.wsRoot))!.files).toEqual([]);
  });

  it("keeps a hand-edited orphan", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    await dropFromRecipe(s.forgeRoot);
    const r = await sync(s.wsRoot);
    expect(r.skipped.map((x) => [x.path, x.state])).toEqual([[A, "orphan-drift"]]);
    expect(await exists(path.join(s.wsRoot, A))).toBe(true);
  });

  it("keeps a hand-edited orphan in the lock so every later sync still reports it", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    const original = (await readLock(s.wsRoot))!.files[0];
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    await dropFromRecipe(s.forgeRoot);
    const first = await sync(s.wsRoot);
    expect(first.skipped.map((x) => [x.path, x.state])).toEqual([[A, "orphan-drift"]]);
    expect((await readLock(s.wsRoot))!.files).toEqual([original]);
    const second = await sync(s.wsRoot);
    expect(second.skipped.map((x) => [x.path, x.state])).toEqual([[A, "orphan-drift"]]);
    expect((await readLock(s.wsRoot))!.files).toEqual([original]);
    expect(await read(s.wsRoot, A)).toContain("hand edit");
  });

  it("forgets a hand-edited orphan once the user deletes it", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    await dropFromRecipe(s.forgeRoot);
    await sync(s.wsRoot);
    await fs.rm(path.join(s.wsRoot, A));
    const r = await sync(s.wsRoot);
    expect(r.skipped).toEqual([]);
    expect(r.removed).toEqual([]);
    expect((await readLock(s.wsRoot))!.files).toEqual([]);
  });

  it("never touches a collision", async () => {
    const s = await oneRule({ [A]: "# mine\n" });
    const r = await sync(s.wsRoot);
    expect(r.skipped.map((x) => x.path)).toEqual([A]);
    expect(await read(s.wsRoot, A)).toBe("# mine\n");
    expect((await readLock(s.wsRoot))!.files).toEqual([]);
  });

  it("dry-run writes neither files nor the lock", async () => {
    const s = await oneRule();
    const r = await sync(s.wsRoot, { dryRun: true });
    expect(r.written).toEqual([A]);
    expect(await exists(path.join(s.wsRoot, A))).toBe(false);
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it("a second sync is a no-op", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    const r = await sync(s.wsRoot);
    expect(r.written).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("refuses a lock whose entry is outside the workspace, and deletes nothing (0.17.3)", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    const victim = path.join(s.root, "victim.txt");
    await fs.writeFile(victim, "keep\n");
    const lockFile = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    // A leading separator does not anchor the path: path.join(root, "/../x") is beside the workspace too.
    for (const escaping of ["../victim.txt", "/../victim.txt", "//../victim.txt"]) {
      const edited = { ...lock, files: [...lock.files, { path: escaping, hash: hashNormalized("keep\n"), target: "claude-code", ingredient: "rule/gone" }] };
      await fs.writeFile(lockFile, JSON.stringify(edited, null, 2) + "\n");
      await expect(sync(s.wsRoot), escaping).rejects.toThrow(`craftar.lock: entry ${escaping} is outside the workspace`);
      expect(await fs.readFile(victim, "utf8"), escaping).toBe("keep\n");
    }
  });

  it("apply never writes or removes a path outside the workspace, whatever it is handed (0.17.3)", async () => {
    const s = await oneRule();
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const victim = path.join(s.root, "victim.txt");
    await fs.writeFile(victim, "keep\n");
    const planned = { path: "../victim.txt", content: Buffer.from("gone\n"), target: "claude-code" as const, ingredient: "rule/a" };
    const entry = { path: "../victim.txt", hash: hashNormalized("keep\n"), target: "claude-code" as const, ingredient: "rule/a" };
    await expect(apply(w, p, [{ path: "../victim.txt", state: "update", target: "claude-code", planned, lock: entry }])).rejects.toThrow("../victim.txt is outside the workspace");
    await expect(apply(w, p, [{ path: "../victim.txt", state: "orphan", target: "claude-code", lock: entry }])).rejects.toThrow("../victim.txt is outside the workspace");
    expect(await fs.readFile(victim, "utf8")).toBe("keep\n");
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it("a planned path outside the workspace is refused, and one that stays inside is not (0.17.3)", () => {
    const f = (p: string) => [{ path: p, content: Buffer.from(""), target: "claude-code" as const, ingredient: "rule/r" }];
    expect(() => assertInsideWorkspace(f(".claude/rules/../../../x.md"))).toThrow("rule/r would write .claude/rules/../../../x.md, outside the workspace");
    expect(() => assertInsideWorkspace(f("/../x.md"))).toThrow("rule/r would write /../x.md, outside the workspace");
    for (const p of [".claude/scripts/./run.sh", ".claude/scripts//run.sh", ".claude/scripts/a/../run.sh", ".claude/rules/r.md"]) expect(() => assertInsideWorkspace(f(p)), p).not.toThrow();
  });

  it("plan() itself refuses a path outside the workspace, for an as the schema never saw (0.17.3)", async () => {
    const s = await oneRule();
    const w = await loadWorkspace(s.wsRoot);
    w.forge.ingredients.get("rule/a")!.meta.as = "../../../x";
    await expect(plan(w)).rejects.toThrow("rule/a would write .claude/rules/../../../x.md, outside the workspace");
  });

  it("sees a Forge change confined to non-UTF-8 bytes", async () => {
    // A Latin-1 script (not valid UTF-8) where only the accented byte differs.
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    const originalContent = Buffer.from("echo caf\xe9\r\n", "latin1"); // café
    await makeForge(forgeRoot, {
      ingredients: [{ meta: { type: "script", name: "s", files: ["run.bat"] }, files: { "run.bat": originalContent } }],
      recipes: [recipe("base", ["script/s"])],
      profiles: [profile("acme", ["base"])],
    });
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // First sync
    await sync(wsRoot);
    const wsFile = path.join(wsRoot, ".claude/scripts/run.bat");
    expect(await fs.readFile(wsFile)).toEqual(originalContent);

    // Rewrite the Forge file with a different accented byte (è instead of é)
    const newContent = Buffer.from("echo caf\xe8\r\n", "latin1"); // cafè
    await fs.writeFile(path.join(forgeRoot, "ingredients/scripts/s/run.bat"), newContent);

    // Status and plan should see it as an update
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const s = await status(w, p, await readLock(w.root));
    const entry = s.find((e) => e.path === ".claude/scripts/run.bat");
    expect(entry?.state).toBe("update");

    // Sync should write the new bytes
    await apply(w, p, s);
    expect(await fs.readFile(wsFile)).toEqual(newContent);
  });

  it("a lock written before the raw hash reads unchanged, and the next sync rewrites only the lock", async () => {
    // A Latin-1 script synced, then overwrite the lock entry's hash with the old-style normalized hash.
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    const content = Buffer.from("echo caf\xe9\r\n", "latin1"); // café
    await makeForge(forgeRoot, {
      ingredients: [{ meta: { type: "script", name: "s", files: ["run.bat"] }, files: { "run.bat": content } }],
      recipes: [recipe("base", ["script/s"])],
      profiles: [profile("acme", ["base"])],
    });
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // First sync to create the lock
    await sync(wsRoot);

    // Compute the OLD-style hash (what 0.17.3 and earlier would have written)
    const oldStyleHash = legacyHash(content);
    // And what we expect now (raw bytes hash)
    const newStyleHash = hashNormalized(content);
    expect(oldStyleHash).not.toBe(newStyleHash); // they really differ

    // Overwrite the lock entry's hash with the old-style hash
    const lockFile = path.join(wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const entry = lock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    entry.hash = oldStyleHash;
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");

    // Status should be unchanged (not drift), because the disk file matches the plan
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const s = await status(w, p, await readLock(w.root));
    const statusEntry = s.find((e) => e.path === ".claude/scripts/run.bat");
    expect(statusEntry?.state).toBe("unchanged");

    // Sync rewrites the lock but not the file
    const beforeSync = await fs.readFile(path.join(wsRoot, ".claude/scripts/run.bat"));
    const result = await apply(w, p, s);
    expect(result.written).toEqual([]); // no files written
    const afterSync = await fs.readFile(path.join(wsRoot, ".claude/scripts/run.bat"));
    expect(afterSync).toEqual(beforeSync); // file unchanged

    // The lock should now have the new-style hash
    const newLock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const newEntry = newLock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    expect(newEntry.hash).toBe(newStyleHash);
  });

  it("a pre-0.17.4 lock: a Forge change to a non-UTF-8 file reads update, not drift, and sync writes it", async () => {
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    const content = Buffer.from("echo caf\xe9\r\n", "latin1"); // café
    await makeForge(forgeRoot, {
      ingredients: [{ meta: { type: "script", name: "s", files: ["run.bat"] }, files: { "run.bat": content } }],
      recipes: [recipe("base", ["script/s"])],
      profiles: [profile("acme", ["base"])],
    });
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // First sync to create the lock
    await sync(wsRoot);

    // Rewrite the lock entry's hash with the pre-0.17.4 hash
    const lockFile = path.join(wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const entry = lock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    entry.hash = legacyHash(content);
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");

    // Now change the Forge's file
    const newContent = Buffer.from("echo caf\xe8\r\n", "latin1"); // cafè (different accent)
    await fs.writeFile(path.join(forgeRoot, "ingredients/scripts/s/run.bat"), newContent);

    // Status should be "update", not "drift"
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const s = await status(w, p, await readLock(w.root));
    const statusEntry = s.find((e) => e.path === ".claude/scripts/run.bat");
    expect(statusEntry?.state).toBe("update");

    // Sync should write the file
    const result = await apply(w, p, s);
    expect(result.written).toEqual([".claude/scripts/run.bat"]);
    expect(result.skipped).toEqual([]);

    // The workspace file now has the new content
    const wsFile = await fs.readFile(path.join(wsRoot, ".claude/scripts/run.bat"));
    expect(wsFile).toEqual(newContent);

    // The lock entry now has the new hash
    const newLock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const newEntry = newLock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    expect(newEntry.hash).toBe(hashNormalized(newContent));
  });

  it("a pre-0.17.4 lock: a non-UTF-8 file that leaves the Forge reads orphan, not orphan-drift, and sync removes it", async () => {
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    const content = Buffer.from("echo caf\xe9\r\n", "latin1"); // café
    await makeForge(forgeRoot, {
      ingredients: [
        rule("a", "# A\n"),
        { meta: { type: "script", name: "s", files: ["run.bat"] }, files: { "run.bat": content } },
      ],
      recipes: [recipe("base", ["script/s", "rule/a"])],
      profiles: [profile("acme", ["base"])],
    });
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // First sync to create the lock
    await sync(wsRoot);

    // Rewrite the lock entry's hash with the pre-0.17.4 hash
    const lockFile = path.join(wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const entry = lock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    entry.hash = legacyHash(content);
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");

    // Remove the script from the recipe
    await fs.writeFile(path.join(forgeRoot, "recipes/base.yaml"), YAML.stringify({ name: "base", ingredients: ["rule/a"] }));

    // Status should be "orphan", not "orphan-drift"
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const s = await status(w, p, await readLock(w.root));
    const statusEntry = s.find((e) => e.path === ".claude/scripts/run.bat");
    expect(statusEntry?.state).toBe("orphan");

    // Sync should remove the file
    const result = await apply(w, p, s);
    expect(result.removed).toEqual([".claude/scripts/run.bat"]);
    expect(await exists(path.join(wsRoot, ".claude/scripts/run.bat"))).toBe(false);
  });

  it("(guard) a pre-0.17.4 lock with a hand-edited non-UTF-8 file reads drift", async () => {
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    const content = Buffer.from("echo caf\xe9\r\n", "latin1"); // café
    await makeForge(forgeRoot, {
      ingredients: [{ meta: { type: "script", name: "s", files: ["run.bat"] }, files: { "run.bat": content } }],
      recipes: [recipe("base", ["script/s"])],
      profiles: [profile("acme", ["base"])],
    });
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // First sync to create the lock
    await sync(wsRoot);

    // Rewrite the lock entry's hash with the pre-0.17.4 hash
    const lockFile = path.join(wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    const entry = lock.files.find((f: { path: string }) => f.path === ".claude/scripts/run.bat");
    entry.hash = legacyHash(content);
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");

    // Hand-edit the workspace file
    const handEdited = Buffer.from("echo HAND\xe9\r\n", "latin1");
    await fs.writeFile(path.join(wsRoot, ".claude/scripts/run.bat"), handEdited);

    // Status should be "drift"
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const s = await status(w, p, await readLock(w.root));
    const statusEntry = s.find((e) => e.path === ".claude/scripts/run.bat");
    expect(statusEntry?.state).toBe("drift");
  });
});
