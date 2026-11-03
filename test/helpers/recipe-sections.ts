import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, type IngredientSpec } from "./forge.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

export const DEFAULT_EXECUTION = "Run the checks by hand.\n";
export const DEFAULT_CHECKLIST = "- [ ] tests\n";

/** `command/open-pr`, whose body holds two sections: `execution` and `checklist` (spec 54 §4). */
export const openPr: IngredientSpec = {
  meta: { type: "command", name: "open-pr", description: "Open a pull request" },
  files: {
    "command.md": [
      "# Open a PR",
      "<!-- craftar:section execution -->",
      DEFAULT_EXECUTION.trimEnd(),
      "<!-- /craftar:section -->",
      "<!-- craftar:section checklist -->",
      DEFAULT_CHECKLIST.trimEnd(),
      "<!-- /craftar:section -->",
      "",
    ].join("\n"),
  },
};

export interface RecipeSectionsOpts {
  schema: number;
  /** `sections` written in recipe `executor-kiro`; absent when undefined. */
  kiroSections?: Record<string, Record<string, string>>;
  /** `sections` written in recipe `base`; absent when undefined. */
  baseSections?: Record<string, Record<string, string>>;
  /** acme-portal's own `sections`. */
  portalSections?: Record<string, Record<string, string>>;
  /** The workspace's `overrides.sections`. */
  overrides?: Record<string, Record<string, string>>;
  workspaceProfile?: string;
}

/**
 * A Forge at `opts.schema` (spec 54 Part A): `command/open-pr` with two sections; recipe `base` lists it; recipe
 * `executor-kiro` (empty) is selected by `integrations.executor.kind: kiro`; `acme-portal` runs Kiro, `globex` does not.
 */
export async function acmeRecipeSections(opts: RecipeSectionsOpts): Promise<Scenario> {
  const withSections = (r: ReturnType<typeof recipe>, s?: Record<string, Record<string, string>>) => (s ? { ...r, sections: s } : r);
  const recipes = [
    withSections(recipe("base", ["command/open-pr"]), opts.baseSections),
    withSections(recipe("executor-kiro", []), opts.kiroSections),
    recipe("executor-claude-subagent", []),
  ];
  const profiles = [
    profile("acme-portal", ["base"], ["claude-code"], {
      integrations: { executor: { kind: "kiro" } },
      ...(opts.portalSections ? { sections: opts.portalSections } : {}),
    }),
    profile("globex", ["base"], ["claude-code"], { integrations: { executor: { kind: "claude-subagent" } } }),
  ];
  const s = await scenario(
    { ingredients: [openPr], recipes, profiles },
    { config: { profile: opts.workspaceProfile ?? "acme-portal", ...(opts.overrides ? { overrides: { sections: opts.overrides } } : {}) } },
  );
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema }));
  return s;
}
