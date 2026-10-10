import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, ADO_MCP_JSON, forgeAt, mcp, PM, snapshot, states, STORIES, STORIES_ACME, sync } from "./helpers/integrations.js";

// Spec 33 §9.6 — importing a workspace synced through an integration leaves the Forge byte for byte.

const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}
const importBack = (s: { wsRoot: string; forgeRoot: string }, profileName = "acme") => importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName });
/** Import, and the Forge files whose bytes moved (added, removed or changed), sorted. */
async function moved(s: { wsRoot: string; forgeRoot: string }, profileName = "acme") {
  const before = await snapshot(s.forgeRoot);
  const r = await importBack(s, profileName);
  const after = await snapshot(s.forgeRoot);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  return { r, changed };
}
const refusal = async (s: { wsRoot: string; forgeRoot: string }) => {
  const before = await snapshot(s.forgeRoot);
  const message = await importBack(s).then(() => "no error", (e: Error) => e.message);
  return { message, untouched: JSON.stringify(await snapshot(s.forgeRoot)) === JSON.stringify(before) };
};
const LEFT = [{ recipe: "pm-azure-devops", slot: "pm", refs: ["rule/stories-azure-devops", "mcp/azure-devops"] }];
const paramsOnly = (block: Record<string, unknown>, profileExtra: Record<string, unknown> = {}): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), rule("where", "Org {{integrations.pm.org}}\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/where"])],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: block, ...profileExtra })],
});

describe("import — the effective params", () => {
  it("1. a body citing an integration param is reused as rendered", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(r.reused).toEqual(["rule/where", "rule/workflow"]);
    expect(r.rendered).toEqual([{ name: "rule/where", keys: ["integrations.pm.org"] }]);
    expect(r.params).toEqual([]);
    expect(r.profileWrite.action).toBe("unchanged");
  });

  it("2. (control) the same at schema 2 with the value in params", async () => {
    const s = await synced(2, paramsOnly({ pm: { org: "acme" } }, { params: { "integrations.pm.org": "acme" } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(r.reused).toEqual(["rule/where", "rule/workflow"]);
    expect(r.rendered).toEqual([{ name: "rule/where", keys: ["integrations.pm.org"] }]);
    expect(r.params).toEqual([]);
    expect(r.profileWrite.action).toBe("unchanged");
  });

  it("3. I3 names the block", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    await writeFiles(s.wsRoot, { ".claude/rules/new.md": "Literal {{integrations.pm.org}}\n" });
    expect(await refusal(s)).toEqual({
      message: "import: .claude/rules/new.md holds {{integrations.pm.org}} literally, but profile acme's integrations set integrations.pm.org — sync would render it\nThe Forge was left untouched.",
      untouched: true,
    });
  });

  it("4. I3 keeps today's wording when params set the key", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "x" } }, { params: { "integrations.pm.org": "acme" } }));
    await writeFiles(s.wsRoot, { ".claude/rules/new.md": "Literal {{integrations.pm.org}}\n" });
    expect((await refusal(s)).message).toBe(
      "import: .claude/rules/new.md holds {{integrations.pm.org}} literally, but profile acme sets integrations.pm.org — sync would render it\nThe Forge was left untouched.",
    );
  });

  it("5. a malformed block fails the import, the Forge untouched", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    // Overwrite the profile in the Forge with a malformed block
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: "x" };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect(await refusal(s)).toEqual({
      message: "import: profile acme does not resolve (profile acme: integrations.pm is not a mapping) — fix the Forge and re-run\nThe Forge was left untouched.",
      untouched: true,
    });
  });

  it("6. (control) the same malformed block at schema 2 imports", async () => {
    const s = await synced(2, paramsOnly({ pm: { org: "acme" } }));
    // Overwrite the profile in the Forge with a malformed block
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: "x" };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect((await refusal(s)).message).toBe("no error");
  });

  it("7. a new profile gets no integrations.* param and integrations: {}", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    const r = await importBack(s, "globex");
    const profileYaml = path.join(s.forgeRoot, "profiles/globex/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    expect(profileData.integrations).toEqual({});
    expect(Object.keys(profileData.params ?? {}).filter((k: string) => k.startsWith("integrations."))).toEqual([]);
    // The rule has "Org acme\n" from the workspace, but "globex" has no value for integrations.pm.org
    // so it becomes a variant, and no integrations.* param is inferred.
    expect(r.variants).toEqual([{ name: "rule/where--globex", reason: "differs from rule/where already in the Forge" }]);
    expect(r.params).toEqual([]);
  });
});

