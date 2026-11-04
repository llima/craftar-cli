import { describe, expect, it } from "vitest";
import { IngredientSchema, type Ingredient } from "../src/schema/index.js";
import { carryInto, isScriptOrHook } from "../src/importers/decide.js";

/**
 * Tests for carryInto — the unified function for carrying Forge-only keys
 * (authEnv, registration, params) from a base or existing ingredient into
 * a variant or local rewrite.
 *
 * Spec references:
 * - MCP authEnv: spec 27 §5.3
 * - Hook registration and params: spec 43 §7.2 row 10
 */

/** Build a hook ingredient with registration citing given param keys via {{key}} in args. */
function hookWithRegistration(
  name: string,
  paramDecls: Record<string, { default: string }>,
  citedKeys: string[],
): Ingredient {
  return IngredientSchema.parse({
    type: "hook",
    name,
    files: [`${name}.sh`],
    params: paramDecls,
    registration: [
      {
        event: "PreToolUse",
        command: `.claude/hooks/${name}.sh`,
        args: citedKeys.map((k) => `{{${k}}}`),
      },
    ],
  });
}

/** Build a hook ingredient without registration. */
function hookNoRegistration(name: string, params?: Record<string, { default: string }>): Ingredient {
  return IngredientSchema.parse({
    type: "hook",
    name,
    files: [`${name}.sh`],
    ...(params ? { params } : {}),
  });
}

/** Build an mcp ingredient with optional authEnv. */
function mcpIngredient(name: string, authEnv?: string[]): Ingredient {
  return IngredientSchema.parse({
    type: "mcp",
    name,
    server: { command: "node", args: ["server.js"] },
    ...(authEnv ? { authEnv } : {}),
  });
}

/** Build a rule ingredient for non-hook/non-mcp tests. */
function ruleIngredient(name: string): Ingredient {
  return IngredientSchema.parse({
    type: "rule",
    name,
    file: "rule.md",
  });
}

