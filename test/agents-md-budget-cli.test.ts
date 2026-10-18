import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";

// Tests for the AGENTS.md size budget CLI surfaces.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Forge with a large rule (40000 bytes body) targeting agents-md. */
const LARGE_RULE_FORGE = (): ForgeSpec => ({
  ingredients: [rule("big", "# Big\n" + "x".repeat(40000) + "\n")],
  recipes: [recipe("base", ["rule/big"])],
  profiles: [profile("acme", ["base"], ["agents-md"])],
});

/** Create a workspace, sync it once, then return paths. */
async function syncedWorkspace(overridesParams?: Record<string, unknown>) {
  const s = await scenario(LARGE_RULE_FORGE(), {
    config: { profile: "acme", ...(overridesParams ? { overrides: { params: overridesParams } } : {}) },
  });
  cleanups.push(s.cleanup);
  const r = runCli(["sync", "--workspace", s.wsRoot]);
  expect(r.code).toBe(0);
  return { ...s, ws: s.wsRoot };
}

/** Set overrides.params in craftar.yaml */
async function setOverrides(wsRoot: string, params: Record<string, unknown>) {
  const configPath = path.join(wsRoot, "craftar.yaml");
  const config = YAML.parse(await fs.readFile(configPath, "utf8"));
  config.overrides = { ...config.overrides, params };
  await fs.writeFile(configPath, YAML.stringify(config));
}

describe("AGENTS.md budget CLI — default budget exceeded (case 9)", () => {
  it("sync --check exit 0, stdout/stderr contain 'over the default budget of 32768'", async () => {
    const s = await syncedWorkspace();
    const r = runCli(["sync", "--check", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).toContain("over the default budget of 32768");
  });

  it("status exit 0", async () => {
    const s = await syncedWorkspace();
    const r = runCli(["status", "--workspace", s.ws]);
    expect(r.code).toBe(0);
  });

  it("diff --exit-code exit 0", async () => {
    const s = await syncedWorkspace();
    const r = runCli(["diff", "--exit-code", "--workspace", s.ws]);
    expect(r.code).toBe(0);
  });
});

describe("AGENTS.md budget CLI — explicit budget exceeded (case 10)", () => {
  it("sync --check exit 1, stderr contains 'error: AGENTS.md is' and 'set by agents-md.maxBytes'", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["sync", "--check", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("out of sync");
    expect(r.stdout).not.toContain("workspace in sync");
    expect(r.stderr).toContain("error: AGENTS.md is");
    expect(r.stderr).toContain("set by agents-md.maxBytes");
  });

  it("status exit 1, same stderr", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["status", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: AGENTS.md is");
    expect(r.stderr).toContain("set by agents-md.maxBytes");
  });

  it("status --json exit 1, JSON keys unchanged", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["status", "--json", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
  });

  it("diff --exit-code exit 1", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["diff", "--exit-code", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no differences");
    expect(r.stderr).toContain("error: AGENTS.md is");
  });

  it("diff --exit-code AGENTS.md exit 0 (single file path, budget does not set exit code)", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["diff", "--exit-code", "AGENTS.md", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("error: AGENTS.md is");
  });

  it("plain diff exit 0", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["diff", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("error: AGENTS.md is");
  });
});

describe("AGENTS.md budget CLI — writing sync with explicit budget (case 11)", () => {
  it("writing sync exit 0 and warning printed", async () => {
    const s = await scenario(LARGE_RULE_FORGE(), {
      config: { profile: "acme", overrides: { params: { "agents-md.maxBytes": 1000 } } },
    });
    cleanups.push(s.cleanup);
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    // The warning should be printed in stdout
    expect(r.stdout).toContain("over the budget of 1000");
  });
});

describe("AGENTS.md budget CLI — doctor (case 12)", () => {
  it("default budget exceeded → agents-md-size level warn with exact message and fix", async () => {
    const s = await syncedWorkspace();
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    const check = json.checks.find((c: { id: string }) => c.id === "agents-md-size");
    expect(check).toBeDefined();
    expect(check.level).toBe("warn");
    expect(check.message).toMatch(/^AGENTS\.md is \d+ bytes, over the default budget of 32768$/);
    expect(check.fix).toBe("set agents-md.maxBytes to fail sync --check above it; to shrink the file: move always-on rules to inclusion: fileMatch, write scoped rules to their own files (target claude-code or kiro)");
  });

  it("default budget exceeded → plan check is ok, no other check mentions AGENTS.md is", async () => {
    const s = await syncedWorkspace();
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    const json = JSON.parse(r.stdout);
    const planCheck = json.checks.find((c: { id: string }) => c.id === "plan");
    expect(planCheck).toBeDefined();
    expect(planCheck.level).toBe("ok");
    // No check other than agents-md-size should mention "AGENTS.md is"
    const otherChecks = json.checks.filter((c: { id: string }) => c.id !== "agents-md-size");
    for (const c of otherChecks) {
      expect(c.message).not.toContain("AGENTS.md is");
    }
  });

  it("explicit budget exceeded → agents-md-size level error with exact message and fix", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    const check = json.checks.find((c: { id: string }) => c.id === "agents-md-size");
    expect(check).toBeDefined();
    expect(check.level).toBe("error");
    expect(check.message).toMatch(/^AGENTS\.md is \d+ bytes, over the budget of 1000 set by agents-md\.maxBytes$/);
    expect(check.fix).toBe("move always-on rules to inclusion: fileMatch, write scoped rules to their own files (target claude-code or kiro), or raise agents-md.maxBytes");
  });

  it("explicit budget exceeded → plan check is ok, no other check mentions AGENTS.md is", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 1000 });
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    const json = JSON.parse(r.stdout);
    const planCheck = json.checks.find((c: { id: string }) => c.id === "plan");
    expect(planCheck).toBeDefined();
    expect(planCheck.level).toBe("ok");
    // No check other than agents-md-size should mention "AGENTS.md is"
    const otherChecks = json.checks.filter((c: { id: string }) => c.id !== "agents-md-size");
    for (const c of otherChecks) {
      expect(c.message).not.toContain("AGENTS.md is");
    }
  });

  it("budget 0 → agents-md-size level ok with exact message", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 0 });
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    const check = json.checks.find((c: { id: string }) => c.id === "agents-md-size");
    expect(check).toBeDefined();
    expect(check.level).toBe("ok");
    expect(check.message).toMatch(/^AGENTS\.md is \d+ bytes; the budget is off \(agents-md\.maxBytes: 0\)$/);
  });

  it("within budget → agents-md-size level ok with exact message", async () => {
    const s = await syncedWorkspace();
    await setOverrides(s.ws, { "agents-md.maxBytes": 100000 }); // Big enough to be within budget
    const r = runCli(["doctor", "--json", "--workspace", s.ws]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    const check = json.checks.find((c: { id: string }) => c.id === "agents-md-size");
    expect(check).toBeDefined();
    expect(check.level).toBe("ok");
    expect(check.message).toMatch(/^AGENTS\.md is \d+ bytes, within the budget of 100000$/);
  });

  it("workspace without agents-md target → no agents-md-size check", async () => {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    runCli(["sync", "--workspace", s.wsRoot]);
    const r = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    const check = json.checks.find((c: { id: string }) => c.id === "agents-md-size");
    expect(check).toBeUndefined();
  });
});
