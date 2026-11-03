import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule } from "./helpers/forge.js";
import { build, OVERRIDDEN, OVERRIDE_FILES } from "./helpers/local-override.js";

/** Spec 56 §5.5 and §6: what the reading surfaces and the warnings say of an override, at the gate. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

type Row = { ref: string; scope?: string; profile?: string | null; overrides?: string | null };

describe("an override on the reading surfaces (spec 56 §6)", () => {
  it("explain prints the source line with the root ingredient it overrides", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    const r = runCli(["explain", ".claude/rules/y.md", "--workspace", s.ws.acme]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  source      profile acme (profiles/acme/ingredients/rules/y), over ingredients/rules/y\n");
    const style = runCli(["explain", ".claude/rules/style.md", "--workspace", s.ws.acme]);
    expect(style.stdout).toContain("  source      forge (ingredients/rules/style)\n");
  });

  it("ingredients --forge --json: both rows, overrides on the local, null on every other row", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    const r = runCli(["ingredients", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = (JSON.parse(r.stdout) as { ingredients: Row[] }).ingredients;
    expect(rows.filter((x) => x.ref === "rule/y").map((x) => [x.scope, x.overrides])).toEqual([
      ["forge", null],
      ["profile", "ingredients/rules/y"],
    ]);
    expect(rows.every((x) => "overrides" in x)).toBe(true);
    const text = runCli(["ingredients", "--forge", s.forge]).stdout;
    expect(text).toContain("y (local to acme, overrides the root)");
  });

  it("ingredients in acme's workspace: one rule/y row, the local's, no overrides key, the text marked", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    const rows = (JSON.parse(runCli(["ingredients", "--json", "--workspace", s.ws.acme]).stdout) as { ingredients: Row[] }).ingredients;
    expect(rows.filter((x) => x.ref === "rule/y")).toEqual([expect.objectContaining({ scope: "profile", profile: "acme" })]);
    expect(rows.some((x) => "overrides" in x)).toBe(false);
    expect(runCli(["ingredients", "--workspace", s.ws.acme]).stdout).toContain("y (local to acme, overrides the root)");
  });

  it("ingredients --forge --profile globex lists the root rule/y only, no local of acme's", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, git: false });
    const rows = (JSON.parse(runCli(["ingredients", "--forge", s.forge, "--profile", "globex", "--json"]).stdout) as { ingredients: Row[] }).ingredients;
    expect(rows.filter((x) => x.ref === "rule/y")).toEqual([expect.objectContaining({ scope: "forge", profile: null })]);
  });
});

describe("an override and the Forge writers (spec 56 §5.5, §6)", () => {
  it("drift promote of a hand edit of the overridden file edits acme's local and never the root rule/y", async () => {
    const s = await build(cleanups, OVERRIDDEN, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    const root = await fs.readFile(path.join(s.forge, "ingredients/rules/y/rule.md"), "utf8");
    await fs.writeFile(path.join(s.ws.acme, ".claude/rules/y.md"), "# Y for acme, edited\n");
    const r = runCli(["drift", "promote", ".claude/rules/y.md", "--workspace", s.ws.acme, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { outcome: string }).outcome).toBe("local");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/y/rule.md"), "utf8")).toBe("# Y for acme, edited\n");
    expect(await fs.readFile(path.join(s.forge, "ingredients/rules/y/rule.md"), "utf8")).toBe(root);
    void listFiles;
  });

  it("forge promote and forge unify on a root ingredient acme overrides warn that acme does not change", async () => {
    const spec = {
      ingredients: [...OVERRIDDEN.ingredients!, rule("y--globex", "# Y g\n", { as: "y" })],
      recipes: [...OVERRIDDEN.recipes!, recipe("base--globex", ["rule/style", "rule/y--globex"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["base--globex"]), profile("initech", ["base"])],
    };
    const line = "rule/y is overridden for profile acme — this run does not change what acme resolves";
    const s = await build(cleanups, spec, { extra: OVERRIDE_FILES });
    const p = runCli(["forge", "promote", "rule/y", "--profile", "globex", "--forge", s.forge, "--dry-run", "--json"]);
    expect(p.code, p.stderr).toBe(0);
    expect((JSON.parse(p.stdout) as { warnings: string[] }).warnings).toContain(line);
    const u = runCli(["forge", "unify", "rule/y", "--profile", "globex", "--take", "base", "--forge", s.forge, "--json"]);
    expect(u.code, u.stderr).toBe(0);
    expect((JSON.parse(u.stdout) as { warnings: string[] }).warnings).toContain(line);
    void YAML;
  });
});
