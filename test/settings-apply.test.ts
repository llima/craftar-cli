/**
 * Settings apply tests (spec 52 §12): the wanted blocks, the merge, and the handler hash.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { forgeAt, sync } from "./helpers/integrations.js";
import { profile, recipe, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import {
  sameHandler,
  wantedBlocks,
  wantedEnvNames,
  plannedRegistrations,
  mergeSettings,
  handlerHash,
  SettingsShapeError,
  type MergeResult,
} from "../src/core/settings-apply.js";
import { settingsExample, EXAMPLE_SETTINGS, type HooksObject } from "../src/emitters/shared.js";
import {
  readRegistry,
  register,
  recordApplied,
  appliedFor,
  forget,
  prune,
  isRegistered,
  isMissing,
} from "../src/core/registry.js";
import { tmpDir } from "./helpers/forge.js";

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

describe("merge (spec 52 §5)", () => {
  // Helper to build a minimal wanted structure
  const wantedWith = (env: Record<string, string> | null, hooks: Record<string, unknown[]> | null) => ({
    env,
    hooks: hooks as HooksObject | null,
  });

  // A simple handler shape
  const handler1 = { type: "command", command: "python3", args: [".claude/hooks/guard.py"] };
  const handler2 = { type: "command", command: "python3", args: [".claude/hooks/other.py"] };
  const handler3 = { type: "command", command: "bash", args: [".claude/hooks/local.sh"] };

  it("1. null current + wanted → returns value with wanted blocks, changed=true", () => {
    const wanted = wantedWith(
      { ACME_TOKEN: "", OTHER_TOKEN: "" },
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    const result = mergeSettings(null, wanted, new Set());

    expect(result.changed).toBe(true);
    expect(result.value.env).toEqual({ ACME_TOKEN: "", OTHER_TOKEN: "" });
    expect(result.value.hooks).toBeDefined();
    const hooks = result.value.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(result.diff.envAdded).toEqual(["ACME_TOKEN", "OTHER_TOKEN"]);
    expect(result.diff.added).toHaveLength(1);
  });

  it("2. empty current {} + wanted → returns value with wanted blocks, changed=true", () => {
    const current: Record<string, unknown> = Object.create(null);
    const wanted = wantedWith(
      { ACME_TOKEN: "" },
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    const result = mergeSettings(current, wanted, new Set());

    expect(result.changed).toBe(true);
    expect(result.value.env).toEqual({ ACME_TOKEN: "" });
    expect(result.value.hooks).toBeDefined();
    expect(result.diff.envAdded).toEqual(["ACME_TOKEN"]);
    expect(result.diff.added).toHaveLength(1);
  });

  it("3. all wanted handlers present + no stale recorded → unchanged=false", () => {
    // Current already has the wanted handler
    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = [{ matcher: "Bash", hooks: [handler1] }];

    const env: Record<string, unknown> = Object.create(null);
    env.ACME_TOKEN = "secret-value";

    const current: Record<string, unknown> = Object.create(null);
    current.env = env;
    current.hooks = hooks;

    const wanted = wantedWith(
      { ACME_TOKEN: "" },
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    const result = mergeSettings(current, wanted, new Set());

    // Should be unchanged since all wanted are present
    expect(result.changed).toBe(false);
    expect(result.diff.envPresent).toBe(1);
    expect(result.diff.envAdded).toHaveLength(0);
  });

  it("4. recorded handler not in wanted → removed, changed=true", () => {
    // Handler that was recorded from previous apply but is not in current wanted
    const oldHandler = { type: "command", command: "python3", args: [".claude/hooks/old.py"] };
    const oldHash = handlerHash("PreToolUse", "Bash", oldHandler);

    // Current has the old handler
    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = [{ matcher: "Bash", hooks: [oldHandler] }];

    const current: Record<string, unknown> = Object.create(null);
    current.hooks = hooks;

    // New wanted has a different handler
    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    // The old handler is in the recorded set
    const recorded = new Set([oldHash]);

    const result = mergeSettings(current, wanted, recorded);

    expect(result.changed).toBe(true);
    // The old handler should be removed
    expect(result.diff.removed).toHaveLength(1);
    // The new handler should be added
    expect(result.diff.added).toHaveLength(1);
  });

  it("5. local handler kept, counted in diff.localKept", () => {
    // Current has a local handler (not in wanted, not in recorded)
    const localHandler = { type: "command", command: "bash", args: ["./local-check.sh"] };

    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = [
      { matcher: "Bash", hooks: [localHandler] },
    ];

    const current: Record<string, unknown> = Object.create(null);
    current.hooks = hooks;

    // Wanted adds a different handler to same event
    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    const result = mergeSettings(current, wanted, new Set());

    expect(result.changed).toBe(true);
    expect(result.diff.localKept).toBe(1);

    // Local handler should still be there
    const resultHooks = result.value.hooks as Record<string, unknown[]>;
    expect(resultHooks.PreToolUse).toHaveLength(2); // local + wanted
  });

  it("6. duplicate Forge handlers removed when a change triggers (spec 52 §11.1)", () => {
    // Per spec 52 §11.1: if all wanted handlers are present and no stale recorded,
    // duplicates are kept (idempotence). Only when something else triggers a change
    // are duplicates removed.
    
    // Scenario: current has duplicate + a stale recorded handler → changed, duplicate removed
    const oldHandler = { type: "command", command: "python3", args: [".claude/hooks/old.py"] };
    const oldHash = handlerHash("Stop", undefined, oldHandler);

    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = [
      { matcher: "Bash", hooks: [handler1] },
      { matcher: "Bash", hooks: [handler1] }, // duplicate wanted
    ];
    hooks.Stop = [
      { hooks: [oldHandler] }, // stale recorded handler triggers change
    ];

    const current: Record<string, unknown> = Object.create(null);
    current.hooks = hooks;

    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    // The old handler is in the recorded set, triggering a change
    const recorded = new Set([oldHash]);

    const result = mergeSettings(current, wanted, recorded);

    // Changed because the stale recorded handler triggers the edit
    expect(result.changed).toBe(true);
    expect(result.diff.duplicatesRemoved).toBe(1);
  });

  it("7. env: present name keeps its value, added name gets empty string", () => {
    const env: Record<string, unknown> = Object.create(null);
    env.ACME_TOKEN = "my-secret-token";
    env.EXISTING = 42; // non-string value kept

    const current: Record<string, unknown> = Object.create(null);
    current.env = env;

    const wanted = wantedWith(
      { ACME_TOKEN: "", NEW_VAR: "" },
      null,
    );

    const result = mergeSettings(current, wanted, new Set());

    expect(result.changed).toBe(true);
    const resultEnv = result.value.env as Record<string, unknown>;
    expect(resultEnv.ACME_TOKEN).toBe("my-secret-token"); // kept original value
    expect(resultEnv.NEW_VAR).toBe(""); // added with empty string
    expect(resultEnv.EXISTING).toBe(42); // non-wanted key kept with original value

    expect(result.diff.envPresent).toBe(1); // ACME_TOKEN was present
    expect(result.diff.envAdded).toEqual(["NEW_VAR"]);
  });

  it("8. SettingsShapeError: hooks is not an object", () => {
    const current: Record<string, unknown> = Object.create(null);
    current.hooks = "not-an-object";

    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    expect(() => mergeSettings(current, wanted, new Set())).toThrow(SettingsShapeError);
    expect(() => mergeSettings(current, wanted, new Set())).toThrow(/hooks is not an object/);
  });

  it("9. SettingsShapeError: env is not an object", () => {
    const current: Record<string, unknown> = Object.create(null);
    current.env = ["array-not-object"];

    const wanted = wantedWith(
      { ACME_TOKEN: "" },
      null,
    );

    expect(() => mergeSettings(current, wanted, new Set())).toThrow(SettingsShapeError);
    expect(() => mergeSettings(current, wanted, new Set())).toThrow(/env is not an object/);
  });

  it("10. SettingsShapeError: event value is not a list", () => {
    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = "not-a-list";

    const current: Record<string, unknown> = Object.create(null);
    current.hooks = hooks;

    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    expect(() => mergeSettings(current, wanted, new Set())).toThrow(SettingsShapeError);
    expect(() => mergeSettings(current, wanted, new Set())).toThrow(/is not a list/);
  });

  it("11. SettingsShapeError: group is not an object with a hooks list", () => {
    const hooks: Record<string, unknown> = Object.create(null);
    hooks.PreToolUse = [
      { matcher: "Bash" }, // missing hooks key
    ];

    const current: Record<string, unknown> = Object.create(null);
    current.hooks = hooks;

    const wanted = wantedWith(
      null,
      { PreToolUse: [{ matcher: "Bash", hooks: [handler1] }] },
    );

    expect(() => mergeSettings(current, wanted, new Set())).toThrow(SettingsShapeError);
    expect(() => mergeSettings(current, wanted, new Set())).toThrow(/not an object with a hooks list/);
  });

  it("12. handlerHash: same event/matcher/handler → same hash; different matcher → different hash", () => {
    const h = { type: "command", command: "test" };

    const hash1 = handlerHash("PreToolUse", "Bash", h);
    const hash2 = handlerHash("PreToolUse", "Bash", h);
    expect(hash1).toBe(hash2);

    // Different matcher
    const hash3 = handlerHash("PreToolUse", "PowerShell", h);
    expect(hash1).not.toBe(hash3);

    // Absent matcher vs literal "-" (spec 52 §5.3)
    const hash4 = handlerHash("PreToolUse", undefined, h);
    const hash5 = handlerHash("PreToolUse", "-", h);
    expect(hash4).not.toBe(hash5);

    // Same handler with different key order → same hash
    const h1 = { type: "command", command: "test", args: ["a"] };
    const h2 = { args: ["a"], command: "test", type: "command" };
    expect(handlerHash("E", "M", h1)).toBe(handlerHash("E", "M", h2));
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

describe("registry: settingsApplied record (spec 52 §5.3)", () => {
  it("1. recordApplied stores handlers and appliedFor returns them", async () => {
    const s = await forgeAt(1, {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // First register the workspace (recordApplied requires registration)
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);

    // Record some handler hashes
    const hashes = ["hash1", "hash2", "hash3"];
    const now = new Date("2026-11-02T12:00:00Z");
    const entry = await recordApplied(home, s.wsRoot, hashes, { now });

    expect(entry.handlers).toEqual(hashes);
    expect(entry.appliedAt).toBe("2026-11-02T12:00:00.000Z");

    // Read it back
    const reg = await readRegistry(home);
    const recorded = await appliedFor(reg, s.wsRoot);
    expect(recorded.size).toBe(3);
    expect(recorded.has("hash1")).toBe(true);
    expect(recorded.has("hash2")).toBe(true);
    expect(recorded.has("hash3")).toBe(true);
  });

  it("2. appliedFor returns empty set when no record exists", async () => {
    const s = await forgeAt(1, {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // Register but don't record applied
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);

    const reg = await readRegistry(home);
    const recorded = await appliedFor(reg, s.wsRoot);
    expect(recorded.size).toBe(0);
  });

  it("3. forget drops settingsApplied record with the workspace", async () => {
    const s = await forgeAt(1, {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // Register and record
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);
    await recordApplied(home, s.wsRoot, ["hash1"]);

    // Verify it's there
    let reg = await readRegistry(home);
    expect(reg.settingsApplied).toBeDefined();
    expect(reg.settingsApplied!.length).toBe(1);

    // Forget the workspace
    await forget(home, s.wsRoot);

    // Verify both workspace and settingsApplied are gone
    reg = await readRegistry(home);
    expect(reg.workspaces.length).toBe(0);
    expect(reg.settingsApplied).toBeUndefined();
  });

  it("4. prune drops settingsApplied record with the workspace", async () => {
    const s = await forgeAt(1, {
      ingredients: [fixtureH()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    cleanups.push(s.cleanup);

    const home = await tmpDir();
    cleanups.push(async () => await fs.rm(home, { recursive: true, force: true }));

    // Register and record
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await register(home, ws, p);
    await recordApplied(home, s.wsRoot, ["hash1"]);

    // Make the workspace "missing" by removing craftar.yaml
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));

    // Verify it's missing
    const regBefore = await readRegistry(home);
    expect(await isMissing(regBefore.workspaces[0])).toBe(true);

    // Prune
    const pruned = await prune(home);
    expect(pruned.length).toBe(1);

    // Verify both workspace and settingsApplied are gone
    const regAfter = await readRegistry(home);
    expect(regAfter.workspaces.length).toBe(0);
    expect(regAfter.settingsApplied).toBeUndefined();
  });

  it("5. handlerHash: absent matcher vs literal '-' are different hashes (spec 52 §5.3)", () => {
    const handler = { type: "command", command: "test" };

    const hashUndefined = handlerHash("PreToolUse", undefined, handler);
    const hashDash = handlerHash("PreToolUse", "-", handler);

    expect(hashUndefined).not.toBe(hashDash);
  });
});
