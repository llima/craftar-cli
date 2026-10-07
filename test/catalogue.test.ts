import { afterEach, describe, expect, it } from "vitest";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace } from "../src/core/sync.js";
import { resolve } from "../src/core/resolve.js";
import { catalogueContext, listIngredients, listRecipes, type CatalogueContext } from "../src/core/catalogue.js";
import { WorkspaceConfigSchema } from "../src/schema/index.js";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { promises as fs } from "node:fs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The Forge of spec 16 §4's examples (synthetic names). */
const ACME: ForgeSpec = {
  ingredients: [
    rule("angular-standards", "# A\n", { description: "Angular conventions" }),
    rule("commit-style", "# C\n"),
    rule("old-naming", "# O\n", { targets: ["kiro"] }),
    rule("react-standards", "# R\n"),
    rule("workflow--acme", "# W\n", { as: "workflow" }),
    { meta: { type: "agent", name: "angular-reviewer" } },
    { meta: { type: "agent", name: "legacy-helper" } },
    { meta: { type: "command", name: "ng-test" } },
  ],
  recipes: [
    recipe("base", ["rule/workflow--acme", "rule/commit-style", "rule/gone"], { description: "Shared conventions" }),
    recipe("legacy", ["agent/legacy-helper"]),
    recipe("stack-angular", ["rule/angular-standards", "agent/angular-reviewer", "command/ng-test"], {
      description: "Angular front end",
      slot: "frontend",
      extends: ["base"],
    }),
    recipe("stack-react", ["rule/react-standards"], { description: "React front end", slot: "frontend", extends: ["base"] }),
  ],
  profiles: [profile("acme", ["base", "legacy"], ["claude-code", "kiro"]), profile("globex", ["stack-angular"])],
};
const ACME_WS = {
  profile: "acme",
  recipes: { add: ["stack-angular"], remove: ["legacy"] },
  overrides: { ingredients: { disable: ["rule/commit-style"] } },
};
const GONE = 'recipe "base" references missing ingredient rule/gone';

async function acme(config: Record<string, unknown> = ACME_WS, spec: ForgeSpec = ACME) {
  const s = await scenario(spec, { config });
  cleanups.push(s.cleanup);
  await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: acme-forge\nschema: 1\n" });
  return s;
}

async function inWorkspace(config: Record<string, unknown> = ACME_WS, spec: ForgeSpec = ACME) {
  const s = await acme(config, spec);
  const w = await loadWorkspace(s.wsRoot);
  return { forge: w.forge, ctx: catalogueContext(w.forge, { kind: "workspace", config: w.config }) };
}

async function forgeOnly(spec: ForgeSpec = ACME) {
  const s = await acme(ACME_WS, spec);
  return loadForge(s.forgeRoot);
}

const byName = <T extends { name: string }>(xs: T[], n: string) => xs.find((x) => x.name === n)!;
const byRef = <T extends { ref: string }>(xs: T[], r: string) => xs.find((x) => x.ref === r)!;

