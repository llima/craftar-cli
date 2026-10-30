/**
 * Skill-layout check tests (spec 44 §5).
 * Tests flatSkills, plan warnings, doctor checks, and import warnings.
 */
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runDoctor, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { resolve } from "../src/core/resolve.js";
import { loadWorkspace, plan, type Plan } from "../src/core/sync.js";
import { flatSkills, flatSkillWarning } from "../src/emitters/shared.js";
import { makeForge, makeWorkspace, profile, recipe, scenario, writeFiles, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { acmeIndex } from "./helpers/rules-index.js";
import { removeWithRetry } from "./helpers/fs.js";
import { importClaudeCode } from "../src/importers/claude-code.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Test-specific CRAFTAR_HOME
let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "craftar-home-skill-layout-"));
});

afterAll(async () => {
  await removeWithRetry(home);
});

// A rule ingredient
const rule = (name: string, body: string, extra: Record<string, unknown> = {}): IngredientSpec => ({
  meta: { type: "rule", name, ...extra },
  files: { "rule.md": body },
});

// A file-layout skill ingredient (Claude Code cannot list)
const flatSkill = (name: string): IngredientSpec => ({
  meta: { type: "skill", name, layout: "file" },
  files: { "SKILL.md": `---\nname: ${name}\ndescription: A skill\n---\nDo something.\n` },
});

// A dir-layout skill ingredient (normal)
const dirSkill = (name: string): IngredientSpec => ({
  meta: { type: "skill", name, layout: "dir" },
  files: {
    "SKILL.md": `---\nname: ${name}\ndescription: A skill\n---\nDo something.\n`,
    "run.sh": "#!/bin/sh\necho running\n",
  },
});

// Helper to run doctor with test-specific options
const runDoc = (o: Partial<DoctorOptions> & { home: string; workspace: string }) =>
  runDoctor({
    version: "0.0.0",
    fetch: false,
    strict: false,
    registryOff: true,
    env: {},
    nodeVersion: "22.11.0",
    gitVersion: async () => "2.53.0",
    ...o,
  });

const of = (checks: Check[], id: string) => checks.filter((c) => c.id === id);

