import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadWorkspace, plan, status, apply, readLock } from "../src/core/sync.js";
import { loadForge, listFiles } from "../src/core/forge.js";
import { hashNormalized } from "../src/core/text.js";
import { tmpDir, writeFiles, profile, recipe, type IngredientSpec } from "./helpers/forge.js";
import { acmeIndex } from "./helpers/rules-index.js";

/**
 * Spec 44 §4.7, §4.8: PK6 — the rules-index gate for import --prefer-kiro.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Hash every file in a directory tree, recursively. */
async function hashForge(forgeRoot: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = prefix + e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, rel + "/");
      } else {
        const content = await fs.readFile(abs);
        result[rel] = hashNormalized(content);
      }
    }
  };
  await walk(forgeRoot, "");
  return result;
}

/** Build a Forge with a rule/readme base that holds the placeholder. */
async function forgeWithPlaceholder(opts: { variantHoldsIt?: boolean; baseHoldsIt?: boolean } = {}) {
  const root = await tmpDir("craftar-pk6-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");

  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "rule", name: "readme", description: "Index of rules" },
      files: { "rule.md": opts.baseHoldsIt !== false ? "# Rules\n\n{{craftar.rules.index}}\n" : "# Rules\n" },
    },
    {
      meta: { type: "rule", name: "style", description: "Code style" },
      files: { "rule.md": "# Style\n" },
    },
  ];

  // Write Forge manifest
  await writeFiles(forgeRoot, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }) });

  // Write ingredients
  for (const ing of ingredients) {
    const folder = ing.meta.type === "mcp" ? "mcp" : `${ing.meta.type}s`;
    const dir = path.join(forgeRoot, "ingredients", folder, ing.meta.name);
    await writeFiles(dir, { "ingredient.yaml": YAML.stringify(ing.meta), ...(ing.files ?? {}) });
  }

  // If variantHoldsIt, create readme--acme with the placeholder (base does not)
  if (opts.variantHoldsIt) {
    const variantDir = path.join(forgeRoot, "ingredients/rules/readme--acme");
    await writeFiles(variantDir, {
      "ingredient.yaml": YAML.stringify({ type: "rule", name: "readme--acme", as: "readme", description: "Index of rules" }),
      "rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
    });
    // Base without placeholder
    await fs.writeFile(path.join(forgeRoot, "ingredients/rules/readme/rule.md"), "# Rules\n");
  }

  // Write base recipe
  const baseRecipe = opts.variantHoldsIt
    ? recipe("base", ["rule/readme--acme", "rule/style"])
    : recipe("base", ["rule/readme", "rule/style"]);
  await writeFiles(forgeRoot, { "recipes/base.yaml": YAML.stringify(baseRecipe) });

  // Write acme profile
  const acmeProfile = profile("acme", ["base"], ["claude-code", "kiro", "agents-md"]);
  await writeFiles(forgeRoot, { "profiles/acme/profile.yaml": YAML.stringify(acmeProfile) });

  // Write workspace
  await writeFiles(wsRoot, {
    "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    ".claude/rules/readme.md": "# Rules\n",
    ".claude/rules/style.md": "# Style\n",
    ".kiro/steering/readme.md": "---\ninclusion: always\n---\n\n# Rules\n",
    ".kiro/steering/style.md": "---\ninclusion: always\n---\n\n# Style\n",
  });

  return { root, forgeRoot, wsRoot };
}

