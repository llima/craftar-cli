import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

// E32.1 = E41.6 (decision 14): no target writes a rule's `description` into a file, so import leaves it out of every
// comparison — an otherwise equal source reuses the base, which keeps its description.

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function setup(s: ForgeSpec, schema: number, files: Record<string, string> = {}) {
  const root = await tmpDir("craftar-import-rule-description-");
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
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/") && (await fs.lstat(path.join(dir, f))).isFile()) out[f] = await fs.readFile(path.join(dir, f), "utf8");
  return out;
}
const importInto = (s: { ws: string; forge: string }) => runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme"]);
const counts = (stdout: string) => stdout.split("\n")[1];

const readme: ForgeSpec = {
  ingredients: [rule("readme", "# Readme\n", { description: "How to read" })],
  recipes: [recipe("base", ["rule/readme"])],
  profiles: [profile("acme", ["base"])],
};

describe("import and a rule's description", () => {
  for (const eol of ["\n", "\r\n"]) {
    it(`D1/D2: an otherwise equal source reuses a base that has a description — ${eol === "\n" ? "LF" : "CRLF"}`, async () => {
      const s = await setup(readme, 1);
      await fs.writeFile(path.join(s.ws, ".claude/rules/readme.md"), `# Readme${eol}`);
      const before = await fs.readFile(path.join(s.forge, "ingredients/rules/readme/ingredient.yaml"), "utf8");
      const r = importInto(s);
      expect(r.code, r.stderr).toBe(0);
      expect(counts(r.stdout)).toBe("  0 created, 1 reused, 0 variants, 0 rejected");
      expect(await exists(path.join(s.forge, "ingredients/rules/readme--acme"))).toBe(false);
      expect(await fs.readFile(path.join(s.forge, "ingredients/rules/readme/ingredient.yaml"), "utf8")).toBe(before);
    });
  }

  it("D3 (control): a body that differs is a variant, written with no description, as before", async () => {
    const s = await setup(readme, 1);
    await fs.writeFile(path.join(s.ws, ".claude/rules/readme.md"), "# Readme v2\n");
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("variant rule/readme--acme — differs from rule/readme already in the Forge");
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "ingredients/rules/readme--acme/ingredient.yaml"), "utf8")).description).toBeUndefined();
  });

  it("D4: at schema 7 a re-import of what sync laid out reuses both rules — no variant, no frozen list, the Forge unchanged", async () => {
    const s = await setup(
      {
        ingredients: [rule("index", "# Rules\n\n{{craftar.rules.index}}\n", { description: "The list" }), rule("style", "# Style\n", { description: "Style guide" })],
        recipes: [recipe("base", ["rule/index", "rule/style"])],
        profiles: [profile("acme", ["base"])],
      },
      7,
    );
    const before = await snapshot(s.forge);
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(counts(r.stdout)).toBe("  0 created, 2 reused, 0 variants, 0 rejected");
    expect(r.stdout).not.toContain("is frozen there");
    const after = await snapshot(s.forge);
    for (const k of Object.keys(before)) if (k !== "profiles/acme/profile.yaml") expect(after[k], k).toBe(before[k]);
  });

  it("D5: at schema 9 a description that renders a param is left out too", async () => {
    const s = await setup(
      {
        ingredients: [rule("readme", "# Readme\n", { description: "How {{who}} reads", params: { who: { description: "the reader" } } })],
        recipes: [recipe("base", ["rule/readme"])],
        profiles: [profile("acme", ["base"], ["claude-code"], { params: { who: "Acme" } })],
      },
      9,
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(counts(r.stdout)).toBe("  0 created, 1 reused, 0 variants, 0 rejected");
  });

  it("D6: at schema 8 a local with a description, equal otherwise, is reused there", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-own"])] },
      8,
      {
        "profiles/acme/ingredients/rules/team/ingredient.yaml": YAML.stringify({ type: "rule", name: "team", description: "Team" }),
        "profiles/acme/ingredients/rules/team/rule.md": "# Team\n",
        "profiles/acme/recipes/acme-own.yaml": YAML.stringify({ name: "acme-own", ingredients: ["rule/team"] }),
      },
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/team (profiles/acme/ingredients/rules/team) — reused there");
  });

  it("D7 (control): drift promote of a hand edit still makes a variant, and the base keeps its description", async () => {
    const s = await setup(readme, 1);
    git(s.forge, "init", "-q");
    git(s.forge, "add", ".");
    git(s.forge, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "forge");
    await fs.writeFile(path.join(s.ws, ".claude/rules/readme.md"), "# Readme, edited by hand\n");
    const r = runCli(["drift", "promote", ".claude/rules/readme.md", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("rule/readme--acme");
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "ingredients/rules/readme/ingredient.yaml"), "utf8")).description).toBe("How to read");
  });

  it("D8: the literal comparison (G1) leaves the description out too — a description citing a key only a recipe defaults", async () => {
    const base = recipe("base", ["rule/readme"], { params: { team: { default: "core" } } });
    const s = await setup(
      { ingredients: [rule("readme", "# Readme\n", { description: "How {{team}} reads" })], recipes: [base], profiles: [profile("acme", ["base"])] },
      9,
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(counts(r.stdout)).toBe("  0 created, 1 reused, 0 variants, 0 rejected");
    expect(await exists(path.join(s.forge, "ingredients/rules/readme--acme"))).toBe(false);
  });

  const describedLocal = (p: string) => ({
    [`profiles/${p}/ingredients/rules/readme/ingredient.yaml`]: YAML.stringify({ type: "rule", name: "readme", description: "How {{team}} reads" }),
    [`profiles/${p}/ingredients/rules/readme/rule.md`]: "# Readme\n",
    [`profiles/${p}/recipes/${p}-own.yaml`]: YAML.stringify({ name: `${p}-own`, ingredients: ["rule/readme"], params: { team: { default: "core" } } }),
  });

  it("D9: the literal comparison of the profile's own local leaves the description out too", async () => {
    const s = await setup(
      { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base", "acme-own"])] },
      9,
      describedLocal("acme"),
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/readme (profiles/acme/ingredients/rules/readme) — reused there");
  });

  it("D10: the literal comparison of a parent profile's local leaves the description out too", async () => {
    const s = await setup(
      {
        ingredients: [rule("style", "# Style\n")],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("org", ["base", "org-own"], ["claude-code"], { abstract: true }), profile("acme", ["base", "org-own"], ["claude-code"], { extends: "org" })],
      },
      13,
      describedLocal("org"),
    );
    const r = importInto(s);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("local to profile acme: rule/readme (profiles/org/ingredients/rules/readme) — reused there");
  });
});
