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
    expect(r.stderr).toContain("recipe globex-extra is local to profile globex — a new profile cannot use it; leave it out, or move it to the root by hand");
  });
});

describe("drift show and drift promote on a local's file (spec 51 §4.5)", () => {
  it("Part B lifts D22: drift show calls a local's file promotable, and drift promote edits the local in place", async () => {
    const s: ForgeSpec = { ...spec, profiles: [profile("acme", ["core--acme", "acme-extra"]), profile("globex", ["core"])] };
    const f = await forgeWith({ ...localRule("acme", "x"), ...citing("acme", "acme-extra", ["rule/x"]) }, s);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/x.md"), "# x, edited by hand\n");
    const show = JSON.parse(runCli(["drift", "show", "--json", "--workspace", f.ws]).stdout);
    expect(show.files.find((x: { path: string }) => x.path === ".claude/rules/x.md")).toMatchObject({ promotable: true, reason: null });
    const promote = runCli(["drift", "promote", ".claude/rules/x.md", "--workspace", f.ws]);
    expect(promote.code, promote.stderr).toBe(0);
    expect(await fs.readFile(path.join(f.dir, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("# x, edited by hand\n");
  });

  it("drift promote's variant outcome: a local recipe that reaches the base only through extends of a shared root recipe follows the root's rules (D17)", async () => {
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
    expect(r.stderr).toContain("recipe core reaches this workspace through acme-extra → core — promote does not fork a recipe chain");
    expect(git(f.dir, "status", "--porcelain")).toBe("");
  });
});

describe("drift promote repoints the profile's own local recipe (the user's ruling, 2026-11-08)", () => {
  const shared: ForgeSpec = {
    ingredients: [rule("workflow", "base text\n"), rule("style", "style\n")],
    recipes: [recipe("core", ["rule/workflow", "rule/style"])],
    profiles: [profile("acme", ["acme-extra"]), profile("globex", ["core"])],
  };
  const acmeExtra = (ingredients: string[]) => ({
    "profiles/acme/recipes/acme-extra.yaml": `# acme's own recipe\nname: acme-extra\ningredients:\n${ingredients.map((i) => `  - ${i} # kept\n`).join("")}`,
  });

  it("writes the variant and repoints the local recipe in place, comments kept; the next sync is in step", async () => {
    const f = await forgeWith(acmeExtra(["rule/workflow", "rule/style"]), shared);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.outcome).toBe("variant");
    expect(out.promoted).toBe("rule/workflow--acme");
    expect(await fs.readFile(path.join(f.dir, "ingredients/rules/workflow--acme/rule.md"), "utf8")).toBe("acme's own text\n");
    expect(await fs.readFile(path.join(f.dir, "profiles/acme/recipes/acme-extra.yaml"), "utf8")).toBe(
      "# acme's own recipe\nname: acme-extra\ningredients:\n  - rule/workflow--acme # kept\n  - rule/style # kept\n",
    );
    // the root recipe globex uses, and the base, are untouched
    expect(git(f.dir, "status", "--porcelain", "--", "recipes", "ingredients/rules/workflow")).toBe("");
    const check = runCli(["sync", "--check", "--workspace", f.ws]);
    expect(check.code, check.stdout + check.stderr).toBe(0);
  });

  it("--dry-run lists the local recipe it would edit and writes nothing", async () => {
    const f = await forgeWith(acmeExtra(["rule/workflow", "rule/style"]), shared);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws, "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("profiles/acme/recipes/acme-extra.yaml (ingredients)");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a root recipe acme alone resolves and its local recipe both cite the base: both are repointed", async () => {
    const s: ForgeSpec = { ...shared, recipes: [...shared.recipes!, recipe("acme-core", ["rule/workflow"])], profiles: [profile("acme", ["acme-core", "acme-extra"]), profile("globex", ["core"])] };
    const f = await forgeWith(acmeExtra(["rule/workflow", "rule/style"]), s);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(YAML.parse(await fs.readFile(path.join(f.dir, "recipes/acme-core.yaml"), "utf8")).ingredients).toEqual(["rule/workflow--acme"]);
    expect(YAML.parse(await fs.readFile(path.join(f.dir, "profiles/acme/recipes/acme-extra.yaml"), "utf8")).ingredients).toEqual(["rule/workflow--acme", "rule/style"]);
    expect(runCli(["sync", "--check", "--workspace", f.ws]).code).toBe(0);
  });

  it("a local recipe saved with CRLF keeps its line endings when repointed", async () => {
    const crlf = { "profiles/acme/recipes/acme-extra.yaml": "name: acme-extra\r\ningredients:\r\n  - rule/workflow\r\n  - rule/style\r\n" };
    const f = await forgeWith(crlf, shared);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(f.dir, "profiles/acme/recipes/acme-extra.yaml"), "utf8")).toBe(
      "name: acme-extra\r\ningredients:\r\n  - rule/workflow--acme\r\n  - rule/style\r\n",
    );
  });

  async function wsWith(f: { root: string; dir: string }, name: string, config: Record<string, unknown>): Promise<string> {
    const ws = path.join(f.root, name);
    await makeWorkspace(ws, f.dir, { config: { profile: "acme", ...config } });
    return ws;
  }

  it("a local recipe the workspace brings in through recipes.add is refused as the root's is (D17), the Forge untouched", async () => {
    const s: ForgeSpec = { ...shared, profiles: [profile("acme", ["core"]), profile("globex", ["core"])] };
    const f = await forgeWith(acmeExtra(["rule/workflow"]), s);
    const ws = await wsWith(f, "ws-add", { recipes: { add: ["acme-extra"] } });
    expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("recipe acme-extra reaches this workspace through recipes.add (craftar.yaml) — promote does not fork a recipe chain");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a local recipe citing the base that the workspace removes is refused, not left naming the base", async () => {
    const s: ForgeSpec = { ...shared, recipes: [...shared.recipes!, recipe("acme-core", ["rule/workflow"])], profiles: [profile("acme", ["acme-core", "acme-extra"]), profile("globex", ["core"])] };
    const f = await forgeWith(acmeExtra(["rule/workflow", "rule/style"]), s);
    const ws = await wsWith(f, "ws-remove", { recipes: { remove: ["acme-extra"] } });
    expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/recipes/acme-extra.yaml reaches rule/workflow but this workspace does not resolve it — promote would leave it naming the base beside the variant");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a local recipe that reaches the base only through extends, removed by this workspace, is refused — no fork that brings the base back elsewhere", async () => {
    const s: ForgeSpec = { ...shared, profiles: [profile("acme", ["core", "acme-extra"]), profile("globex", ["core"])] };
    const f = await forgeWith({ "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", extends: ["core"], ingredients: ["rule/style"] }) }, s);
    const ws = await wsWith(f, "ws-remove-ext", { recipes: { remove: ["acme-extra"] } });
    expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/recipes/acme-extra.yaml reaches rule/workflow but this workspace does not resolve it — promote would leave it naming the base beside the variant");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a profile that does not resolve on its own cannot have its local recipe repointed (fail closed)", async () => {
    const s: ForgeSpec = { ...shared, profiles: [profile("acme", ["missing"]), profile("globex", ["core"])] };
    const f = await forgeWith(acmeExtra(["rule/workflow"]), s);
    const ws = await wsWith(f, "ws-unresolved", { recipes: { remove: ["missing"], add: ["acme-extra"] } });
    expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profile acme does not resolve on its own, so promote cannot tell whether acme-extra is its own recipe");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a local recipe of the child that its abstract parent lists by name is the family's: refused: no command writes a parent (schema 13)", async () => {
    const s: ForgeSpec = {
      ingredients: shared.ingredients,
      recipes: shared.recipes,
      profiles: [profile("base", ["kidrec"], ["claude-code"], { abstract: true }), profile("kid", [], ["claude-code"], { extends: "base" }), profile("globex", ["core"])],
    };
    const f = await forgeWith({ "profiles/kid/recipes/kidrec.yaml": YAML.stringify({ name: "kidrec", ingredients: ["rule/workflow"] }) }, s);
    await fs.writeFile(path.join(f.dir, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 13 }));
    git(f.dir, "commit", "-q", "-am", "schema 13");
    const ws = await wsWith(f, "ws-kid", { profile: "kid" });
    const synced = runCli(["sync", "--workspace", ws]);
    expect(synced.code, synced.stderr).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "kid's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("recipe kidrec is local to kid, and profile base, which it extends, lists it — no command writes a parent: edit the Forge by hand");
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it.skipIf(process.platform === "win32")("a local recipe that is a symbolic link inside the profile's folder is refused before any write", async () => {
    const body = "name: acme-extra\ningredients:\n  - rule/workflow\n  - rule/style\n";
    const f = await forgeWith({ "profiles/acme/kept/acme-extra.yaml": body }, shared);
    await fs.mkdir(path.join(f.dir, "profiles/acme/recipes"), { recursive: true });
    await fs.symlink("../kept/acme-extra.yaml", path.join(f.dir, "profiles/acme/recipes/acme-extra.yaml"));
    git(f.dir, "add", "-A");
    git(f.dir, "commit", "-q", "-m", "link");
    const synced = runCli(["sync", "--workspace", f.ws]);
    expect(synced.code, synced.stderr).toBe(0);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/recipes/acme-extra.yaml is a symbolic link in the Forge — promote does not write through a link");
    expect(await fs.readFile(path.join(f.dir, "profiles/acme/kept/acme-extra.yaml"), "utf8")).toBe(body);
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("a local recipe git does not hold is refused, the Forge untouched", async () => {
    const f = await forgeWith(acmeExtra(["rule/workflow", "rule/style"]), shared);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    const rec = path.join(f.dir, "profiles/acme/recipes/acme-extra.yaml");
    const edited = (await fs.readFile(rec, "utf8")) + "# an uncommitted note\n";
    await fs.writeFile(rec, edited);
    await fs.writeFile(path.join(f.ws, ".claude/rules/workflow.md"), "acme's own text\n");
    const r = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drift promote can only change files git can restore");
    expect(r.stderr).toContain("profiles/acme/recipes/acme-extra.yaml is not held by git");
    expect(await fs.readFile(rec, "utf8")).toBe(edited);
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all")).toBe("M profiles/acme/recipes/acme-extra.yaml");
  });
});
