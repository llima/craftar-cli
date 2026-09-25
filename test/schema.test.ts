import { describe, expect, it } from "vitest";
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
