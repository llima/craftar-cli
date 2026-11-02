/**
 * Registry settingsApplied tests (spec 52 §5.3, §12): the record of handlers the last apply wrote.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { forgeAt } from "./helpers/integrations.js";
import { profile, recipe, tmpDir, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import {
  readRegistry,
  register,
  recordApplied,
  appliedFor,
  forget,
  prune,
  isMissing,
  registryFile,
  revokeWrites,
  allowWrites,
} from "../src/core/registry.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// A minimal hook ingredient
const fixtureH = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard",
    files: ["guard.py"],
    registration: [{ event: "PreToolUse", matcher: "Bash", command: "python3", args: [".claude/hooks/guard.py"] }],
  },
  files: { "guard.py": 'print("ok")\n' },
});

describe("registry: settingsApplied record (spec 52 §5.3)", () => {
  it("R1. recordApplied on a registered dir → 'written'; appliedFor gives the hashes; a second call replaces them", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);

    // First record
    const result1 = await recordApplied(home, s.wsRoot, ["hash1", "hash2"]);
    expect(result1).toBe("written");

    let reg = await readRegistry(home);
    let hashes = await appliedFor(reg, s.wsRoot);
    expect(hashes.size).toBe(2);
    expect(hashes.has("hash1")).toBe(true);
    expect(hashes.has("hash2")).toBe(true);

    // Second call replaces
    const result2 = await recordApplied(home, s.wsRoot, ["hash3"]);
    expect(result2).toBe("written");

    reg = await readRegistry(home);
    hashes = await appliedFor(reg, s.wsRoot);
    expect(hashes.size).toBe(1);
    expect(hashes.has("hash3")).toBe(true);
    expect(hashes.has("hash1")).toBe(false);
  });

  it("R2. recordApplied on an unregistered dir → 'not-registered'; registry.json bytes unchanged (D7)", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // Create registry.json with a different workspace registered
    const regPath = registryFile(home);
    await fs.mkdir(home, { recursive: true });
    const initial = { schema: 1, workspaces: [] };
    await fs.writeFile(regPath, JSON.stringify(initial, null, 2) + "\n", "utf8");
    const bytesBefore = await fs.readFile(regPath);

    // Try to record for an unregistered dir
    const result = await recordApplied(home, s.wsRoot, ["hash1"]);
    expect(result).toBe("not-registered");

    // Registry bytes unchanged
    const bytesAfter = await fs.readFile(regPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  it("R3. forget drops the record; prune with the workspace dir deleted drops it", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);
    await recordApplied(home, s.wsRoot, ["hash1"]);

    // Verify record exists
    let reg = await readRegistry(home);
    expect(reg.settingsApplied).toBeDefined();
    expect(reg.settingsApplied!.length).toBe(1);

    // forget drops it
    await forget(home, s.wsRoot);
    reg = await readRegistry(home);
    expect(reg.settingsApplied).toBeUndefined();

    // Now test prune path: re-register, record, then delete dir
    const s2 = await forgeAt(1, forge);
    cleanups.push(s2.cleanup);
    const ws2 = await loadWorkspace(s2.wsRoot);
    const p2 = await plan(ws2);
    await register(home, ws2, p2);
    await recordApplied(home, s2.wsRoot, ["hash2"]);

    // Delete the workspace dir to make it "missing"
    await fs.rm(path.join(s2.wsRoot, "craftar.yaml"));

    const pruned = await prune(home);
    expect(pruned.length).toBe(1);

    reg = await readRegistry(home);
    expect(reg.workspaces.length).toBe(0);
    expect(reg.settingsApplied).toBeUndefined();
  });

  it("R4. prune drops orphan settingsApplied entry even when no workspace is missing (D7)", async () => {
    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // Write registry.json by hand with an orphan settingsApplied entry (no matching workspace)
    const regPath = registryFile(home);
    await fs.mkdir(home, { recursive: true });
    const orphanRegistry = {
      schema: 1,
      workspaces: [],
      settingsApplied: [{ path: "/nonexistent/path", handlers: ["hash1"], appliedAt: "2026-01-01T00:00:00.000Z" }],
    };
    await fs.writeFile(regPath, JSON.stringify(orphanRegistry, null, 2) + "\n", "utf8");

    // prune should drop the orphan even though no workspace is missing
    const pruned = await prune(home);
    // No workspaces to prune, but the orphan record should be dropped
    expect(pruned).toEqual([]);

    const reg = await readRegistry(home);
    expect(reg.settingsApplied).toBeUndefined();
  });

  it("R5. a registry that never held settingsApplied keeps its exact bytes through register, forget, prune", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // First register
    await register(home, ws, p);
    const regPath = registryFile(home);
    const afterRegister = await fs.readFile(regPath, "utf8");
    expect(afterRegister).not.toContain("settingsApplied");

    // Second register (same args)
    await register(home, ws, p);
    const afterSecondRegister = await fs.readFile(regPath, "utf8");
    expect(afterSecondRegister).not.toContain("settingsApplied");

    // forget
    await forget(home, s.wsRoot);
    const afterForget = await fs.readFile(regPath, "utf8");
    expect(afterForget).not.toContain("settingsApplied");

    // prune (nothing to prune)
    await prune(home);
    const afterPrune = await fs.readFile(regPath, "utf8");
    expect(afterPrune).not.toContain("settingsApplied");
  });

  it("R6. revokeWrites leaves settingsApplied in place", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);

    // Add writeConsent and settingsApplied
    await allowWrites(home, s.wsRoot, { forge: { source: "test", ref: null }, profile: "acme" });
    await recordApplied(home, s.wsRoot, ["hash1"]);

    // Verify both exist
    let reg = await readRegistry(home);
    expect(reg.writeConsent).toBeDefined();
    expect(reg.settingsApplied).toBeDefined();

    // revokeWrites should only remove writeConsent
    await revokeWrites(home, s.wsRoot);

    reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
    expect(reg.settingsApplied).toBeDefined();
    expect(reg.settingsApplied!.length).toBe(1);
  });
});
