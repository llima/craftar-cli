import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, type IngredientSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(ingredients: IngredientSpec[], refs: string[], profileExtra: Record<string, unknown> = {}) {
  const s = await scenario(
    { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["claude-code", "kiro"], profileExtra)] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}

const BODY = "Org: {{scm.org}}\nTitle: {{ 'X' | localize }}\n";

describe("plan warnings", () => {
  it("reports each unresolved param once, with the ingredients citing it", async () => {
    const p = await planFor([rule("a", BODY), rule("b", "Also {{scm.org}}\n")], ["rule/a", "rule/b"]);
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual(['param "scm.org" has no value in any layer — left verbatim (rule/a, rule/b)']);
    const a = p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8");
    expect(a).toContain("{{scm.org}}");
    expect(a).toContain("{{ 'X' | localize }}");
  });

  it("stays quiet when a layer provides the value", async () => {
    const p = await planFor([rule("a", BODY)], ["rule/a"], { params: { "scm.org": "acme" } });
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual([]);
    expect(p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8")).toContain("Org: acme");
  });

  it("warns when two ingredients write the same path", async () => {
    const p = await planFor([rule("x", "# X\n"), rule("x--p", "# X2\n", { as: "x" })], ["rule/x", "rule/x--p"]);
    expect(p.warnings).toContain("two ingredients write .claude/rules/x.md: rule/x and rule/x--p (last wins)");
  });
});
