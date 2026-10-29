/**
 * Doctor hooks-registered check tests (spec 43 §6).
 * Tests the hooks-registered check through runDoctor with seams, plus CLI cases.
 */
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runDoctor, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, scenario, writeFiles, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Test-specific CRAFTAR_HOME and CLAUDE_CONFIG_DIR setup
// (The global setup already sets these, but we keep local dirs for tests that need custom content)
let home: string;
let claudeDir: string;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "craftar-home-"));
  claudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-claude-"));
});

afterAll(async () => {
  await removeWithRetry(home);
  await removeWithRetry(claudeDir);
});

// Fixture H from the preamble: a hook ingredient with registration
const fixtureH = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
    params: { "hooks.python": { default: "python3" } },
    registration: [
      {
        event: "PreToolUse",
        matcher: "Bash|PowerShell",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
        timeout: 10,
      },
    ],
  },
  files: { "guard-path.py": 'print("ok")\n' },
});

// Fixture H without registration
const fixtureHNoReg = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
  },
  files: { "guard-path.py": 'print("ok")\n' },
});

// Fixture M from the preamble: an MCP ingredient with authEnv
const fixtureM = (): IngredientSpec => ({
  meta: {
    type: "mcp",
    name: "tracker",
    authEnv: ["ACME_TOKEN"],
    server: { command: "npx", args: ["acme-tracker"] },
  },
});

// A basic rule for Forges that need something other than just hooks
const rule = (name: string, body: string): IngredientSpec => ({
  meta: { type: "rule", name },
  files: { "rule.md": body },
});

// Helper to run doctor with test-specific options
const run = (o: Partial<DoctorOptions> & { home: string; workspace: string }) =>
  runDoctor({
    version: "0.0.0",
    fetch: false,
    strict: false,
    registryOff: false,
    env: {},
    nodeVersion: "22.11.0",
    gitVersion: async () => "2.53.0",
    ...o,
  });

const of = (checks: Check[], id: string) => checks.filter((c) => c.id === id);
const one = (checks: Check[], id: string) => {
  const found = of(checks, id);
  expect(found, id).toHaveLength(1);
  return found[0];
};

// Helper to build the planned handler JSON as it would appear in a settings file
// Keys in different order to test key-order-insensitive comparison
const plannedHandlerDifferentOrder = () => ({
  hooks: {
    PreToolUse: [
      {
        hooks: [
          {
            timeout: 10,
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            command: "python3",
            type: "command",
          },
        ],
        matcher: "Bash|PowerShell",
      },
    ],
  },
});

// Helper to build the planned handler JSON with correct order (as sync would write it)
const plannedHandlerCorrectOrder = () => ({
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash|PowerShell",
        hooks: [
          {
            type: "command",
            command: "python3",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            timeout: 10,
          },
        ],
      },
    ],
  },
});

async function fixture(ingredients: IngredientSpec[], targets = ["claude-code"]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "craftar-doctor-hooks-"));
  cleanups.push(() => removeWithRetry(root));
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], targets)],
  };
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, forge);
  const wsRoot = path.join(root, "ws");
  await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
  return { root, forgeRoot, wsRoot };
}

