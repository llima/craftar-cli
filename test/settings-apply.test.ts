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
  wantedHooksObject,
  type MergeResult,
  type PlannedRegistration,
  type WantedBlocks,
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
  it("1. settingsExample(env, wantedHooksObject(regs)) deep-equals JSON.parse of the planned EXAMPLE_SETTINGS bytes (D6)", async () => {
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

    // Build env from envNames
    const env: Record<string, string> | null = w!.envNames.length > 0 ? Object.create(null) : null;
    if (env) {
      for (const name of w!.envNames) env[name] = "";
    }

    // Build hooks from registrations using wantedHooksObject
    const hooks = wantedHooksObject(w!.registrations);
    const built = settingsExample(env, hooks);

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

    // Build env from envNames
    const env: Record<string, string> | null = w!.envNames.length > 0 ? Object.create(null) : null;
    if (env) {
      for (const name of w!.envNames) env[name] = "";
    }

    // Build hooks from registrations
    const hooks = wantedHooksObject(w!.registrations);
    const built = settingsExample(env, hooks);

    expect(built).toEqual(planned);

    // Verify env has all names
    expect(w!.envNames.sort()).toEqual(["ACME_TOKEN", "OTHER_SECRET", "OTHER_TOKEN"]);

    // Verify registrations
    expect(w!.registrations.filter((r) => r.event === "PreToolUse")).toHaveLength(2);
    expect(w!.registrations.filter((r) => r.event === "Stop")).toHaveLength(1);
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
  // Helper to build a minimal wanted structure (backward compat)
  const wantedWith = (envNames: string[], regs: PlannedRegistration[]): WantedBlocks => ({
    envNames: envNames,
    registrations: regs,
  });

  // Helper to build a registration
  const makeReg = (event: string, matcher: string | undefined, handler: unknown, ref = "", index = 0): PlannedRegistration => ({
    ref,
    index,
    event,
    matcher,
    handler,
    hasMissing: false,
  });

  // A simple handler shape
  const handler1 = { type: "command", command: "python3", args: [".claude/hooks/guard.py"] };
  const handler2 = { type: "command", command: "python3", args: [".claude/hooks/other.py"] };
  const handler3 = { type: "command", command: "bash", args: [".claude/hooks/local.sh"] };

  it("1. null current + wanted → returns value with wanted blocks, changed=true", () => {
    const wanted = wantedWith(
      ["ACME_TOKEN", "OTHER_TOKEN"],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      ["ACME_TOKEN"],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      ["ACME_TOKEN"],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      ["ACME_TOKEN", "NEW_VAR"],
      [],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
    );

    expect(() => mergeSettings(current, wanted, new Set())).toThrow(SettingsShapeError);
    expect(() => mergeSettings(current, wanted, new Set())).toThrow(/hooks is not an object/);
  });

  it("9. SettingsShapeError: env is not an object", () => {
    const current: Record<string, unknown> = Object.create(null);
    current.env = ["array-not-object"];

    const wanted = wantedWith(
      ["ACME_TOKEN"],
      [],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
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
      [],
      [makeReg("PreToolUse", "Bash", handler1)],
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

describe("merge — spec cases", () => {
  // Helper: deep copy into null-prototype objects
  function nul(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(nul);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj)) {
      out[key] = nul((obj as Record<string, unknown>)[key]);
    }
    return out;
  }

  // Helper: build a PlannedRegistration
  function reg(
    event: string,
    matcher: string | undefined,
    handler: unknown,
    ref = "hook/guard",
    index = 0,
  ): import("../src/core/settings-apply.js").PlannedRegistration {
    return { ref, index, event, matcher, handler, hasMissing: false };
  }

  // Helper: build a Wanted structure (new D6 API)
  function W(envNames: string[], regs: PlannedRegistration[]): WantedBlocks {
    return { envNames, registrations: regs };
  }

  // Handlers
  const OLD = { type: "command", command: "python3", args: [".claude/hooks/old-guard.py"] };
  const NEW = { type: "command", command: "python3", args: [".claude/hooks/guard.py"], timeout: 10 };
  const LOCAL = { type: "command", command: "sh", args: [".claude/hooks/acme-lint.sh"] };

  it("M1. the request's case: replace OLD with NEW, keep LOCAL and env value, don't mutate input (D1)", () => {
    const current = nul({
      env: { ACME_TOKEN: "s3cr3t-value" },
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [LOCAL] }, { matcher: "Bash", hooks: [OLD] }] },
    }) as Record<string, unknown>;

    const currentBefore = JSON.stringify(current);
    const recorded = new Set([handlerHash("PreToolUse", "Bash", OLD)]);
    const wanted = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);

    const result = mergeSettings(current, wanted, recorded);

    // Input not mutated (D1)
    expect(JSON.stringify(current)).toBe(currentBefore);

    // Value correct
    expect(result.value).toEqual(nul({
      env: { ACME_TOKEN: "s3cr3t-value" },
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [LOCAL] }, { matcher: "Bash", hooks: [NEW] }] },
    }));

    // Key order preserved
    expect(Object.keys(result.value)).toEqual(["env", "permissions", "hooks"]);

    // Diff correct
    expect(result.diff.removed).toEqual([{ event: "PreToolUse", matcher: "Bash", handler: OLD }]);
    expect(result.diff.added[0].ref).toBe("hook/guard");
    expect(result.diff.added[0].index).toBe(0);
  });

  it("M2. idempotence: second apply with same wanted → changed false", () => {
    const value = nul({
      env: { ACME_TOKEN: "s3cr3t-value" },
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [LOCAL] }, { matcher: "Bash", hooks: [NEW] }] },
    }) as Record<string, unknown>;

    const recorded = new Set([handlerHash("PreToolUse", "Bash", OLD), handlerHash("PreToolUse", "Bash", NEW)]);
    const wanted = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);

    const result = mergeSettings(value, wanted, recorded);

    expect(result.changed).toBe(false);
    expect(result.value).toBe(value); // Same object reference when unchanged
  });

  it("M3. current null, wanted with env and hooks → keys [env, hooks]", () => {
    const wanted = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);
    const result = mergeSettings(null, wanted, new Set());

    expect(Object.keys(result.value)).toEqual(["env", "hooks"]);
    expect(result.value.env).toEqual(nul({ ACME_TOKEN: "" }));
  });

  it("M4. current {permissions:{}} → keys [env, hooks, permissions] (D2)", () => {
    const current = nul({ permissions: {} }) as Record<string, unknown>;
    const wanted = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);

    const result = mergeSettings(current, wanted, new Set());

    expect(Object.keys(result.value)).toEqual(["env", "hooks", "permissions"]);
  });

  it("M5. existing hooks with wanted handler → hooks unchanged, env added, moved 0 (D2, D4)", () => {
    const current = nul({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [NEW] }] },
      model: "x",
    }) as Record<string, unknown>;

    const wanted = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);
    const result = mergeSettings(current, wanted, new Set());

    // Keys: hooks first (existed), then env (added after hooks), then model
    expect(Object.keys(result.value)).toEqual(["hooks", "env", "model"]);

    // Hooks unchanged (D4: env-only change doesn't touch hooks)
    expect(result.value.hooks).toEqual(current.hooks);
    expect(result.diff.moved).toBe(0);
  });

  it("M6. no record, current has only OLD, wanted [NEW] → OLD kept as local, NEW appended, localKept 1", () => {
    const current = nul({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [OLD] }] },
    }) as Record<string, unknown>;

    const wanted = W([], [reg("PreToolUse", "Bash", NEW)]);
    const result = mergeSettings(current, wanted, new Set());

    // OLD is local (not in recorded, not equal to wanted), NEW is added
    const hooks = result.value.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(result.diff.localKept).toBe(1);
  });

  it("M7. duplicates: unchanged when all wanted present; env-only change doesn't remove duplicates (D4)", () => {
    const current = nul({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [NEW] }, { matcher: "Bash", hooks: [NEW] }] },
    }) as Record<string, unknown>;

    // No env, just hooks → unchanged (both copies of wanted present)
    const wanted1 = W([], [reg("PreToolUse", "Bash", NEW)]);
    const result1 = mergeSettings(current, wanted1, new Set());
    expect(result1.changed).toBe(false);

    // With env → hooks unchanged (D4: env-only change), both copies stay
    const wanted2 = W(["ACME_TOKEN"], [reg("PreToolUse", "Bash", NEW)]);
    const result2 = mergeSettings(current, wanted2, new Set());
    expect(result2.changed).toBe(true);
    const hooks2 = result2.value.hooks as Record<string, unknown[]>;
    expect(hooks2.PreToolUse).toHaveLength(2); // Both copies stay (env-only change)

    // With recorded OLD and extra group → duplicates removed
    const currentWithOld = nul({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [NEW] }, { matcher: "Bash", hooks: [NEW] }, { hooks: [OLD] }] },
    }) as Record<string, unknown>;
    const recorded = new Set([handlerHash("PreToolUse", undefined, OLD)]);
    const result3 = mergeSettings(currentWithOld, wanted1, recorded);
    expect(result3.diff.duplicatesRemoved).toBe(1);
    expect(result3.diff.removed).toHaveLength(1);
  });

  it("M8. groups: LOCAL in same group as OLD kept, emptied group with description kept with hooks:[] (emptiedKept 1)", () => {
    const current = nul({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [LOCAL, OLD] },
          { matcher: "X", description: "d", hooks: [OLD] },
        ],
        Stop: [],
      },
    }) as Record<string, unknown>;

    const recorded = new Set([
      handlerHash("PreToolUse", "Bash", OLD),
      handlerHash("PreToolUse", "X", OLD),
    ]);
    const wanted = W([], [reg("PreToolUse", "Bash", NEW)]);

    const result = mergeSettings(current, wanted, recorded);

    const hooks = result.value.hooks as Record<string, unknown[]>;

    // LOCAL kept in first group
    expect((hooks.PreToolUse[0] as Record<string, unknown>).hooks).toEqual([LOCAL]);

    // Emptied group with description kept with hooks:[]
    expect(hooks.PreToolUse[1]).toEqual(nul({ matcher: "X", description: "d", hooks: [] }));

    // NEW appended
    expect(hooks.PreToolUse[2]).toEqual(nul({ matcher: "Bash", hooks: [NEW] }));

    // Stop kept (was empty before)
    expect(hooks.Stop).toEqual([]);

    expect(result.diff.emptiedKept).toBe(1);
  });

  it("M9. event emptied by removal goes: Stop:[{hooks:[OLD]}] recorded → no Stop key after merge", () => {
    const current = nul({
      hooks: { Stop: [{ hooks: [OLD] }] },
    }) as Record<string, unknown>;

    const recorded = new Set([handlerHash("Stop", undefined, OLD)]);
    const wanted = W([], [reg("PreToolUse", "Bash", NEW)]);

    const result = mergeSettings(current, wanted, recorded);

    const hooks = result.value.hooks as Record<string, unknown>;
    expect(Object.hasOwn(hooks, "Stop")).toBe(false);
  });

  it("M10. plan wants no hooks (D5): recorded OLD removed, env added, hooks empty object or no Stop", () => {
    const current = nul({
      hooks: { Stop: [{ hooks: [OLD] }] },
    }) as Record<string, unknown>;

    const recorded = new Set([handlerHash("Stop", undefined, OLD)]);
    const wanted = W(["A"], []); // No hooks wanted

    const result = mergeSettings(current, wanted, recorded);

    expect(result.changed).toBe(true);
    expect(result.value.env).toEqual(nul({ A: "" }));

    // hooks should be empty (Stop was the only event, and it was emptied by removal)
    const hooks = result.value.hooks as Record<string, unknown>;
    expect(Object.hasOwn(hooks, "Stop")).toBe(false);
  });

  it("M11. env: present names keep values, new names added empty, no env key when no wanted names", () => {
    const current = nul({
      env: { A: "", B: 5, C: "keep" },
    }) as Record<string, unknown>;

    const wanted = W(["A", "B", "D"], []);
    const result = mergeSettings(current, wanted, new Set());

    expect(result.value.env).toEqual(nul({ A: "", B: 5, C: "keep", D: "" }));
    expect(result.diff.envPresent).toBe(2); // A and B
    expect(result.diff.envAdded).toEqual(["D"]);

    // No wanted env names and no env key → no env key in value
    const current2 = nul({ permissions: {} }) as Record<string, unknown>;
    const wanted2 = W([], []);
    const result2 = mergeSettings(current2, wanted2, new Set());
    expect(Object.hasOwn(result2.value, "env")).toBe(false);
  });

  it("M12. sameCommandLocal: local handler with same command/args but different timeout → both present, sameCommandLocal 1", () => {
    const localWithDifferentTimeout = { ...NEW, timeout: 99 };
    const current = nul({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [localWithDifferentTimeout] }] },
    }) as Record<string, unknown>;

    const wanted = W([], [reg("PreToolUse", "Bash", NEW)]);
    const result = mergeSettings(current, wanted, new Set());

    // Both present
    const hooks = result.value.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(result.diff.sameCommandLocal).toBe(1);
  });

  it("M13. __proto__ key round-trips", () => {
    // Parse with reviver that builds null-prototype objects
    const json = '{"__proto__":{"a":1},"permissions":{}}';
    const reviver = (_key: string, value: unknown) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const out: Record<string, unknown> = Object.create(null);
        for (const k of Object.keys(value)) {
          out[k] = (value as Record<string, unknown>)[k];
        }
        return out;
      }
      return value;
    };
    const current = JSON.parse(json, reviver) as Record<string, unknown>;

    const wanted = W(["A"], []);
    const result = mergeSettings(current, wanted, new Set());

    expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
    expect(result.value["__proto__"]).toEqual(nul({ a: 1 }));
  });

  it("M14. shape refusals: each throws SettingsShapeError with exact message, none contains secret value", () => {
    const secret = "s3cr3t-value";

    // env []
    const c1 = nul({ env: [] }) as Record<string, unknown>;
    c1.env = []; // Force array
    (c1 as Record<string, unknown>).secretTest = secret;
    expect(() => mergeSettings(c1, W(["A"], []), new Set())).toThrow(SettingsShapeError);
    try { mergeSettings(c1, W(["A"], []), new Set()); } catch (e) {
      expect((e as Error).message).toContain("env is not an object");
      expect((e as Error).message).not.toContain(secret);
    }

    // hooks []
    const c2 = nul({ hooks: [], env: { SECRET: secret } }) as Record<string, unknown>;
    c2.hooks = [];
    expect(() => mergeSettings(c2, W([], [reg("E", "M", NEW)]), new Set())).toThrow(SettingsShapeError);
    try { mergeSettings(c2, W([], [reg("E", "M", NEW)]), new Set()); } catch (e) {
      expect((e as Error).message).toContain("hooks is not an object");
      expect((e as Error).message).not.toContain(secret);
    }

    // hooks {PreToolUse:{}}
    const c3 = nul({ hooks: { PreToolUse: {} }, env: { SECRET: secret } }) as Record<string, unknown>;
    expect(() => mergeSettings(c3, W([], [reg("PreToolUse", "M", NEW)]), new Set())).toThrow(SettingsShapeError);
    try { mergeSettings(c3, W([], [reg("PreToolUse", "M", NEW)]), new Set()); } catch (e) {
      expect((e as Error).message).toContain("is not a list");
      expect((e as Error).message).not.toContain(secret);
    }

    // hooks {PreToolUse:[3]}
    const c4 = nul({ hooks: { PreToolUse: [3] }, env: { SECRET: secret } }) as Record<string, unknown>;
    expect(() => mergeSettings(c4, W([], [reg("PreToolUse", "M", NEW)]), new Set())).toThrow(SettingsShapeError);
    try { mergeSettings(c4, W([], [reg("PreToolUse", "M", NEW)]), new Set()); } catch (e) {
      expect((e as Error).message).toContain("not an object with a hooks list");
      expect((e as Error).message).not.toContain(secret);
    }

    // hooks {"bad key!":[3]} → prints #1
    const c5: Record<string, unknown> = Object.create(null);
    c5.hooks = Object.create(null);
    (c5.hooks as Record<string, unknown>)["bad key!"] = [3];
    c5.env = Object.create(null);
    (c5.env as Record<string, unknown>).SECRET = secret;
    expect(() => mergeSettings(c5, W([], [reg("bad key!", "M", NEW)]), new Set())).toThrow(SettingsShapeError);
    try { mergeSettings(c5, W([], [reg("bad key!", "M", NEW)]), new Set()); } catch (e) {
      expect((e as Error).message).toContain("#1");
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("M15. handlerHash: '-' matcher !== undefined matcher", () => {
    const h = { type: "command", command: "test" };
    expect(handlerHash("E", "-", h)).not.toBe(handlerHash("E", undefined, h));
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
    const result = await recordApplied(home, s.wsRoot, hashes);

    expect(result).toBe("written");

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
