import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { loadForge, type Forge } from "../src/core/forge.js";
import { WorkspaceConfigSchema } from "../src/schema/index.js";
import { editRecipesText, planRecipeEdit, recipeDiffLine, slotHeld } from "../src/core/recipe-edit.js";

/**
 * Spec 22 §9's Forge: `stack-api` extends `base`; `front-a`, `front-b` and `front-c` share slot
 * `front`; profile `acme` resolves `[stack-api, front-a]`.
 */
let forge: Forge;
let root: string;
beforeAll(async () => {
  root = await tmpDir("craftar-recipe-edit-");
  await makeForge(root, {
    ingredients: [
      rule("base", "base\n"),
      rule("api", "api\n"),
      rule("front-a", "front a\n"),
      rule("front-b", "front b\n"),
      rule("front-c", "owner {{owner}}\n"),
    ],
    recipes: [
      recipe("base", ["rule/base"]),
      recipe("stack-api", ["rule/api"], { extends: ["base"] }),
      recipe("front-a", ["rule/front-a"], { slot: "front" }),
      recipe("front-b", ["rule/front-b"], { slot: "front" }),
      recipe("front-c", ["rule/front-c"], { slot: "front" }),
    ],
    profiles: [profile("acme", ["stack-api", "front-a"])],
  });
  forge = await loadForge(root);
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

const config = (add: string[] = [], remove: string[] = []) =>
  WorkspaceConfigSchema.parse({ forge: "../forge", profile: "acme", recipes: { add, remove } });

describe("planRecipeEdit (spec 22 §3.1–§3.3)", () => {
  it("add: a slot held by another recipe is refused without --replace (R3)", () => {
    expect(() => planRecipeEdit(forge, config(), "add", ["front-b"])).toThrow(
      new Error('recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them'),
    );
  });

  it("add --replace swaps the holder out", () => {
    expect(planRecipeEdit(forge, config(), "add", ["front-b"], { replace: true })).toEqual({
      recipes: { add: ["front-b"], remove: ["front-a"] },
      changed: true,
      reasons: [],
    });
  });

  it("swapping back cancels both entries (Ruling 5)", () => {
    expect(planRecipeEdit(forge, config(["front-b"], ["front-a"]), "add", ["front-a"], { replace: true })).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
  });

  it("remove of a recipe extends brings in is refused, naming the top-level recipe (R4)", () => {
    expect(() => planRecipeEdit(forge, config(), "remove", ["base"])).toThrow(
      new Error('recipe "base" comes in through "stack-api" (extends) — remove "stack-api", or change the Forge'),
    );
  });

  it("remove of a profile recipe appends it to recipes.remove", () => {
    expect(planRecipeEdit(forge, config(), "remove", ["stack-api"])).toEqual({
      recipes: { add: [], remove: ["stack-api"] },
      changed: true,
      reasons: [],
    });
  });

  it("add of a resolved recipe changes nothing, with its reason", () => {
    expect(planRecipeEdit(forge, config(), "add", ["stack-api"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: ["stack-api is already in use"],
    });
  });

  it("add of a recipe reached only through extends changes nothing (§14 item 10)", () => {
    expect(planRecipeEdit(forge, config(), "add", ["base"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: ["base is already in use"],
    });
  });

  it("remove of a recipe not in use changes nothing, with its reason", () => {
    expect(planRecipeEdit(forge, config(), "remove", ["front-b"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: ["front-b is not in use"],
    });
  });

  it("several no-op names give one reason each, in the order given", () => {
    expect(planRecipeEdit(forge, config(), "add", ["base", "stack-api"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: ["base is already in use", "stack-api is already in use"],
    });
  });

  it("an unknown name is refused with the Forge's names sorted (R2)", () => {
    expect(() => planRecipeEdit(forge, config(), "add", ["nope"])).toThrow(
      new Error('recipe "nope" not found in this Forge (base, front-a, front-b, front-c, stack-api)'),
    );
    expect(() => planRecipeEdit(forge, config(), "remove", ["nope"])).toThrow(
      new Error('recipe "nope" not found in this Forge (base, front-a, front-b, front-c, stack-api)'),
    );
  });

  it("a name given twice is refused (R7)", () => {
    expect(() => planRecipeEdit(forge, config(), "add", ["front-b", "front-b"], { replace: true })).toThrow(
      new Error('recipe "front-b" is named twice'),
    );
  });

  it("all or nothing: an unknown name after a good one refuses the call (R2)", () => {
    expect(() => planRecipeEdit(forge, config(), "add", ["front-b", "nope"], { replace: true })).toThrow(
      new Error('recipe "nope" not found in this Forge (base, front-a, front-b, front-c, stack-api)'),
    );
  });

  it("an inert hand-written remove is cancelled by add", () => {
    expect(planRecipeEdit(forge, config([], ["base"]), "add", ["base"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
  });

  it("remove cleans an unknown name out of recipes.add or recipes.remove (§14 item 9)", () => {
    expect(planRecipeEdit(forge, config(["nope"]), "remove", ["nope"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
    expect(planRecipeEdit(forge, config([], ["nope"]), "remove", ["nope"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
  });

  it("the cleanup works in any position of the call", () => {
    expect(planRecipeEdit(forge, config(["nope"]), "remove", ["stack-api", "nope"])).toEqual({
      recipes: { add: [], remove: ["stack-api"] },
      changed: true,
      reasons: [],
    });
  });

  it("an inert unknown name in recipes.remove is left in place by another call", () => {
    expect(planRecipeEdit(forge, config([], ["nope"]), "remove", ["stack-api"])).toEqual({
      recipes: { add: [], remove: ["nope", "stack-api"] },
      changed: true,
      reasons: [],
    });
  });

  it("swaps that undo each other end where they started: changed false, no reasons (§6 item 6)", () => {
    expect(planRecipeEdit(forge, config(), "add", ["front-b", "front-a"], { replace: true })).toEqual({
      recipes: { add: [], remove: [] },
      changed: false,
      reasons: [],
    });
  });

  it("--replace removes every other holder of the slot (§14 item 11)", () => {
    expect(planRecipeEdit(forge, config(["front-c"]), "add", ["front-b"], { replace: true })).toEqual({
      recipes: { add: ["front-b"], remove: ["front-a"] },
      changed: true,
      reasons: [],
    });
  });

  it("the slot check runs for a name that changed nothing (§3.2)", () => {
    expect(() => planRecipeEdit(forge, config(["front-b"]), "add", ["front-a"])).toThrow(
      new Error('recipe "front-a" occupies slot "front", held by "front-b" — pass --replace to swap them'),
    );
  });

  it("--replace with no slot conflict is the same as without it (§14 item 4)", () => {
    const want = { recipes: { add: [], remove: [] }, changed: true, reasons: [] };
    expect(planRecipeEdit(forge, config([], ["stack-api"]), "add", ["stack-api"], { replace: true })).toEqual(want);
    expect(planRecipeEdit(forge, config([], ["stack-api"]), "add", ["stack-api"])).toEqual(want);
  });

  it("remove of a recipes.add entry deletes it, the other entries kept in order", () => {
    expect(planRecipeEdit(forge, config(["front-b", "stack-api"], ["front-a"]), "remove", ["front-b"])).toEqual({
      recipes: { add: ["stack-api"], remove: ["front-a"] },
      changed: true,
      reasons: [],
    });
  });
  it("the whole result must resolve: a slot conflict the call does not name is R5", () => {
    expect(() => planRecipeEdit(forge, config(["front-b"]), "remove", ["stack-api"])).toThrow(
      new Error('recipes "front-a" and "front-b" both occupy slot "front"'),
    );
  });

  it("a call that only reorders a list changes nothing, and the original order is kept", () => {
    expect(planRecipeEdit(forge, config(["front-b"], ["front-a", "base"]), "add", ["front-a", "front-b"], { replace: true })).toEqual({
      recipes: { add: ["front-b"], remove: ["front-a", "base"] },
      changed: false,
      reasons: [],
    });
  });
  it("an unknown name already in recipes.add fails the final resolve, naming craftar.yaml (R5, §14 item 7)", () => {
    expect(() => planRecipeEdit(forge, config(["nope"]), "add", ["front-b"], { replace: true })).toThrow(
      new Error('recipe "nope" not found (referenced by craftar.yaml recipes.add)'),
    );
  });
  it("a name written twice by hand is deleted everywhere it appears (§10 criterion 4)", () => {
    expect(planRecipeEdit(forge, config([], ["stack-api", "stack-api"]), "add", ["stack-api"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
    expect(planRecipeEdit(forge, config(["front-b", "front-b"], ["front-a"]), "remove", ["front-b"])).toEqual({
      recipes: { add: [], remove: ["front-a"] },
      changed: true,
      reasons: [],
    });
    expect(planRecipeEdit(forge, config([], ["nope", "nope"]), "remove", ["nope"])).toEqual({
      recipes: { add: [], remove: [] },
      changed: true,
      reasons: [],
    });
  });
  it("a slot brought in through extends is not swapped by --replace: the whole result is R5", async () => {
    const other = await tmpDir("craftar-recipe-edit-slot-");
    try {
      await makeForge(other, {
        ingredients: [rule("a", "a\n"), rule("y", "y\n")],
        recipes: [
          recipe("front-a", ["rule/a"], { slot: "front" }),
          recipe("front-y", ["rule/y"], { slot: "front" }),
          recipe("stack-y", [], { extends: ["front-y"] }),
        ],
        profiles: [profile("acme", ["front-a"])],
      });
      const f = await loadForge(other);
      const conflict = new Error('recipes "front-a" and "front-y" both occupy slot "front"');
      expect(() => planRecipeEdit(f, config(), "add", ["stack-y"])).toThrow(conflict);
      expect(() => planRecipeEdit(f, config(), "add", ["stack-y"], { replace: true })).toThrow(conflict);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe("recipeDiffLine (spec 22 §3.3, line 1)", () => {
  it("additions per list, the two parts joined by ; ", () => {
    expect(recipeDiffLine({ add: [], remove: [] }, { add: ["front-b"], remove: ["front-a"] })).toBe(
      "recipes.add + front-b; recipes.remove + front-a",
    );
  });
  it("deletions with an ASCII hyphen-minus", () => {
    expect(recipeDiffLine({ add: ["front-b"], remove: ["front-a"] }, { add: [], remove: [] })).toBe(
      "recipes.add - front-b; recipes.remove - front-a",
    );
  });
  it("additions in final order, then deletions in original order, joined by , ; an unchanged list is omitted", () => {
    expect(recipeDiffLine({ add: ["x", "y"], remove: ["r"] }, { add: ["b", "a"], remove: ["r"] })).toBe(
      "recipes.add + b, + a, - x, - y",
    );
  });
});

describe("editRecipesText (spec 22 §5.1, §5.2, §6 items 1–3)", () => {
  const after = { add: ["front-b"], remove: ["front-a"] };
  it("recipes absent: a block mapping with only the filled lists", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\n", { add: ["front-b"], remove: [] }, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n",
    );
  });
  it("recipes: {} becomes block form", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes: {}\n", { add: ["front-b"], remove: [] }, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n",
    );
  });
  it("an unpadded flow mapping stays flow", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes: {add: [], remove: []}\n", after, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes: {add: [front-b], remove: [front-a]}\n",
    );
  });
  it("a one-space comment after a list is kept", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes:\n  add: [] # extra\n  remove: []\n", after, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add: [front-b] # extra\n  remove: [front-a]\n",
    );
  });
  it("CRLF and a BOM are kept", () => {
    expect(
      editRecipesText("﻿forge: ../forge\r\nprofile: acme\r\nrecipes: {add: [], remove: []}\r\n", { add: ["front-b"], remove: [] }, "add recipe"),
    ).toBe("﻿forge: ../forge\r\nprofile: acme\r\nrecipes: {add: [front-b], remove: []}\r\n");
  });
  it("CRLF and a BOM are kept for recipes absent, recipes: {} and a block form with a comment", () => {
    const bom = "\uFEFF";
    const head = "forge: ../forge\r\nprofile: acme\r\n";
    const one = { add: ["front-b"], remove: [] };
    expect(editRecipesText(bom + head, one, "add recipe")).toBe(bom + head + "recipes:\r\n  add:\r\n    - front-b\r\n");
    expect(editRecipesText(bom + head + "recipes: {}\r\n", one, "add recipe")).toBe(bom + head + "recipes:\r\n  add:\r\n    - front-b\r\n");
    expect(editRecipesText(bom + head + "recipes:\r\n  add: [] # extra\r\n  remove: []\r\n", after, "add recipe")).toBe(
      bom + head + "recipes:\r\n  add: [front-b] # extra\r\n  remove: [front-a]\r\n",
    );
  });
  it("an emptied block list is written []", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n", { add: [], remove: [] }, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add: []\n  remove: []\n",
    );
  });
  it("a kept item keeps its own comment", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b # mine\n  remove: []\n", { add: ["front-b", "front-c"], remove: [] }, "add recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b # mine\n    - front-c\n  remove: []\n",
    );
  });
  it("a removed item's comment goes with it", () => {
    expect(editRecipesText("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b # mine\n    - front-c\n", { add: ["front-c"], remove: [] }, "remove recipe")).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-c\n",
    );
  });
  it("a duplicate written by hand keeps each copy's own comment when its list is left as it is", () => {
    expect(
      editRecipesText("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b # mine\n    - front-b\n  remove: []\n", { add: ["front-b", "front-b"], remove: ["front-a"] }, "add recipe"),
    ).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b # mine\n    - front-b\n  remove: [front-a]\n");
  });
  it("the README's craftar.yaml example is edited in place, comments kept", async () => {
    // A Windows checkout may hold the README with CRLF (core.autocrlf); the example is compared as LF.
    const readme = (await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8")).replace(/\r\n/g, "\n");
    const example = readme.match(/Workspace `craftar\.yaml`:\n\n```yaml\n([\s\S]*?)```/)![1];
    expect(editRecipesText(example, { add: ["react-front"], remove: ["angular-front"] }, "add recipe")).toBe(
      "forge: ../forge # a path, or a git URL (see Remote Forge)\n" +
        "ref: v1.4.0 # optional, with a git URL: a branch, a tag or a full SHA\n" +
        "profile: acme-portal\n" +
        "targets: [claude-code, kiro] # optional, overrides the profile\n" +
        "recipes: {add: [react-front], remove: [angular-front]} # edited by craftar add recipe / remove recipe\n" +
        "overrides:\n" +
        "  params: {}\n" +
        "  sections: {} # same shape as the profile's sections\n" +
        "  ingredients: {disable: []}\n",
    );
  });
  it("the README's padded flow form does not round-trip (R6)", () => {
    expect(() => editRecipesText("forge: ../forge\nprofile: acme\nrecipes: { add: [], remove: [] }\n", after, "add recipe")).toThrow(
      new Error("add recipe: cannot edit craftar.yaml in place (it does not round-trip unchanged through the YAML writer) — reformat it by hand and re-run"),
    );
  });
  it("names the command it runs for (R6)", () => {
    expect(() => editRecipesText("forge: ../forge\nprofile: acme   # aligned\nrecipes: {add: [], remove: []}\n", after, "remove recipe")).toThrow(
      new Error("remove recipe: cannot edit craftar.yaml in place (it does not round-trip unchanged through the YAML writer) — reformat it by hand and re-run"),
    );
  });
});


describe("slotHeld (spec 28 §5.2)", () => {
  it("R3 caught: slotHeld returns the fields, message matches, constructor is Error, no extra keys", () => {
    let e: unknown = null;
    try {
      planRecipeEdit(forge, config(), "add", ["front-b"]);
    } catch (err) {
      e = err;
    }
    expect(e).not.toBeNull();
    expect(slotHeld(e)).toEqual({ recipe: "front-b", slot: "front", holder: "front-a" });
    expect((e as Error).message).toBe('recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them');
    expect((e as Error).constructor).toBe(Error);
    expect(Object.keys(e as Error)).toEqual([]);
  });

  it("another refusal (R2) caught: slotHeld returns null; the text alone is not the tag", () => {
    let e: unknown = null;
    try {
      planRecipeEdit(forge, config(), "add", ["nope"]);
    } catch (err) {
      e = err;
    }
    expect(e).not.toBeNull();
    expect(slotHeld(e)).toBe(null);
    expect(slotHeld("x")).toBe(null);
    expect(slotHeld(new Error('recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them'))).toBe(null);
  });
});