describe("rules-index import (spec 44 §4.7–§4.8)", () => {
  describe("PK6: import --prefer-kiro refuses a rule whose resolved ingredient holds the placeholder", () => {
    it("1. base holds the placeholder → exit 1, message, Forge byte-identical", async () => {
      const s = await forgeWithPlaceholder({ baseHoldsIt: true });

      // Record Forge hashes before
      const before = await hashForge(s.forgeRoot);

      // Try to import with --prefer-kiro readme
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      // Should fail
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("--prefer-kiro readme");
      expect((result as Error).message).toContain("{{craftar.rules.index}}");
      expect((result as Error).message).toContain("the rule the profile resolves holds");
      expect((result as Error).message).toContain("which import would freeze");

      // Forge must be byte-identical
      const after = await hashForge(s.forgeRoot);
      expect(after).toEqual(before);
    });

    it("2. profile variant holds it (base does not) → exit 1, message, Forge byte-identical", async () => {
      const s = await forgeWithPlaceholder({ variantHoldsIt: true, baseHoldsIt: false });

      const before = await hashForge(s.forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("--prefer-kiro readme");
      expect((result as Error).message).toContain("{{craftar.rules.index}}");

      const after = await hashForge(s.forgeRoot);
      expect(after).toEqual(before);
    });

    it("3. profile that import creates (base holds it) → exit 1, message, Forge byte-identical", async () => {
      const s = await forgeWithPlaceholder({ baseHoldsIt: true });

      // Remove the acme profile so import would create it
      await fs.rm(path.join(s.forgeRoot, "profiles/acme"), { recursive: true, force: true });

      const before = await hashForge(s.forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("--prefer-kiro readme");
      expect((result as Error).message).toContain("{{craftar.rules.index}}");

      const after = await hashForge(s.forgeRoot);
      expect(after).toEqual(before);
    });

    it("4. PK6 comes before PK4: steering triggers PK4 but PK6 is checked first", async () => {
      // Create a scenario where the steering text would trigger PK4 (a secret) AND holds the placeholder
      const root = await tmpDir("craftar-pk6-order-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({ type: "rule", name: "readme", description: "Index" }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Steering file that would trigger PK4 (any steering body issue)
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\n",
        ".kiro/steering/readme.md": "---\ninclusion: always\n---\n\n# Some different text\n",
      });

      const before = await hashForge(forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      expect(result).toBeInstanceOf(Error);
      // PK6 message, not PK4
      expect((result as Error).message).toContain("{{craftar.rules.index}}");

      const after = await hashForge(forgeRoot);
      expect(after).toEqual(before);
    });

    it("5. below the gate (schema < 7): no PK6 check", async () => {
      const root = await tmpDir("craftar-pk6-below-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 6 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({ type: "rule", name: "readme", description: "Index" }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\n",
        ".kiro/steering/readme.md": "---\ninclusion: always\n---\n\n# Rules\n",
      });

      // Should succeed below the gate
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      });

      // No error: the import succeeded
      expect(result.profile).toBe("acme");
    });

    it("14. PK6 reads the rule's declared file (meta.file), not hard-coded rule.md", async () => {
      // Test finding 5: readIngredientText should use meta.file, not "rule.md"
      const root = await tmpDir("craftar-pk6-custom-file-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Create Forge with rule whose body file is "body.md" (not "rule.md")
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          inclusion: "always",
          file: "body.md",  // Custom file name
        }),
        "ingredients/rules/readme/body.md": "# Rules\n\n{{craftar.rules.index}}\n",  // Placeholder in body.md
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\n",
        ".kiro/steering/readme.md": "---\ninclusion: always\n---\n\n# Rules\n",
      });

      const before = await hashForge(forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      // Should fail with PK6 error (the placeholder was found in body.md)
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("--prefer-kiro readme");
      expect((result as Error).message).toContain("{{craftar.rules.index}}");

      const after = await hashForge(forgeRoot);
      expect(after).toEqual(before);
    });
  });

  describe("fail-closed: broken profile and placeholder presence", () => {
    it("12. schema 7, broken profile, no rule holds placeholder → import does NOT fail on account of spec 44", async () => {
      // Test finding 4(a): when profile doesn't resolve but no base holds the placeholder,
      // the import should not fail with a rules-index related error
      const root = await tmpDir("craftar-failclosed-no-placeholder-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Create Forge with NO rules holding the placeholder, but profile has a missing recipe
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/readme/rule.md": "# Rules\nNo placeholder here.\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        // Profile references a recipe that doesn't exist
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base", "missing-recipe"], targets: ["claude-code"] }),
      });

      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\nNo placeholder here.\n",
      });

      // Import may fail for other reasons (broken profile), but NOT due to rules-index
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
      }).catch((e: Error) => e);

      // If it fails, the message should NOT mention craftar.rules.index
      if (result instanceof Error) {
        expect((result as Error).message).not.toContain("craftar.rules.index");
      }
      // If it succeeds, that's also fine (the profile might resolve without the missing recipe being needed)
    });

    it("13. schema 7, broken profile, base holds placeholder → exits 1 naming the profile, Forge unchanged", async () => {
      // Test finding 4(b): when profile doesn't resolve AND a base holds the placeholder,
      // the import should fail with a message naming the profile
      const root = await tmpDir("craftar-failclosed-with-placeholder-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Create Forge with rule holding placeholder, but profile has a missing recipe
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",  // Has placeholder
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        // Profile references a recipe that doesn't exist
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base", "missing-recipe"], targets: ["claude-code"] }),
      });

      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\n",
      });

      const before = await hashForge(forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
      }).catch((e: Error) => e);

      // Should fail
      expect(result).toBeInstanceOf(Error);
      // Should name the profile
      expect((result as Error).message).toContain("acme");
      expect((result as Error).message).toMatch(/does not resolve/i);

      // Forge byte-identical
      const after = await hashForge(forgeRoot);
      expect(after).toEqual(before);
    });
  });

  describe("re-import at schema 7: compares a base with its index expanded", () => {
    it("6. sync then import back → rule/readme is reused, not a variant", async () => {
      // Finding 2: Use a Forge that round-trips (description-less rules)
      const root = await tmpDir("craftar-reimport-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with description-less rules that round-trip
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/style/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "style",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/style/rule.md": "# Style\nUse consistent formatting.\n",
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/style", "rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Create workspace synced from this Forge
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
      });

      // Sync the workspace to expand the index
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);
      const lock = await readLock(wsRoot);
      const st = await status(ws, p, lock);
      await apply(ws, p, st);

      // Import back into the same Forge with the same profile
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
      });

      // rule/readme should be reused, not a variant (index expanded in fingerprint)
      expect(result.reused).toContain("rule/readme");
      expect(result.reused).toContain("rule/style");
      expect(result.variants.map((v) => v.name)).not.toContain("rule/readme--acme");
    });
  });

  describe("fresh import into an empty Forge", () => {
    it("8. workspace with expanded list → stored as written, sync gives it back byte for byte", async () => {
      const root = await tmpDir("craftar-fresh-import-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Create a workspace with an expanded rules list in the readme rule
      const expandedList = `# Rules

Always on:
- \`.claude/rules/readme.md\` — Index of the rules
- \`.claude/rules/style.md\` — Code style
`;
      await writeFiles(wsRoot, {
        ".claude/rules/readme.md": expandedList,
        ".claude/rules/style.md": "# Style\nUse consistent formatting.\n",
      });

      // Import into an empty Forge
      const importResult = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
        writeWorkspaceConfig: true,
      });

      expect(importResult.created).toContain("rule/readme");

      // The stored rule should be exactly what was written (no placeholder)
      const storedRule = await fs.readFile(path.join(forgeRoot, "ingredients/rules/readme/rule.md"), "utf8");
      expect(storedRule).toBe(expandedList);
      expect(storedRule).not.toContain("{{craftar.rules.index}}");

      // Bump to schema 7
      await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

      // Sync should give it back byte for byte
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);
      const lock = await readLock(wsRoot);
      const st = await status(ws, p, lock);

      // The file should be unchanged or adopt (not update)
      const readmeStatus = st.find((s) => s.path === ".claude/rules/readme.md");
      expect(readmeStatus).toBeDefined();
      expect(["unchanged", "adopt"]).toContain(readmeStatus!.state);
    });
  });

  describe("schema 6 vs schema 7 re-import: body-equality must not skip metadata check", () => {
    it("10. body-equality reuse path incorrectly ignores metadata differences", async () => {
      // This test exposes the body-equality reuse path (spec 44 §4.7 blocker 1):
      // Rules with description in the Forge don't round-trip (import loses description).
      // The body-equality path would reuse them anyway at schema 7 when the expanded body matches,
      // ignoring the metadata difference.
      // After removing the body-equality path, such rules become variants at both schemas.
      const root = await tmpDir("craftar-body-equality-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with rules that have descriptions (won't round-trip through import)
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/style/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "style",
          description: "Code style for every file",  // Description: import loses this
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/style/rule.md": "# Style\nUse consistent formatting.\n",
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          description: "Index of the rules",  // Description: import loses this
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/style", "rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Create workspace synced from this Forge
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
      });

      // Sync the workspace
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);
      const lock = await readLock(wsRoot);
      const st = await status(ws, p, lock);
      await apply(ws, p, st);

      // Import at schema 7
      const result7 = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
      });

      // Copy the Forge and set schema to 6
      const forgeRoot6 = path.join(root, "forge6");
      await fs.cp(forgeRoot, forgeRoot6, { recursive: true });
      await fs.writeFile(path.join(forgeRoot6, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 6 }));

      // Import at schema 6
      const result6 = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot6,
        profileName: "acme",
      });

      // With body-equality path removed, both rules should become variants at both schemas
      // because their metadata (description) differs.
      // The key assertion: schema 7 and schema 6 should AGREE on whether a rule is reused or variant.
      const style7Reused = result7.reused.includes("rule/style");
      const style6Reused = result6.reused.includes("rule/style");
      expect(style7Reused, "rule/style: reused status should agree between schema 7 and 6").toBe(style6Reused);

      // Both should be variants (metadata differs due to description)
      expect(style7Reused, "rule/style should be variant at schema 7 (description missing)").toBe(false);
      expect(style6Reused, "rule/style should be variant at schema 6 (description missing)").toBe(false);
    });

    it("11. round-tripping Forge: sync then import back → readme reused at 7, variant at 6", async () => {
      // This test uses a Forge that round-trips (spec 44 §4.7 finding 2):
      // Rules with no description, targets [claude-code], schema 7.
      // After sync and import back:
      // - At schema 7: readme is reused (index expanded in fingerprint), style is reused
      // - At schema 6: readme becomes a variant (literal placeholder vs expanded list), style is reused
      const root = await tmpDir("craftar-round-trip-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with description-less rules that round-trip
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/style/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "style",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/style/rule.md": "# Style\nUse consistent formatting.\n",
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme",
          inclusion: "always",
          file: "rule.md",
        }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/style", "rule/readme"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Create workspace synced from this Forge
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
      });

      // Sync the workspace
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);
      const lock = await readLock(wsRoot);
      const st = await status(ws, p, lock);
      await apply(ws, p, st);

      // Import at schema 7
      const result7 = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
      });

      // Copy the Forge and set schema to 6
      const forgeRoot6 = path.join(root, "forge6");
      await fs.cp(forgeRoot, forgeRoot6, { recursive: true });
      await fs.writeFile(path.join(forgeRoot6, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 6 }));

      // Import at schema 6
      const result6 = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot6,
        profileName: "acme",
      });

      // rule/style should agree: reused at both schemas
      expect(result7.reused, "style reused at 7").toContain("rule/style");
      expect(result6.reused, "style reused at 6").toContain("rule/style");

      // rule/readme differs:
      // - At schema 7: reused (index expanded in fingerprint comparison)
      // - At schema 6: variant (literal placeholder vs expanded list)
      expect(result7.reused, "readme reused at 7").toContain("rule/readme");
      expect(result6.variants.map((v) => v.name), "readme variant at 6").toContain("rule/readme--acme");
    });
  });

  describe("fail-closed: profile that does not resolve on its own", () => {
    it("9. Forge base holds placeholder, importing profile does not resolve → exit 1, Forge untouched", async () => {
      const root = await tmpDir("craftar-pk6-failclosed-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Create Forge with base holding placeholder, but profile has a missing recipe
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
        "ingredients/rules/readme/ingredient.yaml": YAML.stringify({ type: "rule", name: "readme", description: "Index" }),
        "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
        // Profile references a recipe that doesn't exist
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base", "missing-recipe"], targets: ["claude-code"] }),
      });

      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/readme.md": "# Rules\n",
        ".kiro/steering/readme.md": "---\ninclusion: always\n---\n\n# Rules\n",
      });

      const before = await hashForge(forgeRoot);

      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot: forgeRoot,
        profileName: "acme",
        preferKiro: ["readme"],
      }).catch((e: Error) => e);

      expect(result).toBeInstanceOf(Error);
      // Should fail naming the profile
      expect((result as Error).message).toContain("acme");
      expect((result as Error).message).toMatch(/does not resolve/i);

      const after = await hashForge(forgeRoot);
      expect(after).toEqual(before);
    });
  });
});


