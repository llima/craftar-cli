import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { ForgeStage } from "../src/importers/claude-code.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { git } from "./helpers/remote.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/**
 * Tech-debt L2a, E1.2 (decision 12): `craftar import` gates with `gitUnheld` only the paths it rewrites whole — a variant
 * no other profile resolves, a `--local=auto|always` local, a section value file (spec 55) — never a path it creates.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const withVariant: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("style--acme", "# Style, acme\n", { as: "style" })],
  recipes: [recipe("base", ["rule/style"]), recipe("base--acme", ["rule/style--acme"])],
  profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
};

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});

async function setup(spec: ForgeSpec, opts: { schema?: number; files?: Record<string, string>; commit?: boolean } = {}) {
  const root = await tmpDir("craftar-import-gate-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  if (opts.schema !== undefined) await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema }));
  if (opts.files) await writeFiles(forge, opts.files);
  if (opts.commit !== false) {
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
  }
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const sync = runCli(["sync", "--workspace", ws]);
  expect(sync.code, sync.stderr).toBe(0);
  return { root, forge, ws };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/") && (await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}

const importInto = (s: { ws: string; forge: string }, ...extra: string[]) =>
  runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme", ...extra]);

const VARIANT_RULE = "ingredients/rules/style--acme/rule.md";

describe("import refuses to rewrite whole what git does not hold (E1.2)", () => {
  it("a variant with an uncommitted edit is refused, naming it, with the Forge untouched", async () => {
    const s = await setup(withVariant);
    await fs.writeFile(path.join(s.forge, VARIANT_RULE), "# Style, acme — edited by hand\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, acme, from the workspace\n");
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import can only change files git can restore — 1 path(s) under");
    expect(r.stderr).toContain(`  ${VARIANT_RULE} is not held by git (modified)`);
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("the same variant, committed, is rewritten", async () => {
    const s = await setup(withVariant);
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, acme, from the workspace\n");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, VARIANT_RULE), "utf8")).toBe("# Style, acme, from the workspace\n");
  });

  it("a variant in a Forge that is not a git repository is refused: git cannot undo it", async () => {
    const s = await setup(withVariant, { commit: false });
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, acme, from the workspace\n");
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import can only change files git can restore");
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("a first import into a new directory that is no repository still works: it only creates", async () => {
    const root = await tmpDir("craftar-import-gate-");
    roots.push(root);
    const ws = path.join(root, "ws");
    await writeFiles(ws, { ".claude/rules/style.md": "# Style\n" });
    const forge = path.join(root, "new-forge");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme"]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(forge, "ingredients/rules/style/rule.md"), "utf8")).toBe("# Style\n");
  });

  it("an import that creates a new variant in a Forge that is no repository still works", async () => {
    const s = await setup({ ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"]), profile("globex", ["base"])] }, { commit: false });
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, acme\n");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, VARIANT_RULE), "utf8")).toBe("# Style, acme\n");
  });

  it("--local=auto: a local with an uncommitted edit is refused", async () => {
    const spec: ForgeSpec = { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])] };
    const s = await setup(spec, {
      schema: 8,
      files: { ...localRule("acme", "x", "# X\n"), "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/x"] }) },
    });
    await fs.writeFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "# X — edited by hand\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, from the workspace\n");
    const before = await snapshot(s.forge);
    const r = importInto(s, "--local=auto");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("  profiles/acme/ingredients/rules/x/rule.md is not held by git (modified)");
    expect(await snapshot(s.forge)).toEqual(before);
    git(s.forge, "checkout", "--", ".");
    const ok = importInto(s, "--local=auto");
    expect(ok.code, ok.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("# X, from the workspace\n");
  });

  it("a section value file (spec 55) with an uncommitted edit is refused", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("x", "# X\n<!-- craftar:section tips -->\nd\n<!-- /craftar:section -->\n")],
      recipes: [recipe("base", ["rule/x"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { sections: { "rule/x": { tips: { file: "sections/rule/x/tips.md" } } } }), profile("globex", ["base"])],
    };
    const s = await setup(spec, { schema: FORGE_SCHEMA_SECTION_FILES, files: { "profiles/acme/sections/rule/x/tips.md": "old tip\n" } });
    expect(await fs.readFile(path.join(s.ws, ".claude/rules/x.md"), "utf8")).toContain("old tip\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), (await fs.readFile(path.join(s.ws, ".claude/rules/x.md"), "utf8")).replace("old tip", "new tip"));
    const valueFile = path.join(s.forge, "profiles/acme/sections/rule/x/tips.md");
    await fs.writeFile(valueFile, "old tip, edited by hand\n");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "hand edit");
    await fs.writeFile(valueFile, "uncommitted\n");
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("  profiles/acme/sections/rule/x/tips.md is not held by git (modified)");
    expect(await snapshot(s.forge)).toEqual(before);
    git(s.forge, "checkout", "--", ".");
    const ok = importInto(s);
    expect(ok.code, ok.stderr).toBe(0);
    expect(await fs.readFile(valueFile, "utf8")).toBe("new tip\n");
  });
});

describe("ForgeStage.overwritten", () => {
  it("names only staged paths that exist under a path marked rewritten whole", async () => {
    const root = await tmpDir("craftar-import-gate-");
    roots.push(root);
    const dir = path.join(root, "ingredients/hooks/guard");
    await writeFiles(dir, { "ingredient.yaml": "x\n", "guard.sh": "old\n" });
    await writeFiles(root, { "profiles/acme/profile.yaml": "name: acme\n" });
    const stage = new ForgeStage(root);
    stage.rewritesWhole(dir);
    stage.write(path.join(dir, "guard.sh"), "new\n");
    stage.write(path.join(dir, "guard.ps1"), "created\n");
    stage.write(path.join(root, "profiles/acme/profile.yaml"), "name: acme\nrecipes: []\n");
    expect(await stage.overwritten()).toEqual([path.join(dir, "guard.sh")]);
  });
});
