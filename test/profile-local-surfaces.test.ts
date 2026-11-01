import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/** Spec 51 §4.4 and acceptance 4: the reading surfaces at schema 8, and no new key below it. */

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const localRule = (p: string, name: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: `# ${name} of ${p}\n`,
});
const localRecipe = (p: string, name: string, ingredients: string[]) => ({ [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients }) });

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("core", ["rule/style"])],
  profiles: [profile("acme", ["core", "extra"], ["claude-code"]), profile("globex", ["core", "extra"], ["claude-code"])],
};
const files = { ...localRule("acme", "x"), ...localRecipe("acme", "extra", ["rule/x"]), ...localRule("globex", "y"), ...localRecipe("globex", "extra", ["rule/y"]) };

async function at(schema: number, config: Record<string, unknown> = { profile: "acme" }): Promise<Scenario> {
  const s = await scenario(spec, { config });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(s.forgeRoot, files);
  return s;
}

const json = (args: string[]) => {
  const r = runCli(args);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe("recipes and ingredients --json at schema 8 (spec 51 §4.4)", () => {
  it("with a workspace context: the root and that profile's locals, each with scope and profile", async () => {
    const s = await at(8);
    const r = json(["recipes", "--json", "--workspace", s.wsRoot]);
    expect(r.recipes.map((x: { name: string; scope: string; profile: string | null }) => [x.name, x.scope, x.profile])).toEqual([
      ["core", "forge", null],
      ["extra", "profile", "acme"],
    ]);
    expect(r.recipes[1].inUse).toEqual({ order: 2, by: ["profile"], extendedBy: [] });
    expect(r.recipes[1].profiles).toEqual(["acme"]);
    const i = json(["ingredients", "--json", "--workspace", s.wsRoot]);
    expect(i.ingredients.map((x: { ref: string; scope: string; profile: string | null; recipes: string[]; inUse: boolean }) => [x.ref, x.scope, x.profile, x.recipes, x.inUse])).toEqual([
      ["rule/style", "forge", null, ["core"], true],
      ["rule/x", "profile", "acme", ["extra"], true],
    ]);
  });

  it("with --forge alone: every profile's locals, two rows may share a name", async () => {
    const s = await at(8);
    const r = json(["recipes", "--json", "--forge", s.forgeRoot]);
    expect(r.recipes.map((x: { name: string; profile: string | null; profiles: string[] }) => [x.name, x.profile, x.profiles])).toEqual([
      ["core", null, ["acme", "globex"]],
      ["extra", "acme", ["acme"]],
      ["extra", "globex", ["globex"]],
    ]);
  });

  it("ingredients --recipe naming a local recipe two profiles hold is refused without --profile, and works with it", async () => {
    const s = await at(8);
    const r = runCli(["ingredients", "--recipe", "extra", "--forge", s.forgeRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('recipe "extra" is local to profiles acme, globex — pass --profile');
    const ok = json(["ingredients", "--recipe", "extra", "--json", "--forge", s.forgeRoot, "--profile", "globex"]);
    expect(ok.ingredients.map((x: { ref: string }) => x.ref)).toEqual(["rule/y"]);
    expect(ok.recipe.chain).toEqual([{ recipe: "extra", ingredients: ["rule/y"] }]);
  });

  it("the text marks a local row", async () => {
    const s = await at(8);
    const r = runCli(["recipes", "--workspace", s.wsRoot]);
    expect(r.stdout).toMatch(/extra \(local to acme\)/);
    expect(runCli(["ingredients", "--workspace", s.wsRoot]).stdout).toMatch(/x \(local to acme\)/);
  });

  it("acceptance 4: at schema 7 no row carries scope or profile, and the folder is warned", async () => {
    const s = await at(7, { profile: "acme", recipes: { remove: ["extra"] } });
    const r = json(["recipes", "--json", "--workspace", s.wsRoot]);
    for (const x of r.recipes) expect(Object.keys(x)).not.toContain("scope");
    expect(r.warnings).toContain("profiles/acme/ingredients: ignored below schema 8");
    const i = json(["ingredients", "--json", "--workspace", s.wsRoot]);
    for (const x of i.ingredients) expect(Object.keys(x)).not.toContain("scope");
  });
});

describe("explain at schema 8 (spec 51 §4.4)", () => {
  it("names a local's folder, a root ingredient's, and several for AGENTS.md", async () => {
    const s = await at(8, { profile: "acme", targets: ["claude-code", "agents-md"] });
    expect(runCli(["explain", ".claude/rules/x.md", "--workspace", s.wsRoot]).stdout).toContain("  source      profile acme (profiles/acme/ingredients/rules/x)\n");
    expect(runCli(["explain", ".claude/rules/style.md", "--workspace", s.wsRoot]).stdout).toContain("  source      forge (ingredients/rules/style)\n");
    expect(runCli(["explain", "AGENTS.md", "--workspace", s.wsRoot]).stdout).toContain("  source      several ingredients\n");
  });

  it("at schema 7 prints no source line", async () => {
    const s = await at(7, { profile: "acme", recipes: { remove: ["extra"] } });
    expect(runCli(["explain", ".claude/rules/style.md", "--workspace", s.wsRoot]).stdout).not.toContain("source");
  });
});

describe("the explain builder the MCP tool shares (spec 51 §4.4)", () => {
  it("gains scope and dir at schema 8, Forge-relative, and neither key below", async () => {
    const { loadWorkspace, plan } = await import("../src/core/sync.js");
    const { explainFile } = await import("../src/core/report.js");
    const s8 = await at(8);
    const w8 = await loadWorkspace(s8.wsRoot, { home: process.env.CRAFTAR_HOME });
    const e = explainFile(w8, await plan(w8), ".claude/rules/x.md")!;
    expect([e.scope, e.dir]).toEqual(["profile", "profiles/acme/ingredients/rules/x"]);
    const s7 = await at(7, { profile: "acme", recipes: { remove: ["extra"] } });
    const w7 = await loadWorkspace(s7.wsRoot, { home: process.env.CRAFTAR_HOME });
    expect(Object.keys(explainFile(w7, await plan(w7), ".claude/rules/style.md")!)).not.toContain("scope");
  });
});
