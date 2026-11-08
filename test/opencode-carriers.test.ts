/**
 * Spec 63 §4 and criteria 5 and 9: OpenCode reads AGENTS.md (rules) and both .agents/skills/ and .claude/skills/ (skills), so its
 * rule and skill cells are silent when a carrier is among the targets and the ingredient is aimed at it — `claude-code` only for a
 * folder skill, since OpenCode was not shown to read a flat `.claude/skills/<name>.md`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function warnings(targets: string[], skillTargets?: string[]): Promise<string[]> {
  const t = skillTargets ? { targets: skillTargets } : {};
  const ingredients: IngredientSpec[] = [
    { meta: { type: "rule", name: "style" }, files: { "rule.md": "# Style\n" } },
    { meta: { type: "skill", name: "deploy", layout: "dir", ...t }, files: { "SKILL.md": "---\nname: deploy\ndescription: Use when deploying\n---\nDeploy.\n" } },
    { meta: { type: "skill", name: "docs", layout: "file", ...t }, files: { "SKILL.md": "---\nname: docs\ndescription: Use when writing docs\n---\nDocs.\n" } },
  ];
  const s: Scenario = await scenario(
    { ingredients, recipes: [recipe("base", ["rule/style", "skill/deploy", "skill/docs"])], profiles: [profile("acme", ["base"], targets)] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 18 }));
  const p = await plan(await loadWorkspace(s.wsRoot));
  return p.warnings.filter((w) => w.startsWith("opencode:"));
}

const RULE = "opencode: 1 rule ingredient(s) have no OpenCode equivalent — skipped: rule/style";
const T = { timeout: atLeastWin32(30_000) };

describe("opencode carriers (spec 63 §4)", () => {
  it("1. opencode alone: rules and both skills are warned", T, async () => {
    expect(await warnings(["opencode"])).toEqual([RULE, "opencode: 2 skill ingredient(s) have no OpenCode equivalent — skipped: skill/deploy, skill/docs"]);
  });

  it("2. with agents-md: the rule is silent", T, async () => {
    expect(await warnings(["opencode", "agents-md"])).toEqual(["opencode: 2 skill ingredient(s) have no OpenCode equivalent — skipped: skill/deploy, skill/docs"]);
  });

  it("3. with agent-skills: both skills are silent", T, async () => {
    expect(await warnings(["opencode", "agent-skills"])).toEqual([RULE]);
  });

  it("4. with claude-code: the folder skill is silent, the flat one is warned (criterion 9)", T, async () => {
    expect(await warnings(["opencode", "claude-code"])).toEqual([RULE, "opencode: 1 skill ingredient(s) have no OpenCode equivalent — skipped: skill/docs"]);
  });

  it("5. with claude-code but the skills aimed at opencode only: both warned", T, async () => {
    expect(await warnings(["opencode", "claude-code"], ["opencode"])).toEqual([RULE, "opencode: 2 skill ingredient(s) have no OpenCode equivalent — skipped: skill/deploy, skill/docs"]);
  });

  it("6. with agent-skills and claude-code: both skills silent", T, async () => {
    expect(await warnings(["opencode", "agent-skills", "claude-code", "agents-md"])).toEqual([]);
  });
});
