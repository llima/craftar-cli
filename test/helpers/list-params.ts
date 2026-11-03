import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, scenario, writeFiles, type IngredientSpec } from "./forge.js";

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/** A rule body that writes a list param every way spec 55 Part A reads — none of them a list key below the gate. */
export const LIST_BODY =
  "# Allow\n\nALLOW = {{env | py}}\n$Allow = {{ env | ps }}\nfor v in {{env|sh}}; do\nTags: {{tags}}\n\n{{ 'X' | localize }}\n{{ value | date: 'short' }}\n";

/**
 * A Forge whose profile `acme` gives two YAML lists (`env`, `tags`) and whose rule `allow` cites them unfiltered and filtered —
 * the baseline of spec 55 Part A: below the list-params gate every filtered form is left as written and a list renders `a,b`.
 * `declare` adds `type: list` to `env` in the rule's own `params`; `extra` adds Forge files.
 */
export async function acmeLists(opts: { schema: number; declare?: boolean; body?: string; extra?: Record<string, string> }): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "rule", name: "allow", ...(opts.declare ? { params: { env: { type: "list" } } } : {}) },
      files: { "rule.md": opts.body ?? LIST_BODY },
    },
    {
      meta: { type: "skill", name: "sqlfmt", layout: "dir" },
      files: { "SKILL.md": "---\nname: sqlfmt\ndescription: Formats SQL. Use when asked.\n---\nFormat it.\n", "run.sh": "#!/bin/sh\necho {{tags}}\n" },
    },
  ];
  const s = await scenario(
    {
      ingredients,
      recipes: [recipe("core", ["rule/allow", "skill/sqlfmt"])],
      profiles: [profile("acme", ["core"], ["claude-code", "kiro", "agents-md"], { params: { env: ["A", "B"], tags: ["a", "b"] } })],
    },
    { config: { profile: "acme" } },
  );
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema }));
  await writeFiles(s.forgeRoot, opts.extra ?? {});
  return s;
}
