import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./forge.js";

/**
 * A Forge with ordinary sections (no `targets=`) — the baseline for testing spec 41 Part B.
 * Pins what a workspace whose Forge writes no `targets=` sees today.
 *
 * Includes:
 * - rule `style` (always): three sections — first in file, between blank lines (profile sets value), last
 * - rule `api` (fileMatch): one section with a `{{param}}` inside, value set by profile
 * - agent `api-reviewer`: body has a section
 * - command `review`: body has a section
 * - skill `docs` (file layout): SKILL.md has a section
 * - service `echo`: compose fragment has a section
 *
 * The `style` rule body uses CRLF to pin line-ending handling; others use LF.
 */
export async function acmeSections(
  opts: {
    schema?: 1 | 2 | 3 | 4 | 5 | 6;
    extraRule?: IngredientSpec;
  } = {},
): Promise<Scenario> {
  // Use explicit LF for everything except rule/style which uses CRLF
  const LF = "\n";
  const CRLF = "\r\n";

  // Section markers
  const open = (name: string) => `<!-- craftar:section ${name} -->`;
  const close = "<!-- /craftar:section -->";

  // rule/style — always on, three sections:
  // 1. "intro" first in file
  // 2. "flavors" between blank lines (profile sets value)
  // 3. "notes" last in file
  const styleBody = [
    open("intro"),
    "Default intro text.",
    close,
    "",
    "# Style Guide",
    "",
    "Write plain English.",
    "",
    open("flavors"),
    "| Lang | Style |",
    "|---|---|",
    "| en | US |",
    close,
    "",
    "Follow these rules.",
    "",
    open("notes"),
    "Default notes.",
    close,
  ].join(CRLF) + CRLF; // CRLF file

  // rule/api — fileMatch scoped, one section with {{param}} inside
  const apiBody = [
    "# API Rules",
    "",
    "Every endpoint follows the style guide.",
    "",
    open("endpoints"),
    "Endpoint base: {{api.base}}",
    close,
    "",
    "Document everything.",
  ].join(LF) + LF;

  // agent/api-reviewer — body has a section
  const agentBody = [
    "Review API changes.",
    "",
    open("checklist"),
    "- Check naming",
    "- Check docs",
    close,
    "",
    "Be thorough.",
  ].join(LF) + LF;

  // command/review — body has a section
  const commandBody = [
    "Run a code review.",
    "",
    open("steps"),
    "1. Read the diff",
    "2. Comment",
    close,
  ].join(LF) + LF;

  // skill/docs — SKILL.md has a section
  const skillBody = [
    "---",
    "name: docs",
    "description: Generate documentation",
    "---",
    "Generate docs.",
    "",
    open("format"),
    "Use Markdown.",
    close,
  ].join(LF) + LF;

  // service/echo — compose fragment has a section
  const serviceCompose = [
    "services:",
    "  echo:",
    "    image: example/echo:1",
    "    environment:",
    open("env"),
    "      GREETING: hello",
    close,
  ].join(LF) + LF;

  const ingredients: IngredientSpec[] = [
    // rule/style — always on, CRLF
    {
      meta: { type: "rule", name: "style" },
      files: { "rule.md": styleBody },
    },
    // rule/api — fileMatch scoped, with param
    {
      meta: {
        type: "rule",
        name: "api",
        inclusion: "fileMatch",
        fileMatchPattern: "src/api/**",
        params: { "api.base": { default: "/api/v1" } },
      },
      files: { "rule.md": apiBody },
    },
    // agent/api-reviewer
    {
      meta: { type: "agent", name: "api-reviewer", description: "Reviews API changes" },
      files: { "agent.md": agentBody },
    },
    // command/review
    {
      meta: { type: "command", name: "review", description: "Run a review" },
      files: { "command.md": commandBody },
    },
    // skill/docs — file layout
    {
      meta: { type: "skill", name: "docs", layout: "file" },
      files: { "SKILL.md": skillBody },
    },
    // service/echo
    {
      meta: { type: "service", name: "echo" },
      files: { "compose.yaml": serviceCompose },
    },
  ];

  // Append extra rule if provided
  if (opts.extraRule) {
    ingredients.push(opts.extraRule);
  }

  // Build recipe ingredient list
  const baseIngredients = [
    "rule/style",
    "rule/api",
    "agent/api-reviewer",
    "command/review",
    "skill/docs",
    "service/echo",
    ...(opts.extraRule ? [`${opts.extraRule.meta.type}/${opts.extraRule.meta.name}`] : []),
  ];

  const recipes = [recipe("base", baseIngredients)];

  // Profile sets:
  // - sections.rule/style.flavors — a different table
  // - params.api.base — override the default
  const profiles = [
    profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], {
      params: { "api.base": "/api/v2" },
      sections: {
        "rule/style": {
          flavors: "| Lang | Style |\n|---|---|\n| en | UK |\n| pt | BR |\n",
        },
      },
    }),
  ];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Overwrite craftar.forge.yaml with the requested schema (default 5)
  const schema = opts.schema ?? 5;
  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema }),
  );

  return s;
}