describe("listRecipes (spec 16 §4.2)", () => {
  it("in a workspace: the whole catalogue sorted by name, with reasons, order, extendedBy and removedByWorkspace", async () => {
    const { forge, ctx } = await inWorkspace();
    expect(listRecipes(forge, ctx)).toEqual({
      forge: { name: "acme-forge", commit: null },
      context: { kind: "workspace", profile: "acme", recipes: ["base", "stack-angular"] },
      recipes: [
        {
          name: "base",
          description: "Shared conventions",
          slot: null,
          extends: [],
          ingredients: ["rule/workflow--acme", "rule/commit-style", "rule/gone"],
          profiles: ["acme", "globex"],
          inUse: { order: 1, by: ["profile", "extends"], extendedBy: ["stack-angular"] },
          removedByWorkspace: false,
        },
        {
          name: "legacy",
          description: null,
          slot: null,
          extends: [],
          ingredients: ["agent/legacy-helper"],
          profiles: ["acme"],
          inUse: null,
          removedByWorkspace: true,
        },
        {
          name: "stack-angular",
          description: "Angular front end",
          slot: "frontend",
          extends: ["base"],
          ingredients: ["rule/angular-standards", "agent/angular-reviewer", "command/ng-test"],
          profiles: ["globex"],
          inUse: { order: 2, by: ["workspace"], extendedBy: [] },
          removedByWorkspace: false,
        },
        {
          name: "stack-react",
          description: "React front end",
          slot: "frontend",
          extends: ["base"],
          ingredients: ["rule/react-standards"],
          profiles: [],
          inUse: null,
          removedByWorkspace: false,
        },
      ],
      warnings: [GONE],
    });
  });

  it("keys come in the order of the spec's JSON", async () => {
    const { forge, ctx } = await inWorkspace();
    const r = listRecipes(forge, ctx);
    expect(Object.keys(r)).toEqual(["forge", "context", "recipes", "warnings"]);
    expect(Object.keys(r.forge)).toEqual(["name", "commit"]);
    expect(Object.keys(r.context!)).toEqual(["kind", "profile", "recipes"]);
    expect(Object.keys(r.recipes[0])).toEqual(["name", "description", "slot", "extends", "ingredients", "profiles", "inUse", "removedByWorkspace"]);
    expect(Object.keys(r.recipes[0].inUse!)).toEqual(["order", "by", "extendedBy"]);
  });

  it("without a context: nothing marked, no warnings, profiles still counted through extends", async () => {
    const forge = await forgeOnly();
    const r = listRecipes(forge, catalogueContext(forge, null));
    expect(r.context).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.recipes.map((x) => [x.name, x.inUse, x.removedByWorkspace, x.profiles])).toEqual([
      ["base", null, false, ["acme", "globex"]],
      ["legacy", null, false, ["acme"]],
      ["stack-angular", null, false, ["globex"]],
      ["stack-react", null, false, []],
    ]);
  });

  it("--profile marks what a workspace with no recipes block and no overrides would", async () => {
    const forge = await forgeOnly();
    const r = listRecipes(forge, catalogueContext(forge, { kind: "profile", profile: "globex" }));
    expect(r.context).toEqual({ kind: "profile", profile: "globex", recipes: ["base", "stack-angular"] });
    expect(r.recipes.map((x) => [x.name, x.inUse, x.removedByWorkspace])).toEqual([
      ["base", { order: 1, by: ["extends"], extendedBy: ["stack-angular"] }, false],
      ["legacy", null, false],
      ["stack-angular", { order: 2, by: ["profile"], extendedBy: [] }, false],
      ["stack-react", null, false],
    ]);
    expect(r.warnings).toEqual([GONE]);
  });

  it("profile, workspace and extends combine in that order, each once", async () => {
    const { forge, ctx } = await inWorkspace({ profile: "acme", recipes: { add: ["base", "stack-angular"] } });
    expect(byName(listRecipes(forge, ctx).recipes, "base").inUse).toEqual({ order: 1, by: ["profile", "workspace", "extends"], extendedBy: ["stack-angular"] });
  });

  it("a profile listing a recipe twice, and a parent with its child: one entry, each reason once", async () => {
    const spec: ForgeSpec = { ...ACME, profiles: [profile("dup", ["base", "stack-angular", "base"])] };
    const forge = await forgeOnly(spec);
    const r = listRecipes(forge, catalogueContext(forge, { kind: "profile", profile: "dup" }));
    expect(r.context!.recipes).toEqual(["base", "stack-angular"]);
    expect(byName(r.recipes, "base").inUse).toEqual({ order: 1, by: ["profile", "extends"], extendedBy: ["stack-angular"] });
    expect(byName(r.recipes, "stack-angular").inUse).toEqual({ order: 2, by: ["profile"], extendedBy: [] });
  });

  it("extendedBy names direct children only, on a two-level chain", async () => {
    const spec: ForgeSpec = {
      recipes: [recipe("root", []), recipe("mid", [], { extends: ["root"] }), recipe("top", [], { extends: ["mid"] })],
      profiles: [profile("acme", ["top"])],
    };
    const forge = await forgeOnly(spec);
    const r = listRecipes(forge, catalogueContext(forge, { kind: "profile", profile: "acme" }));
    expect(r.recipes.map((x) => [x.name, x.inUse])).toEqual([
      ["mid", { order: 2, by: ["extends"], extendedBy: ["top"] }],
      ["root", { order: 1, by: ["extends"], extendedBy: ["mid"] }],
      ["top", { order: 3, by: ["profile"], extendedBy: [] }],
    ]);
  });

  it("remove naming a recipe a resolved recipe extends: still in use by extends, removedByWorkspace true (§6.12)", async () => {
    const { forge, ctx } = await inWorkspace({ profile: "globex", recipes: { remove: ["base"] } });
    expect(byName(listRecipes(forge, ctx).recipes, "base")).toMatchObject({
      inUse: { order: 1, by: ["extends"], extendedBy: ["stack-angular"] },
      removedByWorkspace: true,
    });
  });

  it("remove naming a recipe the profile does not list: inUse null, removedByWorkspace true (§6.13)", async () => {
    const { forge, ctx } = await inWorkspace({ profile: "globex", recipes: { remove: ["legacy"] } });
    expect(byName(listRecipes(forge, ctx).recipes, "legacy")).toMatchObject({ inUse: null, removedByWorkspace: true });
  });

  it("remove naming a recipe the profile lists and that a resolved recipe extends: by leaves out profile", async () => {
    const { forge, ctx } = await inWorkspace({ profile: "acme", recipes: { add: ["stack-angular"], remove: ["base"] } });
    expect(byName(listRecipes(forge, ctx).recipes, "base")).toMatchObject({
      inUse: { order: 2, by: ["extends"], extendedBy: ["stack-angular"] },
      removedByWorkspace: true,
    });
  });

  it("a workspace that does not resolve (slot conflict): whole catalogue, context null, nothing marked, one warning", async () => {
    const { forge, ctx } = await inWorkspace({
      profile: "globex",
      recipes: { add: ["stack-react"], remove: ["legacy"] },
      overrides: { ingredients: { disable: ["rule/commit-style"] } },
    });
    const r = listRecipes(forge, ctx);
    expect(r.context).toBeNull();
    expect(r.recipes.map((x) => [x.name, x.inUse, x.removedByWorkspace])).toEqual([
      ["base", null, false],
      ["legacy", null, false],
      ["stack-angular", null, false],
      ["stack-react", null, false],
    ]);
    expect(r.warnings).toEqual([
      'cannot resolve this workspace (profile globex): recipes "stack-angular" and "stack-react" both occupy slot "frontend" — nothing is marked as in use',
    ]);
    const i = listIngredients(forge, ctx);
    expect(i.context).toBeNull();
    expect(i.ingredients.every((x) => x.inUse === null && x.disabled === false)).toBe(true);
    expect(i.ingredients).toHaveLength(8);
    expect(i.warnings).toEqual(r.warnings);
  });

  it("a profile that does not resolve (unknown recipe): one warning, and the profile is still counted in profiles", async () => {
    const spec: ForgeSpec = { ...ACME, profiles: [...ACME.profiles!, profile("broken", ["base", "nope"])] };
    const forge = await forgeOnly(spec);
    const r = listRecipes(forge, catalogueContext(forge, { kind: "profile", profile: "broken" }));
    expect(r.context).toBeNull();
    expect(r.warnings).toEqual(['cannot resolve profile broken: recipe "nope" not found (referenced by profile broken) — nothing is marked as in use']);
    expect(byName(r.recipes, "base").profiles).toEqual(["acme", "broken", "globex"]);
  });

  it("a cycle: the context does not resolve, and profiles is still computed (the walk tolerates it)", async () => {
    const spec: ForgeSpec = {
      recipes: [recipe("a", [], { extends: ["b"] }), recipe("b", [], { extends: ["a"] })],
      profiles: [profile("acme", ["a"])],
    };
    const forge = await forgeOnly(spec);
    const r = listRecipes(forge, catalogueContext(forge, { kind: "profile", profile: "acme" }));
    expect(r.warnings).toEqual(["cannot resolve profile acme: recipe cycle: a → b → a — nothing is marked as in use"]);
    expect(r.recipes.map((x) => [x.name, x.profiles, x.inUse])).toEqual([
      ["a", ["acme"], null],
      ["b", ["acme"], null],
    ]);
  });

  it("a recipe whose name differs from its file name is listed under name", async () => {
    const s = await acme();
    await writeFiles(s.forgeRoot, { "recipes/file-name.yaml": "name: real-name\ningredients: []\n" });
    const forge = await loadForge(s.forgeRoot);
    expect(listRecipes(forge, null).recipes.map((x) => x.name)).toEqual(["base", "legacy", "real-name", "stack-angular", "stack-react"]);
  });

  it("an empty Forge: empty lists", async () => {
    const root = await tmpDir("craftar-catalogue-empty-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {});
    const forge = await loadForge(root);
    expect(listRecipes(forge, null)).toEqual({ forge: { name: "test-forge", commit: null }, context: null, recipes: [], warnings: [] });
    expect(listIngredients(forge, null)).toEqual({
      forge: { name: "test-forge", commit: null },
      context: null,
      recipe: null,
      ingredients: [],
      missing: [],
      warnings: [],
    });
  });
});

