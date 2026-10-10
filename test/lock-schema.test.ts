import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { LockSchema } from "../src/schema/index.js";
import { readLock } from "../src/core/sync.js";
import { tmpDir } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const V1 = { schema: 1, forge: { source: "../forge", commit: null }, profile: "acme", generatedAt: "2026-01-01T00:00:00.000Z", files: [] };
const V2 = {
  schema: 2,
  forge: { source: "../forge", ref: null, commit: null },
  profile: "acme",
  recipes: ["base", "stack-a"],
  targets: ["claude-code"],
  generatedAt: "2026-01-01T00:00:00.000Z",
  files: [],
};

async function lockDir(content: string): Promise<string> {
  const dir = await tmpDir("craftar-lock-");
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "craftar.lock"), content);
  return dir;
}

describe("the lock schema (spec 13 §4.6, §5.2)", () => {
  it("reads schema 1 and schema 2 as written", () => {
    expect(LockSchema.parse(V1)).toEqual(V1);
    expect(LockSchema.parse(V2)).toEqual(V2);
  });

  it("a lock with no schema key reads as version 1", () => {
    const { schema: _drop, ...noKey } = V1;
    expect(LockSchema.parse(noKey)).toEqual(V1);
  });

  it("schema 2 requires recipes, targets and forge.ref", () => {
    const { recipes: _r, ...noRecipes } = V2;
    expect(LockSchema.safeParse(noRecipes).success).toBe(false);
    expect(LockSchema.safeParse({ ...V2, forge: { source: "../forge", commit: null } }).success).toBe(false);
  });

  it("readLock refuses a schema it does not read, by name, without a zod dump", async () => {
    const dir = await lockDir(JSON.stringify({ ...V2, schema: 3 }));
    await expect(readLock(dir)).rejects.toThrow("craftar.lock declares schema 3, which this craftar does not read — upgrade craftar");
    const str = await lockDir(JSON.stringify({ ...V2, schema: "2" }));
    await expect(readLock(str)).rejects.toThrow('craftar.lock declares schema (not a whole number), which this craftar does not read — upgrade craftar');
  });

  it("readLock reads both versions", async () => {
    expect(await readLock(await lockDir(JSON.stringify(V1)))).toEqual(V1);
    expect(await readLock(await lockDir(JSON.stringify(V2)))).toEqual(V2);
  });
});
