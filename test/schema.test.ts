import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { IngredientSchema, INGREDIENT_TYPES } from "../src/schema/index.js";

/** A minimal valid ingredient of each type. */
const MINIMAL: Record<(typeof INGREDIENT_TYPES)[number], Record<string, unknown>> = {
  rule: { type: "rule", name: "x" },
  agent: { type: "agent", name: "x" },
  command: { type: "command", name: "x" },
  skill: { type: "skill", name: "x" },
  mcp: { type: "mcp", name: "x", server: { command: "npx" } },
  script: { type: "script", name: "x", files: ["x.sh"] },
  steering: { type: "steering", name: "x" },
  hook: { type: "hook", name: "x", files: ["x.sh"] },
};

describe("strict ingredient keys", () => {
  for (const type of INGREDIENT_TYPES) {
    it(`accepts a minimal ${type} and refuses an unknown top-level key`, () => {
      expect(IngredientSchema.safeParse(MINIMAL[type]).success).toBe(true);
      const r = IngredientSchema.safeParse({ ...MINIMAL[type], foo: 1 });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["foo"], path: [] })]);
    });
  }

  it("refuses an unknown key inside origin", () => {
    const r = IngredientSchema.safeParse({ ...MINIMAL.rule, origin: { workspace: "acme", path: "a.md", line: 3 } });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["line"], path: ["origin"] })]);
  });

  it("reports every unknown key in one error", () => {
    const r = IngredientSchema.safeParse({ ...MINIMAL.rule, incluson: "always", origin: { workspace: "acme", path: "a.md", line: 3 } });
    expect(r.success).toBe(false);
    if (r.success) return;
    const keys = r.error.issues.filter((i) => i.code === "unrecognized_keys").map((i) => ({ path: i.path, keys: (i as { keys: string[] }).keys }));
    expect(keys).toEqual(expect.arrayContaining([{ path: [], keys: ["incluson"] }, { path: ["origin"], keys: ["line"] }]));
    expect(keys).toHaveLength(2);
  });

  it("refuses a top-level __proto__ key (spec 07 edge case 5)", () => {
    const input = JSON.parse('{"type":"rule","name":"x","__proto__":{"a":1}}');
    const r = IngredientSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["__proto__"] })]);
  });
});

describe("MCP server: validated, loaded as the original object (spec 07, Ruling 7)", () => {
  it("returns the same object, undeclared keys and source key order included", () => {
    const server = { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30, disabled: false };
    const parsed = IngredientSchema.parse({ type: "mcp", name: "r", server });
    if (parsed.type !== "mcp") throw new Error("expected an mcp ingredient");
    expect(parsed.server).toBe(server);
    expect(Object.keys(parsed.server)).toEqual(["type", "url", "headers", "timeout", "disabled"]);
  });

  it("keeps a __proto__ key under server and under env as an own property", () => {
    const meta = YAML.parse("type: mcp\nname: r\nserver:\n  command: npx\n  __proto__: { a: 1 }\n  env:\n    __proto__: x\n");
    const parsed = IngredientSchema.parse(meta);
    if (parsed.type !== "mcp") throw new Error("expected an mcp ingredient");
    expect(Object.hasOwn(parsed.server, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed.server.env ?? {}, "__proto__")).toBe(true);
  });

  it("still validates the declared keys, with their paths", () => {
    const r = IngredientSchema.safeParse({ type: "mcp", name: "r", server: { command: "npx", env: { PORT: 8080 } } });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path)).toEqual([["server", "env", "PORT"]]);
  });

  it("refuses a missing server and a non-object server", () => {
    for (const server of [undefined, []]) {
      const r = IngredientSchema.safeParse({ type: "mcp", name: "r", server });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues[0].path).toEqual(["server"]);
    }
  });
});
