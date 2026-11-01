import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/** Spec 51 §4.1, §4.3 and acceptance 1–2: what a profile sees, and what a load error reads like on each surface. */

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});

async function at(schema: number, spec: ForgeSpec, config: Record<string, unknown>, files: Record<string, string> = {}): Promise<Scenario> {
  const s = await scenario(spec, { config });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(s.forgeRoot, files);
  return s;
}

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("core", ["rule/style"])],
  profiles: [profile("acme", ["core", "acme-extra"], ["claude-code", "kiro", "agents-md"]), profile("globex", ["core"], ["claude-code", "kiro", "agents-md"])],
};
const locals = { ...localRule("acme", "x", "# X\nLocal to acme.\n"), "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/x"] }) };

async function planned(s: Scenario): Promise<Map<string, string>> {
  const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
  return new Map(p.files.map((f) => [f.path, f.content.toString("utf8")]));
}

describe("resolve() through the profile's view (spec 51 §4.3)", () => {
  it("acceptance 1: a local renders as the same ingredient would at the root, and the lock is the same", async () => {
    const local = await at(8, spec, { profile: "acme" }, locals);
    const rootSpec: ForgeSpec = {
      ingredients: [rule("style", "# Style\n"), rule("x", "# X\nLocal to acme.\n")],
      recipes: [recipe("core", ["rule/style"]), recipe("acme-extra", ["rule/x"])],
      profiles: spec.profiles,
    };
    const atRoot = await at(8, rootSpec, { profile: "acme" });
    expect(await planned(local)).toEqual(await planned(atRoot));
    for (const s of [local, atRoot]) expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const lockOf = async (s: Scenario) => {
      const l = JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
      delete l.generatedAt;
      delete l.forge.source;
      return l;
    };
    expect(await lockOf(local)).toEqual(await lockOf(atRoot));
    expect(await fs.readFile(path.join(local.wsRoot, ".claude/rules/x.md"), "utf8")).toBe("# X\nLocal to acme.\n");
  });

  it("acceptance 2: another profile does not see the local, and naming its recipe is not found", async () => {
    const s = await at(8, spec, { profile: "globex" }, locals);
    expect([...(await planned(s)).keys()].some((p) => p.includes("/x.md"))).toBe(false);
    const add = runCli(["add", "recipe", "acme-extra", "--workspace", s.wsRoot]);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain('recipe "acme-extra" not found');
  });

  it("recipes.add of the workspace's own profile's local recipe works", async () => {
    const s = await at(8, { ...spec, profiles: [profile("acme", ["core"], ["claude-code"])] }, { profile: "acme", recipes: { add: ["acme-extra"] } }, locals);
    expect((await planned(s)).has(".claude/rules/x.md")).toBe(true);
  });

  it("overrides.ingredients.disable names a local", async () => {
    const s = await at(8, spec, { profile: "acme", overrides: { ingredients: { disable: ["rule/x"] } } }, locals);
    expect((await planned(s)).has(".claude/rules/x.md")).toBe(false);
  });

  it("a local recipe may extend a root recipe and cite a root ingredient", async () => {
    const s = await at(8, { ...spec, profiles: [profile("acme", ["acme-extra"], ["claude-code"])] }, { profile: "acme" }, {
      ...localRule("acme", "x", "# X\n"),
      "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", extends: ["core"], ingredients: ["rule/x"] }),
    });
    expect([...(await planned(s)).keys()].sort()).toEqual([".claude/rules/style.md", ".claude/rules/x.md"]);
  });

  it("§4.1: below schema 8 the folder is said once per folder, for the workspace's own profile only", async () => {
    const acme = await at(7, spec, { profile: "acme", recipes: { remove: ["acme-extra"] } }, locals);
    const p = await plan(await loadWorkspace(acme.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(p.warnings.filter((w) => w.includes("ignored below schema 8"))).toEqual([
      "profiles/acme/ingredients: ignored below schema 8",
      "profiles/acme/recipes: ignored below schema 8",
    ]);
    const globex = await at(7, spec, { profile: "globex" }, locals);
    const q = await plan(await loadWorkspace(globex.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(q.warnings.some((w) => w.includes("ignored below schema 8"))).toBe(false);
  });
});

describe("§4.1's warning names the folder on disk (spec 51 §4.1)", () => {
  it("below schema 8, a folder whose name is not its profile's is named as it is", async () => {
    const s = await at(7, { ...spec, profiles: [profile("globex", ["core"])] }, { profile: "acme" }, {
      "profiles/acme-folder/profile.yaml": YAML.stringify({ name: "acme", recipes: ["core"], targets: ["claude-code"] }),
      ...localRule("acme-folder", "x", "# X\n"),
    });
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(p.warnings).toContain("profiles/acme-folder/ingredients: ignored below schema 8");
  });
});

describe("a profile-local load error on each surface (spec 51 §4.2)", () => {
  const broken = { ...locals, ...localRule("acme", "style", "# shadow\n"), "recipes/unused.yaml": YAML.stringify({ name: "unused", ingredients: ["rule/ghost"] }) };

  it("sync prints every finding, one per line, and exits 1", async () => {
    const s = await at(8, spec, { profile: "acme" }, broken);
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("L1 profiles/acme/ingredients/rules/style and ingredients/rules/style");
    expect(r.stderr).toContain("L4 recipes/unused.yaml: cites rule/ghost, which does not exist");
  });

  it("doctor --json holds one line, the first finding and how many follow", async () => {
    const s = await at(8, spec, { profile: "acme" }, broken);
    const r = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    const checks = JSON.parse(r.stdout).checks as Array<{ message: string; level: string }>;
    const forge = checks.find((c) => c.message.includes("L1 "))!;
    expect(forge.level).toBe("error");
    expect(forge.message).not.toContain("\n");
    expect(forge.message).toMatch(/\(and 1 more\)$/);
  });

  it("workspaces --json holds one line", async () => {
    const s = await at(7, spec, { profile: "acme", recipes: { remove: ["acme-extra"] } }, locals);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 8 }));
    await writeFiles(s.forgeRoot, broken);
    const r = runCli(["workspaces", "--json"]);
    const warnings = JSON.parse(r.stdout).warnings as string[];
    const line = warnings.find((w) => w.includes("L1 "))!;
    expect(line).not.toContain("\n");
    expect(line).toMatch(/\(and 1 more\)$/);
  });

  it("forge impact fails whole: every finding on stderr, exit 1, no JSON", async () => {
    const s = await at(8, spec, { profile: "acme" }, broken);
    const r = runCli(["forge", "impact", "--json", "--forge", s.forgeRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("L1 ");
    expect(r.stderr).toContain("L4 ");
  });
});
