/**
 * Golden test for the cursor emitter (spec 61 §3.3, §5.2): the acme-cursor scenario synced at schema 15,
 * byte for byte. Regenerated only with test/helpers/regen-golden-cursor.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./helpers/forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/acme-cursor");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Builds the same scenario as regen-golden-cursor.ts.
 */
async function acmeCursor(): Promise<Scenario> {
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
    // Test 5: MCP with env references
    {
      meta: {
        type: "mcp",
        name: "api",
        server: { command: "npx", args: ["api"], env: { TOKEN: "${API_TOKEN}", MODE: "${MODE:-dev}" } },
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

async function synced(): Promise<{ s: Scenario; paths: string[]; p: Awaited<ReturnType<typeof plan>> }> {
  const s = kept(await acmeCursor());
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return { s, paths: p.files.map((f) => f.path).sort(), p };
}

describe("golden — acme-cursor (spec 61 §3.3)", () => {
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
      ".cursor/agents/helper.md",
      ".cursor/mcp.json",
      ".cursor/rules/api.mdc",
      ".cursor/rules/release.mdc",
      ".cursor/rules/style.mdc",
    ]);
  });

  it("plan has the expected warnings", async () => {
    const { p } = await synced();
    expect(p.warnings).toContain("cursor: 1 command ingredient(s) have no Cursor equivalent — skipped: command/review");
    expect(p.warnings).toContain("cursor: 1 skill ingredient(s) have no Cursor equivalent — skipped: skill/docs");
    expect(p.warnings).toContain('cursor: agent "helper": tools have no Cursor field; dropped');
  });
});