describe("hooks-registered check (spec 43 §6)", () => {
  it("1. no registration in the plan → no hooks-registered check at all", async () => {
    // Use a hook without registration (fixture H without reg)
    const f = await fixture([fixtureHNoReg(), rule("style", "# Style\n")]);
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const hooksChecks = of(r.checks, "hooks-registered");
    expect(hooksChecks, "hooks-registered should not be present when no registration").toHaveLength(0);
  });

  it("2. .claude/settings.json holds handler with different key order → ok", async () => {
    const f = await fixture([fixtureH()]);
    // Write settings.json with keys in a DIFFERENT order plus unrelated keys
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["write"] },
        ...plannedHandlerDifferentOrder(),
      }),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("ok");
    expect(check.message).toBe("every hook registration is in a settings file");
  });

  it("3a. handler only in .claude/settings.local.json → ok", async () => {
    const f = await fixture([fixtureH()]);
    await writeFiles(f.wsRoot, {
      ".claude/settings.local.json": JSON.stringify(plannedHandlerCorrectOrder()),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("ok");
    expect(check.message).toBe("every hook registration is in a settings file");
  });

  it("3b. handler only in claudeUserDir/settings.json → ok", async () => {
    const f = await fixture([fixtureH()]);
    // Write to the claudeUserDir (user's settings)
    await writeFiles(claudeDir, {
      "settings.json": JSON.stringify(plannedHandlerCorrectOrder()),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("ok");
    expect(check.message).toBe("every hook registration is in a settings file");
    // Clean up
    await fs.rm(path.join(claudeDir, "settings.json"), { force: true });
  });

  it("4. no settings file → warn with specific message and fix", async () => {
    const f = await fixture([fixtureH()]);
    // No settings files exist
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("warn");
    expect(check.message).toBe("hook/guard-path: registration 0 (PreToolUse) is in no settings file Claude Code reads");
    expect(check.fix).toBe("copy it from .claude/settings.craftar.example.json into .claude/settings.json");
  });

  it("5a. matcher * in settings, absent in planned → warn (absent equals absent only)", async () => {
    // Create a hook with NO matcher
    const hookNoMatcher: IngredientSpec = {
      meta: {
        type: "hook",
        name: "no-matcher-hook",
        files: ["run.sh"],
        registration: [{ event: "Stop", command: "bash" }], // No matcher
      },
      files: { "run.sh": "echo run\n" },
    };
    const f = await fixture([hookNoMatcher]);
    // Settings has matcher: "*" but planned has no matcher
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "bash" }],
            },
          ],
        },
      }),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("warn");
    expect(check.message).toMatch(/is in no settings file/);
  });

  it("5b. matcher \"\" in settings, absent in planned → warn", async () => {
    const hookNoMatcher: IngredientSpec = {
      meta: {
        type: "hook",
        name: "no-matcher-hook",
        files: ["run.sh"],
        registration: [{ event: "Stop", command: "bash" }],
      },
      files: { "run.sh": "echo run\n" },
    };
    const f = await fixture([hookNoMatcher]);
    // Settings has matcher: "" but planned has no matcher
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "bash" }],
            },
          ],
        },
      }),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("warn");
  });

  it("5c. planned entry without matcher matches settings group without matcher → ok", async () => {
    const hookNoMatcher: IngredientSpec = {
      meta: {
        type: "hook",
        name: "no-matcher-hook",
        files: ["run.sh"],
        registration: [{ event: "Stop", command: "bash" }],
      },
      files: { "run.sh": "echo run\n" },
    };
    const f = await fixture([hookNoMatcher]);
    // Settings has no matcher, planned has no matcher
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "bash" }],
            },
          ],
        },
      }),
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("ok");
    expect(check.message).toBe("every hook registration is in a settings file");
  });

  it("6a. .claude/settings.json holding invalid JSON → warn with specific message", async () => {
    const f = await fixture([fixtureH()]);
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": "{ not json",
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const checks = of(r.checks, "hooks-registered");
    // Should have two findings: the invalid JSON warn AND the not-found warn
    expect(checks.length).toBeGreaterThanOrEqual(1);
    const invalidJsonCheck = checks.find((c) => c.message.includes("cannot read"));
    expect(invalidJsonCheck).toBeDefined();
    expect(invalidJsonCheck!.level).toBe("warn");
    expect(invalidJsonCheck!.message).toBe("cannot read .claude/settings.json: not valid JSON");
    // The message should NOT contain the curly brace
    expect(invalidJsonCheck!.message).not.toContain("{");
  });

  it("6b. top level array in settings.json → warn not a JSON object", async () => {
    const f = await fixture([fixtureH()]);
    await writeFiles(f.wsRoot, {
      ".claude/settings.json": "[1]",
    });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const checks = of(r.checks, "hooks-registered");
    const invalidCheck = checks.find((c) => c.message.includes("cannot read"));
    expect(invalidCheck).toBeDefined();
    expect(invalidCheck!.level).toBe("warn");
    expect(invalidCheck!.message).toBe("cannot read .claude/settings.json: not a JSON object");
  });

  it("8. declared param with no value → ok line saying not checked", async () => {
    // Create hook with a param that has no default and no value set
    const hookNoDefault: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": {} }, // No default!
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };
    const f = await fixture([hookNoDefault]);
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });

    // The hooks-registered check should have an ok line about not checked
    const hooksChecks = of(r.checks, "hooks-registered");
    expect(hooksChecks.length).toBeGreaterThanOrEqual(1);
    const notCheckedLine = hooksChecks.find((c) =>
      c.message.includes("not checked") && c.message.includes("a declared parameter has no value")
    );
    expect(notCheckedLine).toBeDefined();
    expect(notCheckedLine!.level).toBe("ok");
    expect(notCheckedLine!.message).toBe(
      "hook/guard-path: registration 0 (PreToolUse) not checked — a declared parameter has no value (see params)"
    );

    // Should NOT have a warn from this check (the params check will have the error)
    const warnFromHooksReg = hooksChecks.filter((c) => c.level === "warn");
    expect(warnFromHooksReg).toHaveLength(0);

    // The params check should have the error
    const paramsCheck = one(r.checks, "params");
    expect(paramsCheck.level).toBe("error");
  });

  it("9. doctor --strict with case 4 (warn) → exit 1 equivalent summary", async () => {
    const f = await fixture([fixtureH()]);
    // No settings files → warn
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir, strict: true });
    // The check should be warn
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("warn");
    // Under strict, warn means exit 1, which is indicated by summary having warns
    expect(r.summary.warn).toBeGreaterThanOrEqual(1);
  });

  it("10. uncovered path warning appears as plan check warn", async () => {
    // Create hook that cites a path it doesn't write (spec 43 §5.6)
    const hookWithUncoveredPath: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/other.py"], // Cites a file NOT in files[]
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };
    const f = await fixture([hookWithUncoveredPath]);
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    // The plan check should have a warn about the uncovered path
    const planChecks = of(r.checks, "plan");
    expect(planChecks.some((c) =>
      c.level === "warn" && c.message.includes("registration cites .claude/hooks/other.py")
    )).toBe(true);
  });

  it("A1. two entries: one cites unset param → not checked; other cites nothing → warn", async () => {
    // H with two registration entries: entry 0 cites {{hooks.python}} (unset), entry 1 cites nothing
    const hookTwoEntries: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": {} }, // No default, no value → unset
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            timeout: 10,
          },
          {
            event: "Stop",
            command: "true", // Cites nothing
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };
    const f = await fixture([hookTwoEntries]);
    // No settings files
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const hooksChecks = of(r.checks, "hooks-registered");

    // Entry 0: ok, not checked because it cites the unset param
    const entry0 = hooksChecks.find((c) =>
      c.message.includes("registration 0 (PreToolUse)") && c.message.includes("not checked")
    );
    expect(entry0, "entry 0 should be marked not checked").toBeDefined();
    expect(entry0!.level).toBe("ok");
    expect(entry0!.message).toBe(
      "hook/guard-path: registration 0 (PreToolUse) not checked — a declared parameter has no value (see params)"
    );

    // Entry 1: warn, because it does NOT cite the unset param (so it IS checked) and is not in a settings file
    const entry1 = hooksChecks.find((c) =>
      c.message.includes("registration 1 (Stop)") && c.message.includes("is in no settings file")
    );
    expect(entry1, "entry 1 should be warned as not in settings file").toBeDefined();
    expect(entry1!.level).toBe("warn");
    expect(entry1!.message).toBe(
      "hook/guard-path: registration 1 (Stop) is in no settings file Claude Code reads"
    );
  });

  it("A2. two hooks: A has unset param → not checked; B has default and is found → ok", async () => {
    // Hook A: declares k: {} (no value) and cites it
    const hookA: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-a",
        files: ["a.sh"],
        params: { k: {} }, // No default, no value → unset
        registration: [
          {
            event: "PreToolUse",
            command: "{{k}}",
          },
        ],
      },
      files: { "a.sh": "echo a\n" },
    };

    // Hook B: declares k: { default: "x" }, cites {{k}} in its command
    const hookB: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-b",
        files: ["b.sh"],
        params: { k: { default: "x" } }, // Has default
        registration: [
          {
            event: "Stop",
            command: "{{k}}", // Renders to "x"
          },
        ],
      },
      files: { "b.sh": "echo b\n" },
    };

    const root = mkdtempSync(path.join(os.tmpdir(), "craftar-doctor-hooks-a2-"));
    cleanups.push(() => removeWithRetry(root));
    const forge: ForgeSpec = {
      ingredients: [hookA, hookB],
      recipes: [recipe("base", ["hook/hook-a", "hook/hook-b"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const forgeRoot = path.join(root, "forge");
    await makeForge(forgeRoot, forge);
    const wsRoot = path.join(root, "ws");
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });

    // Write settings file with B's rendered handler (command "x")
    await writeFiles(wsRoot, {
      ".claude/settings.json": JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "x" }],
            },
          ],
        },
      }),
    });

    const r = await run({ home, workspace: wsRoot, claudeUserDir: claudeDir });
    const hooksChecks = of(r.checks, "hooks-registered");

    // Hook A's entry: not checked (cites unset param)
    const entryA = hooksChecks.find((c) =>
      c.message.includes("hook/hook-a") && c.message.includes("not checked")
    );
    expect(entryA, "hook A's entry should be not checked").toBeDefined();
    expect(entryA!.level).toBe("ok");
    expect(entryA!.message).toBe(
      "hook/hook-a: registration 0 (PreToolUse) not checked — a declared parameter has no value (see params)"
    );

    // Hook B's entry: should be found (no warn for B)
    const warnForB = hooksChecks.filter(
      (c) => c.message.includes("hook/hook-b") && c.level === "warn"
    );
    expect(warnForB, "hook B should NOT have a warn").toHaveLength(0);

    // Should have an "ok" summary line (since all checked entries were found)
    const okSummary = hooksChecks.find((c) =>
      c.level === "ok" && c.message === "every hook registration is in a settings file"
    );
    expect(okSummary, "should have ok summary since B's entry was found").toBeDefined();
  });

  it("B1. settings.json with UTF-8 BOM holding the planned handler → ok", async () => {
    // A settings file with a BOM should be read correctly
    const f = await fixture([fixtureH()]);
    // Write settings.json with UTF-8 BOM prepended
    const handlerJson = JSON.stringify(plannedHandlerCorrectOrder());
    const bom = "\uFEFF"; // UTF-8 BOM
    await fs.mkdir(path.join(f.wsRoot, ".claude"), { recursive: true });
    await fs.writeFile(path.join(f.wsRoot, ".claude/settings.json"), bom + handlerJson, "utf8");
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const hooksChecks = of(r.checks, "hooks-registered");
    // Should NOT have a "cannot read" warning
    const invalidCheck = hooksChecks.find((c) => c.message.includes("cannot read"));
    expect(invalidCheck, "should not warn about BOM file").toBeUndefined();
    // Should find the handler → ok
    const check = one(r.checks, "hooks-registered");
    expect(check.level).toBe("ok");
    expect(check.message).toBe("every hook registration is in a settings file");
  });

  it("B2. settings.json is a directory → warn with unreadable (EISDIR)", async () => {
    const f = await fixture([fixtureH()]);
    // Create .claude/settings.json as a DIRECTORY
    await fs.mkdir(path.join(f.wsRoot, ".claude/settings.json"), { recursive: true });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: claudeDir });
    const hooksChecks = of(r.checks, "hooks-registered");
    // Should have a warning about unreadable
    const dirCheck = hooksChecks.find((c) =>
      c.message.includes("cannot read") && c.message.includes("unreadable")
    );
    expect(dirCheck, "should warn about directory as unreadable").toBeDefined();
    expect(dirCheck!.level).toBe("warn");
    expect(dirCheck!.message).toBe("cannot read .claude/settings.json: unreadable (EISDIR)");
  });

  it("C1. every entry not checked + invalid JSON → no cannot-read warning", async () => {
    // When every registration entry is "not checked" (because of unset param),
    // the cannot-read warnings should not be emitted.
    // Create hook with a param that has no default and no value set
    const hookNoDefault: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": {} }, // No default!
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };
    const f = await fixture([hookNoDefault]);
    // Write invalid JSON in a settings file that would normally trigger a warning
    const coreClaudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-core-claude-c1-"));
    cleanups.push(() => removeWithRetry(coreClaudeDir));
    await writeFiles(coreClaudeDir, { "settings.json": "{ invalid json" });
    const r = await run({ home, workspace: f.wsRoot, claudeUserDir: coreClaudeDir, env: {} });
    const hooksChecks = of(r.checks, "hooks-registered");
    // Should have the "not checked" line
    const notCheckedLine = hooksChecks.find((c) =>
      c.message.includes("not checked") && c.message.includes("a declared parameter has no value")
    );
    expect(notCheckedLine, "should have not checked line").toBeDefined();
    // Should NOT have a "cannot read" warning (spec 43 §6: "When none was checked, the not checked lines are the check's only lines")
    const cannotReadLine = hooksChecks.find((c) => c.message.includes("cannot read"));
    expect(cannotReadLine, "should not have cannot read line when nothing was checked").toBeUndefined();
  });
});

