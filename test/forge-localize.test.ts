import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { forgeWorkspaces } from "../src/core/impact.js";
import { applyMove, planLocalize, planShare, proveMove, type ForgeMove } from "../src/core/localize.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/** Spec 51 §5.1–§5.2: the edit set of `forge localize` and `forge share`, its refusals, the proof and the writes. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const home = () => process.env.CRAFTAR_HOME!;

const base: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("x", "# X\n")],
  recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x"]), recipe("stack-y", [], { extends: ["stack-x"] })],
  profiles: [profile("acme", ["base", "stack-y"]), profile("globex", ["base"])],
};

/** A Forge at `schema` (8 by default) with `extra` files, and a synced workspace for each of `workspaces` (registered). */
async function setup(spec: ForgeSpec = base, opts: { schema?: number; extra?: Record<string, string>; workspaces?: Array<{ name: string; config: Record<string, unknown> }> } = {}) {
  const root = await tmpDir("craftar-localize-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema ?? 8 }));
  if (opts.extra) await writeFiles(forge, opts.extra);
  const ws: Record<string, string> = {};
  for (const w of opts.workspaces ?? [{ name: "acme", config: { profile: "acme" } }]) {
    const dir = path.join(root, w.name);
    await makeWorkspace(dir, forge, { config: w.config });
    const r = runCli(["sync", "--workspace", dir]);
    expect(r.code, r.stderr).toBe(0);
    ws[w.name] = dir;
  }
  return { root, forge, ws };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if ((await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}

async function planAndProve(forge: string, run: (f: Awaited<ReturnType<typeof loadForge>>) => Promise<ForgeMove>) {
  const f = await loadForge(forge);
  const move = await run(f);
  const warnings = await proveMove(f, move, (await forgeWorkspaces(home(), forge)).workspaces);
  return { f, move, warnings };
}

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});

describe("forge localize (spec 51 §5.1)", () => {
  it("moves rule/x into profiles/acme with every root recipe that cites it and every one that extends those, and acme plans the same bytes", async () => {
    const s = await setup();
    const { move } = await planAndProve(s.forge, (f) => planLocalize(f, "rule/x", "acme"));
    expect(move.moved).toEqual({ from: "ingredients/rules/x", to: "profiles/acme/ingredients/rules/x" });
    expect(move.to).toBe("rule/x");
    expect(move.recipes).toEqual([
      { name: "stack-x", from: "recipes/stack-x.yaml", to: "profiles/acme/recipes/stack-x.yaml" },
      { name: "stack-y", from: "recipes/stack-y.yaml", to: "profiles/acme/recipes/stack-y.yaml" },
    ]);
    const before = await snapshot(s.forge);
    await applyMove(move, []);
    const after = await snapshot(s.forge);
    expect(after["profiles/acme/ingredients/rules/x/rule.md"]).toBe(before["ingredients/rules/x/rule.md"]);
    expect(after["profiles/acme/ingredients/rules/x/ingredient.yaml"]).toBe(before["ingredients/rules/x/ingredient.yaml"]);
    expect(after["profiles/acme/recipes/stack-x.yaml"]).toBe(before["recipes/stack-x.yaml"]);
    expect(after["profiles/acme/recipes/stack-y.yaml"]).toBe(before["recipes/stack-y.yaml"]);
    expect(Object.keys(after).filter((k) => k.startsWith("ingredients/rules/x") || k === "recipes/stack-x.yaml" || k === "recipes/stack-y.yaml")).toEqual([]);
    expect((await loadForge(s.forge)).locals.get("acme")!.ingredients.has("rule/x" as never)).toBe(true);
    expect(runCli(["sync", "--check", "--workspace", s.ws.acme]).code).toBe(0);
  });

  it("refuses when another profile resolves the ingredient, naming it, and writes nothing", async () => {
    const s = await setup({ ...base, profiles: [profile("acme", ["base", "stack-y"]), profile("globex", ["base", "stack-x"])] });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: profile globex also resolves rule/x");
  });

  it("refuses when a recipe that would move is resolved by no profile", async () => {
    const s = await setup({ ...base, recipes: [...base.recipes!, recipe("stack-z", ["rule/x"])] });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: recipe stack-z cites rule/x and would have to move, but no profile resolves it");
  });

  it("refuses when a registered workspace of another profile adds a recipe that would move, before anything is written", async () => {
    const s = await setup(base, { workspaces: [{ name: "acme", config: { profile: "acme" } }, { name: "globex", config: { profile: "globex", recipes: { add: ["stack-x"] } } }] });
    const before = await snapshot(s.forge);
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/x", "acme");
    await expect(proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces)).rejects.toThrow(/forge localize: workspace .* \(profile globex\) adds recipe stack-x, which would move to profiles\/acme/);
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("refuses an ingredient that has a variant for any profile", async () => {
    const s = await setup({ ...base, ingredients: [...base.ingredients!, rule("x--globex", "# G\n", { as: "x" })] });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: rule/x has the variant rule/x--globex — a local has no variant; unify or promote it first");
  });

  it("turns a base-less variant into a local under its output name, rewiring the recipes that move", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("style", "# Style\n"), rule("x--acme", "# X for acme\n", { as: "x" })],
      recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/style", "rule/x--acme"])],
      profiles: [profile("acme", ["stack-x"]), profile("globex", ["base"])],
    };
    const s = await setup(spec);
    const { move } = await planAndProve(s.forge, (f) => planLocalize(f, "rule/x--acme", "acme"));
    expect(move.to).toBe("rule/x");
    expect(move.moved).toEqual({ from: "ingredients/rules/x--acme", to: "profiles/acme/ingredients/rules/x" });
    await applyMove(move, []);
    const after = await snapshot(s.forge);
    const meta = YAML.parse(after["profiles/acme/ingredients/rules/x/ingredient.yaml"]);
    expect(meta.name).toBe("x");
    expect(meta.as).toBeUndefined();
    expect(YAML.parse(after["profiles/acme/recipes/stack-x.yaml"]).ingredients).toEqual(["rule/style", "rule/x"]);
    expect(runCli(["sync", "--check", "--workspace", s.ws.acme]).code).toBe(0);
  });

  it("the proof refuses a base-less variant a registered workspace disables by its old ref", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("style", "# Style\n"), rule("x--acme", "# X for acme\n", { as: "x" })],
      recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/style", "rule/x--acme"])],
      profiles: [profile("acme", ["stack-x"]), profile("globex", ["base"])],
    };
    const s = await setup(spec, { workspaces: [{ name: "acme", config: { profile: "acme", overrides: { ingredients: { disable: ["rule/x--acme"] } } } }] });
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/x--acme", "acme");
    await expect(proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces)).rejects.toThrow(/forge localize: workspace .* would not plan the same after the move — .claude\/rules\/x\.md/);
  });

  it("refuses a variant whose base is at the root (L1), and a variant not named for the profile (L6)", async () => {
    const s = await setup({ ...base, ingredients: [...base.ingredients!, rule("x--acme", "# A\n", { as: "x" }), rule("z", "# Z\n", { as: "w" })] });
    const f = await loadForge(s.forge);
    await expect(planLocalize(f, "rule/x--acme", "acme")).rejects.toThrow("forge localize: rule/x--acme is a variant of rule/x, which is at the root");
    await expect(planLocalize(f, "rule/z", "acme")).rejects.toThrow("forge localize: rule/z is a variant (as: w) not named w--acme");
  });

  it("a profile that does not resolve: refused when its recipes name what moves, skipped with a warning otherwise", async () => {
    const naming = await setup({ ...base, profiles: [...base.profiles!, profile("initech", ["nope", "stack-y"])] });
    await expect(loadForge(naming.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: profile initech does not resolve, and its recipes name stack-y, which would move");
    const silent = await setup({ ...base, profiles: [...base.profiles!, profile("initech", ["nope"])] });
    const { move } = await planAndProve(silent.forge, (f) => planLocalize(f, "rule/x", "acme"));
    expect(move.warnings.join("\n")).toContain("profile initech does not resolve");
    expect(move.warnings.join("\n")).toContain("not proved");
  });

  it("refuses when the destination folder is taken", async () => {
    const s = await setup(base, { extra: { "profiles/acme/ingredients/rules/x/notes.txt": "taken\n" } });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: profiles/acme/ingredients/rules/x already exists");
  });

  it("refuses a Forge below schema 8 and says no command raises it", async () => {
    const s = await setup({ ...base }, { schema: 7 });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("forge localize: the Forge is at schema 7 — profile-local ingredients need schema 8");
  });

  it.skipIf(process.platform === "win32")("refuses an ingredient holding a file link inside the Forge, before the proof, the Forge untouched", async () => {
    const s = await setup();
    await fs.symlink(path.join(s.forge, "ingredients/rules/style/rule.md"), path.join(s.forge, "ingredients/rules/x/extra.md"));
    const before = await snapshot(s.forge);
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/x", "acme"))).rejects.toThrow("ingredients/rules/x/extra.md is a symbolic link in the Forge — forge localize does not move a link");
    expect(await snapshot(s.forge)).toEqual(before);
  });
});

