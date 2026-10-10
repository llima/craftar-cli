import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { catalogueContext, listRecipes } from "../src/core/catalogue.js";
import { loadForge } from "../src/core/forge.js";
import { planRecipeEdit } from "../src/core/recipe-edit.js";
import { resolve } from "../src/core/resolve.js";
import { loadWorkspace } from "../src/core/sync.js";
import { WorkspaceConfigSchema } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, forgeAt, PM, sync } from "./helpers/integrations.js";

// Spec 33 §9.4 — an integration recipe is the profile's: `by: ["profile"]`, `add` says it is in use, `remove` takes it out.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function at(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  return s;
}
const forProfile = async (forgeRoot: string, name: string | null) => {
  const forge = await loadForge(forgeRoot);
  return listRecipes(forge, name === null ? null : catalogueContext(forge, { kind: "profile", profile: name }));
};
const entry = (l: Awaited<ReturnType<typeof forProfile>>, name: string) => l.recipes.find((r) => r.name === name)!;
const KEYS = ["name", "description", "slot", "extends", "ingredients", "profiles", "inUse", "removedByWorkspace"];
const config = (extra: Record<string, unknown> = {}) => WorkspaceConfigSchema.parse({ forge: ".", profile: "acme", ...extra });
const GLOBEX_BAD = profile("globex", ["base"], ["claude-code"], { integrations: { pm: "x" } });
const WALK = "profile globex: integrations.pm is not a mapping — its recipes are read as written";

