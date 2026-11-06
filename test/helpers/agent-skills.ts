/**
 * The acme-agent-skills scenario (spec 61 §6, §9): a directory skill with a binary file, a single-file skill, a command, and a rule,
 * an agent and an MCP server the target skips. Shared by test/helpers/regen-golden-agent-skills.ts and test/agent-skills-golden.test.ts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./forge.js";

export async function acmeAgentSkills(): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "skill", name: "deploy", layout: "dir" },
      files: { "SKILL.md": "---\nname: deploy\ndescription: Deploy the app\n---\nSteps.\n", "run.sh": "#!/bin/sh\necho deploy\n", "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
    },
    { meta: { type: "skill", name: "docs", layout: "file" }, files: { "SKILL.md": "---\nname: docs\ndescription: Write docs\n---\nDocs.\n" } },
    { meta: { type: "command", name: "review", description: "Review a file", argumentHint: "[file]" }, files: { "command.md": "Review it.\n" } },
    { meta: { type: "rule", name: "style" }, files: { "rule.md": "Use tabs.\n" } },
    { meta: { type: "agent", name: "helper", description: "Helps" }, files: { "agent.md": "Help.\n" } },
    { meta: { type: "mcp", name: "api", server: { command: "npx", args: ["api"] } } },
  ];
  const recipes = [recipe("base", ["skill/deploy", "skill/docs", "command/review", "rule/style", "agent/helper", "mcp/api"])];
  const s = await scenario({ ingredients, recipes, profiles: [profile("acme", ["base"], ["agent-skills"])] }, { config: { profile: "acme" } });
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
  return s;
}
