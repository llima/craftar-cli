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

  it("steering/notes with targets=kiro section is reused on re-import (sourceTarget fix)", async () => {
    // This tests Fix 1: hand-written steering must be compared as Kiro renders it (sourceTarget: "kiro")
    const t = await setup();
    const LF = "\n";

    // Create schema 6 Forge with steering/notes that has targets=kiro section
    await fs.mkdir(path.join(t.forge, "ingredients/steerings/notes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/steerings/notes/ingredient.yaml"),
      YAML.stringify({ type: "steering", name: "notes", file: "steering.md", targets: ["kiro"], tags: ["client"] }),
    );
    await fs.writeFile(
      path.join(t.forge, "ingredients/steerings/notes/steering.md"),
      `# Notes${LF}${LF}<!-- craftar:section s targets=kiro -->${LF}Kiro only.${LF}<!-- /craftar:section -->${LF}${LF}End.${LF}`,
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), `# Style${LF}`);

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style", "steering/notes"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
    );

    // Create workspace
    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    // Sync
    await syncWorkspace(wsRoot);

    // Copy Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    // Re-import — steering/notes must be reused (it has targets=kiro section, import source is kiro)
    const result = await importInto(forgeCopy, wsRoot, "acme");
    expect(result.reused).toContain("steering/notes");
    expect(result.variants).toEqual([]);

    // Forge copy must be byte-identical
    const origSteering = await fs.readFile(path.join(t.forge, "ingredients/steerings/notes/steering.md"), "utf8");
    const copySteering = await fs.readFile(path.join(forgeCopy, "ingredients/steerings/notes/steering.md"), "utf8");
    expect(copySteering).toBe(origSteering);
  });

  it("steering/notes with untargeted section is reused on re-import (control for sourceTarget fix)", async () => {
    // Control test: untargeted section should also be reused
    const t = await setup();
    const LF = "\n";

    await fs.mkdir(path.join(t.forge, "ingredients/steerings/notes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/steerings/notes/ingredient.yaml"),
      YAML.stringify({ type: "steering", name: "notes", file: "steering.md", targets: ["kiro"], tags: ["client"] }),
    );
    // Untargeted section
    await fs.writeFile(
      path.join(t.forge, "ingredients/steerings/notes/steering.md"),
      `# Notes${LF}${LF}<!-- craftar:section s -->${LF}Default content.${LF}<!-- /craftar:section -->${LF}${LF}End.${LF}`,
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), `# Style${LF}`);

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style", "steering/notes"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
    );

    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    await syncWorkspace(wsRoot);

    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    const result = await importInto(forgeCopy, wsRoot, "acme");
    expect(result.reused).toContain("steering/notes");
    expect(result.variants).toEqual([]);
  });

  it("pin unprojected cited keys: edit to rule b keeps kiro rule a unchanged (F9)", async () => {
    // Tests Fix 2: a key cited in another target's section must be pinned
    // Scenario: rule a has `<!-- craftar:section s targets=kiro -->team {{team}}<!-- /craftar:section -->`
    // rule b has `# B {{team}}`; profile sets team: old; edit .claude/rules/b.md to `# B new`
    // b becomes variant, profile team stays 'old', kiro rule a is unchanged
    const t = await setup();
    const LF = "\n";

    await fs.mkdir(path.join(t.forge, "ingredients/rules/a"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/b"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    // rule a: has a targets=kiro section citing {{team}}
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/a/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "a", params: { team: { description: "team name" } } }),
    );
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/a/rule.md"),
      `# A${LF}${LF}<!-- craftar:section s targets=kiro -->${LF}team {{team}}${LF}<!-- /craftar:section -->${LF}`,
    );

    // rule b: cites {{team}} in body
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/b/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "b", params: { team: { description: "team name" } } }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/b/rule.md"), `# B {{team}}${LF}`);

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/a", "rule/b"] }),
    );

    // Profile sets team: old
    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"], params: { team: "old" } }),
    );

    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    // Sync
    await syncWorkspace(wsRoot);

    // Hand-edit .claude/rules/b.md to `# B new` (removing the param)
    await fs.writeFile(path.join(wsRoot, ".claude/rules/b.md"), `# B new${LF}`);

    // Copy Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    // Re-import
    const result = await importInto(forgeCopy, wsRoot, "acme");

    // Assertion 1: b becomes a variant
    expect(result.variants.map((v: { name: string }) => v.name)).toContain("rule/b--acme");

    // Assertion 2: profile team stays 'old' — check the profile file
    const profileContent = await fs.readFile(path.join(forgeCopy, "profiles/acme/profile.yaml"), "utf8");
    const profile = YAML.parse(profileContent);
    expect(profile.params?.team).toBe("old");

    // Point the workspace at the Forge copy and check status
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge-copy", profile: "acme" }),
    );

    // Assertion 3: .kiro/steering/a.md should be unchanged
    const ws = await loadWorkspace(wsRoot);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    const stJson = st.map((s: { path: string; state: string }) => ({ path: s.path, state: s.state }));
    const kiroA = stJson.find((s: { path: string }) => s.path === ".kiro/steering/a.md");
    expect(kiroA?.state).toBe("unchanged");
  });


  it("variant from claude-code file warns about targets=kiro section left out", async () => {
    // Test the BLOCKER fix: a variant made from one target's file should warn about sections for other targets
    const t = await setup();
    const LF = "\n";

    // Create schema 6 Forge with rule/style having an untargeted part and a targets=kiro section
    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    // rule/style with untargeted content and a targets=kiro section
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/rule.md"),
      `# Style${LF}${LF}Shared content.${LF}${LF}<!-- craftar:section k targets=kiro -->${LF}Kiro only.${LF}<!-- /craftar:section -->${LF}`,
    );

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
    );

    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    // Sync
    await syncWorkspace(wsRoot);

    // Hand-edit .claude/rules/style.md OUTSIDE any section (change the shared content)
    const claudeRule = path.join(wsRoot, ".claude/rules/style.md");
    const content = await fs.readFile(claudeRule, "utf8");
    const edited = content.replace("Shared content.", "Edited shared content.");
    await fs.writeFile(claudeRule, edited);

    // Copy Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    // Re-import — should create variant and warn about k section
    const result = await importInto(forgeCopy, wsRoot, "acme");

    // Assertion 1: rule/style--acme is a variant
    expect(result.variants.map((v: { name: string }) => v.name)).toContain("rule/style--acme");

    // Assertion 2: warning mentions section k with targets=kiro
    const sectionWarning = result.warnings.find((w: string) => w.includes("leaves out section k"));
    expect(sectionWarning).toBeDefined();
    expect(sectionWarning).toContain("made from the claude-code file");
    expect(sectionWarning).toContain("targets=kiro");
    expect(sectionWarning).toContain("sync writes kiro without it");

    // Assertion 3: the text "Kiro only." does NOT appear in any warning
    for (const w of result.warnings) {
      expect(w).not.toContain("Kiro only.");
    }
  });

  it("--prefer-kiro variant from kiro file warns about targets=claude-code section left out", async () => {
    // Mirror case: --prefer-kiro with targets=claude-code section
    const t = await setup();
    const LF = "\n";

    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    // rule/style with untargeted content and a targets=claude-code section
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/rule.md"),
      `# Style${LF}${LF}Shared content.${LF}${LF}<!-- craftar:section c targets=claude-code -->${LF}Claude only.${LF}<!-- /craftar:section -->${LF}`,
    );

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
    );

    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    // Sync
    await syncWorkspace(wsRoot);

    // Hand-edit .kiro/steering/style.md OUTSIDE any section
    const kiroSteering = path.join(wsRoot, ".kiro/steering/style.md");
    const content = await fs.readFile(kiroSteering, "utf8");
    const edited = content.replace("Shared content.", "Edited from kiro.");
    await fs.writeFile(kiroSteering, edited);

    // Copy Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    // Re-import with --prefer-kiro
    const result = await importInto(forgeCopy, wsRoot, "acme", { preferKiro: ["style"] });

    // Assertion 1: rule/style--acme is a variant
    expect(result.variants.map((v: { name: string }) => v.name)).toContain("rule/style--acme");

    // Assertion 2: warning mentions section c with targets=claude-code and "made from the kiro file"
    const sectionWarning = result.warnings.find((w: string) => w.includes("leaves out section c"));
    expect(sectionWarning).toBeDefined();
    expect(sectionWarning).toContain("made from the kiro file");
    expect(sectionWarning).toContain("targets=claude-code");
    expect(sectionWarning).toContain("sync writes claude-code without it");

    // Assertion 3: the text "Claude only." does NOT appear in any warning
    for (const w of result.warnings) {
      expect(w).not.toContain("Claude only.");
    }
  });


  it("a base whose only section is targets=kiro, claude source differs outside → variant reason is from param pass (NIT 3)", async () => {
    // Test NIT 3: when a base's only open section is for another target, the param pass decides (not section inference)
    const t = await setup();
    const LF = "\n";

    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "f", schema: 6 }),
    );

    // rule/style with shared content and ONLY a targets=kiro section
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/rule.md"),
      `# Style${LF}${LF}Shared content.${LF}${LF}<!-- craftar:section k targets=kiro -->${LF}Kiro only.${LF}<!-- /craftar:section -->${LF}`,
    );

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
    );

    const wsRoot = t.ws("ws");
    await fs.mkdir(wsRoot, { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, "craftar.yaml"),
      YAML.stringify({ forge: "../forge", profile: "acme" }),
    );

    // Sync
    await syncWorkspace(wsRoot);

    // Hand-edit .claude/rules/style.md OUTSIDE any section
    const claudeRule = path.join(wsRoot, ".claude/rules/style.md");
    const content = await fs.readFile(claudeRule, "utf8");
    const edited = content.replace("Shared content.", "Edited outside section.");
    await fs.writeFile(claudeRule, edited);

    // Copy Forge
    const forgeCopy = path.join(t.root, "forge-copy");
    await copyDir(t.forge, forgeCopy);

    // Re-import
    const result = await importInto(forgeCopy, wsRoot, "acme");

    // The variant should be created
    expect(result.variants.map((v: { name: string }) => v.name)).toContain("rule/style--acme");

    // With the fix (using projectedNames for open), the param pass returns immediately when there are
    // no open sections for the owner. When the base has no declared params, the variant reason comes
    // from the "differs from..." wrapper, not from section inference.
    const variant = result.variants.find((v: { name: string }) => v.name === "rule/style--acme");
    // Without the fix, section inference would be called and the reason would mention "text outside the sections"
    // With the fix, section inference is skipped and we get just the generic "differs from..." reason
    expect(variant?.reason).not.toContain("text outside the sections");
  });