describe("carryInto — unified carry for variants and locals", () => {
  it("C1: new hook variant from a base — carries registration and only cited params", () => {
    // Base hook/h with params {a, b}, registration citing only {{a}}
    const base = hookWithRegistration("h", { a: { default: "1" }, b: { default: "2" } }, ["a"]);
    // Meta hook/h--acme with no params (a new variant)
    const meta = IngredientSchema.parse({
      type: "hook",
      name: "h--acme",
      files: ["h.sh"],
      as: "h",
    });

    const result = carryInto(meta, base, null);

    // Expect registration deep-equal to base's
    expect(result.type).toBe("hook");
    expect((result as { registration?: unknown[] }).registration).toEqual(base.registration);
    // Expect params = {a: {default: "1"}} (b not cited)
    expect((result as { params?: Record<string, unknown> }).params).toEqual({ a: { default: "1" } });
  });

  it("C2: existing variant decides — uses existing's registration, takes b from base, c from variant", () => {
    // Base as C1: hook/h with params {a, b}, registration citing {{a}}
    const base = hookWithRegistration("h", { a: { default: "1" }, b: { default: "2" } }, ["a"]);
    // Existing hook/h--acme with its own registration citing {{b}}, {{c}} and params {b, c}
    const existing = IngredientSchema.parse({
      type: "hook",
      name: "h--acme",
      files: ["h.sh"],
      as: "h",
      params: { b: { default: "own-b" }, c: { default: "own-c" } },
      registration: [
        {
          event: "Stop",
          command: ".claude/hooks/h.sh",
          args: ["{{b}}", "{{c}}"],
        },
      ],
    });
    // Meta hook/h--acme (the new source, no params)
    const meta = IngredientSchema.parse({
      type: "hook",
      name: "h--acme",
      files: ["h.sh"],
      as: "h",
    });

    const result = carryInto(meta, base, existing);

    // Expect registration = existing's
    expect((result as { registration?: unknown[] }).registration).toEqual(existing.registration);
    // Expect params = {b: {default: "2"}, c: {default: "own-c"}} — b from base, c from variant's own
    expect((result as { params?: Record<string, unknown> }).params).toEqual({
      b: { default: "2" },
      c: { default: "own-c" },
    });
  });

  it("C2b: a key the existing registration cites and only the base declares is carried with the base's entry", () => {
    const base = hookWithRegistration("h", { b: { default: "2" } }, ["b"]);
    const existing = IngredientSchema.parse({
      type: "hook",
      name: "h--acme",
      files: ["h.sh"],
      as: "h",
      registration: [{ event: "Stop", command: ".claude/hooks/h.sh", args: ["{{b}}", "{{d}}"] }],
    });
    const meta = IngredientSchema.parse({ type: "hook", name: "h--acme", files: ["h.sh"], as: "h" });
    const result = carryInto(meta, base, existing);
    expect((result as { registration?: unknown[] }).registration).toEqual(existing.registration);
    expect((result as { params?: Record<string, unknown> }).params).toEqual({ b: { default: "2" } });
  });

  it("C3: existing hook without registration — result has no registration, params as meta's", () => {
    const base = hookWithRegistration("h", { a: { default: "1" } }, ["a"]);
    const existing = hookNoRegistration("h--acme", { x: { default: "existing-x" } });
    const meta = IngredientSchema.parse({
      type: "hook",
      name: "h--acme",
      files: ["h.sh"],
      as: "h",
      params: { y: { default: "meta-y" } },
    });

    const result = carryInto(meta, base, existing);

    // No registration
    expect((result as { registration?: unknown[] }).registration).toBeUndefined();
    // Params as meta's (unchanged)
    expect((result as { params?: Record<string, unknown> }).params).toEqual({ y: { default: "meta-y" } });
  });

  it("C4: local rewrite (base null) — carries existing's registration and cited params", () => {
    // Existing hook with registration citing {{a}}, params {a, z}
    const existing = IngredientSchema.parse({
      type: "hook",
      name: "local-hook",
      files: ["local-hook.sh"],
      params: { a: { default: "x" }, z: { default: "z-val" } },
      registration: [
        {
          event: "PreToolUse",
          command: ".claude/hooks/local-hook.sh",
          args: ["{{a}}"],
        },
      ],
    });
    const meta = IngredientSchema.parse({
      type: "hook",
      name: "local-hook",
      files: ["local-hook.sh"],
    });

    const result = carryInto(meta, null, existing);

    // Registration from existing
    expect((result as { registration?: unknown[] }).registration).toEqual(existing.registration);
    // Params = {a: {default: "x"}} — only the cited one
    expect((result as { params?: Record<string, unknown> }).params).toEqual({ a: { default: "x" } });
  });

  it("C5: mcp new — inherits authEnv from base", () => {
    const base = mcpIngredient("server-a", ["TOKEN_A"]);
    const meta = mcpIngredient("server-a--acme");

    const result = carryInto(meta, base, null);

    expect((result as { authEnv?: string[] }).authEnv).toEqual(["TOKEN_A"]);
  });

  it("C6: mcp existing without authEnv — no authEnv on result", () => {
    const base = mcpIngredient("server-a", ["TOKEN_A"]);
    const existing = mcpIngredient("server-a--acme"); // no authEnv
    const meta = mcpIngredient("server-a--acme");

    const result = carryInto(meta, base, existing);

    // existing decides; existing has no authEnv
    expect((result as { authEnv?: string[] }).authEnv).toBeUndefined();
  });

  it("C7: mcp existing with authEnv — uses existing's authEnv", () => {
    const base = mcpIngredient("server-a", ["TOKEN_A"]);
    const existing = mcpIngredient("server-a--acme", ["TOKEN_B"]);
    const meta = mcpIngredient("server-a--acme");

    const result = carryInto(meta, base, existing);

    expect((result as { authEnv?: string[] }).authEnv).toEqual(["TOKEN_B"]);
  });

  it("C8: a rule meta — returned unchanged, inputs not mutated", () => {
    const meta = ruleIngredient("my-rule");
    const base = ruleIngredient("my-rule");
    const existing = ruleIngredient("my-rule--acme");

    // Snapshot inputs before
    const metaBefore = structuredClone(meta);
    const baseBefore = structuredClone(base);
    const existingBefore = structuredClone(existing);

    const result = carryInto(meta, base, existing);

    // Result is deep-equal to meta (or same object)
    expect(result).toEqual(meta);
    // Inputs not mutated
    expect(meta).toEqual(metaBefore);
    expect(base).toEqual(baseBefore);
    expect(existing).toEqual(existingBefore);
  });
});

describe("isScriptOrHook helper", () => {
  it("C9: returns true for script and hook, false for rule and skill", () => {
    expect(isScriptOrHook({ type: "script" })).toBe(true);
    expect(isScriptOrHook({ type: "hook" })).toBe(true);
    expect(isScriptOrHook({ type: "rule" })).toBe(false);
    expect(isScriptOrHook({ type: "skill" })).toBe(false);
    expect(isScriptOrHook({ type: "mcp" })).toBe(false);
    expect(isScriptOrHook({ type: "agent" })).toBe(false);
    expect(isScriptOrHook({ type: "command" })).toBe(false);
    expect(isScriptOrHook({ type: "steering" })).toBe(false);
    expect(isScriptOrHook({ type: "service" })).toBe(false);
  });
});
