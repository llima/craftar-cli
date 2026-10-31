import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadWorkspace, plan, status, apply, readLock } from "../src/core/sync.js";
import { tmpDir, writeFiles, profile, recipe } from "./helpers/forge.js";

/**
 * Item 1: craftar.rules.index on the import path is only half fixed.
 * Tests that at schema: 7, a value for craftar.rules.index no longer reaches re-import:
 * - no spurious variant
 * - no frozen list
 * - no refusal of an unchanged variant
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * Build a Forge at the given schema with:
 * - rule/readme with body `{{craftar.rules.index}}` alone on a line
 * - rule/style as a second rule
 * - profile acme using both
 * 
 * NOTE: Rules have no description to ensure they round-trip through import
 * (import doesn't preserve description, so a rule with one becomes a variant).
 */
async function makeForge(schema: number, opts: { ingredientDefault?: string; profileParams?: Record<string, unknown>; wsOverrides?: Record<string, unknown>; recipeDefault?: string } = {}) {
  const root = await tmpDir("craftar-ri-value-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");

  // Build the readme ingredient — no description to ensure round-trip
  const readmeMeta: Record<string, unknown> = {
    type: "rule",
    name: "readme",
    inclusion: "always",
    file: "rule.md",
  };
  if (opts.ingredientDefault) {
    readmeMeta.params = { "craftar.rules.index": { default: opts.ingredientDefault } };
  }

  // Build the style ingredient — no description to ensure round-trip
  const styleMeta: Record<string, unknown> = {
    type: "rule",
    name: "style",
    inclusion: "always",
    file: "rule.md",
  };

  // Build the base recipe
  const baseRecipe: Record<string, unknown> = {
    name: "base",
    ingredients: ["rule/readme", "rule/style"],
  };
  if (opts.recipeDefault) {
    baseRecipe.params = { "craftar.rules.index": { default: opts.recipeDefault } };
  }

  // Build the acme profile
  const acmeProfile: Record<string, unknown> = {
    name: "acme",
    recipes: ["base"],
    targets: ["claude-code"],
  };
  if (opts.profileParams) {
    acmeProfile.params = opts.profileParams;
  }

  await writeFiles(forgeRoot, {
    "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema }),
    "ingredients/rules/readme/ingredient.yaml": YAML.stringify(readmeMeta),
    "ingredients/rules/readme/rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
    "ingredients/rules/style/ingredient.yaml": YAML.stringify(styleMeta),
    "ingredients/rules/style/rule.md": "# Style\nConsistent formatting.\n",
    "recipes/base.yaml": YAML.stringify(baseRecipe),
    "profiles/acme/profile.yaml": YAML.stringify(acmeProfile),
  });

  // Build the workspace config
  const wsConfig: Record<string, unknown> = {
    forge: "../forge",
    profile: "acme",
  };
  if (opts.wsOverrides) {
    wsConfig.overrides = { params: opts.wsOverrides };
  }

  await writeFiles(wsRoot, {
    "craftar.yaml": YAML.stringify(wsConfig),
  });

  return { root, forgeRoot, wsRoot };
}

/** Sync the workspace so it has the expanded rules list. */
async function syncWorkspace(wsRoot: string): Promise<void> {
  const ws = await loadWorkspace(wsRoot);
  const p = await plan(ws);
  const lock = await readLock(wsRoot);
  const st = await status(ws, p, lock);
  await apply(ws, p, st);
}

/** Check if a variant directory exists. */
async function variantExists(forgeRoot: string, name: string): Promise<boolean> {
  const variantDir = path.join(forgeRoot, "ingredients/rules", name);
  try {
    await fs.access(variantDir);
    return true;
  } catch {
    return false;
  }
}

/** Read the profile's recipes list. */
async function readProfileRecipes(forgeRoot: string): Promise<string[]> {
  const profilePath = path.join(forgeRoot, "profiles/acme/profile.yaml");
  const content = await fs.readFile(profilePath, "utf8");
  const parsed = YAML.parse(content);
  return parsed.recipes ?? [];
}

