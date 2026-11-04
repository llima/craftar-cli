import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { claudeResolves } from "../src/emitters/claude-code.js";
import type { Ingredient } from "../src/schema/index.js";

// Tech-debt E27.1: `claudeResolves` names a body file as `emittedFile` does, against the ingredient's directory.
// No import round trip pins it: a base whose `file` reads `../<dir>/rule.md` differs from the source's metadata
// (`file: rule.md`) and becomes a variant before any body is compared, with the mode on or off (measured 2026-11-04).

describe("claudeResolves with the ingredient's directory (E27.1)", () => {
  const dir = path.join(os.tmpdir(), "forge", "ingredients", "rules", "api");
  const meta = { type: "rule", name: "api", file: "../api/rule.md" } as unknown as Ingredient;

  it("names the file a `../<dir>/` spelling reaches", () => {
    expect(claudeResolves(meta, "rule.md", dir)).toBe(true);
    expect(claudeResolves(meta, "other.md", dir)).toBe(false);
  });

  it("with no directory, compares the spellings as before (`./rule.md` is `rule.md`)", () => {
    const m = { type: "rule", name: "api", file: "./rule.md" } as unknown as Ingredient;
    expect(claudeResolves(m, "rule.md", null)).toBe(true);
    expect(claudeResolves(meta, "rule.md", null)).toBe(false);
  });
});
