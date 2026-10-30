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
