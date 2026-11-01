import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

/** Spec 51 §4.2 and §4.5: import into a Forge at schema 8 whose profile holds locals. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});
const localRecipe = (p: string, name: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients, ...extra }),
});

/** A Forge at schema 8 and a workspace synced from it, then imported back into it. */
async function setup(spec: ForgeSpec, files: Record<string, string>, opts: { schema?: number } = {}) {
  const root = await tmpDir("craftar-local-import-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema ?? 8 }));
  await writeFiles(forge, files);
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const sync = runCli(["sync", "--workspace", ws]);
  expect(sync.code, sync.stderr).toBe(0);
  return { root, forge, ws };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if ((await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}

const importInto = (s: { ws: string; forge: string }) => runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme"]);

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])],
};
const files = { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) };

describe("import and the profile's locals (spec 51 §4.5)", () => {
  it("a source equal to the profile's local is reused there, never placed at the root, and the Forge is unchanged", async () => {
    const s = await setup(spec, files);
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/x (profiles/acme/ingredients/rules/x) — reused there");
    const after = await snapshot(s.forge);
    for (const k of Object.keys(before)) if (k !== "profiles/acme/profile.yaml") expect(after[k], k).toBe(before[k]);
    expect(YAML.parse(after["recipes/base.yaml"]).ingredients).toEqual(["rule/style"]);
    expect(YAML.parse(after["profiles/acme/profile.yaml"]).recipes).toEqual(["base", "acme-extra"]);
    expect(Object.keys(after).some((k) => k.startsWith("ingredients/rules/x"))).toBe(false);
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  });

  it("a source that differs from the profile's local is refused, the Forge untouched", async () => {
    const s = await setup(spec, files);
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, edited\n");
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: .claude/rules/x.md differs from rule/x, local to profile acme (profiles/acme/ingredients/rules/x)");
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("a reused local no resolved recipe cites is refused, since sync would remove its file", async () => {
    const s = await setup(spec, files);
    await writeFiles(s.forge, localRecipe("acme", "acme-extra", []));
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: rule/x (profiles/acme/ingredients/rules/x) matches the workspace, but no recipe profile acme resolves cites it");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("a reused local only the workspace's recipes.add brings in is seen, not refused", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"]), profile("globex", ["base"])] }, files);
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), YAML.stringify({ forge: path.relative(s.ws, s.forge), profile: "acme", recipes: { add: ["acme-extra"] } }));
    expect(runCli(["sync", "--workspace", s.ws]).code).toBe(0);
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/x (profiles/acme/ingredients/rules/x) — reused there");
  });

  it("I14: a new root ingredient named after another profile's local is refused, naming no profile", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"]), profile("globex", ["base", "globex-extra"])] }, { ...localRule("globex", "secret", "# S\n"), ...localRecipe("globex", "globex-extra", ["rule/secret"]) });
    await writeFiles(s.ws, { ".claude/rules/secret.md": "# mine\n" });
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: I14 .claude/rules/secret.md would become rule/secret at the root, a name another profile holds as a local");
    expect(r.stderr).not.toContain("globex");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("a root ref only a local recipe cites does not fork the root recipe", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n"), rule("extra", "# Extra\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-extra"])] },
      localRecipe("acme", "acme-extra", ["rule/extra"]),
    );
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    const after = await snapshot(s.forge);
    expect(Object.keys(after).filter((k) => k.startsWith("recipes/")).sort()).toEqual(["recipes/base.yaml"]);
    expect(after["recipes/base.yaml"]).toBe(before["recipes/base.yaml"]);
    expect(YAML.parse(after["profiles/acme/profile.yaml"]).recipes).toEqual(["base", "acme-extra"]);
  });

  it("a variant replaces the base in a local recipe in place, and a re-import with the base text swaps it back", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n"), rule("workflow", "# Workflow\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-extra"]), profile("globex", ["base"])] },
      localRecipe("acme", "acme-extra", ["rule/workflow"]),
    );
    await fs.writeFile(path.join(s.ws, ".claude/rules/workflow.md"), "# Workflow for acme\n");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/recipes/acme-extra.yaml"), "utf8")).ingredients).toEqual(["rule/workflow--acme"]);
    expect(runCli(["sync", "--workspace", s.ws]).code).toBe(0);
    await fs.writeFile(path.join(s.ws, ".claude/rules/workflow.md"), "# Workflow\n");
    const back = importInto(s);
    expect(back.code, back.stderr).toBe(0);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/recipes/acme-extra.yaml"), "utf8")).ingredients).toEqual(["rule/workflow"]);
  });

  it("an owned recipe in the profile's folder is found there, keeps its slot and its locals, and no root copy is written", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n")], recipes: [], profiles: [profile("acme", ["base"]), profile("globex", [])] },
      { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "base", ["rule/style", "rule/x"]) },
    );
    await fs.rm(path.join(s.ws, ".claude/rules/x.md"));
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.stat(path.join(s.forge, "recipes/base.yaml")).then(() => true, () => false)).toBe(false);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/recipes/base.yaml"), "utf8")).ingredients).toEqual(["rule/style", "rule/x"]);
    expect(r.stdout).toContain("rule/x: local to profile acme, kept in profiles/acme/recipes/base.yaml though the workspace no longer holds its source — the next sync writes its file back");
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/profile.yaml"), "utf8")).recipes).toEqual(["base"]);
    await loadForge(s.forge);
  });

  it("a computed name another profile holds as a local recipe takes the profile's own --<p>", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n")], recipes: [recipe("core", ["rule/style"])], profiles: [profile("acme", ["core"]), profile("globex", ["base"])] },
      localRecipe("globex", "base", ["rule/style"]),
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.stat(path.join(s.forge, "recipes/base.yaml")).then(() => true, () => false)).toBe(false);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "recipes/base--acme.yaml"), "utf8")).ingredients).toEqual(["rule/style"]);
    await loadForge(s.forge);
  });

  it("a .mcp.json whose order mixes local and root servers is refused, the Forge untouched", async () => {
    const mcp = (name: string) => ({ "ingredient.yaml": YAML.stringify({ type: "mcp", name, server: { command: "npx", args: [name] } }) });
    const s = await setup({ ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style", "mcp/shared"])], profiles: [profile("acme", ["base", "acme-extra"])] }, {
      ...Object.fromEntries(Object.entries(mcp("shared")).map(([k, v]) => [`ingredients/mcp/shared/${k}`, v])),
      ...Object.fromEntries(Object.entries(mcp("mine")).map(([k, v]) => [`profiles/acme/ingredients/mcp/mine/${k}`, v])),
      ...localRecipe("acme", "acme-extra", ["mcp/mine"]),
    });
    const file = path.join(s.ws, ".mcp.json");
    const servers = JSON.parse(await fs.readFile(file, "utf8")).mcpServers;
    await fs.writeFile(file, JSON.stringify({ mcpServers: { mine: servers.mine, shared: servers.shared } }, null, 2) + "\n");
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: .mcp.json lists its servers in an order the recipes cannot express once some are local to profile acme");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("a .mcp.json out of order among root servers alone still imports, as before", async () => {
    const mcp = (name: string) => ({ [`ingredients/mcp/${name}/ingredient.yaml`]: YAML.stringify({ type: "mcp", name, server: { command: "npx", args: [name] } }) });
    const s = await setup({ ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style", "mcp/a", "mcp/b"])], profiles: [profile("acme", ["base"])] }, { ...mcp("a"), ...mcp("b") });
    const file = path.join(s.ws, ".mcp.json");
    const servers = JSON.parse(await fs.readFile(file, "utf8")).mcpServers;
    await fs.writeFile(file, JSON.stringify({ mcpServers: { b: servers.b, a: servers.a } }, null, 2) + "\n");
    expect(importInto(s).code).toBe(0);
  });

  it("a linked profiles/<p> is refused before anything is written (a junction on Windows)", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"]), profile("globex", ["base"])] }, {});
    await fs.rename(path.join(s.forge, "profiles/acme"), path.join(s.forge, "profiles-acme-real"));
    await fs.symlink(path.join(s.forge, "profiles/globex"), path.join(s.forge, "profiles/acme"), "junction");
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: profiles/acme is a symbolic link — a profile's folder holds its own files");
  });

  it("below schema 8 nothing of this runs: a profiles/<p>/ingredients folder is not read by import", async () => {
    const s = await setup({ ...spec, profiles: [profile("acme", ["base"])] }, localRule("acme", "x", "# X\n"), { schema: 7 });
    await writeFiles(s.ws, { ".claude/rules/x.md": "# X\n" });
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("local to profile");
    expect(await fs.stat(path.join(s.forge, "ingredients/rules/x/ingredient.yaml")).then(() => true, () => false)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("a file that is not regular in the Forge stops the proof's copy in import's words, the Forge untouched", async () => {
    const s = await setup(spec, files);
    execFileSync("mkfifo", [path.join(s.forge, "fifo")]);
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("fifo is not a regular file — import cannot copy the Forge to prove its edit; remove it");
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await snapshot(s.forge)).toEqual(before);
  });
});
