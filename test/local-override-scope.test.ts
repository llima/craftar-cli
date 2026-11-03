import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { applyBasePromotion, planBasePromotion, proveBasePromotion } from "../src/core/promote.js";
import { localCiters } from "../src/core/profile-local.js";
import { planLocalize } from "../src/core/localize.js";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { build, fileOf, localRecipe, localRule, OVERRIDDEN, OVERRIDE_FILES, planFor } from "./helpers/local-override.js";

/** Spec 56 §4.4: a ref is no longer one identity across views — the writers compare a resolved ingredient by scope. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const SPEC: ForgeSpec = {
  ingredients: [...OVERRIDDEN.ingredients!, rule("y--globex", "# Y g\n", { as: "y" })],
  recipes: [...OVERRIDDEN.recipes!, recipe("base--globex", ["rule/style", "rule/y--globex"])],
  profiles: [profile("acme", ["base", "acme-local"]), profile("globex", ["base--globex"]), profile("initech", ["base"])],
};
const FILES = { ...OVERRIDE_FILES, ...localRecipe("acme", "acme-local", ["rule/y"]) };

describe("identity by scope (spec 56 §4.4)", () => {
  it("forge promote of the root rule/y while acme overrides it — cited by base and acme-local — leaves acme untouched", async () => {
    const s = await build(cleanups, SPEC, { extra: FILES });
    const before = fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md");
    expect(before).toBe("# Y for acme\n");
    const f = await loadForge(s.forge);
    const promo = await planBasePromotion(f, "rule/y", "globex");
    expect(promo.created).toEqual(["rule/y--initech"]);
    expect(promo.profiles).toEqual(["initech"]);
    await proveBasePromotion(f, promo);
    await applyBasePromotion(promo, []);
    expect(fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md")).toBe(before);
    expect(fileOf(await planFor(s.root, s.forge, "globex"), ".claude/rules/y.md")).toBe("# Y g\n");
    expect(fileOf(await planFor(s.root, s.forge, "initech"), ".claude/rules/y.md")).toBe("# Y shared\n");
  });

  it("localCiters does not count a local recipe citing its own profile's override", async () => {
    const s = await build(cleanups, SPEC, { extra: FILES, git: false });
    const f = await loadForge(s.forge);
    expect(localCiters(f, ["rule/y"])).toEqual([]);
    expect(localCiters(f, ["rule/y"], { profile: "acme", viaExtends: true })).toEqual([]);
  });

  it("localCiters still counts a local recipe citing a root ingredient its profile does not override", async () => {
    const s = await build(cleanups, SPEC, { extra: { ...FILES, ...localRecipe("acme", "acme-more", ["rule/style"]) }, git: false });
    const f = await loadForge(s.forge);
    expect(localCiters(f, ["rule/style"])).toEqual([{ profile: "acme", recipe: "acme-more", file: "profiles/acme/recipes/acme-more.yaml" }]);
  });

  it("forge localize of the root rule/y for globex does not read acme's override as acme resolving the root rule/y", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n")],
      recipes: [recipe("base", ["rule/style"]), recipe("stack-y", ["rule/y"])],
      profiles: [profile("acme", ["base", "acme-local"]), profile("globex", ["base", "stack-y"])],
    };
    const s = await build(cleanups, spec, { extra: { ...localRule("acme", "y", "# Y for acme\n"), ...localRecipe("acme", "acme-local", ["rule/y"]) }, git: false });
    const move = await planLocalize(await loadForge(s.forge), "rule/y", "globex");
    expect(move.moved).toEqual({ from: "ingredients/rules/y", to: "profiles/globex/ingredients/rules/y" });
  });
});

describe("one comparison by scope (spec 56 §4.4)", () => {
  /**
   * A resolution compared with a Forge ingredient by ref alone reads an override as its root base. The files below may
   * still test `.ingredients.some((i) => i.ref === …)`, each for a reason: `profile-local.ts` is `holdsIngredient` itself,
   * and import's check of its run's locals (`claude-code.ts`) asks the importing profile's own resolution about refs of
   * that profile's view. A new file with the pattern must be placed here, or go through `holdsIngredient`.
   */
  const ALLOWED = new Set(["src/core/profile-local.ts", "src/importers/claude-code.ts"]);
  it("no other file under src/ compares a resolution's ingredients by ref", async () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.name.endsWith(".ts")) {
          const rel = path.relative(root, abs).split(path.sep).join("/");
          const text = await fs.readFile(abs, "utf8");
          if (/\.ingredients\.some\(\(\w+\) => \w+\.ref === /.test(text) && !ALLOWED.has(rel)) offenders.push(rel);
        }
      }
    };
    await walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});
