import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { forgeWorkspaces } from "../src/core/impact.js";
import { applyMove, planLocalize, proveMove } from "../src/core/localize.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe } from "./helpers/forge.js";
import { build, bytesOf, CASE2, localRecipe, planFor, S } from "./helpers/local-override.js";

/** Spec 56 §5.1: `forge localize <name>--<p>` with the base at the root makes `p`'s override `<name>`. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const home = () => process.env.CRAFTAR_HOME!;

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/") && (await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}

const both = [
  { name: "acme", config: { profile: "acme" } },
  { name: "globex", config: { profile: "globex" } },
];

describe("forge localize of <name>--<p> with the base at the root (spec 56 §5.1)", () => {
  it("makes acme's override rule/y, keeps the root base, removes the variant, rewires in place and moves no recipe", async () => {
    const s = await build(cleanups, CASE2, { workspaces: both });
    const before = { acme: bytesOf(await planFor(s.root, s.forge, "acme")), globex: bytesOf(await planFor(s.root, s.forge, "globex")) };
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/y--acme", "acme");
    expect(move.to).toBe("rule/y");
    expect(move.moved).toEqual({ from: "ingredients/rules/y--acme", to: "profiles/acme/ingredients/rules/y" });
    expect(move.recipes).toEqual([]);
    expect(move.rewired).toEqual(["recipes/base--acme.yaml"]);
    await proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces);
    await applyMove(move, []);
    const after = await snapshot(s.forge);
    expect(YAML.parse(after["recipes/base--acme.yaml"])).toEqual({ name: "base--acme", ingredients: ["rule/style", "rule/y"] });
    expect(after["ingredients/rules/y/rule.md"]).toBe("# Y shared\n");
    expect(Object.keys(after).filter((k) => k.startsWith("ingredients/rules/y--acme"))).toEqual([]);
    expect(YAML.parse(after["profiles/acme/ingredients/rules/y/ingredient.yaml"])).toEqual({ type: "rule", name: "y" });
    expect(after["profiles/acme/ingredients/rules/y/rule.md"]).toBe("# Y for acme\n");
    expect(bytesOf(await planFor(s.root, s.forge, "acme"))).toEqual(before.acme);
    expect(bytesOf(await planFor(s.root, s.forge, "globex"))).toEqual(before.globex);
    for (const w of ["acme", "globex"]) expect(runCli(["sync", "--check", "--workspace", s.ws[w]]).code).toBe(0);
    expect(runCli(["sync", "--workspace", s.ws.acme]).code).toBe(0);
    const lock = JSON.parse(await fs.readFile(path.join(s.ws.acme, "craftar.lock"), "utf8")) as { files: Array<{ path: string; ingredient: string }> };
    expect(lock.files.find((e) => e.path === ".claude/rules/y.md")?.ingredient).toBe("rule/y");
  });

  it("refuses when another profile resolves rule/y--acme", async () => {
    const spec = { ...CASE2, profiles: [profile("acme", ["base--acme"]), profile("globex", ["base--acme"])] };
    const s = await build(cleanups, spec, { git: false });
    await expect(planLocalize(await loadForge(s.forge), "rule/y--acme", "acme")).rejects.toThrow("forge localize: profile globex also resolves rule/y--acme");
  });

  it("refuses when acme also resolves the root rule/y", async () => {
    const spec = { ...CASE2, recipes: [...CASE2.recipes!, recipe("more", ["rule/y"])], profiles: [profile("acme", ["base--acme", "more"]), profile("globex", ["base"])] };
    const s = await build(cleanups, spec, { git: false });
    await expect(planLocalize(await loadForge(s.forge), "rule/y--acme", "acme")).rejects.toThrow(
      "forge localize: profile acme resolves both rule/y and rule/y--acme — the Forge is inconsistent (both would write one file); remove one from its recipes by hand, commit, and re-run",
    );
  });

  it("refuses, before the proof, another profile's local recipe that cites rule/y--acme, naming its file", async () => {
    const s = await build(cleanups, CASE2, { extra: localRecipe("globex", "globex-extra", ["rule/y--acme"]), git: false });
    await expect(planLocalize(await loadForge(s.forge), "rule/y--acme", "acme")).rejects.toThrow(
      "forge localize: profiles/globex/recipes/globex-extra.yaml cites rule/y--acme — it would be left naming a removed ingredient (L4); edit it by hand, commit, and re-run",
    );
  });

  it("below the gate keeps refusing with L1, and says which schema makes it an override", async () => {
    const s = await build(cleanups, CASE2, { schema: 9, git: false });
    const err = await planLocalize(await loadForge(s.forge), "rule/y--acme", "acme").catch((e: Error) => e.message);
    expect(err).toContain("forge localize: rule/y--acme is a variant of rule/y, which is at the root — a local and a root variant of its own profile cannot write one file (L1)");
    expect(err).toContain(`at schema ${S} in craftar.forge.yaml it becomes profile acme's override of rule/y`);
  });

  it("a registered workspace whose overrides.ingredients.disable names rule/y--acme refuses the proof, writing nothing", async () => {
    const s = await build(cleanups, CASE2, { workspaces: [{ name: "acme", config: { profile: "acme", overrides: { ingredients: { disable: ["rule/y--acme"] } } } }] });
    const before = await snapshot(s.forge);
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/y--acme", "acme");
    await expect(proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces)).rejects.toThrow(/forge localize: workspace .* would not plan the same after the move/);
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("the CLI prints the rewired recipe", async () => {
    const s = await build(cleanups, CASE2, { workspaces: both });
    const r = runCli(["forge", "localize", "rule/y--acme", "--profile", "acme", "--forge", s.forge, "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  moved    ingredients/rules/y--acme → profiles/acme/ingredients/rules/y (now rule/y, overrides the root's)");
    expect(r.stdout).toContain("  rewired  recipes/base--acme.yaml: rule/y--acme → rule/y");
  });
});

describe("forge share of an override (spec 56 §5.3)", () => {
  it("at the gate refuses, naming the root ingredient, in words of its own", async () => {
    const { OVERRIDDEN, OVERRIDE_FILES } = await import("./helpers/local-override.js");
    const { planShare } = await import("../src/core/localize.js");
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    await expect(planShare(await loadForge(s.forge), "rule/y", "acme")).rejects.toThrow(
      "forge share: rule/y is also at the root — profile acme overrides it; share would leave two bases",
    );
  });
});

describe("a Windows-shaped Forge (spec 56 §11)", () => {
  it("rewires a recipe file checked out with CRLF line endings, keeping them", async () => {
    const s = await build(cleanups, CASE2, { git: false });
    const file = path.join(s.forge, "recipes/base--acme.yaml");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/\n/g, "\r\n"));
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/y--acme", "acme");
    await applyMove(move, []);
    const text = await fs.readFile(file, "utf8");
    expect(YAML.parse(text)).toEqual({ name: "base--acme", ingredients: ["rule/style", "rule/y"] });
    expect(text.includes("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});
