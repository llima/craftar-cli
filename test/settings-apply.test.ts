/**
 * Settings apply tests (spec 52 §12): the wanted blocks, the merge, and the handler hash.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { forgeAt, sync } from "./helpers/integrations.js";
import { profile, recipe, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { sameHandler, wantedBlocks, wantedEnvNames, plannedRegistrations } from "../src/core/settings-apply.js";
import { settingsExample, EXAMPLE_SETTINGS } from "../src/emitters/shared.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Fixture H: a hook with registration
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

// Fixture M: an MCP ingredient with authEnv
const fixtureM = (): IngredientSpec => ({
  meta: {
    type: "mcp",
    name: "acme",
    authEnv: ["ACME_TOKEN"],
    server: { command: "npx", args: ["acme-mcp"] },
  },
});

// A hook with two registrations
const hookTwoRegs = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "multi-hook",
    files: ["hook.py"],
    params: { cmd: { default: "run" } },
    registration: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "{{cmd}}",
        args: ["--pre"],
        timeout: 5,
      },
      {
        event: "Stop",
        command: "{{cmd}}",
        // no matcher
      },
    ],
  },
  files: { "hook.py": 'print("multi")\n' },
});

// Another MCP ingredient with authEnv
const fixtureM2 = (): IngredientSpec => ({
  meta: {
    type: "mcp",
    name: "other",
    authEnv: ["OTHER_TOKEN", "OTHER_SECRET"],
    server: { command: "npx", args: ["other-mcp"] },
  },
});

describe("wanted blocks (spec 52 §4.1 step 3)", () => {
  it("1. settingsExample(w.env, w.hooks) deep-equals JSON.parse of the planned EXAMPLE_SETTINGS bytes (step-1 fixture)", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH(), fixtureM()],
      recipes: [recipe("base", ["hook/guard-path", "mcp/acme"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const w = wantedBlocks(p);
    expect(w).not.toBeNull();

    // Find the planned EXAMPLE_SETTINGS file
    const exampleFile = p.files.find((f) => f.path === EXAMPLE_SETTINGS);
    expect(exampleFile).toBeDefined();

    const planned = JSON.parse(exampleFile!.content.toString("utf8"));
    const built = settingsExample(w!.env, w!.hooks);

    expect(built).toEqual(planned);
  });

  it("2. two hooks with two registrations each, two MCP servers with authEnv → same shape", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH(), hookTwoRegs(), fixtureM(), fixtureM2()],
      recipes: [recipe("base", ["hook/guard-path", "hook/multi-hook", "mcp/acme", "mcp/other"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const w = wantedBlocks(p);
    expect(w).not.toBeNull();

    // Find the planned EXAMPLE_SETTINGS file
    const exampleFile = p.files.find((f) => f.path === EXAMPLE_SETTINGS);
    expect(exampleFile).toBeDefined();

    const planned = JSON.parse(exampleFile!.content.toString("utf8"));
    const built = settingsExample(w!.env, w!.hooks);

    expect(built).toEqual(planned);

    // Verify env has all names
    expect(Object.keys(w!.env!).sort()).toEqual(["ACME_TOKEN", "OTHER_SECRET", "OTHER_TOKEN"]);

    // Verify hooks structure
    expect(Object.keys(w!.hooks!).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(w!.hooks!.PreToolUse).toHaveLength(2); // Two hooks with PreToolUse
    expect(w!.hooks!.Stop).toHaveLength(1); // One hook with Stop (no matcher)
  });

  it("3. targets=['kiro'] → wantedBlocks is null; no registration and no authEnv → null", async () => {
    // Case 1: kiro-only targets
    const forgeKiro: ForgeSpec = {
      ingredients: [fixtureH(), fixtureM()],
      recipes: [recipe("base", ["hook/guard-path", "mcp/acme"])],
      profiles: [profile("acme", ["base"], ["kiro"])],
    };
    const s1 = await forgeAt(1, forgeKiro);
    cleanups.push(s1.cleanup);

    const ws1 = await loadWorkspace(s1.wsRoot);
    const p1 = await plan(ws1);
    expect(wantedBlocks(p1)).toBeNull();

    // Case 2: claude-code but no registration and no authEnv
    const rule = (): IngredientSpec => ({
      meta: { type: "rule", name: "style" },
      files: { "rule.md": "# Style\n" },
    });
    const mcpNoAuth = (): IngredientSpec => ({
      meta: {
        type: "mcp",
        name: "plain",
        server: { command: "npx", args: ["plain-mcp"] },
      },
    });
    const forgeNoAuth: ForgeSpec = {
      ingredients: [rule(), mcpNoAuth()],
      recipes: [recipe("base", ["rule/style", "mcp/plain"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s2 = await forgeAt(1, forgeNoAuth);
    cleanups.push(s2.cleanup);

    const ws2 = await loadWorkspace(s2.wsRoot);
    const p2 = await plan(ws2);
    expect(wantedBlocks(p2)).toBeNull();
  });

  it("4. sameHandler with different key order is true; args order differs → false", () => {
    const h1 = { type: "command", command: "a", args: ["x"] };
    const h2 = { args: ["x"], command: "a", type: "command" }; // Different key order
    expect(sameHandler(h1, h2)).toBe(true);

    // Same but args order differs
    const h3 = { type: "command", command: "a", args: ["x", "y"] };
    const h4 = { type: "command", command: "a", args: ["y", "x"] }; // Different args order
    expect(sameHandler(h3, h4)).toBe(false);

    // With timeout in different order
    const h5 = { type: "command", command: "a", args: ["x"], timeout: 10 };
    const h6 = { timeout: 10, args: ["x"], command: "a", type: "command" };
    expect(sameHandler(h5, h6)).toBe(true);

    // Nested objects with different key order
    const h7 = { type: "command", command: "a", opts: { b: 1, a: 2 } };
    const h8 = { type: "command", command: "a", opts: { a: 2, b: 1 } };
    expect(sameHandler(h7, h8)).toBe(true);
  });
});

describe("doctor and hook-registration tests still pass", () => {
  it("plannedRegistrations returns entries in plan order", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureH(), hookTwoRegs()],
      recipes: [recipe("base", ["hook/guard-path", "hook/multi-hook"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const entries = plannedRegistrations(p);

    // Expect 3 entries: 1 from guard-path, 2 from multi-hook
    expect(entries).toHaveLength(3);

    // Verify order: guard-path first
    expect(entries[0].ref).toBe("hook/guard-path");
    expect(entries[0].index).toBe(0);
    expect(entries[0].event).toBe("PreToolUse");

    // Then multi-hook
    expect(entries[1].ref).toBe("hook/multi-hook");
    expect(entries[1].index).toBe(0);
    expect(entries[1].event).toBe("PreToolUse");

    expect(entries[2].ref).toBe("hook/multi-hook");
    expect(entries[2].index).toBe(1);
    expect(entries[2].event).toBe("Stop");
  });

  it("wantedEnvNames returns sorted names from MCP authEnv", async () => {
    const forge: ForgeSpec = {
      ingredients: [fixtureM(), fixtureM2()],
      recipes: [recipe("base", ["mcp/acme", "mcp/other"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, forge);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    const names = wantedEnvNames(p);
    expect(names).toEqual(["ACME_TOKEN", "OTHER_SECRET", "OTHER_TOKEN"]);
  });
});
