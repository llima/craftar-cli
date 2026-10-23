import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, writeFiles, type IngredientSpec, type Scenario } from "./forge.js";

/**
 * A Forge with rules, agents, commands, skills and scripts that reference each other via
 * `.claude/rules/` paths — the baseline scenario for testing agents-md.primary behaviour.
 *
 * Spec 41 §11.1: pins what a workspace that does not set agents-md.primary gets today.
 */
export async function acmePrimary(
  opts: { schema?: 1 | 2 | 3 | 4 | 5 | 6; params?: Record<string, unknown>; wsFiles?: Record<string, string>; wsConfig?: Record<string, unknown> } = {},
): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    // rule/style — always on (default inclusion), targets default
    {
      meta: { type: "rule", name: "style" },
      files: { "rule.md": "# Style\nWrite plain English. See .claude/rules/api.md for the API rules.\n" },
    },
    // rule/api — fileMatch scoped
    {
      meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api/**" },
      files: { "rule.md": "# API\nEvery endpoint follows .claude/rules/style.md.\n" },
    },
    // rule/release — agents-md only
    {
      meta: { type: "rule", name: "release", targets: ["agents-md"] },
      files: { "rule.md": "# Release\nTag after review.\n" },
    },
    // rule/kiro-notes — kiro only
    {
      meta: { type: "rule", name: "kiro-notes", targets: ["kiro"] },
      files: { "rule.md": "# Kiro notes\nKiro only.\n" },
    },
    // agent/api-reviewer
    {
      meta: { type: "agent", name: "api-reviewer", description: "Reviews API changes against .claude/rules/style.md" },
      files: {
        "agent.md":
          "Review the diff.\nFollow .claude/rules/style.md and .claude/rules/release.md.\nSee [the style](.claude/rules/style.md#scope).\nNotes: .claude/rules/kiro-notes.md\n",
      },
    },
    // agent/planner — resources pointing at .kiro/steering
    {
      meta: {
        type: "agent",
        name: "planner",
        resources: ["file://.kiro/steering/style.md", "file://.kiro/steering/**/*.md", "file://docs/plan.md"],
      },
      files: { "agent.md": "Plan the work.\n" },
    },
    // command/review
    {
      meta: { type: "command", name: "review", description: "Run a review" },
      files: { "command.md": "Review with .claude/rules/style.md in mind.\n" },
    },
    // skill/checks — dir layout with SKILL.md and run.sh
    {
      meta: { type: "skill", name: "checks", layout: "dir" },
      files: {
        "SKILL.md": "---\nname: checks\ndescription: Run the checks\n---\nUse .claude/rules/style.md.\n",
        "run.sh": "#!/bin/sh\n# follows .claude/rules/style.md\necho ok\n",
      },
    },
    // script/lint — claude-code only, files array
    {
      meta: { type: "script", name: "lint", targets: ["claude-code"], files: ["lint.sh"] },
      files: { "lint.sh": "#!/bin/sh\n# see .claude/rules/style.md\nexit 0\n" },
    },
  ];

  const recipes = [
    recipe("base", [
      "rule/style",
      "rule/api",
      "rule/release",
      "rule/kiro-notes",
      "agent/api-reviewer",
      "agent/planner",
      "command/review",
      "skill/checks",
      "script/lint",
    ]),
  ];

  const profiles = [
    profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], opts.params ? { params: opts.params } : {}),
  ];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme", ...opts.wsConfig }, files: opts.wsFiles });

  // Overwrite craftar.forge.yaml with the requested schema
  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: opts.schema ?? 4 }),
  );

  return s;
}
