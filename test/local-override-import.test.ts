import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { build, CASE2, OVERRIDDEN, OVERRIDE_FILES, S } from "./helpers/local-override.js";

/** Spec 56 §7: import and an override. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await listFiles(dir)).sort()) if (!f.startsWith(".git/") && (await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}
const importAs = (ws: string, forge: string, local?: string) =>
  runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme", ...(local ? ["--local", local] : [])]);

describe("import and an override (spec 56 §7)", () => {
  it("--local=always, row 4 at the gate: a source differing from the root base becomes acme's override, nothing at the root", async () => {
    const s = await build(cleanups, OVERRIDDEN, { workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    await fs.writeFile(path.join(s.ws.acme, ".claude/rules/y.md"), "# Y, acme's own\n");
    const before = await tree(s.forge);
    const r = importAs(s.ws.acme, s.forge, "always");
    expect(r.code, r.stderr).toBe(0);
    const after = await tree(s.forge);
    expect(after["profiles/acme/ingredients/rules/y/rule.md"]).toBe("# Y, acme's own\n");
    expect(YAML.parse(after["profiles/acme/ingredients/rules/y/ingredient.yaml"])).toMatchObject({ type: "rule", name: "y" });
    expect(YAML.parse(after["profiles/acme/ingredients/rules/y/ingredient.yaml"]).as).toBeUndefined();
    for (const k of Object.keys(before).filter((k) => !k.startsWith("profiles/acme/"))) expect(after[k], k).toBe(before[k]);
    // Reached by the root recipe base: not wired into acme-local, and no base--acme split.
    expect(await exists(path.join(s.forge, "profiles/acme/recipes/acme-local.yaml"))).toBe(false);
    expect(await exists(path.join(s.forge, "recipes/base--acme.yaml"))).toBe(false);
    expect(YAML.parse(after["profiles/acme/profile.yaml"]).recipes).toEqual(YAML.parse(before["profiles/acme/profile.yaml"]).recipes);
    expect(runCli(["sync", "--check", "--workspace", s.ws.acme]).code).toBe(0);
  });

  it("--local=always, row 4 below the gate: refused as before", async () => {
    const s = await build(cleanups, OVERRIDDEN, { schema: S - 1, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    await fs.writeFile(path.join(s.ws.acme, ".claude/rules/y.md"), "# Y, acme's own\n");
    const r = importAs(s.ws.acme, s.forge, "always");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("differs from rule/y at the root — --local=always writes no ingredient at the root");
  });

  it("row 3 under always: at the gate the refusal ends with the forge localize hint; below it, not", async () => {
    const hint = "; or run craftar forge localize rule/y--acme --profile acme";
    for (const schema of [S, S - 1]) {
      const s = await build(cleanups, CASE2, { schema, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
      await fs.writeFile(path.join(s.ws.acme, ".claude/rules/y.md"), "# Y, edited\n");
      const r = importAs(s.ws.acme, s.forge, "always");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("differs from rule/y--acme, profile acme's variant at the root — --local=always does not rewrite a root ingredient");
      if (schema === S) expect(r.stderr).toContain(hint);
      else expect(r.stderr).not.toContain(hint);
    }
  });

  it("a re-import of an override is reused: the Forge is not touched", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    const before = await tree(s.forge);
    for (const mode of [undefined, "auto", "always"]) {
      const r = importAs(s.ws.acme, s.forge, mode);
      expect(r.code, `${mode}: ${r.stderr}`).toBe(0);
      expect(await tree(s.forge), mode).toEqual(before);
    }
  });
});

describe("wiring reads the root recipes as staged (spec 56 §7)", () => {
  it("an override reached only through a root recipe this run writes is not wired into acme-local", async () => {
    const { profile, recipe, rule } = await import("./helpers/forge.js");
    const spec = {
      ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n")],
      recipes: [recipe("base", ["rule/style"]), recipe("stack-y", ["rule/y"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["base", "stack-y"])],
    };
    const s = await build(cleanups, spec, { workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    await fs.writeFile(path.join(s.ws.acme, ".claude/rules/y.md"), "# Y, acme's own\n");
    const r = importAs(s.ws.acme, s.forge, "always");
    expect(r.code, r.stderr).toBe(0);
    const after = await tree(s.forge);
    expect(after["profiles/acme/ingredients/rules/y/rule.md"]).toBe("# Y, acme's own\n");
    expect(await exists(path.join(s.forge, "profiles/acme/recipes/acme-local.yaml"))).toBe(false);
    // The workspace already holds the override's text: the Forge now plans it, and nothing else moves.
    expect(runCli(["sync", "--check", "--workspace", s.ws.acme]).code).toBe(0);
  });
});
