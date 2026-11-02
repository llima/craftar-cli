import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { resolve } from "../src/core/resolve.js";
import { WorkspaceConfigSchema } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/** Spec 51 §5.3 and acceptance 8: `craftar import --local=never|auto|always`. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});
const localRecipe = (p: string, name: string, ingredients: string[]) => ({ [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients }) });

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
};

async function setup(s: ForgeSpec = spec, opts: { schema?: number; files?: Record<string, string>; ws?: Record<string, string>; profile?: string } = {}) {
  const root = await tmpDir("craftar-import-local-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, s);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema ?? 8 }));
  if (opts.files) await writeFiles(forge, opts.files);
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: opts.profile ?? "acme" } });
  const sync = runCli(["sync", "--workspace", ws]);
  expect(sync.code, sync.stderr).toBe(0);
  if (opts.ws) await writeFiles(ws, opts.ws);
  return { root, forge, ws };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/") && (await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}

const importInto = (s: { ws: string; forge: string }, local?: string, profileName = "acme") =>
  runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", profileName, ...(local ? [`--local=${local}`] : [])]);

describe("import --local (spec 51 §5.3)", () => {
  it("acceptance 8: --local=auto writes a new rule under profiles/acme, wires it into acme-local last, and a re-import reuses it", async () => {
    const s = await setup(spec, { ws: { ".claude/rules/new.md": "# New\n" } });
    const r = importInto(s, "auto");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/new (profiles/acme/ingredients/rules/new) — created there");
    const after = await snapshot(s.forge);
    expect(after["profiles/acme/ingredients/rules/new/rule.md"]).toBe("# New\n");
    expect(Object.keys(after).some((k) => k.startsWith("ingredients/rules/new"))).toBe(false);
    expect(YAML.parse(after["profiles/acme/recipes/acme-local.yaml"]).ingredients).toEqual(["rule/new"]);
    expect(YAML.parse(after["profiles/acme/profile.yaml"]).recipes).toEqual(["base", "acme-local"]);
    expect(YAML.parse(after["recipes/base.yaml"]).ingredients).toEqual(["rule/style"]);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);

    const again = importInto(s, "auto");
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("local to profile acme: rule/new (profiles/acme/ingredients/rules/new) — reused there");
    const twice = await snapshot(s.forge);
    for (const k of Object.keys(after)) if (k !== "profiles/acme/profile.yaml") expect(twice[k], k).toBe(after[k]);
    expect(YAML.parse(twice["profiles/acme/profile.yaml"]).recipes).toEqual(["base", "acme-local"]);
  });

  it("--report names each new local and the local recipe by path, never by text", async () => {
    const s = await setup(spec, { ws: { ".claude/rules/new.md": "# New, private words\n" } });
    const out = path.join(s.root, "report.md");
    const r = runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme", "--local=auto", "--report", out]);
    expect(r.code, r.stderr).toBe(0);
    const md = await fs.readFile(out, "utf8");
    expect(md).toContain("## Created as a local of profile acme (1)\n- rule/new (profiles/acme/ingredients/rules/new)");
    expect(md).toContain("## Wired into acme-local (1)\n- profiles/acme/recipes/acme-local.yaml: rule/new");
    expect(md).not.toContain("private words");
  });

  it("acceptance 8: --local=always over a differing root base refuses, naming the source, the Forge untouched", async () => {
    const s = await setup(spec, { ws: { ".claude/rules/style.md": "# Style, ours\n" } });
    const before = await snapshot(s.forge);
    const r = importInto(s, "always");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: .claude/rules/style.md differs from rule/style at the root — --local=always writes no ingredient at the root");
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("--local=always refuses a differing root variant of the profile, and reuses an equal one", async () => {
    const withVariant: ForgeSpec = { ...spec, ingredients: [...spec.ingredients!, rule("style--acme", "# Style, acme\n", { as: "style" })], recipes: [...spec.recipes!, recipe("base--acme", ["rule/style--acme"])], profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])] };
    const same = await setup(withVariant);
    const ok = importInto(same, "always");
    expect(ok.code, ok.stderr).toBe(0);
    const differs = await setup(withVariant, { ws: { ".claude/rules/style.md": "# Style, acme again\n" } });
    const before = await snapshot(differs.forge);
    const r = importInto(differs, "always");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: .claude/rules/style.md differs from rule/style--acme, profile acme's variant at the root — --local=always does not rewrite a root ingredient");
    expect(await snapshot(differs.forge)).toEqual(before);
  });

  it("--local other than never is refused below schema 8", async () => {
    const s = await setup(spec, { schema: 7, ws: { ".claude/rules/new.md": "# New\n" } });
    const r = importInto(s, "auto");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: --local=auto needs a Forge at schema 8 or above");
    const bad = runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme", "--local=sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--local takes never, auto or always");
  });

  it("under never, the two refusals name --local=auto", async () => {
    const differs = await setup({ ...spec, profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])] }, { files: { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) }, ws: {} });
    await fs.writeFile(path.join(differs.ws, ".claude/rules/x.md"), "# X, edited\n");
    expect(importInto(differs).stderr).toContain("— edit the local in the Forge, or re-run with --local=auto to rewrite it, then re-run");
    const i14 = await setup({ ...spec, profiles: [profile("acme", ["base"]), profile("globex", ["base", "globex-extra"])] }, { files: { ...localRule("globex", "secret", "# S\n"), ...localRecipe("globex", "globex-extra", ["rule/secret"]) }, ws: { ".claude/rules/secret.md": "# mine\n" } });
    const r = importInto(i14);
    expect(r.stderr).toContain("rename the source in the workspace, or re-run with --local=auto to keep it local to this profile");
    expect(r.stderr).not.toContain("globex");
  });

  it("under auto, a source that differs from the profile's local rewrites it, warning each {{key}} and section it loses", async () => {
    const s = await setup(
      { ...spec, profiles: [profile("acme", ["base", "acme-extra"], ["claude-code"], { params: { tool: "npm" } }), profile("globex", ["base"])] },
      { schema: 8, files: { ...localRule("acme", "x", "Use {{tool}}.\n<!-- craftar:section tips -->\nTip.\n<!-- /craftar:section -->\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) } },
    );
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "Use npm, always.\n");
    const r = importInto(s, "auto");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/x (profiles/acme/ingredients/rules/x) — rewritten from .claude/rules/x.md");
    expect(r.stdout).toContain("rule/x: local rewritten from .claude/rules/x.md — {{tool}} is no longer in it");
    expect(r.stdout).toContain("rule/x: local rewritten from .claude/rules/x.md — section tips is no longer in it");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("Use npm, always.\n");
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  });

  it("under auto, a name another profile holds as a local becomes this profile's own local", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"]), profile("globex", ["base", "globex-extra"])] }, { files: { ...localRule("globex", "secret", "# S\n"), ...localRecipe("globex", "globex-extra", ["rule/secret"]) }, ws: { ".claude/rules/secret.md": "# mine\n" } });
    const r = importInto(s, "auto");
    expect(r.code, r.stderr).toBe(0);
    const f = await loadForge(s.forge);
    expect(f.locals.get("acme")!.ingredients.has("rule/secret" as never)).toBe(true);
    expect(f.locals.get("globex")!.ingredients.has("rule/secret" as never)).toBe(true);
    expect(r.stdout).not.toContain("globex");
  });

  it("under auto, a base-less root variant of the profile is reused, and no root base is created beside it", async () => {
    const s = await setup({ ingredients: [rule("style", "# S\n"), rule("x--acme", "# X acme\n", { as: "x" })], recipes: [recipe("base", ["rule/style", "rule/x--acme"])], profiles: [profile("acme", ["base"])] });
    const before = await snapshot(s.forge);
    const r = importInto(s, "auto");
    expect(r.code, r.stderr).toBe(0);
    const after = await snapshot(s.forge);
    expect(Object.keys(after).some((k) => k.startsWith("ingredients/rules/x/"))).toBe(false);
    expect(after["ingredients/rules/x--acme/rule.md"]).toBe(before["ingredients/rules/x--acme/rule.md"]);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X acme, changed\n");
    const changed = await snapshot(s.forge);
    const refused = importInto(s, "always");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("import: .claude/rules/x.md differs from rule/x--acme, profile acme's variant at the root");
    expect(await snapshot(s.forge)).toEqual(changed);
  });

  it("a source equal to the base while a differing variant exists: the base is reused under each --local", async () => {
    for (const mode of ["never", "auto", "always"]) {
      const s = await setup({ ...spec, ingredients: [...spec.ingredients!, rule("style--acme", "# Style, acme\n", { as: "style" })], recipes: [...spec.recipes!, recipe("base--acme", ["rule/style--acme"])], profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])] });
      await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style\n");
      const r = importInto(s, mode);
      expect(r.code, `${mode}: ${r.stderr}`).toBe(0);
      const res = resolve(await loadForge(s.forge), WorkspaceConfigSchema.parse({ forge: ".", profile: "acme" }));
      expect(res.ingredients.map((i) => i.ref), mode).toEqual(["rule/style"]);
      const st = JSON.parse(runCli(["status", "--json", "--workspace", s.ws]).stdout);
      expect(st.statuses.filter((x: { state: string }) => x.state !== "unchanged"), mode).toEqual([]);
    }
  });

  it("a hand-written Kiro steering file under --local=auto becomes a local, and a re-import reuses it", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"], ["claude-code", "kiro"]), profile("globex", ["base"])] }, { ws: { ".kiro/steering/notes.md": "# Notes\nKeep it short.\n" } });
    const r = importInto(s, "auto");
    expect(r.code, r.stderr).toBe(0);
    const f = await loadForge(s.forge);
    expect(f.locals.get("acme")!.ingredients.has("steering/notes" as never)).toBe(true);
    expect(f.recipes.has("acme-steering")).toBe(false);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
    const again = importInto(s, "auto");
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("steering/notes (profiles/acme/ingredients/steerings/notes) — reused there");
  });

  it("forge localize for acme, then a globex import of the same name under --local=auto", async () => {
    const s = await setup({ ingredients: [rule("style", "# S\n"), rule("x", "# X\n")], recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x"])], profiles: [profile("acme", ["base", "stack-x"]), profile("globex", ["base"])] });
    git(s.forge, "init", "-q", "-b", "main");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "forge");
    const loc = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge]);
    expect(loc.code, loc.stderr).toBe(0);
    const gws = path.join(s.root, "globex-ws");
    await makeWorkspace(gws, s.forge, { config: { profile: "globex" } });
    expect(runCli(["sync", "--workspace", gws]).code).toBe(0);
    await writeFiles(gws, { ".claude/rules/x.md": "# X for globex\n" });
    const r = importInto({ ws: gws, forge: s.forge }, "auto", "globex");
    expect(r.code, r.stderr).toBe(0);
    const f = await loadForge(s.forge);
    expect(f.locals.get("globex")!.ingredients.has("rule/x" as never)).toBe(true);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  });

  it("a reused local no resolved recipe cites: refused under never, wired into acme-local under auto", async () => {
    const files = { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) };
    const s = await setup({ ...spec, profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])] }, { files });
    await writeFiles(s.forge, localRecipe("acme", "acme-extra", []));
    const before = await snapshot(s.forge);
    const never = importInto(s);
    expect(never.code).toBe(1);
    expect(never.stderr).toContain("import: rule/x (profiles/acme/ingredients/rules/x) matches the workspace, but no recipe profile acme resolves cites it");
    expect(await snapshot(s.forge)).toEqual(before);
    const auto = importInto(s, "auto");
    expect(auto.code, auto.stderr).toBe(0);
    const after = await snapshot(s.forge);
    expect(YAML.parse(after["profiles/acme/recipes/acme-local.yaml"]).ingredients).toEqual(["rule/x"]);
    expect(YAML.parse(after["profiles/acme/profile.yaml"]).recipes).toEqual(["base", "acme-extra", "acme-local"]);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  });

  it("a moved stack-x whose local's source is gone: a re-import keeps the local and the plan is unchanged", async () => {
    const s = await setup({ ingredients: [rule("style", "# S\n"), rule("x", "# X\n")], recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x"])], profiles: [profile("acme", ["base", "stack-x"]), profile("globex", ["base"])] });
    git(s.forge, "init", "-q", "-b", "main");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "forge");
    expect(runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge]).code).toBe(0);
    await fs.rm(path.join(s.ws, ".claude/rules/x.md"));
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    // The moved stack-x is not a recipe import computes, so it is left as it is (no kept-local warning: that one is
    // worded for a computed recipe of the folder — a Part A loose end, recorded in the spec).
    expect(r.stdout).toContain("recipes: base");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("# X\n");
    const st = JSON.parse(runCli(["status", "--json", "--workspace", s.ws]).stdout);
    expect(st.statuses.filter((x: { state: string }) => x.state !== "unchanged").map((x: { path: string; state: string }) => [x.path, x.state])).toEqual([[".claude/rules/x.md", "new"]]);
  });

  it("forge localize of a rule held in base--acme, then a re-import: every file unchanged", async () => {
    const s = await setup({ ingredients: [rule("style", "# S\n"), rule("x", "# X\n")], recipes: [recipe("base", ["rule/style"]), recipe("base--acme", ["rule/style", "rule/x"])], profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])] });
    git(s.forge, "init", "-q", "-b", "main");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "forge");
    const loc = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge]);
    expect(loc.code, loc.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/recipes/base--acme.yaml"), "utf8")).toContain("rule/x");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    const st = JSON.parse(runCli(["status", "--json", "--workspace", s.ws]).stdout);
    expect(st.statuses.filter((x: { state: string }) => x.state !== "unchanged")).toEqual([]);
    expect(Object.keys(await snapshot(s.forge)).some((k) => k.startsWith("recipes/base--acme"))).toBe(false);
  });
});
