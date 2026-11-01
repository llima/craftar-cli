import path from "node:path";
import { describe, expect, it } from "vitest";
import { IngredientSchema } from "../src/schema/index.js";
import { emittedFile, bodyFile } from "../src/core/extract.js";

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
    const s = IngredientSchema.parse({ type: "script", name: "s", files: ["./run.sh", "a/../x.sh"] });
    const sdir = path.join(path.sep, "forge", "ingredients", "scripts", "s");
    expect(emittedFile(s, "run.sh", sdir)).toBe(true);
    expect(emittedFile(s, "x.sh", sdir)).toBe(true);
    expect(emittedFile(s, "y.sh", sdir)).toBe(false);
  });
});

describe("service ingredient emittedFile and bodyFile (spec 31)", () => {
  const dir = path.join(path.sep, "forge", "ingredients", "services", "s");
  const service = IngredientSchema.parse({
    type: "service",
    name: "s",
    compose: "./compose.yaml",
    files: ["init/a.sh", "logo.png"],
    binary: ["logo.png"],
  });

  it("emittedFile: compose.yaml is emitted (with dir)", () => {
    expect(emittedFile(service, "compose.yaml", dir)).toBe(true);
  });

  it("emittedFile: init/a.sh is emitted (with dir)", () => {
    expect(emittedFile(service, "init/a.sh", dir)).toBe(true);
  });

  it("emittedFile: logo.png is emitted (with dir)", () => {
    expect(emittedFile(service, "logo.png", dir)).toBe(true);
  });

  it("emittedFile: other.md is not emitted", () => {
    expect(emittedFile(service, "other.md", dir)).toBe(false);
  });

  it("emittedFile: compose.yaml with null dir is false (the ./compose.yaml spelling only resolves with dir)", () => {
    expect(emittedFile(service, "compose.yaml", null)).toBe(false);
  });

  it("bodyFile: compose.yaml is a body file (emitted and substituted)", () => {
    expect(bodyFile(service, "compose.yaml", dir, 1)).toBe(true);
  });

  it("bodyFile: init/a.sh is a body file (emitted and substituted, not in binary)", () => {
    expect(bodyFile(service, "init/a.sh", dir, 1)).toBe(true);
  });

  it("bodyFile: logo.png is NOT a body file (in binary, so not substituted)", () => {
    expect(bodyFile(service, "logo.png", dir, 1)).toBe(false);
  });

  it("bodyFile: binary: [./logo.png] also matches logo.png", () => {
    const s2 = IngredientSchema.parse({
      type: "service",
      name: "s",
      files: ["logo.png"],
      binary: ["./logo.png"],
    });
    expect(bodyFile(s2, "logo.png", dir, 1)).toBe(false);
  });

  it("bodyFile: other.md is not a body file (not emitted)", () => {
    expect(bodyFile(service, "other.md", dir, 1)).toBe(false);
  });

  it("bodyFile: with null dir, 'compose.yaml' is false (./compose.yaml declared, not string-equal)", () => {
    // service has compose: "./compose.yaml", asking for "compose.yaml" with null dir: not string-equal
    expect(bodyFile(service, "compose.yaml", null, 1)).toBe(false);
  });

  it("bodyFile: with null dir, './compose.yaml' is true (string-equal to declared)", () => {
    // service has compose: "./compose.yaml", asking for "./compose.yaml" with null dir: string-equal
    expect(bodyFile(service, "./compose.yaml", null, 1)).toBe(true);
  });
});
