import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, assertInsideWorkspace, loadWorkspace, plan, readLock, status, type ApplyOptions } from "../src/core/sync.js";
import { exists } from "../src/core/forge.js";
import { hashNormalized } from "../src/core/text.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

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
    lock.files.push({ path: "../victim.txt", hash: hashNormalized("keep\n"), target: "claude-code", ingredient: "rule/gone" });
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");
    await expect(sync(s.wsRoot)).rejects.toThrow("craftar.lock: entry ../victim.txt is outside the workspace");
    expect(await fs.readFile(victim, "utf8")).toBe("keep\n");
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
    for (const p of [".claude/scripts/./run.sh", ".claude/scripts//run.sh", ".claude/scripts/a/../run.sh", ".claude/rules/r.md"]) expect(() => assertInsideWorkspace(f(p)), p).not.toThrow();
  });
});
