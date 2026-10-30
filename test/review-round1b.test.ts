/**
 * Review round 1b tests — findings 5 and 6 from node-cli-reviewer round r1.
 * Each test is committed alone FIRST (shown failing), then the fix is committed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { tmpDir, writeFiles } from "./helpers/forge.js";
import { importClaudeCode } from "../src/importers/claude-code.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("Finding 5: Resolve once; word the failure through errorText", () => {
  it("import with broken profile: error contains 'does not resolve' exactly once and no raw zod '[' or '\"code\"'", async () => {
    // A broken profile (missing recipe) + base holding the placeholder.
    // The error should contain "does not resolve" exactly once (not multiple resolve attempts).
    // The error should NOT contain raw zod issue markers like "[" at start or "code":
    const root = await tmpDir("craftar-import-resolve-once-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    await fs.mkdir(forgeRoot, { recursive: true });
    await fs.mkdir(wsRoot, { recursive: true });

    // Forge at schema 7 with rule/readme holding the placeholder
    // Profile references a recipe that doesn't exist (broken profile)
    await writeFiles(forgeRoot, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 7 }),
      "ingredients/rules/readme/ingredient.yaml": YAML.stringify({
        type: "rule",
        name: "readme",
        description: "Index",
        file: "rule.md",
        targets: "*",
        tags: [],
      }),
      "ingredients/rules/readme/rule.md": "{{craftar.rules.index}}\n",
      "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/readme"] }),
      // Profile references a nonexistent recipe
      "profiles/broken/profile.yaml": YAML.stringify({
        name: "broken",
        description: "Broken profile",
        recipes: ["base", "nonexistent"],
        targets: ["claude-code"],
      }),
    });

    // Workspace with the .claude/rules file
    await fs.mkdir(path.join(wsRoot, ".claude", "rules"), { recursive: true });
    await writeFiles(wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: forgeRoot, profile: "broken" }),
      ".claude/rules/readme.md": "# Rules\n\nAlways on:\n- `.claude/rules/readme.md` — Index\n",
    });

    // Should fail with exactly ONE "does not resolve" in the message
    let caught: Error | null = null;
    try {
      await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "broken",
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    const msg = caught!.message;

    // "does not resolve" should appear exactly once
    const resolveCount = (msg.match(/does not resolve/g) ?? []).length;
    expect(resolveCount).toBe(1);

    // Should NOT contain raw zod issue markers
    expect(msg).not.toMatch(/^\s*\[/); // no leading "[" (array of issues)
    expect(msg).not.toContain('"code"'); // no raw zod "code" field
  });
});

// After the fix: `grep -c "resolveForImport(" src/importers/claude-code.ts` must be 2


import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

describe("Finding 6: The misplaced placeholder line is the planned file's", () => {
  it("rule readme body 'See {{craftar.rules.index}} here' — warning lists .kiro/steering/readme.md:<n> for CRLF planned line", async () => {
    // A rule `readme` whose body is `# Rules\n\nSee {{craftar.rules.index}} here\n`
    // targets claude-code + kiro + agents-md at schema 7
    // The warning should report .kiro/steering/readme.md:<n> where <n> is the 1-based line
    // of "See {{" in the PLANNED kiro content (with banner + frontmatter).
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "readme", description: "Index", targets: "*" },
        files: { "rule.md": "# Rules\n\nSee {{craftar.rules.index}} here\n" },
      },
    ];
    const s = kept(await scenario(
      { ingredients, recipes: [recipe("base", ["rule/readme"])], profiles: [profile("test", ["base"], ["claude-code", "kiro", "agents-md"])] },
      { config: { profile: "test" } }
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 7 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Find the planned kiro file content
    const kiroFile = p.files.find((f) => f.path === ".kiro/steering/readme.md");
    expect(kiroFile).toBeDefined();
    const kiroContent = kiroFile!.content.toString("utf8");

    // Find the line number (1-based) in the planned CRLF content that holds "See {{"
    const kiroLines = kiroContent.replace(/\r\n/g, "\n").split("\n");
    const misplacedLineIndex = kiroLines.findIndex((line) => line.includes("See {{craftar.rules.index}}"));
    expect(misplacedLineIndex).toBeGreaterThanOrEqual(0);
    const expectedKiroLine = misplacedLineIndex + 1;

    // Find the warning
    const warning = p.warnings.find((w) => w.includes("must stand alone on its line"));
    expect(warning).toBeDefined();

    // The warning should contain .kiro/steering/readme.md:<expectedKiroLine>
    expect(warning).toContain(`.kiro/steering/readme.md:${expectedKiroLine}`);

    // Also check AGENTS.md
    const agentsMdFile = p.files.find((f) => f.path === "AGENTS.md");
    expect(agentsMdFile).toBeDefined();
    const agentsMdContent = agentsMdFile!.content.toString("utf8");

    const agentsMdLines = agentsMdContent.replace(/\r\n/g, "\n").split("\n");
    const misplacedAgentsMdLineIndex = agentsMdLines.findIndex((line) => line.includes("See {{craftar.rules.index}}"));
    expect(misplacedAgentsMdLineIndex).toBeGreaterThanOrEqual(0);
    const expectedAgentsMdLine = misplacedAgentsMdLineIndex + 1;

    expect(warning).toContain(`AGENTS.md:${expectedAgentsMdLine}`);

    // Also check .claude/rules/readme.md
    const ccFile = p.files.find((f) => f.path === ".claude/rules/readme.md");
    expect(ccFile).toBeDefined();
    const ccContent = ccFile!.content.toString("utf8");

    const ccLines = ccContent.replace(/\r\n/g, "\n").split("\n");
    const misplacedCcLineIndex = ccLines.findIndex((line) => line.includes("See {{craftar.rules.index}}"));
    expect(misplacedCcLineIndex).toBeGreaterThanOrEqual(0);
    const expectedCcLine = misplacedCcLineIndex + 1;

    expect(warning).toContain(`.claude/rules/readme.md:${expectedCcLine}`);
  });
});
