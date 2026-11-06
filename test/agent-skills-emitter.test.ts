/**
 * Agent-skills emitter tests (spec 61 §6 Ruling 3, §9 Ruling 6): `.agents/skills/<name>/`.
 * The standard skills folder read by Cursor, Copilot, Codex, Antigravity and others.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, apply, status, readLock } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("agent-skills emitter (spec 61 §6 Ruling 3, §9 Ruling 6)", () => {
  // Test 1: skill with dir layout
  it("1. skill (dir layout): written to .agents/skills/<name>/<file>", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "analyze", layout: "dir", targets: ["agent-skills"] },
            files: { "SKILL.md": "# Analyze\nAnalyze the code.\n", "helper.md": "Helper file.\n" },
          },
        ],
        recipes: [recipe("base", ["skill/analyze"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const skillFile = p.files.find((f) => f.path === ".agents/skills/analyze/SKILL.md");
    expect(skillFile).toBeDefined();
    expect(skillFile!.content.toString("utf8")).toBe("# Analyze\nAnalyze the code.\n");

    const helperFile = p.files.find((f) => f.path === ".agents/skills/analyze/helper.md");
    expect(helperFile).toBeDefined();
    expect(helperFile!.content.toString("utf8")).toBe("Helper file.\n");
  });

  // Test 2: skill with file layout (single file becomes <name>/SKILL.md)
  it("2. skill (file layout): single file becomes <name>/SKILL.md", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "docs", layout: "file", targets: ["agent-skills"] },
            files: { "SKILL.md": "# Docs\nDocumentation skill.\n" },
          },
        ],
        recipes: [recipe("base", ["skill/docs"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const skillFile = p.files.find((f) => f.path === ".agents/skills/docs/SKILL.md");
    expect(skillFile).toBeDefined();
    expect(skillFile!.content.toString("utf8")).toBe("# Docs\nDocumentation skill.\n");
  });

  // Test 3: command → skill with disable-model-invocation: true
  it("3. command: written as skill with disable-model-invocation: true in frontmatter", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "review", description: "Review code", argumentHint: "<file>", targets: ["agent-skills"] },
            files: { "command.md": "Review the code.\n" },
          },
        ],
        recipes: [recipe("base", ["command/review"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const skillFile = p.files.find((f) => f.path === ".agents/skills/review/SKILL.md");
    expect(skillFile).toBeDefined();
    expect(skillFile!.content.toString("utf8")).toBe(
      '---\nname: "review"\ndescription: "Review code"\nargument-hint: "<file>"\ndisable-model-invocation: true\n---\nReview the code.\n',
    );
    expect(skillFile!.ingredient).toBe("command/review");
  });

  // Test 4: command with allowedTools warns
  it("4. command with allowedTools: dropped with warning", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "fix", description: "Fix code", allowedTools: "Read,Edit", targets: ["agent-skills"] },
            files: { "command.md": "Fix the code.\n" },
          },
        ],
        recipes: [recipe("base", ["command/fix"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.warnings).toContain('agent-skills: command "fix": allowed-tools is not written to a skill; dropped');
  });

  // Test 5: skill with binary file (non-text copied as bytes)
  it("5. skill with binary file: non-text files copied as bytes", async () => {
    const pngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "visual", layout: "dir", targets: ["agent-skills"] },
            files: { "SKILL.md": "# Visual\nVisual skill.\n", "icon.png": pngContent },
          },
        ],
        recipes: [recipe("base", ["skill/visual"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const iconFile = p.files.find((f) => f.path === ".agents/skills/visual/icon.png");
    expect(iconFile).toBeDefined();
    expect(iconFile!.content.equals(pngContent)).toBe(true);
  });

  // Test 6: skill and command with same name → error
  it("6. skill and command with same outName: throws error", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "analyze", layout: "dir", targets: ["agent-skills"] },
            files: { "SKILL.md": "# Analyze Skill\nSkill.\n" },
          },
          {
            meta: { type: "command", name: "analyze", description: "Analyze", targets: ["agent-skills"] },
            files: { "command.md": "Command.\n" },
          },
        ],
        recipes: [recipe("base", ["skill/analyze", "command/analyze"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    await expect(plan(ws)).rejects.toThrow("agent-skills: command/analyze and skill/analyze both write .agents/skills/analyze/ — rename one of them");
  });

  // Test 6b: the clash is the agent-skills target's alone — the same Forge plans for claude-code
  it("6b. the same skill and command plan fine for claude-code alone", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          { meta: { type: "skill", name: "analyze", layout: "dir" }, files: { "SKILL.md": "# Analyze Skill\nSkill.\n" } },
          { meta: { type: "command", name: "analyze", description: "Analyze" }, files: { "command.md": "Command.\n" } },
        ],
        recipes: [recipe("base", ["skill/analyze", "command/analyze"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.files.map((f) => f.path).sort()).toEqual([".claude/commands/analyze.md", ".claude/skills/analyze/SKILL.md"]);
  });

  // Test 10: a skill's shell script is rendered like claude-code renders it (a {{param}} is substituted), not copied as bytes
  it("10. a skill's run.sh is rendered: {{param}} substituted", async () => {
    const s = kept(await scenario(
      {
        ingredients: [{ meta: { type: "skill", name: "deploy", layout: "dir", params: { env: { default: "prod" } } }, files: { "SKILL.md": "Deploy.\n", "run.sh": "echo {{env}}\n" } }],
        recipes: [recipe("base", ["skill/deploy"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.files.find((f) => f.path === ".agents/skills/deploy/run.sh")!.content.toString("utf8")).toBe("echo prod\n");
  });

  // Test 11: names that differ only in case write one folder on Windows and macOS — still a clash
  it("11. a command Review and a skill review clash, compared without case", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          { meta: { type: "skill", name: "review", layout: "dir", targets: ["agent-skills"] }, files: { "SKILL.md": "Skill.\n" } },
          { meta: { type: "command", name: "Review", description: "Review", targets: ["agent-skills"] }, files: { "command.md": "Command.\n" } },
        ],
        recipes: [recipe("base", ["skill/review", "command/Review"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    await expect(plan(ws)).rejects.toThrow("agent-skills: command/Review and skill/review both write .agents/skills/Review/ — rename one of them");
  });

  // Test 12: a command with no description — the Agent Skills format expects one
  it("12. a command with no description is written and warned", async () => {
    const s = kept(await scenario(
      {
        ingredients: [{ meta: { type: "command", name: "fix", targets: ["agent-skills"] }, files: { "command.md": "Fix it.\n" } }],
        recipes: [recipe("base", ["command/fix"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.files.find((f) => f.path === ".agents/skills/fix/SKILL.md")!.content.toString("utf8")).toBe('---\nname: "fix"\ndisable-model-invocation: true\n---\nFix it.\n');
    expect(p.warnings).toContain('agent-skills: command "fix" has no description, which the Agent Skills format expects; a reader may skip it');
  });

  // Test 9: every new target on — the skill reaches .agents/skills/ once, never .cursor/ or .github/, no (last wins)
  it("9. with claude-code, cursor, copilot and agent-skills, a skill is written once under .agents/skills/", async () => {
    const s = kept(await scenario(
      {
        ingredients: [{ meta: { type: "skill", name: "deploy", layout: "dir" }, files: { "SKILL.md": "---\nname: deploy\ndescription: Deploy\n---\nSteps.\n" } }],
        recipes: [recipe("base", ["skill/deploy"])],
        profiles: [profile("acme", ["base"], ["claude-code", "cursor", "copilot", "agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.files.map((f) => f.path).sort()).toEqual([".agents/skills/deploy/SKILL.md", ".claude/skills/deploy/SKILL.md"]);
    expect(p.warnings.filter((w) => w.includes("last wins"))).toEqual([]);
  });

  // Test 7: rule/agent/mcp aimed at agent-skills → skipped with warning
  it("7. rule/agent/mcp: skipped with one warning per type", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", targets: ["agent-skills"] },
            files: { "rule.md": "Style.\n" },
          },
          {
            meta: { type: "agent", name: "helper", targets: ["agent-skills"] },
            files: { "agent.md": "Help.\n" },
          },
          {
            meta: { type: "mcp", name: "api", server: { command: "npx" }, targets: ["agent-skills"] },
          },
        ],
        recipes: [recipe("base", ["rule/style", "agent/helper", "mcp/api"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // No .agents/skills/ files for these types
    expect(p.files.filter((f) => f.target === "agent-skills")).toEqual([]);
    // One warning per type
    expect(p.warnings).toContain("agent-skills: 1 rule ingredient(s) have no Agent Skills equivalent — skipped: rule/style");
    expect(p.warnings).toContain("agent-skills: 1 agent ingredient(s) have no Agent Skills equivalent — skipped: agent/helper");
    expect(p.warnings).toContain("agent-skills: 1 mcp ingredient(s) have no Agent Skills equivalent — skipped: mcp/api");
  });

  // Test 8: CRLF preservation and BOM stripping
  it("8. CRLF preserved, BOM stripped", async () => {
    const crlfContent = "# Analyze\r\nAnalyze the code.\r\n";
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const contentWithCrlfAndBom = Buffer.concat([BOM, Buffer.from(crlfContent, "utf8")]);

    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "analyze", layout: "dir", targets: ["agent-skills"] },
            files: { "SKILL.md": "# Analyze\nAnalyze the code.\n" },
          },
        ],
        recipes: [recipe("base", ["skill/analyze"])],
        profiles: [profile("acme", ["base"], ["agent-skills"])],
      },
      { config: { profile: "acme" }, files: { ".agents/skills/analyze/SKILL.md": contentWithCrlfAndBom } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const skillFile = p.files.find((f) => f.path === ".agents/skills/analyze/SKILL.md");
    expect(skillFile).toBeDefined();
    // CRLF should be preserved
    expect(skillFile!.content.toString("utf8")).toBe("# Analyze\r\nAnalyze the code.\r\n");
    // BOM should be stripped
    expect(skillFile!.content.slice(0, 3).equals(BOM)).toBe(false);
  });
});
