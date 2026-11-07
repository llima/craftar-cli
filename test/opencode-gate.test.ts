/**
 * Spec 63 §10: the `opencode` target name, Forge schema 18, lock schema 7, and lock 6 frozen at its 21815df owners.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan, apply, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, tmpDir, writeFiles, type IngredientSpec, type Scenario } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

async function forge(schema: number, opts: { ingredientTargets?: string[]; profileTargets?: string[]; section?: boolean; config?: Record<string, unknown> }) {
  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "agent", name: "helper", description: "Helps", ...(opts.ingredientTargets ? { targets: opts.ingredientTargets } : {}) },
      files: { "agent.md": opts.section ? "Help.\n\n<!-- craftar:section tone targets=opencode -->\nBe kind.\n<!-- /craftar:section -->\n" : "Help.\n" },
    },
  ];
  const s = await scenario(
    { ingredients, recipes: [recipe("base", ["agent/helper"])], profiles: [profile("acme", ["base"], opts.profileTargets ?? ["claude-code"])] },
    { config: { profile: "acme", ...(opts.config ?? {}) } },
  );
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}

const lockDoc = (schema: number, targets: string[], files: Array<Record<string, string>> = []) =>
  JSON.stringify({ schema, forge: { source: "../forge", ref: null, commit: null }, profile: "acme", recipes: ["base"], targets, generatedAt: "2026-11-07T00:00:00.000Z", files }, null, 2) + "\n";

describe("opencode gate (spec 63 §10)", () => {
  it("1. Forge schema 17, ingredient targets: [opencode] → loadForge refuses with the near miss", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forge(17, { ingredientTargets: ["opencode"] }));
    await expect(loadForge(s.forgeRoot)).rejects.toThrow("ingredients/agents/helper/ingredient.yaml: targets: opencode needs schema: 18 in craftar.forge.yaml");
  });

  it("2. Forge schema 17, profile targets: [opencode] → loadForge refuses", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forge(17, { profileTargets: ["claude-code", "opencode"] }));
    await expect(loadForge(s.forgeRoot)).rejects.toThrow("profiles/acme/profile.yaml: targets: opencode needs schema: 18 in craftar.forge.yaml");
  });

  it("3. Forge schema 17, section targets=opencode → plan() refuses", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forge(17, { section: true }));
    const ws = await loadWorkspace(s.wsRoot);
    await expect(plan(ws)).rejects.toThrow("section tone targets=: opencode needs schema: 18 in craftar.forge.yaml");
  });

  it("4. Forge schema 18 with the same → loads and plans", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forge(18, { ingredientTargets: ["opencode", "claude-code"], profileTargets: ["claude-code", "opencode"], section: true }));
    await expect(loadForge(s.forgeRoot)).resolves.toBeTruthy();
    const ws = await loadWorkspace(s.wsRoot);
    await expect(plan(ws)).resolves.toBeTruthy();
  });

  it("5. workspace targets [claude-code, opencode] → lock schema 7; [claude-code] → lock schema 2", { timeout: atLeastWin32(60_000) }, async () => {
    const s = kept(await forge(17, { config: { targets: ["claude-code", "opencode"] } }));
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(s.wsRoot)));
    const lock = await readLock(s.wsRoot);
    expect(lock!.schema).toBe(7);
    expect(lock!.targets).toContain("opencode");

    const s2 = kept(await forge(17, {}));
    const ws2 = await loadWorkspace(s2.wsRoot);
    const p2 = await plan(ws2);
    await apply(ws2, p2, await status(ws2, p2, await readLock(s2.wsRoot)));
    expect((await readLock(s2.wsRoot))!.schema).toBe(2);
  });

  it("6. lock schema 6 naming opencode → readLock refuses; schema 7 → reads", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await writeFiles(dir, { "craftar.lock": lockDoc(6, ["claude-code", "opencode"]) });
    await expect(readLock(dir)).rejects.toThrow();
    await writeFiles(dir, { "craftar.lock": lockDoc(6, ["claude-code"], [{ path: ".opencode/agents/helper.md", hash: "sha256:abc", target: "opencode", ingredient: "agent/helper" }]) });
    await expect(readLock(dir)).rejects.toThrow();
    await writeFiles(dir, { "craftar.lock": lockDoc(7, ["claude-code", "opencode"], [{ path: ".opencode/agents/helper.md", hash: "sha256:abc", target: "opencode", ingredient: "agent/helper" }]) });
    const lock = await readLock(dir);
    expect(lock.schema).toBe(7);
  });

  it("7. lock schema 6 still reads the eight targets and a removed gemini entry", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await writeFiles(dir, { "craftar.lock": lockDoc(6, ["claude-code", "codex", "antigravity", "gemini"], [{ path: "GEMINI.md", hash: "sha256:abc", target: "gemini", ingredient: "rule/*" }]) });
    expect((await readLock(dir)).schema).toBe(6);
  });

  it("8. lock schema 8 → readLock refuses by name", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await writeFiles(dir, { "craftar.lock": lockDoc(8, ["claude-code"]) });
    await expect(readLock(dir)).rejects.toThrow("declares schema 8, which this craftar does not read — upgrade craftar");
  });
});