describe("forge share (spec 51 §5.2)", () => {
  const local: ForgeSpec = { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])] };
  const files = { ...localRule("acme", "x", "# X\n"), "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/x"] }) };

  it("moves a local to the root; the local recipe stays local and now cites the root, and acme plans the same bytes", async () => {
    const s = await setup(local, { extra: files });
    const { move } = await planAndProve(s.forge, (f) => planShare(f, "rule/x", "acme"));
    expect(move.moved).toEqual({ from: "profiles/acme/ingredients/rules/x", to: "ingredients/rules/x" });
    expect(move.recipes).toEqual([]);
    await applyMove(move, []);
    const after = await snapshot(s.forge);
    expect(after["ingredients/rules/x/rule.md"]).toBe("# X\n");
    expect(Object.keys(after).some((k) => k.startsWith("profiles/acme/ingredients/"))).toBe(false);
    expect(after["profiles/acme/recipes/acme-extra.yaml"]).toBe(files["profiles/acme/recipes/acme-extra.yaml"]);
    expect(runCli(["sync", "--check", "--workspace", s.ws.acme]).code).toBe(0);
  });

  it("refuses when a root variant of that name exists for another profile", async () => {
    const s = await setup({ ...local, ingredients: [...local.ingredients!, rule("x--globex", "# G\n", { as: "x" })] }, { extra: files });
    await expect(loadForge(s.forge).then((f) => planShare(f, "rule/x", "acme"))).rejects.toThrow("forge share: rule/x--globex at the root is a variant named x");
  });

  it("refuses when another profile holds a local of that name", async () => {
    const s = await setup(local, { extra: { ...files, ...localRule("globex", "x", "# GX\n"), "profiles/globex/recipes/globex-extra.yaml": YAML.stringify({ name: "globex-extra", ingredients: ["rule/x"] }) } });
    await expect(loadForge(s.forge).then((f) => planShare(f, "rule/x", "acme"))).rejects.toThrow("forge share: rule/x is local to profile globex too");
  });

  it("refuses an ingredient that is not local to the profile", async () => {
    const s = await setup(local, { extra: files });
    await expect(loadForge(s.forge).then((f) => planShare(f, "rule/style", "acme"))).rejects.toThrow("forge share: rule/style is not local to profile acme");
  });
});
