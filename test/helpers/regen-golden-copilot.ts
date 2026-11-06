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
  // Test 1: always-on rule with description
  {
    meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
    files: { "rule.md": "Use tabs.\n" },
  },
  // Test 2: scoped rule (fileMatch) with multiple patterns
  {
    meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts", "test/**"] },
    files: { "rule.md": "API.\n" },
  },
  // Test 3: manual rule (no description)
  {
    meta: { type: "rule", name: "release", inclusion: "manual" },
    files: { "rule.md": "Release.\n" },
  },
  // Test 4: agent with tools
  {
    meta: { type: "agent", name: "helper", description: "Helps", tools: ["Read", "Bash"] },
    files: { "agent.md": "Help.\n" },
  },
  // Test 5: command with description
  {
    meta: { type: "command", name: "review", description: "Review code" },
    files: { "command.md": "Review.\n" },
  },
  // Test 5b: command without description
  {
    meta: { type: "command", name: "build" },
    files: { "command.md": "Build.\n" },
  },
  // Test 6: MCP with env references
  {
    meta: {
      type: "mcp",
      name: "api",
      server: { command: "npx", args: ["api", "--port", "8080"], env: { TOKEN: "${API_TOKEN}" } },
    },
  },
  // Test 7: skill (unsupported)
  {
    meta: { type: "skill", name: "docs", layout: "dir" },
    files: { "SKILL.md": "Docs.\n" },
  },
];

const baseIngredients = [
  "rule/style",
  "rule/api",
  "rule/release",
  "agent/helper",
  "command/review",
  "command/build",
  "mcp/api",
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
