/**
 * Spec 41 Part B Task 05 — Import with target-scoped sections.
 * Tests that import infers a section only when it reaches the importing target.
 */
import { afterEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-target-sections-import-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (name: string) => path.join(root, name) };
}

const importInto = (forge: string, workspaceRoot: string, profileName: string, opts?: { preferKiro?: string[] }) =>
  importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName, preferKiro: opts?.preferKiro });

/** Copy a directory recursively. */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** Sync a workspace to disk. */
async function syncWorkspace(wsRoot: string): Promise<void> {
  const ws = await loadWorkspace(wsRoot);
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  await apply(ws, p, st, {});
}

/**
 * Creates a schema-6 Forge with rule `style` having two target-scoped sections:
 * - `k` targets=kiro: only for kiro
 * - `c` targets=claude-code: only for claude-code
 */
async function schemaWithTargetedSections(t: { forge: string; ws: (name: string) => string }) {
  const LF = "\n";
  const openK = "<!-- craftar:section k targets=kiro -->";
  const openC = "<!-- craftar:section c targets=claude-code -->";
  const close = "<!-- /craftar:section -->";

  // rule/style with two target-scoped sections
  const styleBody = [
    "# Style",
    "",
    openK,
    "Kiro default content.",
    close,
    "",
    openC,
    "Claude default content.",
    close,
    "",
    "End.",
  ].join(LF) + LF;

  // Create the Forge structure
  await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
  await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
  await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

  // Write craftar.forge.yaml with schema 6
  await fs.writeFile(
    path.join(t.forge, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: 6 }),
  );

  // Write ingredient
  await fs.writeFile(
    path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
    YAML.stringify({ type: "rule", name: "style" }),
  );
  await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), styleBody);

  // Write recipe
  await fs.writeFile(
    path.join(t.forge, "recipes/base.yaml"),
    YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
  );

  // Write profile
  await fs.writeFile(
    path.join(t.forge, "profiles/acme/profile.yaml"),
    YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
  );

  // Create workspace with craftar.yaml
  const wsRoot = t.ws("acme");
  await fs.mkdir(wsRoot, { recursive: true });
  await fs.writeFile(
    path.join(wsRoot, "craftar.yaml"),
    YAML.stringify({ forge: "../forge", profile: "acme" }),
  );

  return { forgeRoot: t.forge, wsRoot };
}

describe("import with target-scoped sections (spec 41 Part B Task 05)", () => {
  it("re-import after sync round-trips: every base reused, Forge copy byte-identical", async () => {
    const t = await setup();
    const { forgeRoot, wsRoot } = await schemaWithTargetedSections(t);

    // Sync the workspace
    await syncWorkspace(wsRoot);

    // Copy the Forge to a new location
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(forgeRoot, forgeCopy);

    // Re-import — should reuse everything
    const result = await importInto(forgeCopy, wsRoot, "acme");
    expect(result.reused).toContain("rule/style");
    expect(result.variants).toEqual([]);
    expect(result.sectioned).toEqual([]);

    // The Forge copy should be byte-identical to the original
    const origRule = await fs.readFile(path.join(forgeRoot, "ingredients/rules/style/rule.md"), "utf8");
    const copyRule = await fs.readFile(path.join(forgeCopy, "ingredients/rules/style/rule.md"), "utf8");
    expect(copyRule).toBe(origRule);
  });

  it("hand edit inside 'c' section of .claude/rules/style.md → infers 'c' into profile sections (not a variant), never 'k'", async () => {
    const t = await setup();
    const { forgeRoot, wsRoot } = await schemaWithTargetedSections(t);

    // Sync the workspace
    await syncWorkspace(wsRoot);

    // Hand-edit the .claude/rules/style.md file — change only the 'c' section
    const claudeRule = path.join(wsRoot, ".claude/rules/style.md");
    const content = await fs.readFile(claudeRule, "utf8");
    // The claude-code file should have the 'c' section rendered (default), but not 'k'
    // Replace the default content
    const edited = content.replace("Claude default content.", "Edited Claude content.");
    await fs.writeFile(claudeRule, edited);

    // Copy the Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(forgeRoot, forgeCopy);

    // Re-import
    const result = await importInto(forgeCopy, wsRoot, "acme");

    // Should infer the 'c' section value, not create a variant
    expect(result.variants).toEqual([]);
    expect(result.sectioned).toEqual([{ name: "rule/style", sections: ["c"] }]);
    expect(result.sections.map((x) => x.name)).toEqual(["c"]);
    expect(result.sections.find((x) => x.name === "c")?.value).toBe("Edited Claude content.\n");

    // Should NOT have inferred 'k' (it's for kiro only)
    expect(result.sections.find((x) => x.name === "k")).toBeUndefined();

    // The Forge's rule.md should still have both markers with targets=
    const forgeRule = await fs.readFile(path.join(forgeCopy, "ingredients/rules/style/rule.md"), "utf8");
    expect(forgeRule).toContain("<!-- craftar:section k targets=kiro -->");
    expect(forgeRule).toContain("<!-- craftar:section c targets=claude-code -->");
  });

  it("--prefer-kiro style with edit inside 'k' in steering file → infers 'k' into sections, not 'c'", async () => {
    const t = await setup();
    const { forgeRoot, wsRoot } = await schemaWithTargetedSections(t);

    // Sync the workspace
    await syncWorkspace(wsRoot);

    // Hand-edit the .kiro/steering/style.md file — change only the 'k' section
    const kiroSteering = path.join(wsRoot, ".kiro/steering/style.md");
    const content = await fs.readFile(kiroSteering, "utf8");
    // The kiro file should have the 'k' section rendered (default), but not 'c'
    const edited = content.replace("Kiro default content.", "Edited Kiro content.");
    await fs.writeFile(kiroSteering, edited);

    // Copy the Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(forgeRoot, forgeCopy);

    // Re-import with --prefer-kiro style
    const result = await importInto(forgeCopy, wsRoot, "acme", { preferKiro: ["style"] });

    // Should infer the 'k' section value, not create a variant
    expect(result.variants).toEqual([]);
    expect(result.sectioned).toEqual([{ name: "rule/style", sections: ["k"] }]);
    expect(result.sections.map((x) => x.name)).toEqual(["k"]);
    expect(result.sections.find((x) => x.name === "k")?.value).toBe("Edited Kiro content.\n");

    // Should NOT have inferred 'c' (it's for claude-code only)
    expect(result.sections.find((x) => x.name === "c")).toBeUndefined();
  });
});
