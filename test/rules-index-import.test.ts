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
  });

  describe("re-import at schema 7: compares a base with its index expanded", () => {
    it("6. sync then import back → rule/readme is reused, not a variant", async () => {
      const s = await acmeIndex({ schema: 7, literal: true });
      cleanups.push(s.cleanup);

      // Sync the workspace to expand the index
      expect(await (async () => {
        const ws = await loadWorkspace(s.wsRoot);
        const p = await plan(ws);
        const lock = await readLock(s.wsRoot);
        const st = await status(ws, p, lock);
        await apply(ws, p, st);
        return true;
      })()).toBe(true);

      // Import back into the same Forge with the same profile
      const result = await importClaudeCode({
        workspaceRoot: s.wsRoot,
        forgeRoot: s.forgeRoot,
        profileName: "acme",
      });

      // rule/readme should be reused, not a variant
      expect(result.reused).toContain("rule/readme");
      expect(result.variants.map((v) => v.name)).not.toContain("rule/readme--acme");
    });

    it("7. sync with agents-md.primary then import back → scoped rules still reused", async () => {
      const s = await acmeIndex({ schema: 7, literal: true });
      cleanups.push(s.cleanup);

      // Add agents-md.primary to the profile
      const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
      const profileYaml = YAML.parse(await fs.readFile(profilePath, "utf8"));
      profileYaml.params = { ...profileYaml.params, "agents-md.primary": true };
      await fs.writeFile(profilePath, YAML.stringify(profileYaml));

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

      // With agents-md.primary:
      // - rule/readme and rule/style go into AGENTS.md, not individual files, so not imported
      // - rule/api is scoped (fileMatch), so it's written as a file and should be reused
      // - rule/release is kiro-only, not in claude-code
      expect(result.reused).toContain("rule/api");
      expect(result.reused).toContain("skill/deploy");
      // readme is NOT imported as a rule file in agents-md.primary mode
      expect(result.reused).not.toContain("rule/readme");
      expect(result.variants.map((v) => v.name)).not.toContain("rule/api--acme");
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