describe("BLOCKER 1: new profile must keep spec 41 fail-closed (review round 2)", () => {
  it("import --profile newco into a schema 5 Forge with agents-md.primary default → exit 1 with fail-closed message, Forge byte-identical", async () => {
    // A schema 5 Forge with a recipe that defaults agents-md.primary: true
    // A workspace with claude-code + agents-md targets and a .claude/rules/style.md
    // import --profile newco → exit 1 with exactly the message from origin/main
    const root = await tmpDir("craftar-newco-failclosed-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    // Create Forge at schema 5 with a recipe that defaults agents-md.primary: true
    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 5 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "Code style",
        file: "rule.md",
        targets: "*",
        tags: [],
      }),
      "ingredients/rules/style/rule.md": "# Style\nFollow coding standards.\n",
      "recipes/base.yaml": YAML.stringify({
        name: "base",
        ingredients: ["rule/style"],
        params: { "agents-md.primary": { default: true } },
      }),
    });

    // Create workspace with targets claude-code + agents-md
    await writeFiles(wsRoot, {
      ".claude/rules/style.md": "# Style\nFollow coding standards.\n",
    });

    // Hash the Forge before
    const before = await hashForge(forgeRoot);

    // Import under a NEW profile name
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "newco",
    }).catch((e: Error) => e);

    // Should fail with the exact message from origin/main
    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    expect(msg).toContain("profile newco is not in the Forge");

    // Forge must be byte-identical
    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });
});


