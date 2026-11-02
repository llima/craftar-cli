import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/** Spec 51 §5.4 and acceptance 9: `drift promote` of a profile-local ingredient's file, D22 lifted. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function setup(body: string, params: Record<string, unknown> = {}) {
  const root = await tmpDir("craftar-promote-local-");
  roots.push(root);
  const forge = path.join(root, "forge");
  const spec: ForgeSpec = {
    ingredients: [rule("style", "# Style\n")],
    recipes: [recipe("base", ["rule/style"])],
    profiles: [profile("acme", ["base", "acme-extra"], ["claude-code"], { params }), profile("globex", ["base"])],
  };
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 8 }));
  await writeFiles(forge, {
    "profiles/acme/ingredients/rules/x/ingredient.yaml": YAML.stringify({ type: "rule", name: "x", ...(Object.keys(params).length ? { params: Object.fromEntries(Object.keys(params).map((k) => [k, { description: k }])) } : {}) }),
    "profiles/acme/ingredients/rules/x/rule.md": body,
    "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/x"] }),
  });
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const r = runCli(["sync", "--workspace", ws]);
  expect(r.code, r.stderr).toBe(0);
  return { root, forge, ws };
}

async function forgeFiles(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((f) => !f.startsWith(".git/"));
}

describe("drift promote on a local (spec 51 §5.4)", () => {
  it("acceptance 9: a hand edit of a local's file edits that file in place, no variant, and the proof holds", async () => {
    const s = await setup("# X\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, edited by hand\n");
    const show = JSON.parse(runCli(["drift", "show", "--json", "--workspace", s.ws]).stdout);
    expect(show.files.find((x: { path: string }) => x.path === ".claude/rules/x.md")).toMatchObject({ promotable: true, reason: null });
    const r = runCli(["drift", "promote", ".claude/rules/x.md", "--json", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ outcome: "local", promoted: "rule/x", ingredient: "rule/x" });
    expect(out.written.map((w: { path: string }) => w.path)).toContain("profiles/acme/ingredients/rules/x/rule.md");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("# X, edited by hand\n");
    expect((await forgeFiles(s.forge)).some((f) => f.includes("x--acme"))).toBe(false);
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "promote");
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  });

  it("the text form says the local was edited in place", async () => {
    const s = await setup("# X\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, edited by hand\n");
    const r = runCli(["drift", "promote", ".claude/rules/x.md", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("promote .claude/rules/x.md → rule/x (local, profile acme)");
  });

  it("a value inference proves goes to the profile's params, the local untouched", async () => {
    const s = await setup("Use {{tool}}.\n", { tool: "npm" });
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "Use pnpm.\n");
    const r = runCli(["drift", "promote", ".claude/rules/x.md", "--json", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).outcome).toBe("params");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("Use {{tool}}.\n");
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/profile.yaml"), "utf8")).params.tool).toBe("pnpm");
  });

  it("a {{key}} the edited text no longer holds is flattened and named", async () => {
    const s = await setup("Use {{tool}}.\n", { tool: "npm" });
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "Always use the package manager.\n");
    const r = runCli(["drift", "promote", ".claude/rules/x.md", "--json", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.outcome).toBe("local");
    expect(out.flattened.params).toEqual(["tool"]);
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("Always use the package manager.\n");
  });
});
