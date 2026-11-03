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
   * Spec 56 §4.4's table. An override shares its root base's ref, so a resolution compared with a Forge ingredient by
   * ref alone can read an override as its root base. Every file under src/ that compares a resolution's ingredients by
   * ref — `.ingredients.some((i) => i.ref === …)`, `.ingredients.find((i) => i.ref === …)`, a ref set built with
   * `.ingredients.map((i) => i.ref)`, or `resolvedBy(…)` — is placed here with the reason it is safe; a new one fails
   * the scan until it is placed, or goes through `holdsIngredient`.
   */
  /** The number of matches each file holds today: a new comparison in a listed file fails too, until it is counted here. */
  const COUNT: Record<string, number> = {};
  const TABLE: Record<string, string> = {
    "src/core/profile-local.ts": "holdsIngredient itself: ref and folder",
    "src/core/report.ts": "looks up a planned file's ingredient in the same plan's resolution (one view)",
    "src/core/sync.ts": "looks up a status row's ingredient in the same plan's resolution (one view)",
    "src/core/catalogue.ts": "inUse against the context's own resolution; with a context the overridden root row is left out",
    "src/core/param-writes.ts": "resolvedBy is asked about a variant's ref (`<name>--<p>`), never a local's (L6)",
    "src/core/promote.ts": "the proof compares a profile's refs before and after with itself (one view per profile)",
    "src/importers/drift-promote.ts": "the promoting workspace's own plans (one view), and resolvedBy about a variant's ref (L6)",
    "src/importers/claude-code.ts": "the importing profile's own view, and resolvedBy about a variant's ref (L6)",
    "src/cli.ts": "rows of the catalogue's own result, not a resolution",
  };
  const COUNTED: Record<string, number> = {
    "src/cli.ts": 4,
    "src/core/catalogue.ts": 2,
    "src/core/param-writes.ts": 6,
    "src/core/profile-local.ts": 2,
    "src/core/promote.ts": 2,
    "src/core/report.ts": 2,
    "src/core/sync.ts": 2,
    "src/importers/claude-code.ts": 8,
    "src/importers/drift-promote.ts": 10,
  };
  const PATTERN = /\.ingredients\.(some|find)\(\(\w+\) => \w+\.ref === |\.ingredients\.map\(\(\w+\) => \w+\.ref\)|resolvedBy\(/;
  it("every file under src/ comparing a resolution's ingredients by ref is in the table", async () => {
    const root = path.resolve(__dirname, "..");
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.name.endsWith(".ts")) {
          const n = (await fs.readFile(abs, "utf8")).split(new RegExp(PATTERN.source, "g")).length - 1;
          if (n > 0) {
            const rel = path.relative(root, abs).split(path.sep).join("/");
            found.push(rel);
            COUNT[rel] = n;
          }
        }
      }
    };
    await walk(path.join(root, "src"));
    expect(found.filter((f) => !(f in TABLE))).toEqual([]);
    expect(Object.keys(TABLE).filter((f) => !found.includes(f))).toEqual([]); // no stale row
    expect(COUNT).toEqual(COUNTED);
  });
});