describe("import — the round trip", () => {
  it("8. untouched: the Forge is byte-identical and the report names what was left", async () => {
    const s = await synced(3, ado());
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual(LEFT);
    expect(r.reused).toEqual(["rule/where", "rule/workflow"]);
    expect([r.created, r.variants, r.rejected, r.recipeSplits]).toEqual([[], [], [], []]);
    expect(r.recipes).toEqual(["base"]);
    expect(r.profileWrite).toEqual({ path: "profiles/acme/profile.yaml", action: "unchanged", fields: [] });
    expect(r.manifestWrite).toBe("unchanged");
    expect(Object.values(await states(s.wsRoot)).every((s) => s === "unchanged")).toBe(true);
  });

  it("9. the CLI prints the line, and the counts line does not count it", async () => {
    const s = await synced(3, ado());
    const cli = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot]);
    expect(cli.code).toBe(0);
    expect(cli.stdout.split("\n")).toContain("  left to recipe pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops — not compared; when this workspace resolves that recipe, craftar status shows whether its copies differ");
    expect(cli.stdout.split("\n")).toContain("  0 created, 2 reused, 0 variants, 0 rejected");
    expect(cli.stdout.split("\n").find((l) => l.startsWith("  variant"))).toBeUndefined();
    expect(cli.stdout.split("\n").find((l) => l.startsWith("  rejected"))).toBeUndefined();
  });

  it("10. the integration recipe extends another that holds the rule", async () => {
    const spec = ado({
      recipes: [
        recipe("pm-common", ["rule/stories-azure-devops"]),
        { ...recipe("pm-azure-devops", ["mcp/azure-devops"], { slot: "pm" }), extends: ["pm-common"] },
      ],
    });
    // Remove the rule from pm-azure-devops since it's now in pm-common
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      { name: "pm-azure-devops", extends: ["pm-common"], ingredients: ["mcp/azure-devops"], slot: "pm" },
    ]);
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([
      { recipe: "pm-common", slot: "pm", refs: ["rule/stories-azure-devops"] },
      { recipe: "pm-azure-devops", slot: "pm", refs: ["mcp/azure-devops"] },
    ]);
  });

  it("11. a scoped rule and the agent attached to it, both provided", async () => {
    const spec = ado({
      ingredients: [
        { meta: { type: "rule", name: "api-standards", inclusion: "fileMatch", fileMatchPattern: "**/*.cs" }, files: { "rule.md": "# API\n" } },
        { meta: { type: "agent", name: "api-reviewer", description: "Reviews against .claude/rules/api-standards.md", tools: ["Read"] }, files: { "agent.md": "Review the API.\n" } },
      ],
      recipes: [
        { ...recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops", "rule/api-standards", "agent/api-reviewer"], { slot: "pm" }) },
      ],
    });
    // Override the pm-azure-devops recipe to include the agent
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops", "rule/api-standards", "agent/api-reviewer"], { slot: "pm" }),
    ]);
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.recipes).toEqual(["base"]);
    expect(r.leftToRecipes[0].refs).toEqual(["rule/api-standards", "rule/stories-azure-devops", "agent/api-reviewer", "mcp/azure-devops"]);
  });

  it("12. a steering ingredient", async () => {
    const spec = ado({
      ingredients: [{ meta: { type: "steering", name: "product" }, files: { "steering.md": "# Product\n" } }],
      recipes: [recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops", "steering/product"], { slot: "pm" })],
    });
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops", "steering/product"], { slot: "pm" }),
    ]);
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.recipes).toEqual(["base"]);
    // Print once, then pin: steering/product is last
    expect(r.leftToRecipes[0].refs).toEqual(["rule/stories-azure-devops", "mcp/azure-devops", "steering/product"]);
  });

  it("13. an as: ingredient with no directory under its output name", async () => {
    const spec = ado();
    // Replace the rule with an as: version
    spec.ingredients = spec.ingredients!.filter((i) => i.meta.name !== "stories-azure-devops").concat([
      rule("stories-azure-devops", STORIES, { as: "stories" }),
    ]);
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(await exists(path.join(s.forgeRoot, "ingredients/rules/stories"))).toBe(false);
    expect(r.leftToRecipes).toEqual(LEFT);
  });

  it("14. an integration recipe that defaults a param its rule cites", async () => {
    const spec = ado();
    // Add params to the recipe
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      { ...recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }), params: { greeting: { default: "Hi" } } },
    ]);
    // Update the rule to cite the param
    spec.ingredients = spec.ingredients!.filter((i) => i.meta.name !== "stories-azure-devops").concat([
      rule("stories-azure-devops", "{{greeting}} " + STORIES),
    ]);
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("15. the agents-md target", async () => {
    const spec = ado();
    spec.profiles = [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], { integrations: PM })];
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect((await states(s.wsRoot))["AGENTS.md"]).toBe("unchanged");
  });
});