describe("Item 1: craftar.rules.index value at re-import (schema 7)", () => {
  describe("a) value from ingredient's params default", () => {
    it("exit 0, rule/readme reused, no readme--acme variant, profile's recipes unchanged, no 'compared literally' warning", async () => {
      const s = await makeForge(7, { ingredientDefault: "Always on:\n- readme\n- style\n" });

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Get recipes before import
      const recipesBefore = await readProfileRecipes(s.forgeRoot);

      // Re-import
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // Assertions
      expect(result.reused).toContain("rule/readme");
      expect(await variantExists(s.forgeRoot, "readme--acme")).toBe(false);
      expect(await readProfileRecipes(s.forgeRoot)).toEqual(recipesBefore);
      expect(result.warnings.some((w) => w.includes("compared literally"))).toBe(false);
    });
  });

  describe("b) value from profile's params", () => {
    it("exit 0, rule/readme reused, no readme--acme variant, profile's recipes unchanged, no 'compared literally' warning", async () => {
      const s = await makeForge(7, { profileParams: { "craftar.rules.index": "Always on:\n- readme\n- style\n" } });

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Get recipes before import
      const recipesBefore = await readProfileRecipes(s.forgeRoot);

      // Re-import
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // Assertions
      expect(result.reused).toContain("rule/readme");
      expect(await variantExists(s.forgeRoot, "readme--acme")).toBe(false);
      expect(await readProfileRecipes(s.forgeRoot)).toEqual(recipesBefore);
      expect(result.warnings.some((w) => w.includes("compared literally"))).toBe(false);
    });
  });

  describe("c) value from workspace's overrides.params", () => {
    it("exit 0, rule/readme reused, no readme--acme variant, profile's recipes unchanged, no 'compared literally' warning", async () => {
      const s = await makeForge(7, { wsOverrides: { "craftar.rules.index": "Always on:\n- readme\n- style\n" } });

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Get recipes before import
      const recipesBefore = await readProfileRecipes(s.forgeRoot);

      // Re-import
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // Assertions
      expect(result.reused).toContain("rule/readme");
      expect(await variantExists(s.forgeRoot, "readme--acme")).toBe(false);
      expect(await readProfileRecipes(s.forgeRoot)).toEqual(recipesBefore);
      expect(result.warnings.some((w) => w.includes("compared literally"))).toBe(false);
    });
  });

  describe("d) value only from recipe's params default", () => {
    it("exit 0, rule/readme reused, no readme--acme variant, profile's recipes unchanged, no 'compared literally' warning", async () => {
      const s = await makeForge(7, { recipeDefault: "Always on:\n- readme\n- style\n" });

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Get recipes before import
      const recipesBefore = await readProfileRecipes(s.forgeRoot);

      // Re-import
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // Assertions
      expect(result.reused).toContain("rule/readme");
      expect(await variantExists(s.forgeRoot, "readme--acme")).toBe(false);
      expect(await readProfileRecipes(s.forgeRoot)).toEqual(recipesBefore);
      expect(result.warnings.some((w) => w.includes("compared literally"))).toBe(false);
    });
  });

  describe("e) unchanged variant holding placeholder, value at profile", () => {
    it("import does not throw; variant's files unchanged", async () => {
      const s = await makeForge(7, { profileParams: { "craftar.rules.index": "Always on:\n- readme\n- style\n" } });

      // Create the variant holding the placeholder — no description to match source
      const variantDir = path.join(s.forgeRoot, "ingredients/rules/readme--acme");
      await writeFiles(variantDir, {
        "ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "readme--acme",
          as: "readme",
          inclusion: "always",
          file: "rule.md",
        }),
        "rule.md": "# Rules\n\n{{craftar.rules.index}}\n",
      });

      // Update the profile to use the variant
      await fs.writeFile(
        path.join(s.forgeRoot, "recipes/base--acme.yaml"),
        YAML.stringify({ name: "base--acme", ingredients: ["rule/readme--acme", "rule/style"] }),
      );
      await fs.writeFile(
        path.join(s.forgeRoot, "profiles/acme/profile.yaml"),
        YAML.stringify({
          name: "acme",
          recipes: ["base--acme"],
          targets: ["claude-code"],
          params: { "craftar.rules.index": "Always on:\n- readme\n- style\n" },
        }),
      );

      // A base whose text differs from the variant's, so decide() does not answer reuse
      await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/readme/rule.md"), "# Another base\n");

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Record variant file content before
      const variantContentBefore = await fs.readFile(path.join(variantDir, "rule.md"), "utf8");

      // Re-import should not throw
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // Key assertion: variant's files are unchanged (not overwritten with the expanded list)
      const variantContentAfter = await fs.readFile(path.join(variantDir, "rule.md"), "utf8");
      expect(variantContentAfter).toBe(variantContentBefore);
      expect(variantContentAfter).toContain("{{craftar.rules.index}}");
      
      // The base differs, so the unchanged variant is what this import compares and keeps
      expect(result.reused).not.toContain("rule/readme");
      expect(await variantExists(s.forgeRoot, "readme--acme")).toBe(true);
    });
  });

  describe("an MCP server citing the key, a recipe defaulting it", () => {
    it("is reused, no variant", async () => {
      const s = await makeForge(7, { recipeDefault: "x" });
      const server = { command: "run", args: ["{{craftar.rules.index}}"] };
      await writeFiles(s.forgeRoot, {
        "ingredients/mcp/srv/ingredient.yaml": YAML.stringify({ type: "mcp", name: "srv", server, params: { "craftar.rules.index": {} } }),
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme", "rule/style", "mcp/srv"], params: { "craftar.rules.index": { default: "x" } } }),
      });
      await syncWorkspace(s.wsRoot);
      const result = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
      expect(result.variants.map((v) => v.name)).not.toContain("mcp/srv--acme");
      expect(result.reused).toContain("mcp/srv");
    });
  });

  describe("f) control: schema 6 with value at profile behaves as origin/main", () => {
    it("schema 6 reuses the base when it round-trips (no description)", async () => {
      const s = await makeForge(6, { profileParams: { "craftar.rules.index": "Always on:\n- readme\n- style\n" } });

      // Sync to expand the index
      await syncWorkspace(s.wsRoot);

      // Re-import at schema 6 — without description, rules round-trip
      // so they are reused (the value of craftar.rules.index IS in renderMap
      // at schema 6, but the workspace text matches the base's rendered text).
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // At schema 6 without descriptions, rules round-trip and are reused
      expect(result.reused).toContain("rule/readme");
      expect(result.reused).toContain("rule/style");
    });
  });
});
