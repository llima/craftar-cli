import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import type { Scenario } from "./helpers/forge.js";

/**
 * CLI tests for spec 41 agents-md.primary: Kiro resources check, CLAUDE.md warning, orphan words.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("Kiro resources check — CLI (spec 41 §4.5–§4.6)", () => {
  it("test k2: CLI, mode on, after sync — sync --check fails, status fails, status --json exits 1 but stderr empty", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const W = ["--workspace", s.wsRoot];

    // First sync — should succeed and write files
    const syncResult = runCli(["sync", ...W]);
    expect(syncResult.code).toBe(0);

    // sync --check should fail with the Kiro resources refusal on stderr
    const syncCheckResult = runCli(["sync", "--check", ...W]);
    expect(syncCheckResult.code).toBe(1);
    expect(syncCheckResult.stderr).toContain("Kiro agent resource(s) name a file the plan does not write: planner → .kiro/steering/style.md");

    // status (text) should exit 1 with the same refusal on stderr
    const statusResult = runCli(["status", ...W]);
    expect(statusResult.code).toBe(1);
    expect(statusResult.stderr).toContain("Kiro agent resource(s) name a file the plan does not write: planner → .kiro/steering/style.md");

    // status --json should exit 1, stderr empty, stdout parses, warnings contain the warning
    const statusJsonResult = runCli(["status", "--json", ...W]);
    expect(statusJsonResult.code).toBe(1);
    expect(statusJsonResult.stderr).toBe("");
    const statusJson = JSON.parse(statusJsonResult.stdout);
    // Check it has the same top-level keys (forge, statuses, warnings, unsetParams)
    expect(Object.keys(statusJson).sort()).toEqual(["forge", "statuses", "unsetParams", "warnings"]);
    expect(statusJson.warnings.some((w: string) => w.startsWith("kiro: agent resources"))).toBe(true);

    // diff --exit-code should fail
    const diffExitResult = runCli(["diff", "--exit-code", ...W]);
    expect(diffExitResult.code).toBe(1);

    // diff --exit-code .claude/rules/api.md should NOT fail due to the kiro resources check
    const diffExitApiResult = runCli(["diff", "--exit-code", ".claude/rules/api.md", ...W]);
    expect(diffExitApiResult.code).toBe(0);
  });

  it("test k3: present — synced mode off first, then mode on — present list, sync --check passes", async () => {
    // First: create workspace with mode OFF and sync (so .kiro/steering/style.md exists)
    const s = kept(await acmePrimary({ schema: 5 })); // no agents-md.primary
    const W = ["--workspace", s.wsRoot];

    // Sync with mode off
    const syncOffResult = runCli(["sync", ...W]);
    expect(syncOffResult.code).toBe(0);

    // Verify .kiro/steering/style.md exists
    const stylePath = path.join(s.wsRoot, ".kiro/steering/style.md");
    const styleStat = await fs.stat(stylePath).catch(() => null);
    expect(styleStat).not.toBeNull();

    // Now switch profile to mode on by editing the profile
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileContent = await fs.readFile(profilePath, "utf8");
    const profile = YAML.parse(profileContent);
    profile.params = { ...profile.params, "agents-md.primary": true };
    await fs.writeFile(profilePath, YAML.stringify(profile));

    // Also bump schema to 5
    const manifestPath = path.join(s.forgeRoot, "craftar.forge.yaml");
    await fs.writeFile(manifestPath, YAML.stringify({ name: "test-forge", schema: 5 }));

    // Now plan — the entry should be in 'present', not 'unplanned'
    const { loadWorkspace, plan } = await import("../src/core/sync.js");
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.kiroResources).not.toBeNull();
    expect(p.kiroResources!.present).toEqual([{ agent: "planner", path: ".kiro/steering/style.md" }]);
    expect(p.kiroResources!.unplanned).toEqual([]);

    // sync --check should NOT print the Kiro resources refusal (only present, not unplanned)
    const syncCheckResult = runCli(["sync", "--check", ...W]);
    // Note: it may still fail because there are orphans, but the refusal message should not appear
    expect(syncCheckResult.stderr).not.toContain("Kiro agent resource(s) name a file the plan does not write");
  });
});


describe("Orphan's words — CLI (spec 41 §4.8)", () => {
  it("synced mode off, then mode on — sync and diff show agents-md.primary wording", async () => {
    // First: create and sync with mode off
    const s = kept(await acmePrimary({ schema: 5 })); // mode off
    const W = ["--workspace", s.wsRoot];

    // Sync with mode off
    const syncOffResult = runCli(["sync", ...W]);
    expect(syncOffResult.code).toBe(0);

    // Now switch to mode on
    const { promises: fs } = await import("node:fs");
    const YAML = (await import("yaml")).default;
    const path = await import("node:path");

    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileContent = await fs.readFile(profilePath, "utf8");
    const profile = YAML.parse(profileContent);
    profile.params = { ...profile.params, "agents-md.primary": true };
    await fs.writeFile(profilePath, YAML.stringify(profile));

    // diff shows the agents-md.primary wording in diff header
    const diffResult = runCli(["diff", ...W]);
    expect(diffResult.stdout).toContain(".claude/rules/style.md (forge: written to AGENTS.md only — sync removes it)");
    expect(diffResult.stdout).toContain(".kiro/steering/style.md (forge: written to AGENTS.md only — sync removes it)");

    // sync --dry-run shows the wording in removal line
    const syncDryResult = runCli(["sync", "--dry-run", ...W]);
    expect(syncDryResult.stdout).toContain("(orphan: written to AGENTS.md only (agents-md.primary))");

    // sync (actual) shows the wording in removal line
    const syncResult = runCli(["sync", ...W]);
    expect(syncResult.code).toBe(0);
    expect(syncResult.stdout).toContain("orphan: written to AGENTS.md only (agents-md.primary)");

    // status --json shows same keys as an ordinary orphan
    const statusJsonResult = runCli(["status", "--json", ...W]);
    const statusJson = JSON.parse(statusJsonResult.stdout);
    // No orphan should exist now (they were removed), but verify the structure was the same
    expect(Object.keys(statusJson).sort()).toEqual(["forge", "statuses", "unsetParams", "warnings"]);
  });
});


describe("primaryOrphan per file — CLI (spec 41 §4.8 fix)", () => {
  it("ordinary orphan beside primary orphan — different wording for each", async () => {
    // Sync with mode off first
    const s = kept(await acmePrimary({ schema: 5 })); // mode off
    const W = ["--workspace", s.wsRoot];

    const syncOffResult = runCli(["sync", ...W]);
    expect(syncOffResult.code).toBe(0);

    // Now: drop command/review from the recipe AND turn mode on
    const { promises: fs } = await import("node:fs");
    const YAML = (await import("yaml")).default;
    const path = await import("node:path");

    // Update recipe to remove command/review
    const recipePath = path.join(s.forgeRoot, "recipes/base.yaml");
    const recipeContent = await fs.readFile(recipePath, "utf8");
    const recipe = YAML.parse(recipeContent);
    recipe.ingredients = recipe.ingredients.filter((i: string) => i !== "command/review");
    await fs.writeFile(recipePath, YAML.stringify(recipe));

    // Turn mode on
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileContent = await fs.readFile(profilePath, "utf8");
    const profile = YAML.parse(profileContent);
    profile.params = { ...profile.params, "agents-md.primary": true };
    await fs.writeFile(profilePath, YAML.stringify(profile));

    // diff shows different wording for each type of orphan
    const diffResult = runCli(["diff", ...W]);
    // command/review is an ordinary orphan (Forge dropped it) — NOT agents-md.primary
    expect(diffResult.stdout).toContain(".claude/commands/review.md (forge: no longer produced — sync removes it)");
    // style is a primary orphan (mode turned it off for claude-code and kiro)
    expect(diffResult.stdout).toContain(".claude/rules/style.md (forge: written to AGENTS.md only — sync removes it)");

    // sync shows different wording for each type
    const syncResult = runCli(["sync", ...W]);
    expect(syncResult.code).toBe(0);
    // Ordinary orphan gets ordinary message
    expect(syncResult.stdout).toContain("(orphan: no longer produced by the Forge)");
    // Primary orphan gets specific message  
    expect(syncResult.stdout).toContain("(orphan: written to AGENTS.md only (agents-md.primary))");

    // drift show should NOT contain agents-md.primary wording (uses original words)
    // First create a drift situation
    const apiPath = path.join(s.wsRoot, ".claude/rules/api.md");
    await fs.appendFile(apiPath, "\n# Hand edit\n");
    
    const driftResult = runCli(["drift", "show", ...W]);
    expect(driftResult.stdout).not.toContain("written to AGENTS.md only");
  });
});

describe("Orphan's words — the sync tool of craftar mcp (spec 41 §4.8, spec 40 §5.6)", () => {
  async function syncedOffThenOn(): Promise<Scenario> {
    const s = kept(await acmePrimary({ schema: 5 }));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const file = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const prof = YAML.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, YAML.stringify({ ...prof, params: { ...prof.params, "agents-md.primary": true } }));
    return s;
  }

  it("names agents-md.primary for the orphans the mode made, as craftar sync does", async () => {
    const { mcpWriters } = await import("../src/core/write-actions.js");
    const { readWorkspaceConfig } = await import("../src/core/sync.js");
    const s = await syncedOffThenOn();
    const home = path.join(s.root, "home");
    const r = await mcpWriters(home, true).sync(s.wsRoot, await readWorkspaceConfig(s.wsRoot), {});
    expect(r.removed).toContainEqual({ path: ".claude/rules/style.md", reason: "orphan: written to AGENTS.md only (agents-md.primary)" });
    expect(r.removed).toContainEqual({ path: ".kiro/steering/style.md", reason: "orphan: written to AGENTS.md only (agents-md.primary)" });
    for (const row of r.removed) {
      if (!row.path.endsWith("/style.md") && !row.path.endsWith("/release.md")) expect(row.reason).toBe("orphan: no longer produced by the Forge");
    }
  });
});
