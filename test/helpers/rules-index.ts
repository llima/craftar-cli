import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./forge.js";

/**
 * A Forge with rules, an agent and a skill that may or may not use the `{{craftar.rules.index}}` placeholder —
 * the baseline scenario for testing rules-index behaviour.
 *
 * Spec 44 §11.1: pins what a workspace that does not use the placeholder gets today.
 */
export async function acmeIndex(
  opts: {
    schema: number;
    /** When true, rule `readme` body is `# Rules\n\n{{craftar.rules.index}}\n` and agent `helper` has `{{craftar.rules.index}}` alone on a line. */
    literal?: boolean;
    /** When true, skill `deploy` uses `layout: file` instead of `layout: dir`. */
    flatSkill?: boolean;
  },
): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    // rule/style — always on (default inclusion)
    {
      meta: { type: "rule", name: "style", description: "Code style for every file" },
      files: { "rule.md": "# Style\nUse consistent formatting.\n" },
    },
    // rule/api — fileMatch scoped
    {
      meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api/**", description: "API conventions" },
      files: { "rule.md": "# API\nEvery endpoint is RESTful.\n" },
    },
    // rule/release — manual, kiro only, no description
    {
      meta: { type: "rule", name: "release", inclusion: "manual", targets: ["kiro"] },
      files: { "rule.md": "# Release\nTag after review.\n" },
    },
    // rule/readme — always, body depends on `literal`
    {
      meta: { type: "rule", name: "readme", description: "Index of the rules" },
      files: { "rule.md": opts.literal ? "# Rules\n\n{{craftar.rules.index}}\n" : "# Rules\n" },
    },
    // agent/helper — body holds `{{craftar.rules.index}}` alone on a line when `literal`
    {
      meta: { type: "agent", name: "helper" },
      files: { "agent.md": opts.literal ? "Help the user.\n\n{{craftar.rules.index}}\n" : "Help the user.\n" },
    },
    // skill/deploy — dir or file layout
    {
      meta: { type: "skill", name: "deploy", layout: opts.flatSkill ? "file" : "dir" },
      files: opts.flatSkill
        ? { "skill.md": "---\nname: deploy\ndescription: Deploy the app\n---\nRun the deployment.\n" }
        : {
            "SKILL.md": "---\nname: deploy\ndescription: Deploy the app\n---\nRun the deployment.\n",
            "run.sh": "#!/bin/sh\necho deploying\n",
          },
    },
  ];

  const baseIngredients = [
    "rule/style",
    "rule/api",
    "rule/release",
    "rule/readme",
    "agent/helper",
    "skill/deploy",
  ];

  const recipes = [recipe("base", baseIngredients)];

  const profiles = [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Overwrite craftar.forge.yaml with the requested schema
  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: opts.schema }),
  );

  return s;
}
