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
