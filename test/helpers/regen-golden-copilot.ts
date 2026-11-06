/**
 * Regenerate test/golden/acme-copilot from the ingredients.
 * Run with: npx tsx test/helpers/regen-golden-copilot.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../golden/acme-copilot");

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

async function main() {
  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Set schema to 15 for copilot target
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});

  // Clean golden directory
  await fs.rm(GOLDEN, { recursive: true, force: true });
  await fs.mkdir(GOLDEN, { recursive: true });

  // Copy written files to golden
  for (const f of p.files) {
    const dest = path.join(GOLDEN, f.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(s.wsRoot, f.path), dest);
  }

  console.log(`Written ${p.files.length} files to ${GOLDEN}`);
  console.log("Warnings:", p.warnings);
  await s.cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
