import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, writeFiles, type IngredientSpec } from "./forge.js";

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/** The body of `rule/review`: two sections and an Angular line that must survive every render (spec 55 §9). */
export const REVIEW_BODY =
  "# Review\n\n<!-- craftar:section checklist -->\ndefault checklist\n<!-- /craftar:section -->\n\n" +
  "<!-- craftar:section tone -->\ndefault tone\n<!-- /craftar:section -->\n\n{{ 'X' | localize }}\n";

/**
 * A Forge whose profile `acme` gives `rule/review` two sections, and a skill whose description says when to use it — the
 * baseline of spec 55 Parts B and C. `sections` replaces the profile's section values; `files` adds Forge files (a section
 * file, an unnamed file under `profiles/acme/sections/`).
 */
export async function acmeSections(opts: {
  schema: number;
  sections?: Record<string, Record<string, unknown>>;
  files?: Record<string, string | Buffer>;
  skillDescription?: string;
}): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    { meta: { type: "rule", name: "review", description: "How a review is written" }, files: { "rule.md": REVIEW_BODY } },
    {
      meta: { type: "skill", name: "sqlfmt", layout: "dir" },
      files: {
        "SKILL.md": `---\nname: sqlfmt\ndescription: ${opts.skillDescription ?? "Formats SQL. Use when asked to format a query."}\n---\nFormat it.\n`,
        "run.sh": "#!/bin/sh\necho formatting\n",
      },
    },
  ];
  const sections = opts.sections ?? { "rule/review": { checklist: "- one\n- two\n", tone: "Short paragraphs.\n" } };
  const s = await scenario(
    {
      ingredients,
      recipes: [recipe("core", ["rule/review", "skill/sqlfmt"])],
      profiles: [profile("acme", ["core"], ["claude-code", "kiro", "agents-md"], { sections })],
    },
    { config: { profile: "acme" } },
  );
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema }));
  await writeFiles(s.forgeRoot, opts.files ?? {});
  return s;
}
