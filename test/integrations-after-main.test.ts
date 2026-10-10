import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { ado, forgeAt, mcp, PM, snapshot, sync, STORIES } from "./helpers/integrations.js";

// Task R1 Part C — three measurements on 0.23.0, pinned

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ForgeSpec, ws: { config: { profile: string } } = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}

/** Forge files whose bytes moved (added, removed or changed), sorted. */
async function moved(forgeRoot: string, before: Record<string, string>): Promise<string[]> {
  const after = await snapshot(forgeRoot);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
}

function gitInit(dir: string) {
  execSync("git init -q && git add -A && git commit -q -m init", { cwd: dir, encoding: "utf8" });
}

describe("--prefer-kiro on a rule the block provides", () => {
  // C1. `synced(3, ado())` (33f case 8's workspace). Run import with --prefer-kiro on the rule the block provides.
  // Expected: code 0; no Forge byte moved; stdout holds the `left to recipe` line and NO `prefer-kiro` line;
  // a warning about the --prefer-kiro rule being left to its recipe.
  it("C1. --prefer-kiro on a rule the block provides — untouched workspace", async () => {
    const s = await synced(3, ado());
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "stories-azure-devops"]);
    const forgeFiles = await moved(s.forgeRoot, before);

    expect(r.code).toBe(0);
    expect(forgeFiles).toEqual([]);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops");
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro"))).toBe(false);
    // The warning about --prefer-kiro on a rule left to its recipe (printed to stdout with other warnings).
    expect(r.stdout).toContain("warn --prefer-kiro stories-azure-devops: left to recipe pm-azure-devops (integrations.pm) — not read");
  });

  // C2. Same but with the steering file edited by hand.
  // Expected: same as C1 — the rule is left to its recipe, so the steering file is not read regardless of edits.
  it("C2. --prefer-kiro on a rule the block provides — steering edited by hand", async () => {
    const s = await synced(3, ado());
    await fs.appendFile(path.join(s.wsRoot, ".kiro/steering/stories-azure-devops.md"), "by hand\n");
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "stories-azure-devops"]);
    const forgeFiles = await moved(s.forgeRoot, before);

    expect(r.code).toBe(0);
    expect(forgeFiles).toEqual([]);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops");
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro"))).toBe(false);
    // The warning about --prefer-kiro on a rule left to its recipe (printed to stdout with other warnings).
    expect(r.stdout).toContain("warn --prefer-kiro stories-azure-devops: left to recipe pm-azure-devops (integrations.pm) — not read");
  });

  // C3. (control) --prefer-kiro on a rule `base` lists.
  // Expected: code 0, a prefer-kiro line, and the left to recipe line still printed.
  it("C3. (control) --prefer-kiro on a rule base lists", async () => {
    const s = await synced(3, ado());
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "workflow"]);

    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").some((l) => l.trim().startsWith("prefer-kiro rule/workflow"))).toBe(true);
    expect(r.stdout).toContain("left to recipe pm-azure-devops (integrations.pm):");
    // No warning — the rule is not left to its recipe.
    expect(r.stdout).not.toContain("warn --prefer-kiro workflow");
  });
});