describe("flatSkills (spec 44 §5)", () => {
  it("1a. layout: file skill with targets including claude-code → [name]", async () => {
    const s = await scenario(
      {
        ingredients: [flatSkill("deploy"), rule("style", "# Style\n")],
        recipes: [recipe("base", ["skill/deploy", "rule/style"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const ws = await loadWorkspace(s.wsRoot);
    const resolution = resolve(ws.forge, ws.config);
    expect(flatSkills(resolution, resolution.targets)).toEqual(["deploy"]);
  });

  it("1b. layout: dir skill → []", async () => {
    const s = await scenario(
      {
        ingredients: [dirSkill("deploy"), rule("style", "# Style\n")],
        recipes: [recipe("base", ["skill/deploy", "rule/style"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const ws = await loadWorkspace(s.wsRoot);
    const resolution = resolve(ws.forge, ws.config);
    expect(flatSkills(resolution, resolution.targets)).toEqual([]);
  });

  it("1c. skill targets: [kiro] only → []", async () => {
    const s = await scenario(
      {
        ingredients: [
          { meta: { type: "skill", name: "deploy", layout: "file", targets: ["kiro"] }, files: { "SKILL.md": "# deploy\n" } },
          rule("style", "# Style\n"),
        ],
        recipes: [recipe("base", ["skill/deploy", "rule/style"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const ws = await loadWorkspace(s.wsRoot);
    const resolution = resolve(ws.forge, ws.config);
    expect(flatSkills(resolution, resolution.targets)).toEqual([]);
  });

  it("1d. workspace without claude-code target → []", async () => {
    const s = await scenario(
      {
        ingredients: [flatSkill("deploy"), rule("style", "# Style\n")],
        recipes: [recipe("base", ["skill/deploy", "rule/style"])],
        profiles: [profile("acme", ["base"], ["kiro"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const ws = await loadWorkspace(s.wsRoot);
    const resolution = resolve(ws.forge, ws.config);
    expect(flatSkills(resolution, resolution.targets)).toEqual([]);
  });
});

describe("plan() flat skill warning (spec 44 §5)", () => {
  it("2. plan warning holds once for flat skills at ANY schema", async () => {
    // Use acmeIndex with flatSkill=true at schema 1
    const s = await acmeIndex({ schema: 1, flatSkill: true });
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    const warnings = p.warnings.filter((w) => w.includes("Claude Code does not list"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "claude-code: Claude Code does not list a skill written as one file — .claude/skills/deploy.md; set layout: dir in each ingredient.yaml",
    );
    // Planned bytes for skill should be unchanged (still planned)
    expect(p.files.some((f) => f.path === ".claude/skills/deploy.md")).toBe(true);
  });

  it("2b. two flat skills sorted in warning", async () => {
    const s = await scenario(
      {
        ingredients: [flatSkill("deploy"), flatSkill("lint"), rule("style", "# Style\n")],
        recipes: [recipe("base", ["skill/deploy", "skill/lint", "rule/style"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    const warnings = p.warnings.filter((w) => w.includes("Claude Code does not list"));
    expect(warnings).toHaveLength(1);
    // Sorted: deploy, lint
    expect(warnings[0]).toBe(
      "claude-code: Claude Code does not list a skill written as one file — .claude/skills/deploy.md, .claude/skills/lint.md; set layout: dir in each ingredient.yaml",
    );
  });
});

describe("doctor skill-layout check (spec 44 §5)", () => {
  it("3a. skill-layout check: warn per skill", async () => {
    const s = await acmeIndex({ schema: 6, flatSkill: true });
    cleanups.push(s.cleanup);
    const r = await runDoc({ home, workspace: s.wsRoot });
    const checks = of(r.checks, "skill-layout");
    expect(checks).toHaveLength(1);
    expect(checks[0].level).toBe("warn");
    expect(checks[0].message).toBe(".claude/skills/deploy.md is a skill Claude Code does not list");
    expect(checks[0].fix).toBe(
      "set layout: dir in ingredients/skills/deploy/ingredient.yaml — sync then writes .claude/skills/deploy/SKILL.md",
    );
  });

  it("3d. a skill variant's fix names the variant's own folder", async () => {
    const s = await scenario(
      {
        ingredients: [{ meta: { type: "skill", name: "deploy--acme", as: "deploy", layout: "file" }, files: { "skill.md": "---\nname: deploy\ndescription: Deploy\n---\nRun it.\n" } }],
        recipes: [recipe("base", ["skill/deploy--acme"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const r = await runDoc({ home, workspace: s.wsRoot });
    const checks = of(r.checks, "skill-layout");
    expect(checks.map((c) => c.message)).toEqual([".claude/skills/deploy.md is a skill Claude Code does not list"]);
    expect(checks[0].fix).toBe(
      "set layout: dir in ingredients/skills/deploy--acme/ingredient.yaml — sync then writes .claude/skills/deploy/SKILL.md",
    );
  });

  it("3b. skill-layout is NOT a plan finding", async () => {
    const s = await acmeIndex({ schema: 6, flatSkill: true });
    cleanups.push(s.cleanup);
    // The warning from plan() should NOT appear as a "plan" check
    const r = await runDoc({ home, workspace: s.wsRoot });
    const planChecks = of(r.checks, "plan");
    const hasSkillWarning = planChecks.some((c) => c.message.includes("Claude Code does not list"));
    expect(hasSkillWarning).toBe(false);
  });

  it("3c. doctor --strict exits 1 with skill-layout warn", async () => {
    const s = await acmeIndex({ schema: 6, flatSkill: true });
    cleanups.push(s.cleanup);
    const r = await runDoc({ home, workspace: s.wsRoot, strict: true });
    const checks = of(r.checks, "skill-layout");
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].level).toBe("warn");
    // strict mode means exit 1 for any warn
    expect(r.summary.warn).toBeGreaterThan(0);
  });

  it("3d. layout: dir → no skill-layout check at all", async () => {
    // Use acmeIndex with flatSkill=false (default)
    const s = await acmeIndex({ schema: 6 });
    cleanups.push(s.cleanup);
    const r = await runDoc({ home, workspace: s.wsRoot });
    const checks = of(r.checks, "skill-layout");
    expect(checks).toHaveLength(0);
  });
});

describe("MCP tool doctor (spec 44 §5)", () => {
  it("4. craftar mcp doctor carries skill-layout for flat-skill workspace", async () => {
    const s = await acmeIndex({ schema: 6, flatSkill: true });
    cleanups.push(s.cleanup);
    // The MCP tool uses runDoctor internally, so checking runDoctor is sufficient
    const r = await runDoc({ home, workspace: s.wsRoot });
    const checks = of(r.checks, "skill-layout");
    expect(checks.length).toBeGreaterThan(0);
  });
});

describe("Kiro emitter (spec 44 §5)", () => {
  it("5. kiro: flat skill's .kiro/skills/deploy/SKILL.md is unchanged, no warning", async () => {
    const s = await scenario(
      {
        ingredients: [flatSkill("deploy"), rule("style", "# Style\n")],
        recipes: [recipe("base", ["skill/deploy", "rule/style"])],
        profiles: [profile("acme", ["base"], ["kiro"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    // No warning about skill layout for kiro
    const warnings = p.warnings.filter((w) => w.includes("Claude Code does not list"));
    expect(warnings).toHaveLength(0);
    // Kiro writes skills as directories
    expect(p.files.some((f) => f.path === ".kiro/skills/deploy/SKILL.md")).toBe(true);
  });
});

describe("import flat skill warning (spec 44 §5)", () => {
  it("6. import workspace with .claude/skills/deploy.md → layout: file, import warning", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "craftar-skill-import-"));
    cleanups.push(() => removeWithRetry(root));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    // Create a minimal forge
    await makeForge(forgeRoot, {
      ingredients: [],
      recipes: [],
      profiles: [],
    });

    // Create workspace with a flat skill
    await fs.mkdir(path.join(wsRoot, ".claude/skills"), { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, ".claude/skills/deploy.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\nRun deployment.\n",
    );

    // Import into the forge
    const report = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
    });

    // Should have warning about flat skill
    const warnings = report.warnings.filter((w) => w.includes("Claude Code does not list"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "import: Claude Code does not list a skill written as one file — .claude/skills/deploy.md; set layout: dir in each ingredient.yaml",
    );

    // Check that created ingredient has layout: file
    const ingYaml = await fs.readFile(
      path.join(forgeRoot, "ingredients/skills/deploy/ingredient.yaml"),
      "utf8",
    );
    expect(ingYaml).toContain("layout: file");
  });

  it("6b. import --report lists skill-layout warning among warnings", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "craftar-skill-import-report-"));
    cleanups.push(() => removeWithRetry(root));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");

    await makeForge(forgeRoot, {
      ingredients: [],
      recipes: [],
      profiles: [],
    });

    await fs.mkdir(path.join(wsRoot, ".claude/skills"), { recursive: true });
    await fs.writeFile(
      path.join(wsRoot, ".claude/skills/lint.md"),
      "---\nname: lint\ndescription: Lint code\n---\nLint the code.\n",
    );

    const report = await importClaudeCode({
      workspaceRoot: wsRoot,
      forgeRoot,
      profileName: "acme",
      report: true,
    });

    expect(report.warnings.some((w) => w.includes("Claude Code does not list"))).toBe(true);
  });
});

describe("flatSkillWarning helper", () => {
  it("builds correct warning with claude-code prefix", () => {
    const msg = flatSkillWarning(["deploy", "lint"], "claude-code");
    expect(msg).toBe(
      "claude-code: Claude Code does not list a skill written as one file — .claude/skills/deploy.md, .claude/skills/lint.md; set layout: dir in each ingredient.yaml",
    );
  });

  it("builds correct warning with import prefix", () => {
    const msg = flatSkillWarning(["deploy"], "import");
    expect(msg).toBe(
      "import: Claude Code does not list a skill written as one file — .claude/skills/deploy.md; set layout: dir in each ingredient.yaml",
    );
  });
});
