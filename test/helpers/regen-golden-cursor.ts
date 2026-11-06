/**
 * Regenerates test/golden/acme-cursor/ — the cursor emitter scenario of spec 61 §3.3:
 * rules, an agent, an MCP server, a command and a skill (commands and skills reach Cursor through agent-skills).
 * A characterization snapshot: run it only after an intended change to what the cursor emitter writes.
 * Usage: npx tsx test/helpers/regen-golden-cursor.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../golden/acme-cursor");

/**
 * The cursor golden scenario: tests 1-6 from cursor-emitter.test.ts.
 */
async function acmeCursor(): Promise<ReturnType<typeof scenario>> {
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
      meta: { type: "agent", name: "helper", description: "Helps", model: "sonnet", tools: ["Read", "Bash"] },
      files: { "agent.md": "Help.\n" },
    },
    // Test 5: MCP with env references (including Cursor predefined variable)
    {
      meta: {
        type: "mcp",
        name: "api",
        server: { command: "npx", args: ["api", "${workspaceFolder}/x"], env: { TOKEN: "${API_TOKEN}", MODE: "${MODE:-dev}" } },
      },
    },
    // Test 6: command and skill (both aimed at cursor but unsupported)
    {
      meta: { type: "command", name: "review", description: "Review code" },
      files: { "command.md": "Review.\n" },
    },
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
    "mcp/api",
    "command/review",
    "skill/docs",
  ];

  const recipes = [recipe("base", baseIngredients)];
  const profiles = [profile("acme", ["base"], ["cursor"])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Set schema to 15 for cursor target
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

  return s;
}

process.env.CRAFTAR_HOME ??= await fs.mkdtemp(path.join(os.tmpdir(), "craftar-home-"));
const s = await acmeCursor();
try {
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  await fs.rm(GOLDEN, { recursive: true, force: true });
  for (const f of p.files) {
    await fs.mkdir(path.dirname(path.join(GOLDEN, f.path)), { recursive: true });
    await fs.copyFile(path.join(s.wsRoot, f.path), path.join(GOLDEN, f.path));
  }
  console.log(`regenerated test/golden/acme-cursor (${p.files.length} files)`);
  for (const w of p.warnings) console.log(`warn ${w}`);
} finally {
  await s.cleanup();
}