describe("catalogueContext (spec 16 §4.1, §5.2)", () => {
  it("a profile the Forge lacks throws the very string resolve throws (Forge with profiles)", async () => {
    const forge = await forgeOnly();
    const fromResolve = (() => {
      try {
        resolve(forge, WorkspaceConfigSchema.parse({ forge: forge.root, profile: "nobody" }));
      } catch (e) {
        return (e as Error).message;
      }
      return "did not throw";
    })();
    expect(fromResolve).toMatch(/^profile "nobody" not found in Forge \((acme, globex|globex, acme)\)$/);
    expect(() => catalogueContext(forge, { kind: "profile", profile: "nobody" })).toThrow(fromResolve);
    const { ctx: _unused, forge: f2 } = await inWorkspace();
    expect(() => catalogueContext(f2, { kind: "workspace", config: WorkspaceConfigSchema.parse({ forge: f2.root, profile: "nobody" }) })).toThrow(fromResolve);
  });

  it("a Forge with no profile: the message ends in (none)", async () => {
    const forge = await forgeOnly({ ...ACME, profiles: [] });
    expect(() => catalogueContext(forge, { kind: "profile", profile: "nobody" })).toThrow('profile "nobody" not found in Forge (none)');
  });
});

describe("listIngredients (spec 16 §4.3)", () => {
  it("in a workspace: every ingredient by type then name, outputName, recipes, inUse, disabled, missing", async () => {
    const { forge, ctx } = await inWorkspace();
    const e = (ref: string, over: Record<string, unknown>) => {
      const [type, name] = ref.split("/");
      return { ref, type, name, outputName: name, description: null, targets: "*", recipes: [], inUse: false, disabled: false, ...over };
    };
    expect(listIngredients(forge, ctx)).toEqual({
      forge: { name: "acme-forge", commit: null },
      context: { kind: "workspace", profile: "acme", recipes: ["base", "stack-angular"] },
      recipe: null,
      ingredients: [
        e("rule/angular-standards", { description: "Angular conventions", recipes: ["stack-angular"], inUse: true }),
        e("rule/commit-style", { recipes: ["base"], disabled: true }),
        e("rule/old-naming", { targets: ["kiro"] }),
        e("rule/react-standards", { recipes: ["stack-react"] }),
        e("rule/workflow--acme", { outputName: "workflow", recipes: ["base"], inUse: true }),
        e("agent/angular-reviewer", { recipes: ["stack-angular"], inUse: true }),
        e("agent/legacy-helper", { recipes: ["legacy"] }),
        e("command/ng-test", { recipes: ["stack-angular"], inUse: true }),
      ],
      missing: [{ ref: "rule/gone", recipes: ["base"] }],
      warnings: [GONE],
    });
  });

  it("keys come in the order of the spec's JSON", async () => {
    const { forge, ctx } = await inWorkspace();
    const r = listIngredients(forge, ctx, { recipe: "stack-angular" });
    expect(Object.keys(r)).toEqual(["forge", "context", "recipe", "ingredients", "missing", "warnings"]);
    expect(Object.keys(r.recipe!)).toEqual(["name", "chain"]);
    expect(Object.keys(r.recipe!.chain[0])).toEqual(["recipe", "ingredients"]);
    expect(Object.keys(r.ingredients[0])).toEqual(["ref", "type", "name", "outputName", "description", "targets", "recipes", "inUse", "disabled"]);
    expect(Object.keys(r.missing[0])).toEqual(["ref", "recipes"]);
  });

  it("without a context: inUse null, disabled false, no warnings", async () => {
    const forge = await forgeOnly();
    const r = listIngredients(forge, null);
    expect(r.warnings).toEqual([]);
    expect(r.ingredients.map((x) => [x.ref, x.inUse, x.disabled])).toEqual([
      ["rule/angular-standards", null, false],
      ["rule/commit-style", null, false],
      ["rule/old-naming", null, false],
      ["rule/react-standards", null, false],
      ["rule/workflow--acme", null, false],
      ["agent/angular-reviewer", null, false],
      ["agent/legacy-helper", null, false],
      ["command/ng-test", null, false],
    ]);
    expect(r.missing).toEqual([{ ref: "rule/gone", recipes: ["base"] }]);
  });

  it("--recipe: the chain parents first, the union of its ingredients, its missing references", async () => {
    const { forge, ctx } = await inWorkspace();
    const r = listIngredients(forge, ctx, { recipe: "stack-angular" });
    expect(r.recipe).toEqual({
      name: "stack-angular",
      chain: [
        { recipe: "base", ingredients: ["rule/workflow--acme", "rule/commit-style", "rule/gone"] },
        { recipe: "stack-angular", ingredients: ["rule/angular-standards", "agent/angular-reviewer", "command/ng-test"] },
      ],
    });
    expect(r.ingredients.map((x) => x.ref)).toEqual([
      "rule/angular-standards",
      "rule/commit-style",
      "rule/workflow--acme",
      "agent/angular-reviewer",
      "command/ng-test",
    ]);
    expect(r.missing).toEqual([{ ref: "rule/gone", recipes: ["base"] }]);
    expect(r.warnings).toEqual([GONE]);
  });

  it("--recipe naming a recipe the context does not use: its own ingredients read inUse false (§6.8)", async () => {
    const { forge, ctx } = await inWorkspace();
    const r = listIngredients(forge, ctx, { recipe: "stack-react" });
    expect(r.recipe!.chain.map((c) => c.recipe)).toEqual(["base", "stack-react"]);
    expect(byRef(r.ingredients, "rule/react-standards")).toMatchObject({ inUse: false, recipes: ["stack-react"] });
    expect(byRef(r.ingredients, "rule/workflow--acme")).toMatchObject({ inUse: true });
  });

  it("an ingredient listed by parent and child appears under both chain entries, once in ingredients", async () => {
    const spec: ForgeSpec = {
      ...ACME,
      recipes: [recipe("base", ["rule/commit-style"]), recipe("child", ["rule/commit-style", "rule/gone"], { extends: ["base"] }), recipe("other", ["rule/gone"])],
    };
    const forge = await forgeOnly(spec);
    const r = listIngredients(forge, null, { recipe: "child" });
    expect(r.recipe!.chain).toEqual([
      { recipe: "base", ingredients: ["rule/commit-style"] },
      { recipe: "child", ingredients: ["rule/commit-style", "rule/gone"] },
    ]);
    expect(r.ingredients.map((x) => [x.ref, x.recipes])).toEqual([["rule/commit-style", ["base", "child"]]]);
    // a missing reference also cited by a recipe outside the chain lists that recipe too
    expect(r.missing).toEqual([{ ref: "rule/gone", recipes: ["child", "other"] }]);
  });

  it("--recipe: unknown recipe, cycle and unknown parent each throw the named message", async () => {
    const forge = await forgeOnly({
      ...ACME,
      recipes: [...ACME.recipes!, recipe("a", [], { extends: ["b"] }), recipe("b", [], { extends: ["a"] }), recipe("orphan", [], { extends: ["ghost"] })],
    });
    expect(() => listIngredients(forge, null, { recipe: "nope" })).toThrow(
      'recipe "nope" not found in this Forge (a, b, base, legacy, orphan, stack-angular, stack-react)',
    );
    expect(() => listIngredients(forge, null, { recipe: "a" })).toThrow("recipe cycle: a → b → a");
    expect(() => listIngredients(forge, null, { recipe: "orphan" })).toThrow('recipe "ghost" not found (referenced by orphan)');
  });

  it("a --recipe chain with two recipes on one slot is listed, with the warning", async () => {
    const forge = await forgeOnly({ ...ACME, recipes: [...ACME.recipes!, recipe("both", [], { extends: ["stack-angular", "stack-react"] })] });
    const r = listIngredients(forge, null, { recipe: "both" });
    expect(r.recipe!.chain.map((c) => c.recipe)).toEqual(["base", "stack-angular", "stack-react", "both"]);
    expect(r.warnings).toEqual(['recipes "stack-angular" and "stack-react" both occupy slot "frontend" — no workspace can resolve "both"']);
  });

  it("--type filters ingredients, chain and missing; resolve's warning stays whole", async () => {
    const { forge, ctx } = await inWorkspace();
    const agents = listIngredients(forge, ctx, { type: "agent" });
    expect(agents.ingredients.map((x) => x.ref)).toEqual(["agent/angular-reviewer", "agent/legacy-helper"]);
    expect(agents.missing).toEqual([]);
    expect(agents.warnings).toEqual([GONE]);
    const rules = listIngredients(forge, ctx, { recipe: "stack-angular", type: "rule" });
    expect(rules.recipe!.chain).toEqual([
      { recipe: "base", ingredients: ["rule/workflow--acme", "rule/commit-style", "rule/gone"] },
      { recipe: "stack-angular", ingredients: ["rule/angular-standards"] },
    ]);
    expect(rules.missing).toEqual([{ ref: "rule/gone", recipes: ["base"] }]);
    const hooks = listIngredients(forge, ctx, { type: "hook" });
    expect([hooks.ingredients, hooks.missing]).toEqual([[], []]);
  });

  it("an unknown --type throws naming the eight types", async () => {
    const forge = await forgeOnly();
    expect(() => listIngredients(forge, null, { type: "widget" })).toThrow(
      'unknown ingredient type "widget" — one of rule, agent, command, skill, mcp, script, steering, hook',
    );
  });

  it("--profile context: disabled is never true", async () => {
    const forge = await forgeOnly();
    const r = listIngredients(forge, catalogueContext(forge, { kind: "profile", profile: "acme" }));
    expect(byRef(r.ingredients, "rule/commit-style")).toMatchObject({ inUse: true, disabled: false });
  });
});


