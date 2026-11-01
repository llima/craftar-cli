import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, type IngredientSpec } from "./forge.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * A Forge whose metadata fields (spec 50 §5.2) cite `{{glob}}` and `{{org}}`, both set by the profile —
 * a rule's `frontmatterRaw`, `fileMatchPattern` and `description`, an agent's `frontmatterRaw` and
 * `description`, a command's `description` and `argumentHint` — plus a variant for profile `beta` that
 * differs in metadata only, so `forge diff` has something to compare.
 *
 * Spec 50 §5.1: pins what such a Forge gets below the gate, where no metadata field is rendered.
 */
export async function acmeMeta(opts: { schema: number; workspaceProfile?: string }): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    // rule/paths — frontmatterRaw with a `paths:` that cites {{glob}}
    {
      meta: {
        type: "rule",
        name: "paths",
        inclusion: "fileMatch",
        fileMatchPattern: "{{glob}}",
        description: "Rules for {{org}} sources",
        frontmatterRaw: "paths: {{glob}}",
      },
      files: { "rule.md": "# Paths\nKeep {{org}} code tidy.\n" },
    },
    // rule/paths--beta — differs in metadata only
    {
      meta: {
        type: "rule",
        name: "paths--beta",
        as: "paths",
        inclusion: "fileMatch",
        fileMatchPattern: "lib/**",
        description: "Rules for beta sources",
        frontmatterRaw: "paths: lib/**",
      },
      files: { "rule.md": "# Paths\nKeep {{org}} code tidy.\n" },
    },
    // rule/style — always on, a description that cites {{org}}
    {
      meta: { type: "rule", name: "style", description: "Style of {{org}}" },
      files: { "rule.md": "# Style\nUse consistent formatting.\n" },
    },
    // agent/helper — description cites {{org}}
    {
      meta: { type: "agent", name: "helper", description: "Helps {{org}} engineers" },
      files: { "agent.md": "Help the user.\n" },
    },
    // agent/raw — frontmatterRaw cites {{org}}
    {
      meta: { type: "agent", name: "raw", frontmatterRaw: "name: raw\ndescription: Reviews {{org}} changes" },
      files: { "agent.md": "Review the change.\n" },
    },
    // command/ship — description and argumentHint cite {{org}}
    {
      meta: { type: "command", name: "ship", description: "Ship an {{org}} release", argumentHint: "<{{org}}-version>" },
      files: { "command.md": "Ship it.\n" },
    },
  ];

  const recipes = [
    recipe("base", ["rule/paths", "rule/style", "agent/helper", "agent/raw", "command/ship"]),
    recipe("base--beta", ["rule/paths--beta", "rule/style", "agent/helper", "agent/raw", "command/ship"]),
  ];

  const profiles = [
    profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], { params: { glob: "src/**", org: "acme" } }),
    profile("beta", ["base--beta"], ["claude-code", "kiro", "agents-md"], { params: { glob: "lib/**", org: "beta" } }),
  ];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: opts.workspaceProfile ?? "acme" } });

  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: opts.schema }),
  );

  return s;
}
