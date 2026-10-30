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


describe("Review round 3 item 1: variant holding placeholder is protected", () => {
  it("1a. variant holding placeholder — sync then import → variant untouched (reused), NOT rewritten with the list", async () => {
    // p3.sh scenario: a variant rule/readme--acme holding {{craftar.rules.index}}, base does not
    // sync expands to the workspace, import back should reuse the variant, not rewrite it
    const root = await tmpDir("craftar-variant-placeholder-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    // Forge with: rule/style, rule/readme (base, no placeholder), rule/readme--acme (variant, has placeholder)
    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
        file: "rule.md",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
        file: "rule.md",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase text\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D readme--acme",
        file: "rule.md",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    // Workspace config
    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync the workspace
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Verify the readme.md now has the expanded list (sanity check)
    const readmeMd = await fs.readFile(path.join(wsRoot, ".claude/rules/readme.md"), "utf8");
    expect(readmeMd).toContain("Always on:");
    expect(readmeMd).not.toContain("{{craftar.rules.index}}");

    // Capture the variant body BEFORE import
    const variantBodyBefore = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );
    expect(variantBodyBefore).toContain("{{craftar.rules.index}}");

    // Import back
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // The variant should be REUSED, not overwritten
    expect(result.reused).toContain("rule/readme--acme");
    expect(result.variants.map((v) => v.name)).not.toContain("rule/readme--acme");

    // The variant body should be UNCHANGED (byte-identical)
    const variantBodyAfter = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );
    expect(variantBodyAfter).toBe(variantBodyBefore);
    expect(variantBodyAfter).toContain("{{craftar.rules.index}}");
  });

  it("1b. variant holding placeholder, workspace hand-edited → exit 1 with refusal message, Forge byte-identical", async () => {
    // Same setup but the workspace readme.md is hand-edited differently
    const root = await tmpDir("craftar-variant-placeholder-edited-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
        file: "rule.md",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
        file: "rule.md",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase text\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D readme--acme",
        file: "rule.md",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync, then hand-edit the readme.md
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Hand-edit: add a line that differs from what the variant would produce
    const readmeMd = await fs.readFile(path.join(wsRoot, ".claude/rules/readme.md"), "utf8");
    await fs.writeFile(
      path.join(wsRoot, ".claude/rules/readme.md"),
      readmeMd + "\nHand-edited extra line.\n"
    );

    const before = await hashForge(forgeRoot);

    // Import should REFUSE
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    }).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    expect(msg).toContain("rule/readme--acme");
    expect(msg).toContain("{{craftar.rules.index}}");
    expect(msg).toContain(".claude/rules/readme.md");
    expect(msg).toContain("differs");

    // Forge byte-identical
    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });
});

