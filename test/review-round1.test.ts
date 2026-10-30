/**
 * Review round 1 tests — six should-fixes from node-cli-reviewer.
 * Each test is shown failing before its fix.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, status, readLock } from "../src/core/sync.js";
import { driftList, INDEXED_REASON } from "../src/core/drift.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, scenario, tmpDir, writeFiles, type IngredientSpec } from "./helpers/forge.js";
import { acmeIndex } from "./helpers/rules-index.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { hashNormalized } from "../src/core/text.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

describe("Finding 1: A schema-7 Forge that never uses the index must not fail its plan", () => {
  it("1a. Forge at 7 with no placeholder and a rule whose description holds <!-- craftar: plans without error", async () => {
    // A Forge at schema 7 where NO rule holds the placeholder, but one has <!-- craftar: in its description.
    // The plan should NOT fail because the description check only fires when expanding.
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "style", description: "Has <!-- craftar: marker in description" }, files: { "rule.md": "# Style\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/style"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    // This should NOT throw
    const p = await plan(ws);
    expect(p.warnings).toEqual([]);
  });

  it("1b. Same Forge at 6 and at 7 with no placeholder: bytes identical", async () => {
    // A Forge with no placeholder should give the same bytes at schema 6 and 7.
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "style", description: "Has <!-- craftar: marker in description" }, files: { "rule.md": "# Style\n" } },
    ];

    // Schema 6 version
    const s6 = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/style"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s6.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 6 }));
    const ws6 = await loadWorkspace(s6.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p6 = await plan(ws6);

    // Schema 7 version
    const s7 = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/style"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s7.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));
    const ws7 = await loadWorkspace(s7.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p7 = await plan(ws7);

    // Same number of files
    expect(p7.files.length).toBe(p6.files.length);
    // Same content for each file
    for (const f7 of p7.files) {
      const f6 = p6.files.find((f) => f.path === f7.path);
      expect(f6).toBeDefined();
      expect(f7.content.equals(f6!.content)).toBe(true);
    }
  });
});

describe("Finding 2: Indexed means the list was expanded at least once", () => {
  it("2a. Misplaced-only placeholder: Plan.indexed is empty", async () => {
    // A rule with the placeholder not alone on its line (misplaced): Plan.indexed should be [].
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "bad", description: "Misplaced" },
        files: { "rule.md": "See {{craftar.rules.index}} here\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/bad"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Plan.indexed should be empty because nothing was actually expanded
    expect(p.indexed).toEqual([]);
    // But there should be a warning about the misplaced placeholder
    expect(p.warnings.some((w) => w.includes("must stand alone on its line"))).toBe(true);
  });

  it("2b. Misplaced-only: drift promote is NOT refused with D21", async () => {
    // After a hand edit to a file that only has a misplaced placeholder, drift promote should NOT refuse.
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "bad", description: "Misplaced" },
        files: { "rule.md": "See {{craftar.rules.index}} here\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/bad"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));

    // Check that the file is not considered indexed for drift purposes
    const indexedPaths = new Set(p.indexed.map((x) => x.path));
    const rows = driftList(st, new Map(), new Set(), indexedPaths);
    // The file should not have INDEXED_REASON since it was never expanded
    const badRow = rows.find((r) => r.path === ".claude/rules/bad.md");
    expect(badRow?.reason).not.toBe(INDEXED_REASON);
  });

  it("2c. Two always-on rules each holding the placeholder: ONE AGENTS.md entry", async () => {
    // Two rules, each with the placeholder in their body. When both appear in AGENTS.md,
    // Plan.indexed should have only ONE AGENTS.md entry (deduplicated by path).
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "alpha", description: "First" },
        files: { "rule.md": "{{craftar.rules.index}}\n" },
      },
      {
        meta: { type: "rule", name: "beta", description: "Second" },
        files: { "rule.md": "{{craftar.rules.index}}\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/alpha", "rule/beta"])], profiles: [profile("test", ["base"], ["agents-md"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Count AGENTS.md entries in indexed
    const agentsMdEntries = p.indexed.filter((x) => x.path === "AGENTS.md");
    expect(agentsMdEntries.length).toBe(1);
  });

  it("2d. A profile with no listed rule and a steering holding the placeholder: steering is indexed with rules: 0", async () => {
    // A steering file holding the placeholder but no rules resolve → indexed with rules: 0.
    const ingredients: IngredientSpec[] = [
      { meta: { type: "steering", name: "index", targets: ["kiro"] }, files: { "steering.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["steering/index"])], profiles: [profile("test", ["base"], ["kiro"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // The steering should be indexed with rules: 0
    const steeringEntry = p.indexed.find((x) => x.path === ".kiro/steering/index.md");
    expect(steeringEntry).toBeDefined();
    expect(steeringEntry!.rules).toBe(0);
  });
});

describe("Finding 3: explain AGENTS.md prints no index line", () => {
  it("3. explain AGENTS.md does not print index line", async () => {
    // AGENTS.md is not one ingredient, so the README says it gets neither line.
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    
    // Run craftar explain AGENTS.md
    const { stdout, code } = await runCli(["explain", "AGENTS.md"], { cwd: s.wsRoot });
    
    expect(code).toBe(0);
    // The output should NOT contain the index line
    expect(stdout).not.toContain("index       craftar.rules.index");
  });
});

describe("Finding 4: Fail closed for a profile the import creates", () => {
  it("4. import a NEW profile where base holds placeholder: exit 1, Forge byte-identical", async () => {
    // Setup: Forge at 7 with rule/readme base holding the placeholder.
    // Import under a NEW profile name (one that doesn't exist yet).
    // Should fail closed because the new profile would be compared against a base with the placeholder.
    const root = await tmpDir("craftar-import-new-profile-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    await fs.mkdir(forgeRoot, { recursive: true });
    await fs.mkdir(wsRoot, { recursive: true });

    // Create Forge with rule/readme holding the placeholder
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
      // No profile yet — we're importing a NEW profile
    });

    // Create workspace with .claude/rules/readme.md (expanded list)
    await fs.mkdir(path.join(wsRoot, ".claude", "rules"), { recursive: true });
    await writeFiles(wsRoot, {
      ".claude/rules/readme.md": "# Rules\n\nAlways on:\n- `.claude/rules/readme.md` — Index\n",
    });

    // Hash all Forge files before import
    const forgeFilesBefore = new Map<string, string>();
    const hashDirTo = async (dir: string, target: Map<string, string>, prefix = ""): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await hashDirTo(path.join(dir, entry.name), target, rel);
        } else {
          const content = await fs.readFile(path.join(dir, entry.name));
          target.set(rel, hashNormalized(content));
        }
      }
    };
    await hashDirTo(forgeRoot, forgeFilesBefore);

    // Import under a NEW profile name (not existing in Forge)
    await expect(
      importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "newprofile",
      })
    ).rejects.toThrow(/profile newprofile does not resolve/);

    // Forge should be byte-identical
    const forgeFilesAfter = new Map<string, string>();
    await hashDirTo(forgeRoot, forgeFilesAfter);
    for (const [file, hash] of forgeFilesBefore) {
      expect(forgeFilesAfter.get(file)).toBe(hash);
    }
  });

  it("4b. import NEW profile into Forge at 7 where NO rule holds placeholder: succeeds", async () => {
    // A new profile into a Forge at 7 where no rule holds the placeholder should still import.
    const root = await tmpDir("craftar-import-new-no-placeholder-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    await fs.mkdir(forgeRoot, { recursive: true });
    await fs.mkdir(wsRoot, { recursive: true });

    // Create Forge with rule/readme WITHOUT the placeholder
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
      "ingredients/rules/readme/rule.md": "# Rules\n\nHere are the rules.\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
    });

    // Create workspace
    await fs.mkdir(path.join(wsRoot, ".claude", "rules"), { recursive: true });
    await writeFiles(wsRoot, {
      ".claude/rules/readme.md": "# Rules\n\nHere are the rules.\n",
    });

    // Should succeed
    const report = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "newprofile",
    });
    expect(report.profile).toBe("newprofile");
  });
});

describe("Finding 5: Resolve once, word the failure through errorText", () => {
  it("5. Broken profile + base holding placeholder: exactly ONE error line", async () => {
    // A broken profile (e.g., missing recipe) plus a base holding the placeholder
    // should produce exactly ONE error line, not multiple calls to resolveForImport.
    const root = await tmpDir("craftar-import-broken-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    await fs.mkdir(forgeRoot, { recursive: true });
    await fs.mkdir(wsRoot, { recursive: true });

    // Create Forge with rule/readme holding the placeholder and a profile that references a missing recipe
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
      "ingredients/rules/readme/rule.md": "{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
      // Profile references a recipe that doesn't exist
      "profiles/broken/profile.yaml": YAML.stringify({
        name: "broken",
        description: "Broken profile",
        recipes: ["base", "nonexistent"],
        targets: ["claude-code"],
      }),
    });

    // Create workspace
    await fs.mkdir(path.join(wsRoot, ".claude", "rules"), { recursive: true });
    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: forgeRoot, profile: "broken" }),
      ".claude/rules/readme.md": "# Rules\n\nAlways on:\n- `.claude/rules/readme.md` — Index\n",
    });

    // Should fail
    await expect(
      importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "broken",
      })
    ).rejects.toThrow(/profile broken does not resolve/);
  });
});

describe("Finding 6: Misplaced placeholder names its file line, sorted numerically", () => {
  it("6a. Kiro steering reports the line where the text sits in the CRLF file", async () => {
    // Kiro files are CRLF. A misplaced placeholder on line 3 should report line 3.
    // The line number should be counted from the planned content.
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "steering", name: "test", targets: ["kiro"] },
        files: { "steering.md": "Line 1\nLine 2\nSee {{craftar.rules.index}} here\nLine 4\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["steering/test"])], profiles: [profile("test", ["base"], ["kiro"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Find the warning about misplaced placeholder
    const warning = p.warnings.find((w) => w.includes("must stand alone on its line"));
    expect(warning).toBeDefined();
    // Should report the correct line number (line 3 in the CRLF file)
    expect(warning).toContain(".kiro/steering/test.md:3");
  });

  it("6b. Misplaced placeholders on lines 2 and 10: lists :2 before :10 (numeric sort)", async () => {
    // A file with misplaced placeholders on lines 2 and 10 should list :2 before :10.
    const body = [
      "Line 1",
      "See {{craftar.rules.index}} here",  // line 2
      "Line 3",
      "Line 4",
      "Line 5",
      "Line 6",
      "Line 7",
      "Line 8",
      "Line 9",
      "Also {{craftar.rules.index}} here",  // line 10
      "Line 11",
    ].join("\n") + "\n";

    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "many", description: "Many misplaced" },
        files: { "rule.md": body },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/many"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const warning = p.warnings.find((w) => w.includes("must stand alone on its line"));
    expect(warning).toBeDefined();
    // Check that :2 appears before :10 in the warning
    const idx2 = warning!.indexOf(":2");
    const idx10 = warning!.indexOf(":10");
    expect(idx2).toBeLessThan(idx10);
  });
});

describe("Finding 7 (nits)", () => {
  it("7a. No redundant -text line in .gitattributes", async () => {
    // The line `test/golden/rules-index/** -text` is redundant because `test/golden/** -text` covers it.
    // Check with git check-attr.
    const { stdout: before } = await runCli(["--version"], { cwd: process.cwd() }); // just to get CWD
    
    // This test checks that the line is absent from .gitattributes
    const gitattributes = await fs.readFile(
      path.join(process.cwd(), ".gitattributes"),
      "utf8"
    );
    expect(gitattributes).not.toContain("test/golden/rules-index/** -text");
  });
});
