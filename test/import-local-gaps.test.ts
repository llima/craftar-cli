import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

// E42.3, E42.4, E42.5 (spec 51 §4.5, §5.3): import and a profile's locals at Forge schema 8.

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const localRule = (p: string, name: string, body: string, extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name, ...extra }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});
const localRecipe = (p: string, file: string, name: string, ingredients: string[]) => ({ [`profiles/${p}/recipes/${file}`]: YAML.stringify({ name, ingredients }) });

async function setup(s: ForgeSpec, files: Record<string, string>, schema = 8) {
  const root = await tmpDir("craftar-import-local-gaps-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, s);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(forge, files);
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const sync = runCli(["sync", "--workspace", ws]);
  expect(sync.code, sync.stderr).toBe(0);
  return { root, forge, ws };
}
const importInto = (s: { ws: string; forge: string }, extra: string[] = []) =>
  runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme", ...extra]);

describe("import and a profile's locals — the gaps of spec 51 Part B", () => {
  it("L1 (E42.3, a pin): a local only a recipe the integrations block selects cites is left to that recipe, never wired into <p>-local", async () => {
    // `providedByBlock` leaves such a source to its recipe before any decision, so it never reaches `wireLocals`.
    const s = await setup(
      {
        ingredients: [rule("style", "# Style\n")],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } })],
      },
      { ...localRule("acme", "team", "# Team\n"), ...localRecipe("acme", "pm-jira.yaml", "pm-jira", ["rule/team"]) },
    );
    expect(await fs.readFile(path.join(s.ws, ".claude/rules/team.md"), "utf8")).toBe("# Team\n");
    const r = importInto(s, ["--local=auto"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("left to recipe pm-jira (integrations.pm): rule/team");
    expect(r.stdout).not.toContain("local recipe acme-local");
    expect(await exists(path.join(s.forge, "profiles/acme/recipes/acme-local.yaml"))).toBe(false);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/profile.yaml"), "utf8")).recipes).not.toContain("acme-local");
  });

  const extraSpec: ForgeSpec = {
    ingredients: [rule("style", "# Style\n")],
    recipes: [recipe("base", ["rule/style"])],
    profiles: [profile("acme", ["base", "acme-extra"])],
  };
  const KEPT = (file: string) =>
    `warn rule/team: local to profile acme, kept in profiles/acme/recipes/${file} though the workspace no longer holds its source — the next sync writes its file back`;

  for (const file of ["acme-extra.yaml", "Acme-Extra.yaml"]) {
    it(`L2 (E42.4): a source-less local kept in a recipe import did not compute is warned — ${file}`, async () => {
      const s = await setup(extraSpec, { ...localRule("acme", "team", "# Team\n"), ...localRecipe("acme", file, "acme-extra", ["rule/team"]) });
      const recipeFile = path.join(s.forge, "profiles/acme/recipes", file);
      const before = await fs.readFile(recipeFile, "utf8");
      await fs.rm(path.join(s.ws, ".claude/rules/team.md"));
      const r = importInto(s);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.split(KEPT(file)).length - 1).toBe(1);
      expect(await fs.readFile(recipeFile, "utf8")).toBe(before);
    });
  }

  it("L2 control: the local's source present and equal gives no such warning", async () => {
    const s = await setup(extraSpec, { ...localRule("acme", "team", "# Team\n"), ...localRecipe("acme", "acme-extra.yaml", "acme-extra", ["rule/team"]) });
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("though the workspace no longer holds its source");
  });

  for (const eol of ["\n", "\r\n"]) {
    it(`L3 (E42.5): a reused local's rendered values reach the summary — ${eol === "\n" ? "LF" : "CRLF"}`, async () => {
      const s = await setup(
        {
          ingredients: [rule("style", "# Style\n")],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base", "acme-own"], ["claude-code"], { params: { who: "Acme" } })],
        },
        { ...localRule("acme", "greet", "Hello {{who}}.\n", { params: { who: { description: "who is greeted" } } }), ...localRecipe("acme", "acme-own.yaml", "acme-own", ["rule/greet"]) },
      );
      const file = path.join(s.ws, ".claude/rules/greet.md");
      expect(await fs.readFile(file, "utf8")).toBe("Hello Acme.\n");
      await fs.writeFile(file, `Hello Acme.${eol}`);
      const r = importInto(s);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("local to profile acme: rule/greet (profiles/acme/ingredients/rules/greet) — reused there");
      expect(r.stdout).toContain("rendered rule/greet — who");
    });
  }

  it("L4 (E42.5): a local the parent profile holds, reused, reaches the summary's rendered line too", async () => {
    const s = await setup(
      {
        ingredients: [rule("style", "# Style\n")],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("org", ["base", "org-own"], ["claude-code"], { abstract: true }), profile("acme", ["base", "org-own"], ["claude-code"], { extends: "org", params: { who: "Acme" } })],
      },
      { ...localRule("org", "greet", "Hello {{who}}.\n", { params: { who: { description: "who is greeted" } } }), ...localRecipe("org", "org-own.yaml", "org-own", ["rule/greet"]) },
      13,
    );
    expect(await fs.readFile(path.join(s.ws, ".claude/rules/greet.md"), "utf8")).toBe("Hello Acme.\n");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/greet (profiles/org/ingredients/rules/greet) — reused there");
    expect(r.stdout).toContain("rendered rule/greet — who");
  });
});
