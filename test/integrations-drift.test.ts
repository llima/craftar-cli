import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCli } from "./helpers/cli.js";
import { driftList } from "../src/core/drift.js";
import type { FileStatus } from "../src/core/sync.js";
import { hashNormalized } from "../src/core/text.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, forgeAt, mcp, PM, snapshot, states, sync, STORIES } from "./helpers/integrations.js";

// Spec 33 step 33i: drift × the integrations block.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Git environment variables for predictable commits. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

/** Initialize a git repo with one commit. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

/** Git porcelain output for the Forge. */
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

describe("promote renders with the effective profile's params", () => {
  it("1. a rule citing an integration param, hand-edited elsewhere, is compared as rendered", async () => {
    // Build the spec by hand: forgeAt(3, ado()) with rule("where", "Org {{integrations.pm.org}}\nline two\n") in place of the helper's where
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\nline two\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    // Sync the workspace
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    
    // Edit the file elsewhere (not in the org line)
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/where.md"), "Org acme\nline two, by hand\n");
    
    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    
    // The JSON output (pinned after commit 1)
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    
    // After commit 1, the outcome is variant. The base was rendered with the effective params,
    // so the comparison is: "Org acme\nline two\n" vs "Org acme\nline two, by hand\n".
    // The difference is in line 2, not in the param, so it's a variant.
    // The flattened params show what the base cited.
    expect(j.outcome).toBe("variant");
    expect(j.promoted).toBe("rule/where--acme");
    expect(j.flattened.params).toEqual(["integrations.pm.org"]);
    
    // The key assertions: written files include the variant
    expect(j.written).toEqual([
      { path: "ingredients/rules/where--acme/ingredient.yaml", action: "created" },
      { path: "ingredients/rules/where--acme/rule.md", action: "created" },
      { path: "recipes/base.yaml", action: "edited" },
    ]);
  });

  it("control: the same Forge at schema 2 with the recipe listed by hand and the two keys in params", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\nline two\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], { params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } })],
    };
    const s = await forgeAt(2, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    // Sync the workspace
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    
    // Edit the file elsewhere (not in the org line)
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/where.md"), "Org acme\nline two, by hand\n");
    
    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    
    // The JSON is the same before and after commit 1 for schema 2
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.promoted).toBe("rule/where--acme");
    expect(j.flattened.params).toEqual(["integrations.pm.org"]);
  });
});
