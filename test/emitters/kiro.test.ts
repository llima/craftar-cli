import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { hasBom } from "../../src/core/text.js";
import { profile, recipe, rule, scenario, type IngredientSpec } from "../helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(ingredients: IngredientSpec[], profileExtra: Record<string, unknown> = {}): Promise<Plan> {
  const s = await scenario(
    {
      ingredients,
      recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
      profiles: [profile("acme", ["base"], ["kiro"], profileExtra)],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}
const file = (p: Plan, rel: string) => p.files.find((f) => f.path === rel);

describe("kiro emitter", () => {
  it("emits an always rule as CRLF steering with the default banner and no BOM", async () => {
    const p = await planFor([rule("a", "# A\n")]);
    const f = file(p, ".kiro/steering/a.md")!;
    expect(f.content.toString("utf8")).toBe("---\r\ninclusion: always\r\n---\r\n\r\n<!-- GENERATED from .claude/rules/a.md by craftar -- do not edit. -->\r\n\r\n# A\r\n");
    expect(hasBom(f.content)).toBe(false);
  });

  it("uses the kiro.banner param", async () => {
    const p = await planFor([rule("a", "# A\n")], { params: { "kiro.banner": "<!-- X from {{source}} -->" } });
    expect(file(p, ".kiro/steering/a.md")!.content.toString("utf8")).toContain("<!-- X from .claude/rules/a.md -->");
  });

  it("writes fileMatch frontmatter", async () => {
    const p = await planFor([rule("b", "# B\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" })]);
    expect(file(p, ".kiro/steering/b.md")!.content.toString("utf8")).toMatch(/^---\r\ninclusion: fileMatch\r\nfileMatchPattern: "projects\/api\/\*\*"\r\n---\r\n\r\n/);
  });

  it("rewrites .claude/rules/ references to .kiro/steering/", async () => {
    const p = await planFor([rule("a", "see .claude/rules/b.md\n")]);
    expect(file(p, ".kiro/steering/a.md")!.content.toString("utf8")).toContain("see .kiro/steering/b.md");
  });

  it("maps agent tools and warns about the ones Kiro cannot express", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Task"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.tools).toEqual(["read"]);
    expect(json.prompt).toBe("# Rev");
    expect(p.warnings).toContain('kiro: tool "Task" has no Kiro equivalent; dropped');
  });

  it("emits a variant under its original name", async () => {
    const p = await planFor([rule("workflow--acme", "# W\n", { as: "workflow" })]);
    expect(p.files.map((f) => f.path)).toEqual([".kiro/steering/workflow.md"]);
  });
});