describe("import — what the workspace did to its copies", () => {
  it("16. the rule edited in the organisation only, and the server edited", async () => {
    const s = await synced(3, ado());
    await writeFiles(s.wsRoot, {
      ".claude/rules/stories-azure-devops.md": STORIES_ACME.replace("organisation acme", "organisation other"),
      ".mcp.json": ADO_MCP_JSON.replace("ado-mcp", "ado-mcp@2"),
    });
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual(LEFT);
    expect(r.variants).toEqual([]);
    const st = await states(s.wsRoot);
    expect(st[".claude/rules/stories-azure-devops.md"]).toBe("drift");
    expect(st[".mcp.json"]).toBe("drift");
  });

  it("17. the rule deleted", async () => {
    const s = await synced(3, ado());
    await fs.rm(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([{ recipe: "pm-azure-devops", slot: "pm", refs: ["mcp/azure-devops"] }]);
    expect((await states(s.wsRoot))[".claude/rules/stories-azure-devops.md"]).toBe("new");
  });

  it("18. a foreign workspace holding a differing rule of the same name", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    // No sync — write the workspace files by hand
    await writeFiles(s.wsRoot, {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".claude/rules/where.md": "Org acme\n",
      ".claude/rules/stories-azure-devops.md": "mine\n",
    });
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([{ recipe: "pm-azure-devops", slot: "pm", refs: ["rule/stories-azure-devops"] }]);
    const st = await states(s.wsRoot);
    expect(st[".claude/rules/stories-azure-devops.md"]).toBe("collision");
    expect(st[".claude/rules/workflow.md"]).toBe("adopt");
  });

  it("19. recipes.remove of the integration recipe plus an own file of that name", async () => {
    const s = await synced(3, ado(), { config: { profile: "acme", recipes: { remove: ["pm-azure-devops"] } } });
    await writeFiles(s.wsRoot, { ".claude/rules/stories-azure-devops.md": "mine\n" });
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([{ recipe: "pm-azure-devops", slot: "pm", refs: ["rule/stories-azure-devops"] }]);
    expect((await states(s.wsRoot))[".claude/rules/stories-azure-devops.md"]).toBeUndefined();
  });

  it("20. the skipped rule's steering file, banner removed", async () => {
    const s = await synced(3, ado());
    await writeFiles(s.wsRoot, { ".kiro/steering/stories-azure-devops.md": "plain\n" });
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(await exists(path.join(s.forgeRoot, "ingredients/steerings/stories-azure-devops"))).toBe(false);
  });

  it("21. a token pasted into a skipped server", async () => {
    const s = await synced(3, ado());
    // Paste the token into the skipped server only
    const mcpJson = JSON.parse(await fs.readFile(path.join(s.wsRoot, ".mcp.json"), "utf8"));
    mcpJson.mcpServers["azure-devops"].args = ["-y", "ado-mcp", TOKEN];
    await fs.writeFile(path.join(s.wsRoot, ".mcp.json"), JSON.stringify(mcpJson, null, 2));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // Control: the same paste into a server base lists is rejected.
    const spec2 = ado({ ingredients: [mcp("local", { command: "x" })] });
    spec2.recipes = spec2.recipes!.filter((r) => r.name !== "base").concat([recipe("base", ["rule/workflow", "rule/where", "mcp/local"])]);
    const s2 = await synced(3, spec2);
    cleanups.push(s2.cleanup);
    const mcpJson2 = JSON.parse(await fs.readFile(path.join(s2.wsRoot, ".mcp.json"), "utf8"));
    mcpJson2.mcpServers.local.args = [TOKEN];
    await fs.writeFile(path.join(s2.wsRoot, ".mcp.json"), JSON.stringify(mcpJson2, null, 2));
    const { r: r2 } = await moved(s2);
    expect(r2.rejected.map((x) => x.name)).toEqual(["mcp/local"]);
  });

  it("22. a profile new to the Forge: nothing skipped", async () => {
    const s = await synced(3, ado());
    const { r } = await moved(s, "globex");
    expect(r.leftToRecipes).toEqual([]);
    expect(r.reused).toContain("mcp/azure-devops");
  });
});

