import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status, type ApplyOptions } from "../src/core/sync.js";
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
});