describe("Review round 3 item 2: steering base holding placeholder compared with kiro-form expansion", () => {
  it("2a. steering base holding placeholder — sync then import → steering/guide reused, no variant", async () => {
    // p4.sh scenario: steering/guide holding {{craftar.rules.index}}
    // sync expands to kiro form, import back should reuse the base
    const root = await tmpDir("craftar-steering-placeholder-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        file: "rule.md",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/steerings/guide/ingredient.yaml": YAML.stringify({
        type: "steering",
        name: "guide",
        file: "steering.md",
        tags: ["client"],
      }),
      "ingredients/steerings/guide/steering.md": "# Guide\n\n{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({
        name: "base",
        ingredients: ["rule/style", "steering/guide"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["base"],
        targets: ["claude-code", "kiro"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync the workspace
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Verify the guide.md has the kiro-form expansion
    const guideMd = await fs.readFile(path.join(wsRoot, ".kiro/steering/guide.md"), "utf8");
    expect(guideMd).toContain("Always on:");
    expect(guideMd).toContain(".kiro/steering/"); // kiro form uses .kiro/steering/
    expect(guideMd).not.toContain("{{craftar.rules.index}}");

    // Import back
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // The steering/guide should be REUSED
    expect(result.reused).toContain("steering/guide");
    expect(result.variants.map((v) => v.name)).not.toContain("steering/guide--acme");

    // No new steering directory
    const dirs = await fs.readdir(path.join(forgeRoot, "ingredients/steerings"));
    expect(dirs).toEqual(["guide"]);
  });
});

describe("Review round 3 item 3: described index rule creates variant with frozen-list warning", () => {
  it("3a. acmeIndex({ schema: 7, literal: true }) → sync then import produces frozen-list warning", async () => {
    // spec §4.4's example: a rule with description holding the placeholder
    // sync expands, import back creates variant, warns about frozen list
    const s = await acmeIndex({ schema: 7, literal: true });
    cleanups.push(s.cleanup);

    // Sync the workspace
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    const lock = await readLock(s.wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Import back
    const result = await importClaudeCode({
      workspaceRoot: s.wsRoot,
      forgeRoot: s.forgeRoot,
      profileName: "acme",
    });

    // rule/readme becomes a variant because it has a description (import loses description)
    expect(result.variants.map((v) => v.name)).toContain("rule/readme--acme");

    // The warning about frozen list should be present
    const frozenWarning = result.warnings.find(
      (w) => w.includes("rule/readme--acme") && w.includes("frozen")
    );
    expect(frozenWarning).toBeDefined();
    expect(frozenWarning).toContain("rule/readme");
    expect(frozenWarning).toContain("{{craftar.rules.index}}");
  });
});


describe("Review round 4: variant comparison moved to writeIngredient", () => {
  /**
   * r4fm.sh fm: variant rule/readme--acme (fileMatch, frontmatterRaw paths: src/**, placeholder in body);
   * sync; change paths: to lib/** in .claude/rules/readme.md; import → exit 1 with refusal, Forge byte-identical.
   */
  it("4a. variant with fileMatch and placeholder — frontmatter differs → refused, Forge untouched", async () => {
    const root = await tmpDir("craftar-r4-fm-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D",
        inclusion: "fileMatch",
        fileMatchPattern: ["src/**"],
        frontmatterRaw: "paths:\n  - src/**\n",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Change frontmatter: paths: src/** → lib/**
    const readmePath = path.join(wsRoot, ".claude/rules/readme.md");
    let content = await fs.readFile(readmePath, "utf8");
    content = content.replace(/  - src\/\*\*/g, "  - lib/**");
    await fs.writeFile(readmePath, content);

    const before = await hashForge(forgeRoot);

    // Import should REFUSE
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    }).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    expect(msg).toContain("rule/readme--acme");
    expect(msg).toContain("{{craftar.rules.index}}");
    expect(msg).toContain(".claude/rules/readme.md");
    expect(msg).toContain("differs");

    // Forge byte-identical
    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });

  /**
   * r4.sh param: variant body `# Rules of {{project}}\n\n{{craftar.rules.index}}\n`, project set by profile;
   * sync; import → exit 0, variant files byte-identical, report.variants lists it.
   */
  it("4b. variant with param and placeholder — unchanged → reused, files byte-identical", async () => {
    const root = await tmpDir("craftar-r4-param-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D",
        params: { project: { default: "acme-portal" } },
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules of {{project}}\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Capture before
    const variantBodyBefore = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );
    const variantMetaBefore = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/ingredient.yaml"),
      "utf8"
    );

    // Import back
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // Should be in report.variants (not reused the normal way, but handled specially)
    expect(result.variants.map((v) => v.name)).toContain("rule/readme--acme");

    // Variant files byte-identical
    const variantBodyAfter = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );
    const variantMetaAfter = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/ingredient.yaml"),
      "utf8"
    );
    expect(variantBodyAfter).toBe(variantBodyBefore);
    expect(variantMetaAfter).toBe(variantMetaBefore);
  });

  /**
   * r4.sh dotfile: variant declares file: ./rule.md → exit 0 (no crash), files byte-identical.
   */
  it("4c. variant with file: ./rule.md and placeholder → exit 0, files byte-identical", async () => {
    const root = await tmpDir("craftar-r4-dotfile-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D",
        file: "./rule.md",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Capture before
    const variantBodyBefore = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );

    // Import back — should not crash
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // exit 0 (no error)
    expect(result.profile).toBe("acme");

    // Variant files byte-identical
    const variantBodyAfter = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/rule.md"),
      "utf8"
    );
    expect(variantBodyAfter).toBe(variantBodyBefore);
  });

  /**
   * r4.sh other: variant declares file: body.md → exit 0 (no crash), files byte-identical.
   */
  it("4d. variant with file: body.md and placeholder → exit 0, files byte-identical", async () => {
    const root = await tmpDir("craftar-r4-other-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "D",
        file: "body.md",
      }),
      "ingredients/rules/readme--acme/body.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Capture before
    const variantBodyBefore = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/body.md"),
      "utf8"
    );

    // Import back — should not crash
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // exit 0 (no error)
    expect(result.profile).toBe("acme");

    // Variant files byte-identical
    const variantBodyAfter = await fs.readFile(
      path.join(forgeRoot, "ingredients/rules/readme--acme/body.md"),
      "utf8"
    );
    expect(variantBodyAfter).toBe(variantBodyBefore);
  });

  /**
   * r4b.sh plain: after import, rule/readme--acme is listed in recipes/base--acme.yaml, not in recipes/base.yaml.
   */
  it("4e. variant listed in base--acme, not in base", async () => {
    const root = await tmpDir("craftar-r4-plain-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Import back
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    expect(result.profile).toBe("acme");

    // Check recipes: acme-rules should have the variant, not a base recipe
    const acmeRules = YAML.parse(
      await fs.readFile(path.join(forgeRoot, "recipes/acme-rules.yaml"), "utf8")
    );
    expect(acmeRules.ingredients).toContain("rule/readme--acme");

    // And if base.yaml exists, it should not have the variant
    const recipesDir = await fs.readdir(path.join(forgeRoot, "recipes"));
    if (recipesDir.includes("base.yaml")) {
      const base = YAML.parse(
        await fs.readFile(path.join(forgeRoot, "recipes/base.yaml"), "utf8")
      );
      expect(base.ingredients).not.toContain("rule/readme--acme");
    }
  });

  /**
   * A variant holding the placeholder whose workspace body equals its list but whose frontmatter differs → refused.
   */
  it("4f. variant with placeholder — body matches, frontmatter differs → refused", async () => {
    const root = await tmpDir("craftar-r4-fm-diff-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "D readme",
      }),
      "ingredients/rules/readme/rule.md": "# Rules\nbase\n",
      "ingredients/rules/readme--acme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme--acme",
        as: "readme",
        description: "Different desc from variant",  // will differ when import reads from workspace
        inclusion: "fileMatch",
        fileMatchPattern: ["src/**"],
        frontmatterRaw: "paths:\n  - src/**\n",
      }),
      "ingredients/rules/readme--acme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      "recipes/acme-rules.yaml": YAML.stringify({
        name: "acme-rules",
        ingredients: ["rule/style", "rule/readme--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["acme-rules"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Now, modify the frontmatter in the workspace while keeping body (rules list) the same
    const readmePath = path.join(wsRoot, ".claude/rules/readme.md");
    let content = await fs.readFile(readmePath, "utf8");
    // Change paths pattern — the body is still the same, but frontmatter differs
    content = content.replace(/  - src\/\*\*/g, "  - lib/**");
    await fs.writeFile(readmePath, content);

    const before = await hashForge(forgeRoot);

    // Import should REFUSE
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    }).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    const msg = (result as Error).message;
    expect(msg).toContain("rule/readme--acme");
    expect(msg).toContain("{{craftar.rules.index}}");
    expect(msg).toContain("differs");

    // Forge byte-identical
    const after = await hashForge(forgeRoot);
    expect(after).toEqual(before);
  });

  /**
   * An agent base holding {{craftar.rules.index}} that import turns into a variant → NO "frozen" warning.
   */
  it("4g. agent base with placeholder becomes variant → no frozen warning", async () => {
    const root = await tmpDir("craftar-r4-agent-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "f", schema: 7 }),
      "ingredients/rules/style/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "style",
        description: "D style",
      }),
      "ingredients/rules/style/rule.md": "# Style\n",
      "ingredients/agents/helper/ingredient.yaml": YAML.stringify({
        type: "agent",
        name: "helper",
        description: "Helper agent",  // description triggers variant creation on import
      }),
      "ingredients/agents/helper/agent.md": "# Helper\n\n{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({
        name: "base",
        ingredients: ["rule/style", "agent/helper"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
      }),
    });

    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
    });

    // Sync
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const lock = await readLock(wsRoot);
    const st = await status(ws, p, lock);
    await apply(ws, p, st);

    // Import back — agent with description will become a variant (import doesn't write description)
    const result = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // It should create a variant for the agent
    expect(result.variants.map((v) => v.name)).toContain("agent/helper--acme");

    // But NO "frozen" warning for agent (only for rule/steering)
    const frozenWarning = result.warnings.find(
      (w) => w.includes("agent/helper") && w.includes("frozen")
    );
    expect(frozenWarning).toBeUndefined();
  });
});
