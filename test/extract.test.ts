import path from "node:path";
import { describe, expect, it } from "vitest";
import { IngredientSchema } from "../src/schema/index.js";
import { emittedFile } from "../src/core/extract.js";

describe("emittedFile resolves a declared file the way the emitters read it (0.8.2)", () => {
  const dir = path.join(path.sep, "forge", "ingredients", "rules", "r");
  const rule = (file: string) => IngredientSchema.parse({ type: "rule", name: "r", file });
  it("accepts every spelling path.join resolves to the listed file, on every platform", () => {
    for (const f of ["rule.md", "./rule.md", "/rule.md", ".//rule.md", "a/../rule.md", "../r/rule.md", "a/../../r/rule.md"]) {
      expect(emittedFile(rule(f), "rule.md", dir), f).toBe(true);
    }
    expect(emittedFile(rule("rule.md"), "notes.md", dir)).toBe(false);
    expect(emittedFile(rule("../other/rule.md"), "rule.md", dir)).toBe(false);
  });
  it("treats a backslash as a separator only where path.join does", () => {
    const win = process.platform === "win32";
    expect(emittedFile(rule(".\\rule.md"), "rule.md", dir)).toBe(win);
    expect(emittedFile(rule("\\rule.md"), "rule.md", dir)).toBe(win);
    expect(emittedFile(rule("sub\\rule.md"), "sub/rule.md", dir)).toBe(win);
  });
  it("matches script files the same way", () => {
    const s = IngredientSchema.parse({ type: "script", name: "s", files: ["./run.sh", "../s/x.sh"] });
    const sdir = path.join(path.sep, "forge", "ingredients", "scripts", "s");
    expect(emittedFile(s, "run.sh", sdir)).toBe(true);
    expect(emittedFile(s, "x.sh", sdir)).toBe(true);
    expect(emittedFile(s, "y.sh", sdir)).toBe(false);
  });
});
