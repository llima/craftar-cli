import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { forgeFor } from "../src/core/profile-local.js";
import type { IngredientRef } from "../src/schema/index.js";
import { rule } from "./helpers/forge.js";
import { build, CASE2, fileOf, localRule, OVERRIDDEN, OVERRIDE_FILES, planFor } from "./helpers/local-override.js";

/** Spec 56 §4.2–§4.3: an override loads at the gate, L1 keeps the rest, and the view gives the local over the root. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const Y = "rule/y" as IngredientRef;

describe("an override at load (spec 56 §4.2)", () => {
  it("at the gate, a local with a root base's ref loads, and only acme's view holds the local", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    const f = await loadForge(s.forge);
    expect(forgeFor(f, "acme").ingredients.get(Y)!.dir).toBe(path.join(s.forge, "profiles/acme/ingredients/rules/y"));
    expect(forgeFor(f, "globex").ingredients.get(Y)!.dir).toBe(path.join(s.forge, "ingredients/rules/y"));
  });

  it("at the gate, a local with a root variant's ref fails the load (L1)", async () => {
    const spec = { ...OVERRIDDEN, ingredients: [...OVERRIDDEN.ingredients!, rule("y-shared", "# S\n", { as: "y" })] };
    const s = await build(cleanups, spec, { extra: localRule("acme", "y-shared", "# A\n"), git: false });
    await expect(loadForge(s.forge)).rejects.toThrow(
      "L1 profiles/acme/ingredients/rules/y-shared and ingredients/rules/y-shared: a local ingredient and a root variant of the same ref — a local overrides a root base only",
    );
  });

  it("at the gate, a local beside the root ingredient <name>--<p> still fails (L1)", async () => {
    const s = await build(cleanups, CASE2, { extra: localRule("acme", "y", "# A\n"), git: false });
    await expect(loadForge(s.forge)).rejects.toThrow(
      "L1 profiles/acme/ingredients/rules/y and ingredients/rules/y--acme: a local ingredient and the root variant of the same name for its own profile",
    );
  });

  it("below the gate, an override fails the load with today's L1 message", async () => {
    const s = await build(cleanups, OVERRIDDEN, { schema: 9, extra: OVERRIDE_FILES, git: false });
    await expect(loadForge(s.forge)).rejects.toThrow(
      "L1 profiles/acme/ingredients/rules/y and ingredients/rules/y: the same ingredient, local to profile acme and at the root",
    );
  });
});

describe("an override at resolution (spec 56 §4.3)", () => {
  it("the root recipe reaches the override for acme only: acme writes acme's text, globex the root's", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    expect(fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md")).toBe("# Y for acme\n");
    expect(fileOf(await planFor(s.root, s.forge, "globex"), ".claude/rules/y.md")).toBe("# Y shared\n");
  });

  it("overrides.ingredients.disable: rule/y drops the override from acme's workspace (spec 56 test 6)", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    expect(fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md")).toBe("# Y for acme\n");
    const p = await planFor(s.root, s.forge, "acme", { overrides: { ingredients: { disable: ["rule/y"] } } });
    expect(p.files.map((f) => f.path)).not.toContain(".claude/rules/y.md");
  });
});