describe("import — what the block does not provide alone", () => {
  it("23. listed in base and in the integration recipe: imported as today", async () => {
    // Put stories-azure-devops in both base and pm-azure-devops
    const spec = ado();
    spec.recipes = spec.recipes!.filter((r) => r.name !== "base").concat([
      recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),
    ]);
    const s = await synced(3, spec);
    // Untouched
    let { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([{ recipe: "pm-azure-devops", slot: "pm", refs: ["mcp/azure-devops"] }]);
    expect(r.reused).toContain("rule/stories-azure-devops");
    // Edited
    await writeFiles(s.wsRoot, { ".claude/rules/stories-azure-devops.md": STORIES_ACME.replace("organisation acme", "organisation other") });
    ({ r, changed } = await moved(s));
    expect(r.variants.map((v) => v.name)).toEqual(["rule/stories-azure-devops--acme"]);
    const p = await plan(await loadWorkspace(s.wsRoot));
    // Print once, then pin: the warning format from the actual output.
    expect(p.warnings).toEqual([
      "two ingredients write .claude/rules/stories-azure-devops.md: rule/stories-azure-devops--acme and rule/stories-azure-devops (last wins)",
      "two ingredients write .kiro/steering/stories-azure-devops.md: rule/stories-azure-devops--acme and rule/stories-azure-devops (last wins)",
    ]);
    // Import again on that result: byte-identical
    ({ r, changed } = await moved(s));
    expect(changed).toEqual([]);
  });

  it("24. an integration recipe with extends: [base]", async () => {
    const spec = ado();
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      { ...recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }), extends: ["base"] },
    ]);
    const s = await synced(3, spec);
    await writeFiles(s.wsRoot, { ".claude/rules/workflow.md": "# Workflow 2\n" });
    const { r } = await moved(s);
    expect(r.variants.map((v) => v.name)).toEqual(["rule/workflow--acme"]);
    expect(r.leftToRecipes).toEqual(LEFT);
  });

  it("25. a provided scoped rule whose agent stays in a recipe import owns", async () => {
    // The scoped rule api-standards in pm-azure-devops; the agent in stack-api-standards the profile lists
    // The agent needs frontmatterRaw to match what claude-code emits
    const agentFrontmatter = "name: api-reviewer\ndescription: Reviews against .claude/rules/api-standards.md\ntools: Read";
    const spec = ado({
      ingredients: [
        { meta: { type: "rule", name: "api-standards", inclusion: "fileMatch", fileMatchPattern: "**/*.cs" }, files: { "rule.md": "# API\n" } },
        { meta: { type: "agent", name: "api-reviewer", description: "Reviews against .claude/rules/api-standards.md", tools: ["Read"], frontmatterRaw: agentFrontmatter }, files: { "agent.md": "Review the API.\n" } },
      ],
      recipes: [
        recipe("stack-api-standards", ["agent/api-reviewer"]),
      ],
    });
    spec.recipes = spec.recipes!.filter((r) => r.name !== "pm-azure-devops").concat([
      recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops", "rule/api-standards"], { slot: "pm" }),
    ]);
    spec.profiles = [profile("acme", ["base", "stack-api-standards"], ["claude-code", "kiro"], { integrations: PM })];
    const s = await synced(3, spec);
    const { r, changed } = await moved(s);
    // Print once, then pin
    expect(r.recipes).toEqual(["base--acme"]);
    expect(r.recipeSplits).toEqual([{ shared: "base", owned: "base--acme", reason: "this workspace has agent/api-reviewer, which base lacks" }]);
    expect(r.variants).toEqual([]);
    expect(changed).toEqual(["profiles/acme/profile.yaml", "recipes/base--acme.yaml"]);
    // Claims that must hold:
    expect(r.recipes.find((n) => n === "stack-api-standards")).toBeUndefined();
    const baseRecipe = r.recipes.find((n) => n.startsWith("base"));
    expect(baseRecipe).toBeDefined();
    expect(r.leftToRecipes[0].refs[0]).toBe("rule/api-standards");
  });
});

