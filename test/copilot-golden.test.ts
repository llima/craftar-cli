/**
 * Golden test for the copilot emitter (spec 61 §3.4, §5.2): the acme-copilot scenario synced at schema 15,
 * byte for byte. Regenerated only with test/helpers/regen-golden-copilot.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./helpers/forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/acme-copilot");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Builds the same scenario as regen-golden-copilot.ts.
 */
async function acmeCopilot(): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    // Tests 1 (always-on rules joined into .github/copilot-instructions.md)
    {
      meta: { type: "rule", name: "style", inclusion: "always" },
      files: { "rule.md": "Use tabs.\n" },
    },
    {
      meta: { type: "rule", name: "tone", inclusion: "always" },
      files: { "rule.md": "Be brief.\n\n" },
    },
    // Test 2 (scoped rule with applyTo)
    {
      meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts", "test/**"] },
      files: { "rule.md": "API.\n" },
    },
    // Test 3 (manual rule - skipped with warning)
    {
      meta: { type: "rule", name: "release", inclusion: "manual" },
      files: { "rule.md": "Release.\n" },
    },
    // Test 4 (agent with tools mapped to aliases)
    {
      meta: { type: "agent", name: "helper", description: "Helps", model: "sonnet", tools: ["Read", "Grep", "Bash", "Unknown"] },
      files: { "agent.md": "Help.\n" },
    },
    // Test 5 (command with description, argument-hint, agent: agent)
    {
      meta: { type: "command", name: "review", description: "Review", argumentHint: "[file]" },
      files: { "command.md": "Review it.\n" },
    },
    // Test 6 (MCP servers kept whole with ${NAME} -> ${env:NAME})
    {
      meta: {
        type: "mcp",
        name: "api",
        server: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${API_TOKEN}" } },
      },
    },
    {
      meta: {
        type: "mcp",
        name: "remote",
        server: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${KEY}" } },
      },
    },
    // Test 7 (skill - unsupported)
    {
      meta: { type: "skill", name: "docs", layout: "dir" },
      files: { "SKILL.md": "Docs.\n" },
    },
  ];

  const baseIngredients = [
    "rule/style",
    "rule/tone",
    "rule/api",
    "rule/release",
    "agent/helper",
    "command/review",
    "mcp/api",
    "mcp/remote",
    "skill/docs",
  ];

  const recipes = [recipe("base", baseIngredients)];
  const profiles = [profile("acme", ["base"], ["copilot"])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Set schema to 15 for copilot target
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

  return s;
}

async function synced(): Promise<{ s: Scenario; paths: string[]; p: Awaited<ReturnType<typeof plan>> }> {
  const s = kept(await acmeCopilot());
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return { s, paths: p.files.map((f) => f.path).sort(), p };
}

describe("golden — acme-copilot (spec 61 §3.4)", () => {
  it("a sync writes exactly the golden files, byte for byte", async () => {
    const { s, paths } = await synced();
    expect(paths).toEqual((await listFiles(GOLDEN)).sort());
    for (const rel of paths) {
      expect((await fs.readFile(path.join(s.wsRoot, rel))).equals(await fs.readFile(path.join(GOLDEN, rel))), rel).toBe(true);
    }
  });

  it("the file list matches", async () => {
    const { paths } = await synced();
    expect(paths).toEqual([
      ".github/agents/helper.agent.md",
      ".github/copilot-instructions.md",
      ".github/instructions/api.instructions.md",
      ".github/prompts/review.prompt.md",
      ".vscode/mcp.json",
    ]);
  });

  it("plan has the expected warnings", async () => {
    const { p } = await synced();
    expect(p.warnings).toContain("copilot: 1 skill ingredient(s) have no Copilot equivalent — skipped: skill/docs");
    expect(p.warnings).toContain("copilot: rule rule/release (manual) has no Copilot equivalent — skipped");
    expect(p.warnings).toContain('copilot: agent "helper": tool "Unknown" has no Copilot alias; dropped');
  });
});
