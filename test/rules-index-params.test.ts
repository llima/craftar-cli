import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { acmeIndex } from "./helpers/rules-index.js";
import { loadWorkspace, plan, declaredWithoutValue } from "../src/core/sync.js";
import { paramsFor } from "../src/core/resolve.js";
import { RULES_INDEX_KEY } from "../src/core/rules-index.js";
import { runCli } from "./helpers/cli.js";
import { explainFile } from "../src/core/report.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

type Scenario = Awaited<ReturnType<typeof acmeIndex>>;

/**
 * Spec 44 §4.1 last bullet, §4.2: the key `craftar.rules.index` is generated at schema 7; below it,
 * a literal in the body is warned; at the gate, a value set in any layer is ignored.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

describe("rules-index params (spec 44 §4)", () => {
  /**
   * Test 1: Below the gate (schema: 6, literal: true)
   * - plan().warnings holds exactly one line for the literal warning
   * - The line lists refs sorted: "agent/helper (agent.md), rule/readme (rule.md)"
   * - Planned bytes for readme/helper bodies hold the literal verbatim
   * - doctor --strict --json exits 1, the line is a plan warn
   */
  it("1. below the gate: a Forge with the literal on a line warns once, naming every ref (file) sorted", async () => {
    const s = kept(await acmeIndex({ schema: 6, literal: true }));
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // One warning line about the placeholder needing schema 7
    const literalWarning = p.warnings.find((w) => w.includes(RULES_INDEX_KEY) && w.includes("needs a Forge at schema: 7"));
    expect(literalWarning).toBeDefined();
    expect(literalWarning).toBe(
      `{{${RULES_INDEX_KEY}}} needs a Forge at schema: 7 — left as written in agent/helper (agent.md), rule/readme (rule.md)`
    );

    // Count: exactly one such warning
    const literalWarnings = p.warnings.filter((w) => w.includes(RULES_INDEX_KEY) && w.includes("needs a Forge at schema: 7"));
    expect(literalWarnings.length).toBe(1);

    // Planned bodies hold the literal verbatim
    // The readme rule is in .kiro/steering/readme.md (for kiro) and also in .claude/rules/readme.md (for claude-code)
    const kiroReadme = p.files.find((f) => f.path === ".kiro/steering/readme.md");
    expect(kiroReadme).toBeDefined();
    expect(kiroReadme!.content.toString("utf8")).toContain(`{{${RULES_INDEX_KEY}}}`);

    const claudeReadme = p.files.find((f) => f.path === ".claude/rules/readme.md");
    expect(claudeReadme).toBeDefined();
    expect(claudeReadme!.content.toString("utf8")).toContain(`{{${RULES_INDEX_KEY}}}`);

    // The agent helper body - for kiro it's a JSON file with a "prompt" field
    const kiroHelper = p.files.find((f) => f.path === ".kiro/agents/helper.json");
    expect(kiroHelper).toBeDefined();
    const kiroHelperJson = JSON.parse(kiroHelper!.content.toString("utf8"));
    expect(kiroHelperJson.prompt).toContain(`{{${RULES_INDEX_KEY}}}`);

    // For claude-code it's a markdown file
    const claudeHelper = p.files.find((f) => f.path === ".claude/agents/helper.md");
    expect(claudeHelper).toBeDefined();
    expect(claudeHelper!.content.toString("utf8")).toContain(`{{${RULES_INDEX_KEY}}}`);

    // doctor --strict --json exits 1 with the plan warn
    const W = ["--workspace", s.wsRoot];
    const doctorResult = runCli(["doctor", "--strict", "--json", ...W]);
    expect(doctorResult.code).toBe(1);
    const doctorJson = JSON.parse(doctorResult.stdout);
    const planWarns = (doctorJson.checks as Array<{ id: string; scope: string; level: string; message: string }>)
      .filter((c) => c.id === "plan" && c.level === "warn");
    expect(planWarns.some((c) => c.message.includes(RULES_INDEX_KEY) && c.message.includes("needs a Forge at schema: 7"))).toBe(true);
  });

  /**
   * Test 2: Below the gate, a Forge without the literal → no such warning
   * (covered by the pin test, but assert here too)
   */
  it("2. below the gate without the literal: no warning", async () => {
    const s = kept(await acmeIndex({ schema: 6, literal: false }));
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const literalWarnings = p.warnings.filter((w) => w.includes(RULES_INDEX_KEY) && w.includes("needs a Forge at schema: 7"));
    expect(literalWarnings.length).toBe(0);
  });

  /**
   * Test 3: At the gate, a value for craftar.rules.index in various layers is ignored with a warning
   * - Profile's params: "the value in profile acme is ignored"
   * - Recipe default: "the value in recipe <name> is ignored"
   * - Workspace overrides.params: "the value in workspace is ignored"
   * - Ingredient's own params default: "the value in rule/readme is ignored"
   * The value text never appears in any warning.
   */
  it("3a. at the gate, a value in the profile is warned as ignored", async () => {
    const s = kept(await acmeIndex({ schema: 7 }));
    // Add the key to the profile's params
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileYaml = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileYaml.params = { ...profileYaml.params, [RULES_INDEX_KEY]: "zz-not-shown" };
    await fs.writeFile(profilePath, YAML.stringify(profileYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const ignoredWarning = p.warnings.find((w) => w.includes(RULES_INDEX_KEY) && w.includes("is generated by sync") && w.includes("profile acme is ignored"));
    expect(ignoredWarning).toBeDefined();
    expect(ignoredWarning).toBe(`${RULES_INDEX_KEY} is generated by sync — the value in profile acme is ignored`);
    // The value text must not appear
    expect(p.warnings.every((w) => !w.includes("zz-not-shown"))).toBe(true);
  });

  it("3b. at the gate, a value in a recipe default is warned as ignored", async () => {
    const s = kept(await acmeIndex({ schema: 7 }));
    // Add the key to a recipe's params
    const recipePath = path.join(s.forgeRoot, "recipes/base.yaml");
    const recipeYaml = YAML.parse(await fs.readFile(recipePath, "utf8"));
    recipeYaml.params = { ...recipeYaml.params, [RULES_INDEX_KEY]: { default: "zz-not-shown" } };
    await fs.writeFile(recipePath, YAML.stringify(recipeYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const ignoredWarning = p.warnings.find((w) => w.includes(RULES_INDEX_KEY) && w.includes("is generated by sync") && w.includes("recipe base is ignored"));
    expect(ignoredWarning).toBeDefined();
    expect(ignoredWarning).toBe(`${RULES_INDEX_KEY} is generated by sync — the value in recipe base is ignored`);
    expect(p.warnings.every((w) => !w.includes("zz-not-shown"))).toBe(true);
  });

  it("3c. at the gate, a value in workspace overrides.params is warned as ignored", async () => {
    const s = kept(await acmeIndex({ schema: 7 }));
    // Add the key to craftar.yaml's overrides.params
    const wsYamlPath = path.join(s.wsRoot, "craftar.yaml");
    const wsYaml = YAML.parse(await fs.readFile(wsYamlPath, "utf8"));
    wsYaml.overrides = { ...wsYaml.overrides, params: { [RULES_INDEX_KEY]: "zz-not-shown" } };
    await fs.writeFile(wsYamlPath, YAML.stringify(wsYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const ignoredWarning = p.warnings.find((w) => w.includes(RULES_INDEX_KEY) && w.includes("is generated by sync") && w.includes("workspace is ignored"));
    expect(ignoredWarning).toBeDefined();
    expect(ignoredWarning).toBe(`${RULES_INDEX_KEY} is generated by sync — the value in workspace is ignored`);
    expect(p.warnings.every((w) => !w.includes("zz-not-shown"))).toBe(true);
  });

  it("3d. at the gate, a value in an ingredient's own params default is warned as ignored", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    // Add the key to rule/readme's ingredient.yaml params with a default
    const ingPath = path.join(s.forgeRoot, "ingredients/rules/readme/ingredient.yaml");
    const ingYaml = YAML.parse(await fs.readFile(ingPath, "utf8"));
    ingYaml.params = { ...ingYaml.params, [RULES_INDEX_KEY]: { default: "zz-not-shown" } };
    await fs.writeFile(ingPath, YAML.stringify(ingYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const ignoredWarning = p.warnings.find((w) => w.includes(RULES_INDEX_KEY) && w.includes("is generated by sync") && w.includes("rule/readme is ignored"));
    expect(ignoredWarning).toBeDefined();
    expect(ignoredWarning).toBe(`${RULES_INDEX_KEY} is generated by sync — the value in rule/readme is ignored`);
    expect(p.warnings.every((w) => !w.includes("zz-not-shown"))).toBe(true);
  });

  /**
   * Test 4: At the gate, paramsFor(ing, resolution) has no own key craftar.rules.index whatever the layers hold
   */
  it("4. at the gate, paramsFor omits the key regardless of layer values", async () => {
    const s = kept(await acmeIndex({ schema: 7 }));
    // Add the key to profile, recipe, workspace, and an ingredient's params
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileYaml = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileYaml.params = { ...profileYaml.params, [RULES_INDEX_KEY]: "from-profile" };
    await fs.writeFile(profilePath, YAML.stringify(profileYaml));

    const recipePath = path.join(s.forgeRoot, "recipes/base.yaml");
    const recipeYaml = YAML.parse(await fs.readFile(recipePath, "utf8"));
    recipeYaml.params = { ...recipeYaml.params, [RULES_INDEX_KEY]: { default: "from-recipe" } };
    await fs.writeFile(recipePath, YAML.stringify(recipeYaml));

    const wsYamlPath = path.join(s.wsRoot, "craftar.yaml");
    const wsYaml = YAML.parse(await fs.readFile(wsYamlPath, "utf8"));
    wsYaml.overrides = { ...wsYaml.overrides, params: { [RULES_INDEX_KEY]: "from-workspace" } };
    await fs.writeFile(wsYamlPath, YAML.stringify(wsYaml));

    const ingPath = path.join(s.forgeRoot, "ingredients/rules/readme/ingredient.yaml");
    const ingYaml = YAML.parse(await fs.readFile(ingPath, "utf8"));
    ingYaml.params = { ...ingYaml.params, [RULES_INDEX_KEY]: { default: "from-ingredient" } };
    await fs.writeFile(ingPath, YAML.stringify(ingYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    for (const ing of p.resolution.ingredients) {
      const params = paramsFor(ing, p.resolution);
      expect(Object.hasOwn(params, RULES_INDEX_KEY)).toBe(false);
    }
  });

  /**
   * Test 5: At the gate, an ingredient declaring craftar.rules.index with no default:
   * - declaredWithoutValue(plan) has no entry for it
   * - unsetDeclared(plan) is empty
   * - doctor reports no params finding for it
   * With a default: the same (it's ignored, not cited).
   */
  it("5a. at the gate, declaring the key without a default: not in declaredWithoutValue, doctor has no params finding", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    // Add the key to an ingredient's params WITHOUT a default
    const ingPath = path.join(s.forgeRoot, "ingredients/rules/readme/ingredient.yaml");
    const ingYaml = YAML.parse(await fs.readFile(ingPath, "utf8"));
    ingYaml.params = { ...ingYaml.params, [RULES_INDEX_KEY]: { description: "The rules index" } };
    await fs.writeFile(ingPath, YAML.stringify(ingYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // declaredWithoutValue should NOT have an entry for the key
    const dwv = declaredWithoutValue(p);
    expect(dwv.has(RULES_INDEX_KEY)).toBe(false);

    // doctor --strict --json: no params finding for the key
    const W = ["--workspace", s.wsRoot];
    const doctorResult = runCli(["doctor", "--strict", "--json", ...W]);
    const doctorJson = JSON.parse(doctorResult.stdout);
    const paramsFindings = (doctorJson.checks as Array<{ id: string; message: string }>)
      .filter((c) => c.id === "params" && c.message.includes(RULES_INDEX_KEY));
    expect(paramsFindings.length).toBe(0);
  });

  it("5b. at the gate, declaring the key with a default: not in declaredWithoutValue, doctor has no params finding", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    // Add the key to an ingredient's params WITH a default
    const ingPath = path.join(s.forgeRoot, "ingredients/rules/readme/ingredient.yaml");
    const ingYaml = YAML.parse(await fs.readFile(ingPath, "utf8"));
    ingYaml.params = { ...ingYaml.params, [RULES_INDEX_KEY]: { default: "ignored-value" } };
    await fs.writeFile(ingPath, YAML.stringify(ingYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // declaredWithoutValue should NOT have an entry for the key
    const dwv = declaredWithoutValue(p);
    expect(dwv.has(RULES_INDEX_KEY)).toBe(false);

    // doctor --strict --json: no params finding for the key
    const W = ["--workspace", s.wsRoot];
    const doctorResult = runCli(["doctor", "--strict", "--json", ...W]);
    const doctorJson = JSON.parse(doctorResult.stdout);
    const paramsFindings = (doctorJson.checks as Array<{ id: string; message: string }>)
      .filter((c) => c.id === "params" && c.message.includes(RULES_INDEX_KEY));
    expect(paramsFindings.length).toBe(0);
  });

  /**
   * Test 6: At the gate, Plan.missingParams holds no entry for the key, and explainFile().params does not list it
   */
  it("6. at the gate, missingParams has no entry for the key, and explainFile().params does not list it", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // missingParams should NOT have an entry for the key
    expect(p.missingParams.find((mp) => mp.key === RULES_INDEX_KEY)).toBeUndefined();

    // explainFile for a file that would cite it (the readme rule)
    const explained = explainFile(ws, p, ".kiro/steering/readme.md");
    expect(explained).not.toBeNull();
    expect(explained!.params.find((param) => param.key === RULES_INDEX_KEY)).toBeUndefined();
  });

  /**
   * Test 7: At schema 4+ and the gate, an MCP server citing {{craftar.rules.index}} declared by its ingredient:
   * - The planned .mcp.json keeps the literal
   * - No missingParams entry
   * - The sync is not refused
   */
  it("7. at the gate, an MCP server citing the key keeps the literal in .mcp.json and does not refuse", async () => {
    // Build a custom scenario with an MCP ingredient that cites the key
    const mcpIngredient: IngredientSpec = {
      meta: {
        type: "mcp",
        name: "test-mcp",
        server: {
          command: "echo",
          args: ["{{craftar.rules.index}}"],
        },
        params: { [RULES_INDEX_KEY]: { description: "The rules index" } },
      },
    };
    const s = kept(await scenario(
      {
        ingredients: [mcpIngredient],
        recipes: [recipe("base", ["mcp/test-mcp"])],
        profiles: [profile("test", ["base"], ["claude-code"])],
      },
      { config: { profile: "test" } }
    ));
    // Set schema to 7
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 7 }),
    );

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // The .mcp.json should keep the literal
    const mcpFile = p.files.find((f) => f.path === ".mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpContent = JSON.parse(mcpFile!.content.toString("utf8"));
    expect(mcpContent.mcpServers["test-mcp"].args).toContain(`{{${RULES_INDEX_KEY}}}`);

    // No missingParams entry for the key
    expect(p.missingParams.find((mp) => mp.key === RULES_INDEX_KEY)).toBeUndefined();

    // The sync is not refused (no unset declared params)
    const W = ["--workspace", s.wsRoot];
    const syncResult = runCli(["sync", ...W]);
    expect(syncResult.code).toBe(0);
  });

  /**
   * Test 8: Below the gate, a value for the key is an ordinary param: substituted, no warning (as on 0.37.1)
   */
  it("8. below the gate, a value for the key is substituted as an ordinary param", async () => {
    const s = kept(await acmeIndex({ schema: 6, literal: true }));
    // Set a value in profile params
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileYaml = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileYaml.params = { ...profileYaml.params, [RULES_INDEX_KEY]: "substituted-value" };
    await fs.writeFile(profilePath, YAML.stringify(profileYaml));

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // No "is generated by sync" warning (that's an at-the-gate warning)
    const ignoredWarnings = p.warnings.filter((w) => w.includes("is generated by sync"));
    expect(ignoredWarnings.length).toBe(0);

    // No "needs a Forge at schema: 7" warning (because the value is provided)
    const literalWarnings = p.warnings.filter((w) => w.includes("needs a Forge at schema: 7"));
    expect(literalWarnings.length).toBe(0);

    // The value IS substituted into the bodies
    const kiroReadme = p.files.find((f) => f.path === ".kiro/steering/readme.md");
    expect(kiroReadme).toBeDefined();
    expect(kiroReadme!.content.toString("utf8")).toContain("substituted-value");
    expect(kiroReadme!.content.toString("utf8")).not.toContain(`{{${RULES_INDEX_KEY}}}`);
  });
});