describe("import — the profile must resolve", () => {
  it("26. the kind has no recipe", async () => {
    const s = await synced(3, ado());
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: { kind: "jira", org: "acme" } };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect(await refusal(s)).toEqual({
      message: 'import: profile acme does not resolve (recipe "pm-jira" not found (referenced by integrations.pm of profile acme)) — fix the Forge and re-run\nThe Forge was left untouched.',
      untouched: true,
    });
  });

  it("27. an unknown recipe in recipes while the block selects one", async () => {
    const s = await synced(3, ado());
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.recipes = ["base", "nope"];
    profileData.integrations = PM;
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    const r = await refusal(s);
    expect(r.message).toBe('import: profile acme does not resolve (recipe "nope" not found (referenced by profile acme)) — fix the Forge and re-run\nThe Forge was left untouched.');
    expect(r.untouched).toBe(true);
  });

  it("28. (control) an unknown recipe in recipes, a well-formed block with no kind: imports as today", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.recipes = ["base", "nope"];
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect((await refusal(s)).message).toBe("no error");
  });

  it("29. (control) schema 2, a full block whose kind has no recipe: imports as today", async () => {
    const spec = ado();
    spec.profiles = [profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], {
      integrations: { pm: { kind: "azure-devops", org: "acme", project: "Platform" } },
      params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" },
    })];
    const s = await synced(2, spec);
    // Change the block to a kind that has no recipe
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: { kind: "jira", org: "acme" } };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect((await refusal(s)).message).toBe("no error");
  });
});

describe("import — below the gate", () => {
  it("30. (control — print once at BASE, then pin) schema 2, the recipe listed by hand: today's output", async () => {
    const spec = ado({}, PM, {
      recipes: ["base", "pm-azure-devops"],
      params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" },
    });
    const s = await synced(2, spec);
    const { r, changed } = await moved(s);
    expect(r.leftToRecipes).toEqual([]);
    expect(r.recipes).toEqual(["base--acme"]);
    expect(r.recipeSplits).toEqual([{ shared: "base", owned: "base--acme", reason: "this workspace has rule/stories-azure-devops, which base lacks" }]);
    expect(r.profileWrite).toEqual({ path: "profiles/acme/profile.yaml", action: "edited", fields: ["recipes"] });
    expect(changed).toEqual(["profiles/acme/profile.yaml", "recipes/base--acme.yaml"]);
  });
});
