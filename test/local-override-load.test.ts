import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { forgeFor } from "../src/core/profile-local.js";
import type { IngredientRef } from "../src/schema/index.js";
import { rule } from "./helpers/forge.js";
import { build, bytesOf, CASE2, fileOf, localRecipe, localRule, OVERRIDDEN, OVERRIDE_FILES, planFor, S } from "./helpers/local-override.js";
import { runCli } from "./helpers/cli.js";

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
    const s = await build(cleanups, OVERRIDDEN, { schema: S - 1, extra: OVERRIDE_FILES, git: false });
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

describe("a Forge at the gate with no override (spec 56 §9)", () => {
  it("plans, warns, explains and lists as at schema 9, but for the catalogue's overrides: null", async () => {
    const spec = { ...CASE2, profiles: [...CASE2.profiles!.filter((p) => p.name !== "acme"), { ...CASE2.profiles!.find((p) => p.name === "acme")!, recipes: ["base--acme", "acme-extra"] }] };
    const extra = { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) };
    const at = async (schema: number) => {
      const s = await build(cleanups, spec, { schema, extra, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
      const strip = (t: string) => t.split(s.root).join("<root>");
      const rel = (x: string) => strip(x).replace(/forge test-forge @ \w+/, "forge test-forge @ <commit>");
      return {
        acme: bytesOf(await planFor(s.root, s.forge, "acme")),
        globex: bytesOf(await planFor(s.root, s.forge, "globex")),
        warnings: (await planFor(s.root, s.forge, "acme")).warnings,
        status: JSON.parse(rel(runCli(["status", "--json", "--workspace", s.ws.acme]).stdout)).statuses,
        explain: rel(runCli(["explain", ".claude/rules/x.md", "--workspace", s.ws.acme]).stdout),
        doctor: (JSON.parse(rel(runCli(["doctor", "--json", "--workspace", s.ws.acme]).stdout)) as { checks: Array<{ id: string; level: string }> }).checks.map((c) => `${c.id}:${c.level}`),
        catalogue: (JSON.parse(rel(runCli(["ingredients", "--forge", s.forge, "--json"]).stdout)) as { ingredients: Array<Record<string, unknown>> }).ingredients,
      };
    };
    const nine = await at(9);
    const ten = await at(S);
    expect(nine.catalogue.length).toBeGreaterThan(3);
    expect(nine.explain).toContain("source      profile acme (profiles/acme/ingredients/rules/x)");
    expect(Object.keys(nine.acme).length).toBeGreaterThan(1);
    expect(ten.catalogue.every((r) => r.overrides === null)).toBe(true);
    for (const r of ten.catalogue) delete r.overrides;
    expect(ten).toEqual(nine);
  });
});
