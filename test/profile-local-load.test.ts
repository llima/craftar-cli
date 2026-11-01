import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { ProfileLocalLoadError } from "../src/core/profile-local.js";
import { profile, recipe, rule, tmpDir, makeForge, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/** Spec 51 §4.2: the local layer at load — what it holds, and L1–L9. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function forgeAt(schema: number, spec: ForgeSpec, files: Record<string, string> = {}): Promise<string> {
  const root = await tmpDir();
  roots.push(root);
  await makeForge(root, spec);
  await fs.writeFile(path.join(root, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(root, files);
  return root;
}

const localRule = (p: string, name: string, extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name, ...extra }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: `# ${name}\n`,
});
const localRecipe = (p: string, name: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients, ...extra }),
});

const base: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("core", ["rule/style"])],
  profiles: [profile("acme", ["core"]), profile("globex", ["core"])],
};

async function findings(root: string): Promise<string[]> {
  try {
    await loadForge(root);
  } catch (e) {
    if (e instanceof ProfileLocalLoadError) return e.findings;
    throw e;
  }
  return [];
}

describe("loadForge: the local layer (spec 51 §4.2)", () => {
  it("at schema 8, reads each profile's ingredients and recipes into locals, never into the root maps", async () => {
    const root = await forgeAt(8, base, { ...localRule("acme", "x"), ...localRecipe("acme", "acme-extra", ["rule/x", "rule/style"]) });
    const f = await loadForge(root);
    expect([...f.ingredients.keys()]).toEqual(["rule/style"]);
    expect([...f.recipes.keys()]).toEqual(["core"]);
    expect([...f.locals.get("acme")!.ingredients.keys()]).toEqual(["rule/x"]);
    expect(f.locals.get("acme")!.recipes.get("acme-extra")!.file).toBe("profiles/acme/recipes/acme-extra.yaml");
    expect(f.locals.get("globex")).toBeUndefined();
    expect(f.ignoredLocals.size).toBe(0);
  });

  it("a local's forgeRoot is its profile's folder, labelled Forge-relative", async () => {
    const root = await forgeAt(8, base, localRule("acme", "x"));
    const ing = (await loadForge(root)).locals.get("acme")!.ingredients.get("rule/x" as never)!;
    expect(ing.forgeRoot.label).toEqual({ rel: "profiles/acme", tree: "the profile's folder" });
    expect(await fs.realpath(ing.forgeRoot.given)).toBe(await fs.realpath(path.join(root, "profiles/acme")));
  });

  it("below schema 8, records the folders it ignores and reads nothing from them", async () => {
    const root = await forgeAt(7, base, { ...localRule("acme", "x"), ...localRecipe("acme", "acme-extra", ["rule/x"]) });
    const f = await loadForge(root);
    expect(f.locals.size).toBe(0);
    expect(f.ignoredLocals.get("acme")).toEqual(["ingredients", "recipes"]);
  });

  it("below schema 8, a broken reference and a local of the root's name still load (Ruling 2)", async () => {
    const root = await forgeAt(7, { ...base, recipes: [...base.recipes!, { name: "unused", extends: ["nope"], ingredients: ["rule/ghost"] }] }, localRule("acme", "style"));
    await expect(loadForge(root)).resolves.toBeDefined();
  });

  it("L1: a local of the root's ref fails, naming both paths", async () => {
    const root = await forgeAt(8, base, localRule("acme", "style"));
    expect(await findings(root)).toEqual([
      "L1 profiles/acme/ingredients/rules/style and ingredients/rules/style: the same ingredient, local to profile acme and at the root",
    ]);
  });

  it("L1: a local and its own profile's root variant of the same name fail", async () => {
    const root = await forgeAt(8, { ...base, ingredients: [...base.ingredients!, rule("x--acme", "# X\n", { as: "x" })] }, localRule("acme", "x"));
    expect(await findings(root)).toEqual([
      "L1 profiles/acme/ingredients/rules/x and ingredients/rules/x--acme: a local ingredient and the root variant of the same name for its own profile",
    ]);
  });

  it("L1 does not fire for another profile's root variant", async () => {
    const root = await forgeAt(8, { ...base, ingredients: [...base.ingredients!, rule("x--globex", "# X\n", { as: "x" })] }, localRule("acme", "x"));
    expect(await findings(root)).toEqual([]);
  });

  it("L2: a local recipe of the root's name fails, naming both files", async () => {
    const root = await forgeAt(8, base, localRecipe("acme", "core", ["rule/style"]));
    expect(await findings(root)).toEqual(["L2 profiles/acme/recipes/core.yaml and recipes/core.yaml: the same recipe, local to profile acme and at the root"]);
  });

  it("L3: a root recipe citing a local fails, naming its file and the local's path", async () => {
    const root = await forgeAt(8, { ...base, recipes: [recipe("core", ["rule/style", "rule/x"])] }, localRule("acme", "x"));
    expect(await findings(root)).toEqual([
      "L3 recipes/core.yaml: cites rule/x, which is local (profiles/acme/ingredients/rules/x) — a root recipe does not see a profile's ingredients",
    ]);
  });

  it("L3: a root recipe extending a local recipe fails", async () => {
    const root = await forgeAt(8, { ...base, recipes: [recipe("core", ["rule/style"], { extends: ["acme-extra"] })] }, localRecipe("acme", "acme-extra", []));
    expect(await findings(root)).toEqual([
      "L3 recipes/core.yaml: extends acme-extra, which is local (profiles/acme/recipes/acme-extra.yaml) — a root recipe does not see a profile's recipes",
    ]);
  });

  it("L4: a broken reference fails, in a recipe no profile uses too", async () => {
    const root = await forgeAt(8, { ...base, recipes: [...base.recipes!, { name: "unused", extends: ["nope"], ingredients: ["rule/ghost"] }] });
    expect(await findings(root)).toEqual([
      "L4 recipes/unused.yaml: cites rule/ghost, which does not exist",
      "L4 recipes/unused.yaml: extends nope, which does not exist",
    ]);
  });

  it("L4: a local recipe citing another profile's local fails", async () => {
    const root = await forgeAt(8, base, { ...localRule("acme", "x"), ...localRecipe("globex", "globex-extra", ["rule/x"]) });
    expect(await findings(root)).toEqual(["L4 profiles/globex/recipes/globex-extra.yaml: cites rule/x, which profile globex does not have"]);
  });

  it("L4: a ref not shaped like a name is not printed", async () => {
    const root = await forgeAt(8, { ...base, recipes: [recipe("core", ["rule/style", "rule/https://user:pw@host"])] });
    expect(await findings(root)).toEqual(["L4 recipes/core.yaml: cites a ref (not shown: not shaped like a name), which does not exist"]);
  });

  it("L5: an extends cycle fails, at the root and through a local recipe", async () => {
    const root = await forgeAt(8, { ...base, recipes: [recipe("core", ["rule/style"]), recipe("a", [], { extends: ["b"] }), recipe("b", [], { extends: ["a"] })] });
    expect(await findings(root)).toEqual(["L5 recipe cycle: a → b → a"]);
  });

  it("L6: a local with -- in its name, or declaring as, fails", async () => {
    const root = await forgeAt(8, base, { ...localRule("acme", "x--y"), ...localRule("acme", "z", { as: "w" }) });
    expect((await findings(root)).sort()).toEqual([
      'L6 profiles/acme/ingredients/rules/x--y: a local ingredient\'s name holds no "--" and it declares no "as" — it is not a variant',
      'L6 profiles/acme/ingredients/rules/z: a local ingredient\'s name holds no "--" and it declares no "as" — it is not a variant',
    ]);
  });

  it("L7: a folder of locals with no profile.yaml, or whose name differs, fails", async () => {
    const root = await forgeAt(8, base, {
      ...localRule("orphan", "x"),
      "profiles/other/profile.yaml": YAML.stringify({ name: "named-else", recipes: [] }),
      ...localRule("other", "y"),
    });
    expect((await findings(root)).sort()).toEqual([
      "L7 profiles/orphan: holds ingredients or recipes but no profile.yaml",
      "L7 profiles/other: holds ingredients or recipes, and its profile.yaml names another profile — rename the folder to the profile's name",
    ]);
  });

  it("L8: a linked ingredients folder fails, naming the path and never its target (a junction on Windows)", async () => {
    const root = await forgeAt(8, base, localRule("globex", "secret"));
    await fs.mkdir(path.join(root, "profiles/acme"), { recursive: true });
    await fs.symlink(path.join(root, "profiles/globex/ingredients"), path.join(root, "profiles/acme/ingredients"), "junction");
    const out = await findings(root);
    expect(out).toEqual(["L8 profiles/acme/ingredients: a symbolic link — a profile's folder holds its own files; replace it with a directory"]);
    expect(out.join("\n")).not.toContain("globex");
  });

  it("L9: two locals of one profile with one ref fail", async () => {
    const root = await forgeAt(8, base, {
      ...localRule("acme", "x"),
      "profiles/acme/ingredients/rules/x-copy/ingredient.yaml": YAML.stringify({ type: "rule", name: "x" }),
      "profiles/acme/ingredients/rules/x-copy/rule.md": "# X\n",
    });
    expect(await findings(root)).toEqual(["L9 profiles/acme/ingredients/rules/x and profiles/acme/ingredients/rules/x-copy: two local ingredients of one profile with one name"]);
  });

  it("two profiles may each hold a local of the same name", async () => {
    const root = await forgeAt(8, base, { ...localRule("acme", "x"), ...localRule("globex", "x") });
    const f = await loadForge(root);
    expect(f.locals.get("acme")!.ingredients.has("rule/x" as never)).toBe(true);
    expect(f.locals.get("globex")!.ingredients.has("rule/x" as never)).toBe(true);
  });

  it("collects every finding before the throw, one per line", async () => {
    const root = await forgeAt(8, { ...base, recipes: [recipe("core", ["rule/style", "rule/ghost"])] }, localRule("acme", "style"));
    const e = await loadForge(root).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProfileLocalLoadError);
    expect((e as Error).message.split("\n")).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")("a local's file read through a link into another profile's folder fails, naming no target", async () => {
    const root = await forgeAt(8, base, { ...localRecipe("globex", "globex-extra", []), ...localRule("acme", "x") });
    await fs.mkdir(path.join(root, "profiles/acme/recipes"), { recursive: true });
    await fs.symlink("../../globex/recipes/globex-extra.yaml", path.join(root, "profiles/acme/recipes/acme-extra.yaml"));
    const e = await loadForge(root).catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain("profiles/acme/recipes/acme-extra.yaml: a symbolic link out of the profile's folder");
    expect(String((e as Error).message)).not.toContain("globex");
  });
});