describe("catalogue — one sort order, each recipe once (review of 0.9.0)", () => {
  it("names sort in code-unit order everywhere, and a recipe listing a ref twice is named once", async () => {
    const root = await tmpDir("craftar-catalogue-sort-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("a", "# A\n")],
      recipes: [recipe("zeta", ["rule/a", "rule/a", "rule/gone", "rule/gone"]), recipe("alpha", [])],
      profiles: [profile("acme", ["zeta"])],
    });
    // A second recipe and profile whose names differ from the first only in case: distinct FILE names,
    // because Windows and macOS file systems are case-insensitive (loadForge keys by `name`, not by file).
    await writeFiles(root, {
      "recipes/upper-zeta.yaml": "name: Zeta\ningredients: [rule/a]\n",
      "profiles/upper-acme/profile.yaml": "name: Acme\nrecipes: [Zeta]\n",
    });
    const forge = await loadForge(root);
    expect(listRecipes(forge, null).recipes.map((x) => x.name)).toEqual(["Zeta", "alpha", "zeta"]);
    const i = listIngredients(forge, null);
    expect(i.ingredients[0].recipes).toEqual(["Zeta", "zeta"]);
    expect(i.missing).toEqual([{ ref: "rule/gone", recipes: ["zeta"] }]);
    expect(() => listIngredients(forge, null, { recipe: "nope" })).toThrow('recipe "nope" not found in this Forge (Zeta, alpha, zeta)');
  });
});
