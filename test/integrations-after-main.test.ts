import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { ado, forgeAt, mcp, PM, snapshot, sync, STORIES } from "./helpers/integrations.js";

// Task R1 Part C — three measurements on 0.23.0, pinned

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ForgeSpec, ws: { config: { profile: string } } = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}

/** Forge files whose bytes moved (added, removed or changed), sorted. */
async function moved(forgeRoot: string, before: Record<string, string>): Promise<string[]> {
  const after = await snapshot(forgeRoot);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
}

function gitInit(dir: string) {
  execSync("git init -q && git add -A && git commit -q -m init", { cwd: dir, encoding: "utf8" });
}

describe("--prefer-kiro on a rule the block provides", () => {
  // C1. `synced(3, ado())` (33f case 8's workspace). Run import with --prefer-kiro on the rule the block provides.
  // Expected: code 0; no Forge byte moved; stdout holds the `left to recipe` line and NO `prefer-kiro` line.
  it("C1. --prefer-kiro on a rule the block provides — untouched workspace", async () => {
    const s = await synced(3, ado());
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "stories-azure-devops"]);
    const forgeFiles = await moved(s.forgeRoot, before);

    console.log("--- C1 output ---");
    console.log("code:", r.code);
    console.log("stdout:", r.stdout);
    console.log("stderr:", r.stderr);
    console.log("Forge files moved:", forgeFiles);

    expect(r.code).toBe(0);
    expect(forgeFiles).toEqual([]);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops");
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro"))).toBe(false);
  });

  // C2. Same but with the steering file edited by hand.
  // Expected: same as C1, or a refusal.
  it("C2. --prefer-kiro on a rule the block provides — steering edited by hand", async () => {
    const s = await synced(3, ado());
    await fs.appendFile(path.join(s.wsRoot, ".kiro/steering/stories-azure-devops.md"), "by hand\n");
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "stories-azure-devops"]);
    const forgeFiles = await moved(s.forgeRoot, before);

    console.log("--- C2 output ---");
    console.log("code:", r.code);
    console.log("stdout:", r.stdout);
    console.log("stderr:", r.stderr);
    console.log("Forge files moved:", forgeFiles);

    // The test expects code 0 and no Forge byte moved (the rule is left to its recipe, so nothing is read).
    // If it refuses, that is FINDING C2.
    expect(r.code).toBe(0);
    expect(forgeFiles).toEqual([]);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops");
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro"))).toBe(false);
  });

  // C3. (control) --prefer-kiro on a rule `base` lists.
  // Expected: code 0, a prefer-kiro line, and the left to recipe line still printed.
  it("C3. (control) --prefer-kiro on a rule base lists", async () => {
    const s = await synced(3, ado());
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "workflow"]);

    console.log("--- C3 output ---");
    console.log("code:", r.code);
    console.log("stdout:", r.stdout);
    console.log("stderr:", r.stderr);

    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro rule/workflow"))).toBe(true);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm):");
  });
});

describe("drift promote with two profiles selecting the same integration recipe", () => {
  // C4. Two profiles select the same integration recipe; one promotes a rule listed in `base` and in that recipe.
  it("C4. two profiles select the same integration recipe — promote a dual-listed rule", async () => {
    // Forge at schema 3: 33f case 23's Forge
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [
        profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM }),
        profile("globex", ["base"], ["claude-code", "kiro"], { integrations: PM }),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);
    
    // Hand-edit the rule
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    const content = await fs.readFile(rulePath, "utf8");
    await fs.writeFile(rulePath, content.replace("organisation acme", "organisation other"));

    // First: --dry-run --json
    const r1 = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    console.log("--- C4 dry-run output ---");
    console.log("code:", r1.code);
    console.log("stdout:", r1.stdout);
    console.log("stderr:", r1.stderr);

    // Then: without --dry-run
    const r2 = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--json"], { env });
    console.log("--- C4 actual promote output ---");
    console.log("code:", r2.code);
    console.log("stdout:", r2.stdout);
    console.log("stderr:", r2.stderr);

    // Check status afterwards
    const r3 = runCli(["status", "--workspace", s.wsRoot, "--json"], { env });
    console.log("--- C4 status after promote ---");
    console.log("code:", r3.code);
    console.log("stdout (states):", r3.code === 0 ? JSON.parse(r3.stdout).statuses?.map((s: { path: string; state: string }) => `${s.path}: ${s.state}`) : r3.stdout);
    console.log("stderr:", r3.stderr);

    // Check git status of the Forge
    const gitStatus = execSync("git status --porcelain", { cwd: s.forgeRoot, encoding: "utf8" });
    console.log("--- C4 forge git status ---");
    console.log(gitStatus);

    // Read the profile file
    const acmeProfile = await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), "utf8");
    console.log("--- C4 profiles/acme/profile.yaml ---");
    console.log(acmeProfile);

    // Read recipes
    const recipesDir = path.join(s.forgeRoot, "recipes");
    const recipeFiles = await fs.readdir(recipesDir);
    for (const f of recipeFiles.sort()) {
      console.log(`--- C4 recipes/${f} ---`);
      console.log(await fs.readFile(path.join(recipesDir, f), "utf8"));
    }

    // Check globex recipes before and after (for comparison)
    const recipesBefore = runCli(["recipes", "--forge", s.forgeRoot, "--profile", "globex", "--json"], { env });
    console.log("--- C4 globex recipes --json ---");
    console.log(recipesBefore.stdout);

    // The claims:
    // 1. After a promote that exits 0, craftar status for the acme workspace exits 0
    //    (the profile still RESOLVES — no `both occupy slot` error, no unknown recipe)
    // 2. A second profile's resolution is unchanged (globex's context.recipes before and after).
    //
    // If promote REFUSES, pin the refusal whole.
    // FINDING C4: The promote is refused NOT because of integrations.pm, but because the recipe chain
    // reaches the rule through pm-azure-devops (an integration recipe two profiles share) and promote
    // does not fork shared recipe chains. This is D17 — recipe pm-azure-devops reaches this workspace
    // through pm-azure-devops.
    expect(r2.code).toBe(1);
    expect(r2.stdout).toBe("");
    expect(r2.stderr).toBe("error: recipe pm-azure-devops reaches this workspace through pm-azure-devops — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand\n");
    // The Forge is untouched:
    expect(gitStatus).toBe("");
  });
});