describe("CLI tests for hooks-registered", () => {
  it("7a. CLAUDE_CONFIG_DIR=<tmp> with invalid JSON → label is $CLAUDE_CONFIG_DIR/settings.json", async () => {
    const f = await fixture([fixtureH()]);
    const { runCli } = await import("./helpers/cli.js");

    // Create a temp dir for CLAUDE_CONFIG_DIR with invalid settings.json
    const cliClaudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-cli-claude-"));
    cleanups.push(() => removeWithRetry(cliClaudeDir));
    await writeFiles(cliClaudeDir, { "settings.json": "nope" });

    const result = runCli(["doctor", "--workspace", f.wsRoot, "--json"], {
      env: {
        CRAFTAR_HOME: home,
        CLAUDE_CONFIG_DIR: cliClaudeDir,
      },
    });

    expect(result.code).toBe(0); // Doctor completes even with warnings
    const output = JSON.parse(result.stdout);
    const hooksChecks = output.checks.filter((c: Check) => c.id === "hooks-registered");
    // Should have a warning about invalid JSON with label $CLAUDE_CONFIG_DIR/settings.json
    const invalidCheck = hooksChecks.find((c: Check) =>
      c.message.includes("cannot read") && c.message.includes("$CLAUDE_CONFIG_DIR/settings.json")
    );
    expect(invalidCheck).toBeDefined();
    expect(invalidCheck.message).toBe("cannot read $CLAUDE_CONFIG_DIR/settings.json: not valid JSON");
    // The absolute path should NOT appear anywhere in the output
    expect(result.stdout).not.toContain(cliClaudeDir);
    expect(result.stderr).not.toContain(cliClaudeDir);
  });

  it("7b. CLAUDE_CONFIG_DIR unset, core seam pointed at temp user dir with bad JSON → label ~/.claude/settings.json", async () => {
    const f = await fixture([fixtureH()]);

    // Create a temp dir to act as claudeUserDir (simulating ~/.claude)
    const coreClaudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-core-claude-"));
    cleanups.push(() => removeWithRetry(coreClaudeDir));
    await writeFiles(coreClaudeDir, { "settings.json": "{ bad json" });

    // Run with claudeUserDir seam (no CLAUDE_CONFIG_DIR in env)
    const r = await run({
      home,
      workspace: f.wsRoot,
      claudeUserDir: coreClaudeDir,
      env: {}, // No CLAUDE_CONFIG_DIR
    });

    const hooksChecks = of(r.checks, "hooks-registered");
    const invalidCheck = hooksChecks.find((c) =>
      c.message.includes("cannot read") && c.message.includes("~/.claude/settings.json")
    );
    expect(invalidCheck).toBeDefined();
    expect(invalidCheck!.message).toBe("cannot read ~/.claude/settings.json: not valid JSON");
    // The absolute path should NOT appear
    expect(JSON.stringify(r)).not.toContain(coreClaudeDir);
  });
});

describe("craftar mcp doctor tool returns hooks-registered id", () => {
  it("11. the doctor tool of craftar mcp returns hooks-registered id for case 4", async () => {
    const f = await fixture([fixtureH()]);
    // Sync once so there's a workspace to test
    const ws = await loadWorkspace(f.wsRoot, { home });
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)));

    const { session } = await import("./helpers/mcp.js");
    const s = await session(f.wsRoot, { env: { CRAFTAR_HOME: home, CLAUDE_CONFIG_DIR: claudeDir } });

    const response = await s.tool("doctor");
    expect(response.rpcError).toBeUndefined();
    expect(response.isError).toBeUndefined();
    const data = response.structuredContent;

    // Should have hooks-registered check
    const hooksChecks = data.checks.filter((c: Check) => c.id === "hooks-registered");
    expect(hooksChecks.length).toBeGreaterThanOrEqual(1);

    // Case 4: no settings file → warn
    const warnCheck = hooksChecks.find((c: Check) => c.level === "warn");
    expect(warnCheck).toBeDefined();
    expect(warnCheck.message).toContain("is in no settings file Claude Code reads");
  });
});
