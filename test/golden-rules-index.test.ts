import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { acmeIndex } from "./helpers/rules-index.js";
import type { Scenario } from "./helpers/forge.js";
import { RULES_INDEX_KEY } from "../src/core/rules-index.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import YAML from "yaml";

// Spec 44 §4.4: the acme workspace synced at schema 7 with literal: true, byte for byte;
// regenerated only with test/helpers/regen-golden-rules-index.ts.

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/rules-index");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

async function synced(): Promise<{ s: Scenario; paths: string[]; p: Awaited<ReturnType<typeof plan>> }> {
  const s = kept(await acmeIndex({ schema: 7, literal: true }));
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return { s, paths: p.files.map((f) => f.path).sort(), p };
}

describe("golden — rules-index (spec 44 §4.4)", () => {
  it("1. a sync writes exactly the golden files, byte for byte", async () => {
    const { s, paths } = await synced();
    expect(paths).toEqual((await listFiles(GOLDEN)).sort());
    for (const rel of paths) {
      expect((await fs.readFile(path.join(s.wsRoot, rel))).equals(await fs.readFile(path.join(GOLDEN, rel))), rel).toBe(true);
    }
  });

  it("2. states: kiro index K1 shows .kiro/steering/, K2 shows .claude/rules/, K3 shows AGENTS.md (rule: x)", async () => {
    const { p } = await synced();
    const kiroReadme = p.files.find((f) => f.path === ".kiro/steering/readme.md")!;
    const kiroContent = kiroReadme.content.toString("utf8");
    // K1: style is written by kiro → .kiro/steering/style.md
    expect(kiroContent).toContain("`.kiro/steering/style.md`");
    // On request: release is kiro only → .kiro/steering/release.md
    expect(kiroContent).toContain("`.kiro/steering/release.md`");
  });

  it("3. groups and order: names in code-point order, blank line between groups, none before/after", async () => {
    const { p } = await synced();
    const claudeReadme = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const content = claudeReadme.content.toString("utf8");
    // Groups are: Always on, Scoped, On request — with blank lines between them
    const lines = content.split("\n");
    // Check no blank line before first group
    expect(lines[0]).toBe("# Rules");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Always on:");
    // Check blank line between Always on and Scoped
    const scopedIdx = lines.indexOf("Scoped:");
    expect(scopedIdx).toBeGreaterThan(0);
    expect(lines[scopedIdx - 1]).toBe("");
    // Check blank line between Scoped and On request
    const onRequestIdx = lines.indexOf("On request:");
    expect(onRequestIdx).toBeGreaterThan(scopedIdx);
    expect(lines[onRequestIdx - 1]).toBe("");
    // Check no blank line after last group
    expect(lines[lines.length - 1]).toBe("");
    expect(lines[lines.length - 2]).toBe("- `.kiro/steering/release.md`");
  });

  it("4. description: folded to single line, absent/whitespace → name only with warning", async () => {
    const { p } = await synced();
    // Check warning for undescribed rule (release has no description)
    const warning = p.warnings.find((w) => w.includes("no description for rule release"));
    expect(warning).toBe(`${RULES_INDEX_KEY}: no description for rule release — listed by name only`);

    // Check that release is listed by name only (no — desc)
    const claudeReadme = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const content = claudeReadme.content.toString("utf8");
    expect(content).toContain("- `.kiro/steering/release.md`");
    // No dash-description after release
    expect(content).not.toContain("`.kiro/steering/release.md` —");
  });

  it("5. placement: placeholder in agent/command/skill → left as written with ONE warning", async () => {
    const { p } = await synced();
    // The warning should list the paths where the placeholder was left
    const placementWarning = p.warnings.find((w) => w.includes("is expanded in rule and steering bodies only"));
    expect(placementWarning).toBeDefined();
    expect(placementWarning).toContain(".claude/agents/helper.md");
    expect(placementWarning).toContain(".kiro/agents/helper.json");
    // Only one such warning
    const placementWarnings = p.warnings.filter((w) => w.includes("is expanded in rule and steering bodies only"));
    expect(placementWarnings.length).toBe(1);
  });

  it("6. two placeholders in one body → both expanded identically", async () => {
    // Create a rule with two placeholders
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "double", description: "Rule with two indices" },
            files: { "rule.md": "# First\n\n{{craftar.rules.index}}\n\n# Second\n\n{{craftar.rules.index}}\n" },
          },
        ],
        recipes: [recipe("base", ["rule/double"])],
        profiles: [profile("test", ["base"], ["claude-code"])],
      },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const file = p.files.find((f) => f.path === ".claude/rules/double.md")!;
    const content = file.content.toString("utf8");

    // Count occurrences of "Always on:" - should be 2 (one for each placeholder)
    const matches = content.match(/Always on:/g);
    expect(matches?.length).toBe(2);
  });

  it("7. budget: Plan.agentsMd.bytes includes the index bytes", async () => {
    const { p } = await synced();
    expect(p.agentsMd).not.toBeNull();
    // The AGENTS.md file contains the expanded index, so bytes should be > 0
    expect(p.agentsMd!.bytes).toBeGreaterThan(0);
  });

  it("8. Plan.indexed shows paths and rule counts", async () => {
    const { p } = await synced();
    expect(p.indexed).toEqual([
      { path: ".claude/rules/readme.md", rules: 4 },
      { path: ".kiro/steering/readme.md", rules: 4 },
      { path: "AGENTS.md", rules: 4 },
    ]);
  });

  it("8b. Plan.indexed is empty at schema 6", async () => {
    const s = kept(await acmeIndex({ schema: 6, literal: true }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.indexed).toEqual([]);
  });

  it("9. agents-md.primary + steering index ingredient: rules written to AGENTS.md only", async () => {
    // Create a scenario with agents-md.primary and a steering ingredient with the index placeholder
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "style", description: "Code style" }, files: { "rule.md": "# Style\n" } },
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "# Readme\n" } },
      { meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api/**", description: "API" }, files: { "rule.md": "# API\n" } },
      { meta: { type: "steering", name: "index", targets: ["kiro"] }, files: { "steering.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      {
        ingredients,
        recipes: [recipe("base", ["rule/style", "rule/readme", "rule/api", "steering/index"])],
        profiles: [profile("test", ["base"], ["kiro", "agents-md"], { params: { "agents-md.primary": true } })],
      },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Check that style and readme are in AGENTS.md (K3 state)
    const indexFile = p.files.find((f) => f.path === ".kiro/steering/index.md");
    expect(indexFile).toBeDefined();
    const indexContent = indexFile!.content.toString("utf8");

    // style and readme should be AGENTS.md (rule: x) because they are AGENTS.md-only under primary
    expect(indexContent).toContain("AGENTS.md (rule: style)");
    expect(indexContent).toContain("AGENTS.md (rule: readme)");
    // api is scoped (fileMatch), so it gets written to .kiro/steering/api.md
    expect(indexContent).toContain("`.kiro/steering/api.md`");
  });
});

describe("rules-index edge cases", () => {
  it("description holding <!-- craftar: fails plan()", async () => {
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "bad", description: "Has <!-- craftar: in it" },
        files: { "rule.md": "{{craftar.rules.index}}\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/bad"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    await expect(plan(ws)).rejects.toThrow(/rule\/bad.*section marker/);
  });

  it("placeholder not alone on line → misplaced warning", async () => {
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "inline", description: "Inline placeholder" },
        files: { "rule.md": "See {{craftar.rules.index}} here\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/inline"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Should have a warning about misplaced placeholder
    const warning = p.warnings.find((w) => w.includes("must stand alone on its line"));
    expect(warning).toBeDefined();
    expect(warning).toContain(".claude/rules/inline.md:1");
  });

  it("state C/K3: rule targets: [agents-md] is listed as AGENTS.md (rule: x) when agents-md is a target", async () => {
    // Spec §6 items 8-9: in a workspace with targets [claude-code, kiro, agents-md], a rule aimed at
    // agents-md alone is listed as AGENTS.md (rule: x) in both claude and kiro indices (state C, K3).
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "style", description: "Style" }, files: { "rule.md": "# Style\n" } },
      { meta: { type: "rule", name: "agenthints", targets: ["agents-md"], description: "Hints" }, files: { "rule.md": "# Hints\n" } },
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/style", "rule/agenthints", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code", "kiro", "agents-md"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // In the claude index, agenthints should appear as AGENTS.md (rule: agenthints) — state C
    const claudeIndex = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const claudeContent = claudeIndex.content.toString("utf8");
    expect(claudeContent).toContain("AGENTS.md (rule: agenthints)");

    // In the kiro index, agenthints should appear as AGENTS.md (rule: agenthints) — state K3
    const kiroIndex = p.files.find((f) => f.path === ".kiro/steering/readme.md")!;
    const kiroContent = kiroIndex.content.toString("utf8");
    expect(kiroContent).toContain("AGENTS.md (rule: agenthints)");

    // In the AGENTS.md, the index should also show agenthints
    const agentsMd = p.files.find((f) => f.path === "AGENTS.md")!;
    const agentsContent = agentsMd.content.toString("utf8");
    expect(agentsContent).toContain("AGENTS.md (rule: agenthints)");
  });

  it("state D: rule targets: [agents-md] is absent when agents-md is NOT a target (no warning)", async () => {
    // Spec §6 item 9: in a workspace with targets [claude-code, kiro] (no agents-md), a rule aimed at
    // agents-md alone is D and left out with no warning.
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "style", description: "Style" }, files: { "rule.md": "# Style\n" } },
      { meta: { type: "rule", name: "agenthints", targets: ["agents-md"], description: "Hints" }, files: { "rule.md": "# Hints\n" } },
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/style", "rule/agenthints", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code", "kiro"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // In the claude index, agenthints should NOT appear (state D)
    const claudeIndex = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const claudeContent = claudeIndex.content.toString("utf8");
    expect(claudeContent).not.toContain("agenthints");

    // In the kiro index, agenthints should NOT appear (state D)
    const kiroIndex = p.files.find((f) => f.path === ".kiro/steering/readme.md")!;
    const kiroContent = kiroIndex.content.toString("utf8");
    expect(kiroContent).not.toContain("agenthints");

    // No warning for the absent rule (state D is silent)
    expect(p.warnings.filter((w) => w.includes("agenthints"))).toEqual([]);
  });
});

describe("rules-index groups and scope", () => {
  it("3a: a Forge with only fileMatch and manual rules has no Always on: heading", async () => {
    // Spec 44 §4.4: each group only when it holds a rule. A Forge with only api (fileMatch) and the
    // index rule readme made inclusion: manual → the index has no Always on: line, starts with Scoped:.
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api/**", description: "API" }, files: { "rule.md": "# API\n" } },
      { meta: { type: "rule", name: "readme", inclusion: "manual", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/api", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const claudeIndex = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const content = claudeIndex.content.toString("utf8");
    // No Always on: heading
    expect(content).not.toContain("Always on:");
    // Should start with Scoped:
    expect(content).toContain("Scoped:");
    // On request: should be present
    expect(content).toContain("On request:");
  });

  it("3b: a profile with NO rules resolving → the index is exactly '- (no rules)' (CRLF for kiro)", async () => {
    // Spec 44 §4.4: when the index lists no rule at all, the whole index is the single line `- (no rules)`.
    // A steering index (kiro target) holding the placeholder in a workspace whose profile resolves NO rule.
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

    const kiroIndex = p.files.find((f) => f.path === ".kiro/steering/index.md")!;
    const content = kiroIndex.content.toString("utf8");
    // The body should be exactly "- (no rules)" with CRLF
    expect(content).toContain("- (no rules)");
    // No group headings
    expect(content).not.toContain("Always on:");
    expect(content).not.toContain("Scoped:");
    expect(content).not.toContain("On request:");
  });

  it("4: a fileMatch rule with no fileMatchPattern adds nothing (no applies to)", async () => {
    // Spec 44 §4.4: a fileMatch rule with no pattern adds nothing (not "(applies to `**`)").
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "scoped", inclusion: "fileMatch", description: "A scoped rule" }, files: { "rule.md": "# Scoped\n" } },
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/scoped", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const claudeIndex = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const content = claudeIndex.content.toString("utf8");
    // The scoped rule line should end with its description, not with "(applies to `**`)"
    expect(content).toContain("`.claude/rules/scoped.md` — A scoped rule");
    expect(content).not.toContain("applies to");
  });

  it("4b: multiple patterns are listed as (applies to `a`, `b`)", async () => {
    // Spec 44 §4.4: several patterns read "(applies to `a`, `b`)".
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "multi", inclusion: "fileMatch", fileMatchPattern: ["src/**", "lib/**"], description: "Multi" }, files: { "rule.md": "# Multi\n" } },
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/multi", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const claudeIndex = p.files.find((f) => f.path === ".claude/rules/readme.md")!;
    const content = claudeIndex.content.toString("utf8");
    // The multi rule should have (applies to `src/**`, `lib/**`)
    expect(content).toContain("(applies to `src/**`, `lib/**`)");
  });
});

describe("rules-index warnings and order", () => {
  it("5: two undescribed rules → exactly one warning line holding both names", async () => {
    // Spec 44 §4.4: ONE line naming every such rule (code-point order, each once).
    const ingredients: IngredientSpec[] = [
      { meta: { type: "rule", name: "alpha" }, files: { "rule.md": "# Alpha\n" } },  // no description
      { meta: { type: "rule", name: "beta" }, files: { "rule.md": "# Beta\n" } },   // no description
      { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": "{{craftar.rules.index}}\n" } },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/alpha", "rule/beta", "rule/readme"])], profiles: [profile("test", ["base"], ["claude-code"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Should have exactly ONE warning containing both names
    const undescribedWarnings = p.warnings.filter((w) => w.includes("no description for rule"));
    expect(undescribedWarnings.length).toBe(1);
    expect(undescribedWarnings[0]).toContain("alpha");
    expect(undescribedWarnings[0]).toContain("beta");
    // Check the exact wording: "craftar.rules.index: no description for rule alpha, beta — listed by name only"
    expect(undescribedWarnings[0]).toBe(`${RULES_INDEX_KEY}: no description for rule alpha, beta — listed by name only`);
  });

  it("6: Plan.indexed paths sorted by code-point order (.claude < .kiro < AGENTS)", async () => {
    // Spec 44 §4.4: code-point order for Plan.indexed paths (`.` < `A`).
    const { p } = await synced();
    // Expected order: .claude/..., .kiro/..., AGENTS.md
    const paths = p.indexed.map((i) => i.path);
    expect(paths[0]).toMatch(/^\.claude\//);
    expect(paths[1]).toMatch(/^\.kiro\//);
    expect(paths[2]).toBe("AGENTS.md");
    // Verify code-point order
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(sorted);
  });
});
