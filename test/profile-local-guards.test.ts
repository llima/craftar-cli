import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { planBasePromotion } from "../src/core/promote.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/** Spec 51 §4.5: the Forge writers and a local recipe that cites what they would move. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const variantOf = (name: string, of: string, body: string) => rule(name, body, { as: of });
const spec: ForgeSpec = {
  ingredients: [rule("workflow", "base text\n"), variantOf("workflow--acme", "workflow", "acme text\n"), rule("style", "style\n")],
  recipes: [recipe("core", ["rule/workflow", "rule/style"]), recipe("core--acme", ["rule/workflow--acme", "rule/style"])],
  profiles: [profile("acme", ["core--acme"]), profile("globex", ["core", "globex-extra"])],
};

async function forgeWith(files: Record<string, string>, s: ForgeSpec = spec): Promise<{ root: string; dir: string; ws: string }> {
  const root = await tmpDir("craftar-local-guards-");
  cleanups.push(root);
  const dir = path.join(root, "forge");
  await makeForge(dir, s);
  await fs.writeFile(path.join(dir, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 8 }));
  await writeFiles(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "forge");
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, dir, { config: { profile: "acme" } });
  return { root, dir, ws };
}

const citing = (p: string, name: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients, ...extra }),
});
const localRule = (p: string, name: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: `# ${name}\n`,
});

describe("forge promote and a local recipe (spec 51 §4.5)", () => {
  it("refuses when a local recipe cites the base, naming the file", async () => {
    const f = await forgeWith(citing("globex", "globex-extra", ["rule/workflow"]));
    await expect(planBasePromotion(await loadForge(f.dir), "rule/workflow", "acme")).rejects.toThrow(
      "forge promote: profiles/globex/recipes/globex-extra.yaml cites rule/workflow or rule/workflow--acme — promote does not edit a profile's local recipe",
    );
  });

  it("goes on when no local recipe cites either", async () => {
    const f = await forgeWith(citing("globex", "globex-extra", ["rule/style"]));
    await expect(planBasePromotion(await loadForge(f.dir), "rule/workflow", "acme")).resolves.toBeDefined();
  });

  it("asked about a local, says whose it is", async () => {
    const f = await forgeWith({ ...citing("globex", "globex-extra", []), ...localRule("acme", "x"), ...localRule("globex", "x") });
    await expect(planBasePromotion(await loadForge(f.dir), "rule/x", "acme")).rejects.toThrow("forge promote: rule/x is local to profiles acme, globex");
  });
});

describe("forge unify and a local recipe (spec 51 §4.5)", () => {
  it("refuses when a local recipe cites the variant unify would remove", async () => {
    const f = await forgeWith({
      ...citing("globex", "globex-extra", []),
      "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/workflow--acme"] }),
    });
    const r = runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "base", "--forge", f.dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unify: profiles/acme/recipes/acme-extra.yaml cites rule/workflow--acme — unify does not edit a profile's local recipe");
  });

  it("asked about a local, says whose it is", async () => {
    const f = await forgeWith({ ...citing("globex", "globex-extra", []), ...localRule("acme", "x") });
    const r = runCli(["forge", "unify", "rule/x", "--profile", "acme", "--take", "base", "--forge", f.dir]);
    expect(r.stderr).toContain("unify: rule/x is local to profile acme");
  });
});

describe("init --new-profile --like and a template's local recipe (spec 51 §4.5)", () => {
  it("refuses a recipe local to the template", async () => {
    const f = await forgeWith(citing("globex", "globex-extra", ["rule/style"]));
    const ws2 = path.join(f.root, "ws2");
    const r = runCli(["init", "--forge", f.dir, "--new-profile", "initech", "--like", "globex", "--workspace", ws2]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("recipe globex-extra is local to profile globex — a new profile cannot use it");
  });
});

describe("drift show and drift promote on a local's file (spec 51 §4.5)", () => {
  it("drift show says profile-local, and drift promote refuses with D22", async () => {
    const s: ForgeSpec = { ...spec, profiles: [profile("acme", ["core--acme", "acme-extra"]), profile("globex", ["core"])] };
    const f = await forgeWith({ ...localRule("acme", "x"), ...citing("acme", "acme-extra", ["rule/x"]) }, s);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/x.md"), "# x, edited by hand\n");
    const show = JSON.parse(runCli(["drift", "show", "--json", "--workspace", f.ws]).stdout);
    expect(show.files.find((x: { path: string }) => x.path === ".claude/rules/x.md")).toMatchObject({ promotable: false, reason: "profile-local" });
    const promote = runCli(["drift", "promote", ".claude/rules/x.md", "--workspace", f.ws]);
    expect(promote.code).toBe(1);
    expect(promote.stderr).toContain(".claude/rules/x.md comes from profiles/acme/ingredients/rules/x, local to this profile — edit it there");
  });

  it("drift promote's variant outcome refuses when a local recipe of this profile reaches the base", async () => {
    const s: ForgeSpec = {
      ingredients: [rule("workflow", "base text\n"), rule("style", "style\n")],
      recipes: [recipe("core", ["rule/workflow", "rule/style"])],
      profiles: [profile("acme", ["acme-extra"]), profile("globex", ["core"])],
    };
    const f = await forgeWith(citing("acme", "acme-extra", [], { extends: ["core"] }), s);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/recipes/acme-extra.yaml reaches rule/workflow, local to this profile — promote does not edit a local recipe");
  });
});