describe("Catalogue", () => {
  it("1. in use, by the profile", async () => {
    const { forgeRoot } = await at(3, ado());
    const l = await forProfile(forgeRoot, "acme");
    expect(entry(l, "pm-azure-devops")).toEqual({
      name: "pm-azure-devops",
      description: null,
      slot: "pm",
      extends: [],
      ingredients: ["mcp/azure-devops", "rule/stories-azure-devops"],
      profiles: ["acme"],
      inUse: { order: 2, by: ["profile"], extendedBy: [] },
      removedByWorkspace: false,
    });
    expect(l.warnings).toEqual([]);
    expect(l.context).toEqual({ kind: "profile", profile: "acme", recipes: ["base", "pm-azure-devops"] });
    for (const e of l.recipes) expect(Object.keys(e)).toEqual(KEYS);
    expect(Object.keys(l)).toEqual(["forge", "context", "recipes", "warnings"]);
  });

  it("2. (control) at schema 2 the same Forge does not use it", async () => {
    const { forgeRoot } = await at(2, ado());
    const l = await forProfile(forgeRoot, "acme");
    expect(entry(l, "pm-azure-devops").inUse).toBeNull();
    expect(entry(l, "pm-azure-devops").profiles).toEqual([]);
  });

  it("3. profiles names every profile that selects it, either way", async () => {
    const { forgeRoot } = await at(3, ado({ profiles: [profile("globex", ["base", "pm-azure-devops"])] }));
    const l = await forProfile(forgeRoot, "acme");
    expect(entry(l, "pm-azure-devops").profiles).toEqual(["acme", "globex"]);
  });

  it("4. the walk goes through extends", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        { meta: { type: "rule", name: "workflow" }, files: { "rule.md": "# Workflow\n" } },
        { meta: { type: "rule", name: "where" }, files: { "rule.md": "Org {{integrations.pm.org}}\n" } },
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-common", []),
        recipe("pm-azure-devops", [], { extends: ["pm-common"], slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: PM })],
    };
    const { forgeRoot } = await at(3, spec);
    const l = await forProfile(forgeRoot, "acme");
    expect(entry(l, "pm-common").profiles).toEqual(["acme"]);
    expect(entry(l, "pm-common").inUse).toEqual({ order: 2, by: ["extends"], extendedBy: ["pm-azure-devops"] });
    expect(entry(l, "pm-azure-devops").inUse).toEqual({ order: 3, by: ["profile"], extendedBy: [] });
  });

  it("5. removed by the workspace", async () => {
    const { forgeRoot, wsRoot } = await at(3, ado(), { config: { profile: "acme", recipes: { remove: ["pm-azure-devops"] } } });
    const w = await loadWorkspace(wsRoot);
    const l = listRecipes(w.forge, catalogueContext(w.forge, { kind: "workspace", config: w.config }));
    expect(entry(l, "pm-azure-devops").inUse).toBeNull();
    expect(entry(l, "pm-azure-devops").removedByWorkspace).toBe(true);
  });

  it("6. listed and selected: by holds profile once", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        { meta: { type: "rule", name: "workflow" }, files: { "rule.md": "# Workflow\n" } },
        { meta: { type: "rule", name: "where" }, files: { "rule.md": "Org {{integrations.pm.org}}\n" } },
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", [], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base", "pm-azure-devops"], ["claude-code"], { integrations: PM })],
    };
    const { forgeRoot } = await at(3, spec);
    const l = await forProfile(forgeRoot, "acme");
    expect(entry(l, "pm-azure-devops").inUse!.by).toEqual(["profile"]);
  });

  it("7. another profile's malformed block does not fail the catalogue", async () => {
    const { forgeRoot } = await at(3, ado({ profiles: [GLOBEX_BAD] }));
    const l = await forProfile(forgeRoot, "acme");
    expect(l.warnings).toEqual([WALK]);
    expect(entry(l, "base").profiles).toEqual(["acme", "globex"]);
    expect(entry(l, "pm-azure-devops").inUse!.by).toEqual(["profile"]);
  });

  it("8. with the malformed profile in context the warning appears once", async () => {
    const { forgeRoot } = await at(3, ado({ profiles: [GLOBEX_BAD] }));
    const l = await forProfile(forgeRoot, "globex");
    expect(l.warnings).toEqual([
      "cannot resolve profile globex: profile globex: integrations.pm is not a mapping — nothing is marked as in use",
    ]);
    expect(l.context).toBeNull();
    for (const e of l.recipes) expect(e.inUse).toBeNull();
  });

  it("9. with no context the walk's warning is given", async () => {
    const { forgeRoot } = await at(3, ado({ profiles: [GLOBEX_BAD] }));
    const l = await forProfile(forgeRoot, null);
    expect(l.warnings).toEqual([WALK]);
  });

  it("10. (control) the same malformed block at schema 2 warns nothing", async () => {
    const { forgeRoot } = await at(2, ado({ profiles: [GLOBEX_BAD] }));
    const l = await forProfile(forgeRoot, "globex");
    expect(l.warnings).toEqual([]);
    expect(l.context!.recipes).toEqual(["base"]);
  });

  it("11. recipes --json keeps its shape", async () => {
    const { forgeRoot } = await at(3, ado());
    const r = runCli(["recipes", "--forge", forgeRoot, "--profile", "acme", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["forge", "context", "recipes", "warnings"]);
    for (const rec of j.recipes) expect(Object.keys(rec)).toEqual(KEYS);
    expect(j.recipes.find((r: { name: string }) => r.name === "pm-azure-devops").inUse).toEqual({
      order: 2,
      by: ["profile"],
      extendedBy: [],
    });
  });

  it("20. the walk's warning is left out by profile name, not by text", async () => {
    // A profile name with a colon tests that the filter is by exact profile name, not by text prefix.
    const { forgeRoot } = await at(3, ado({ profiles: [profile("acme:x", ["base"], ["claude-code"], { integrations: { pm: "x" } })] }));
    const l = await forProfile(forgeRoot, "acme");
    expect(l.warnings).toEqual(["profile acme:x: integrations.pm is not a mapping — its recipes are read as written"]);
  });
});