describe("BLOCKER 2: rules-index fail-closed looks only at bases this import compares (review round 2)", () => {
  it("2a. import --profile newco where only rule/readme (not imported) holds placeholder → exit 0, rule/lint written", async () => {
    // A schema 7 Forge with rule/readme holding the placeholder (in the Forge)
    // A workspace holding only .claude/rules/lint.md (NOT readme)
    // import --profile newco → exit 0, rule/lint written, nothing about the index
    const root = await tmpDir("craftar-failclosed-unrelated-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
      // rule/readme with the placeholder
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "Index",
        file: "rule.md",
        targets: "*",
        tags: [],
      }),
      "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
    });

    // Workspace with ONLY lint.md (no readme)
    await writeFiles(wsRoot, {
      ".claude/rules/lint.md": "# Lint\nRun linter.\n",
    });

    // Import under a NEW profile name
    const report = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "newco",
    });

    // Should succeed
    expect(report.profile).toBe("newco");
    // rule/lint--newco should be created (or rule/lint)
    expect(report.created.some((r) => r.includes("lint"))).toBe(true);
    // No mention of index-related errors
  });

  it("2b. import --profile newco with .claude/rules/readme.md where rule/readme holds placeholder → exit 1 with new-profile message, Forge byte-identical", async () => {
    // A schema 7 Forge with rule/readme holding the placeholder
    // A workspace holding .claude/rules/readme.md (the SAME name as the rule with placeholder)
    // import --profile newco → exit 1 with the new-profile error, naming the rule
    const root = await tmpDir("craftar-failclosed-same-rule-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "Index",
        file: "rule.md",
        targets: "*",
        tags: [],
      }),
      "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
    });

    // Workspace with readme.md
    await writeFiles(wsRoot, {
      ".claude/rules/readme.md": "# Rules\n\nSome content.\n",
    });

    const before = await hashForge(forgeRoot);

    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "newco",
    }).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    // The message should name the rule and say what to do
    expect(msg).toContain("profile newco is not in the Forge");
    expect(msg).toContain("rule/readme");
    expect(msg).toContain("{{craftar.rules.index}}");
    expect(msg).toContain("create the profile first");

    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });

  it("2c. broken profile (missing recipe) + readme in workspace where rule/readme holds placeholder → exit 1 with broken-profile message naming the rule", async () => {
    // A schema 7 Forge with rule/readme holding the placeholder
    // A profile that references a missing recipe (broken)
    // A workspace holding .claude/rules/readme.md
    // → exit 1 with the broken-profile error, naming the rule
    const root = await tmpDir("craftar-failclosed-broken-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "Index",
        file: "rule.md",
        targets: "*",
        tags: [],
      }),
      "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
      // Broken profile - references missing recipe
      "profiles/broken/profile.yaml": YAML.stringify({
        name: "broken",
        description: "Broken profile",
        recipes: ["base", "nonexistent"],
        targets: ["claude-code"],
      }),
    });

    // Workspace with readme.md
    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: forgeRoot, profile: "broken" }),
      ".claude/rules/readme.md": "# Rules\n\nSome content.\n",
    });

    const before = await hashForge(forgeRoot);

    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "broken",
    }).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    // The message should name the rule
    expect(msg).toContain("profile broken does not resolve");
    expect(msg).toContain("rule/readme");
    expect(msg).toContain("{{craftar.rules.index}}");
    expect(msg).toContain("fix the Forge and re-run");

    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });
});
