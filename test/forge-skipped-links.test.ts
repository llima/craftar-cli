import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, writeFiles } from "./helpers/forge.js";

// E39.2: a folder the Forge's loader skips because it is a symbolic link (a junction on Windows) is warned about,
// one line per link, naming the Forge-relative path and never what it points at.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const TARGET_NAME = "private-target-folder";

async function linkedForge(schema = 1) {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("core", ["rule/style"])], profiles: [profile("acme", ["core"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  // What the links point at: an ingredient folder and a profile folder, outside the Forge.
  const target = path.join(s.root, TARGET_NAME);
  await writeFiles(target, {
    "ingredient.yaml": YAML.stringify({ type: "rule", name: "linked" }),
    "rule.md": "# Linked\n",
  });
  const profTarget = path.join(s.root, `${TARGET_NAME}-profile`);
  await writeFiles(profTarget, { "profile.yaml": YAML.stringify(profile("other", ["core"])) });
  return { ...s, target, profTarget };
}

describe("loadForge: a linked ingredient or profile folder (E39.2)", () => {
  it("records each skipped link, Forge-relative, and loads nothing through it", async () => {
    const s = await linkedForge();
    await fs.symlink(s.target, path.join(s.forgeRoot, "ingredients/rules/linked"), "junction");
    await fs.symlink(s.profTarget, path.join(s.forgeRoot, "profiles/other"), "junction");
    await fs.symlink(path.join(s.forgeRoot, "ingredients/rules"), path.join(s.forgeRoot, "ingredients/more"), "junction");
    const f = await loadForge(s.forgeRoot);
    expect([...f.ingredients.keys()]).toEqual(["rule/style"]);
    expect([...f.profiles.keys()]).toEqual(["acme"]);
    expect(f.skippedLinks).toEqual(["ingredients/more", "ingredients/rules/linked", "profiles/other"]);
  });

  it("the plan warns once per link, naming the path and never the target", async () => {
    const s = await linkedForge();
    await fs.symlink(s.target, path.join(s.forgeRoot, "ingredients/rules/linked"), "junction");
    const p = await plan(await loadWorkspace(s.wsRoot));
    const linked = p.warnings.filter((w) => w.includes("symbolic link"));
    expect(linked).toEqual(["ingredients/rules/linked is a symbolic link — the Forge does not read through it, so what it holds is not loaded; replace it with the folder"]);
    expect(p.warnings.join("\n")).not.toContain(TARGET_NAME);
  });

  it("a linked ingredient folder in a profile's own tree is warned too (schema 8)", async () => {
    const s = await linkedForge(8);
    await writeFiles(s.forgeRoot, { "profiles/acme/ingredients/rules/own/ingredient.yaml": YAML.stringify({ type: "rule", name: "own" }), "profiles/acme/ingredients/rules/own/rule.md": "# Own\n" });
    await fs.symlink(s.target, path.join(s.forgeRoot, "profiles/acme/ingredients/rules/linked"), "junction");
    const f = await loadForge(s.forgeRoot);
    expect(f.skippedLinks).toEqual(["profiles/acme/ingredients/rules/linked"]);
  });

  it("a Forge with no link records none and warns nothing new", async () => {
    const s = await linkedForge();
    const f = await loadForge(s.forgeRoot);
    expect(f.skippedLinks).toEqual([]);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.warnings.filter((w) => w.includes("symbolic link"))).toEqual([]);
  });
});