describe("Recipe commands", () => {
  it("12. add of a selected recipe changes nothing", async () => {
    const { forgeRoot } = await at(3, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    expect(planRecipeEdit(forge, config(), "add", ["pm-azure-devops"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: ["pm-azure-devops is already in use"],
    });
  });

  it("13. remove writes recipes.remove", async () => {
    const { forgeRoot } = await at(3, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    expect(planRecipeEdit(forge, config(), "remove", ["pm-azure-devops"])).toEqual({
      recipes: { add: [], remove: ["pm-azure-devops"] },
      changed: true,
      reasons: [],
    });
  });

  it("14. add --replace on the same slot swaps; the block's params stay", async () => {
    const { forgeRoot } = await at(3, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    const e = planRecipeEdit(forge, config(), "add", ["pm-github"], { replace: true });
    expect(e.recipes).toEqual({ add: ["pm-github"], remove: ["pm-azure-devops"] });
    const r = resolve(forge, config({ recipes: e.recipes }));
    expect(r.recipes).toEqual(["base", "pm-github"]);
    expect(r.params["integrations.pm.kind"]).toBe("azure-devops");
    expect(r.params["integrations.pm.org"]).toBe("acme");
  });

  it("15. without --replace the slot is held by the integration recipe", async () => {
    const { forgeRoot } = await at(3, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    expect(() => planRecipeEdit(forge, config(), "add", ["pm-github"])).toThrow(
      'recipe "pm-github" occupies slot "pm", held by "pm-azure-devops" — pass --replace to swap them',
    );
  });

  it("16. re-adding after a remove cleans the list", async () => {
    const { forgeRoot } = await at(3, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    const e = planRecipeEdit(forge, config({ recipes: { remove: ["pm-azure-devops"] } }), "add", ["pm-azure-devops"]);
    expect(e.recipes).toEqual({ add: [], remove: [] });
    expect(e.changed).toBe(true);
  });

  it("17. (control) at schema 2 add adds it", async () => {
    const { forgeRoot } = await at(2, ado({ recipes: [recipe("pm-github", [], { slot: "pm" })] }));
    const forge = await loadForge(forgeRoot);
    expect(planRecipeEdit(forge, config(), "add", ["pm-azure-devops"]).recipes).toEqual({
      add: ["pm-azure-devops"],
      remove: [],
    });
  });

  it("18. a malformed block is the resolution's error", async () => {
    const spec: ForgeSpec = {
      ingredients: [{ meta: { type: "rule", name: "workflow" }, files: { "rule.md": "# Workflow\n" } }],
      recipes: [recipe("base", ["rule/workflow"]), recipe("pm-github", [], { slot: "pm" })],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: "x" } })],
    };
    const { forgeRoot } = await at(3, spec);
    const forge = await loadForge(forgeRoot);
    expect(() => planRecipeEdit(forge, config(), "add", ["pm-github"])).toThrow(
      "profile acme: integrations.pm is not a mapping",
    );
  });

  it("19. the three stdout lines are spec 22's", async () => {
    const { forgeRoot, wsRoot } = await at(3, ado());
    await sync(wsRoot);

    // Read initial bytes
    const initialBytes = await fs.readFile(path.join(wsRoot, "craftar.yaml"));

    // add recipe that's already in use
    const r1 = runCli(["add", "recipe", "pm-azure-devops", "--workspace", wsRoot]);
    expect([r1.code, r1.stdout, r1.stderr]).toEqual([0, "nothing to change: pm-azure-devops is already in use\n", ""]);
    // craftar.yaml unchanged
    expect(await fs.readFile(path.join(wsRoot, "craftar.yaml"))).toEqual(initialBytes);

    // remove recipe
    const r2 = runCli(["remove", "recipe", "pm-azure-devops", "--workspace", wsRoot]);
    expect([r2.code, r2.stderr]).toEqual([0, ""]);
    expect(r2.stdout).toBe("craftar.yaml: recipes.remove + pm-azure-devops\nrecipes: base\nnext sync: 4 orphan — run `craftar sync`\n");
    const yamlContent = await fs.readFile(path.join(wsRoot, "craftar.yaml"), "utf8");
    expect(yamlContent.endsWith("recipes:\n  remove:\n    - pm-azure-devops\n")).toBe(true);
  });
});
