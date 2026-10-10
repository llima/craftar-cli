import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { reservedKey } from "../src/core/extract.js";
import { exists, loadForge } from "../src/core/forge.js";
import { applyPlan, planFrom, pruneCandidates } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

// Spec 33 §9.5 — take: param never extracts into integrations.* at schema 3, and --prune-recipes keeps a recipe a block selects.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const KEY = "integrations.pm.org";
const manifest = (schema: number) => YAML.stringify({ name: "test-forge", schema });
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}
async function forgeOf(schema: number, spec: ForgeSpec) {
  const root = await tmpDir("craftar-int-unify-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), manifest(schema));
  execFileSync("git", ["init", "-q", forge]);
  git(forge, "config", "gc.auto", "0");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "init");
  return { root, forge, env: { CRAFTAR_HOME: path.join(root, "home") } };
}
const VALUE: ForgeSpec = {
  ingredients: [rule("w", "x globex-api\n"), rule("w--acme", "x acme-api\n", { as: "w" })],
  recipes: [recipe("base", ["rule/w"]), recipe("base--acme", ["rule/w--acme"])],
  profiles: [profile("acme", ["base--acme"])],
};
/** `take: param` on the one hunk, extracting `globex-api` into `key`, through the engine. */
async function extract(schema: number, key: string, pass = true) {
  const { forge } = await forgeOf(schema, VALUE);
  const f = await loadForge(forge);
  const base = f.ingredients.get("rule/w")!;
  const variant = f.ingredients.get("rule/w--acme")!;
  const diff = await diffIngredients(base, variant);
  const plan = await planFrom(base, variant, diff, "acme");
  Object.assign(plan.files[0].hunks![0], { take: "param", params: [{ token: "globex-api", key }] });
  return applyPlan(base, variant, diff, plan, pass ? { forgeSchema: f.manifest.schema } : {});
}
const message = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

describe("reservedKey and take: param at schema 3 (spec 33 §5.2)", () => {
  it("1. reservedKey, the table", () => {
    expect([1, 2].map((s) => reservedKey(KEY, s))).toEqual([false, false]);
    expect([3, 4].map((s) => reservedKey(KEY, s))).toEqual([true, true]);
    for (const s of [1, 2, 3]) {
      expect(reservedKey("kiro.banner", s)).toBe(true);
      expect(reservedKey("constructor", s)).toBe(true);
      expect(reservedKey("integrations", s)).toBe(false);       // no dot: not under the prefix
      expect(reservedKey("integrationsx.y", s)).toBe(false);
      expect(reservedKey("my.integrations.x", s)).toBe(false);  // the prefix, not a substring
      expect(reservedKey("deploy.api", s)).toBe(false);
    }
  });

  it("2. the engine refuses the key at schema 3", async () => {
    expect(await message(extract(3, KEY))).toBe('unify plan: "rule.md" hunk 1: key integrations.pm.org is reserved');
  });

  it("3. (control) the engine extracts into it at schema 2, exactly as today", async () => {
    const r = await extract(2, KEY);
    expect(r.params.map((e) => [e.key, e.default, e.value])).toEqual([[KEY, "globex-api", "acme-api"]]);
    expect(r.write["rule.md"]).toBe("x {{integrations.pm.org}}\n");
  });

  it("4. (control) with no forgeSchema the engine is below every gate", async () => {
    expect(await message(extract(3, KEY, false))).toBe("no error");
  });

  it("5. (control) another key extracts at schema 3", async () => {
    expect((await extract(3, "deploy.api")).params.map((e) => e.key)).toEqual(["deploy.api"]);
  });

  it("6. the CLI hands the Forge's schema to the engine", async () => {
    const { root, forge, env } = await forgeOf(3, VALUE);
    const planPath = path.join(root, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/w", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "param";
    plan.files[0].hunks[0].params = [{ token: "globex-api", key: KEY }];
    await fs.writeFile(planPath, YAML.stringify(plan));
    const r = runCli(["forge", "unify", "rule/w", "--profile", "acme", "--plan", planPath, "--forge", forge], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unify plan: "rule.md" hunk 1: key integrations.pm.org is reserved');
    expect(git(forge, "status", "--porcelain")).toBe("");
  });

  it("7. (control) the same CLI run at schema 2 extracts", async () => {
    const { root, forge, env } = await forgeOf(2, VALUE);
    const planPath = path.join(root, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/w", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "param";
    plan.files[0].hunks[0].params = [{ token: "globex-api", key: KEY }];
    await fs.writeFile(planPath, YAML.stringify(plan));
    const r = runCli(["forge", "unify", "rule/w", "--profile", "acme", "--plan", planPath, "--forge", forge], { env });
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(forge, "ingredients/rules/w/rule.md"), "utf8")).toBe("x {{integrations.pm.org}}\n");
  });

  it("8. import never infers an integrations.* key at schema 3, and still does at schema 2", async () => {
    // Schema 2 (control)
    {
      const { root, forge } = await forgeOf(2, {
        ingredients: [rule("deploy", "use {{integrations.x}} here\n", { params: { "integrations.x": { default: "globex-api" } } })],
        recipes: [recipe("base", ["rule/deploy"])],
        profiles: [profile("acme", ["base"])],
      });
      const ws = path.join(root, "b");
      await writeFiles(ws, { ".claude/rules/deploy.md": "use initech-api here\n" });
      const r = await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "b" });
      expect(r.inferred).toEqual([{ name: "rule/deploy", values: { "integrations.x": "initech-api" } }]);
      expect(r.variants).toEqual([]);
    }
    // Schema 3
    {
      const { root, forge } = await forgeOf(3, {
        ingredients: [rule("deploy", "use {{integrations.x}} here\n", { params: { "integrations.x": { default: "globex-api" } } })],
        recipes: [recipe("base", ["rule/deploy"])],
        profiles: [profile("acme", ["base"])],
      });
      const ws = path.join(root, "b");
      await writeFiles(ws, { ".claude/rules/deploy.md": "use initech-api here\n" });
      const r = await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "b" });
      expect(r.inferred).toEqual([]);
      expect(r.params).toEqual([]);
      expect(r.variants.map((v) => v.name)).toEqual(["rule/deploy--b"]);
      expect(YAML.parse(await fs.readFile(path.join(forge, "profiles/b/profile.yaml"), "utf8")).params).toEqual({});
    }
  });
});

describe("--prune-recipes and a recipe a block selects (spec 33 §4.4)", () => {
  const pruneSpec = (acme: Record<string, unknown>, extra: ForgeSpec["profiles"] = []): ForgeSpec => ({
    ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
    recipes: [recipe("pm-ado", ["rule/wf"]), recipe("pm-ado--acme", ["rule/wf--acme"])],
    profiles: [{ name: "acme", targets: ["claude-code"], ...acme }, ...(extra ?? [])],
  });
  const SELECTS = { recipes: [], integrations: { pm: { kind: "ado--acme" } } };
  async function pruned(schema: number, spec: ForgeSpec) {
    const t = await forgeOf(schema, spec);
    const ws = path.join(t.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(runCli(["sync", "--workspace", ws], { env: t.env }).code).toBe(0);
    const profileBefore = await fs.readFile(path.join(t.forge, "profiles/acme/profile.yaml"), "utf8");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", t.forge, "--json"], { env: t.env });
    return { ...t, ws, r, profileBefore };
  }

  it("9. selected only through the block: kept, with the reason, no profile file edited", async () => {
    const t = await pruned(3, pruneSpec(SELECTS));
    expect(t.r.code).toBe(0);
    const out = JSON.parse(t.r.stdout);
    expect(out.recipes).toEqual({
      rewritten: ["pm-ado--acme"],
      identicalToSibling: ["pm-ado--acme"],
      pruned: [],
      kept: [{ recipe: "pm-ado--acme", reason: "profile acme selects it through integrations" }],
    });
    expect(await exists(path.join(t.forge, "recipes/pm-ado--acme.yaml"))).toBe(true);
    expect(await fs.readFile(path.join(t.forge, "profiles/acme/profile.yaml"), "utf8")).toBe(t.profileBefore);
    expect(runCli(["status", "--workspace", t.ws, "--json"], { env: t.env }).code).toBe(0);
    // Print once, then pin: the warnings array
    expect(out.warnings).toEqual([]);
  });

  it("10. listed by hand AND selected: kept too (choice B10)", async () => {
    const t = await pruned(3, pruneSpec({ recipes: ["pm-ado--acme"], integrations: { pm: { kind: "ado--acme" } } }));
    const out = JSON.parse(t.r.stdout);
    expect(out.recipes.pruned).toEqual([]);
    expect(out.recipes.kept).toEqual([{ recipe: "pm-ado--acme", reason: "profile acme selects it through integrations" }]);
    expect(await fs.readFile(path.join(t.forge, "profiles/acme/profile.yaml"), "utf8")).toBe(t.profileBefore);
    expect(await exists(path.join(t.forge, "recipes/pm-ado--acme.yaml"))).toBe(true);
  });

  it("11. two profiles select it: both named, sorted", async () => {
    const t = await pruned(3, pruneSpec(SELECTS, [{ name: "globex", recipes: [], targets: ["claude-code"], integrations: { pm: { kind: "ado--acme" } } }]));
    const out = JSON.parse(t.r.stdout);
    expect(out.recipes.kept[0].reason).toBe("profile acme, globex selects it through integrations");
  });

  it("12. (control) the same Forge at schema 2, the recipe listed by hand, prunes as today", async () => {
    const t = await pruned(2, pruneSpec({ recipes: ["pm-ado--acme"], integrations: { pm: { kind: "ado--acme" } } }));
    const out = JSON.parse(t.r.stdout);
    expect(out.recipes.pruned).toEqual([{ recipe: "pm-ado--acme", sibling: "pm-ado", profiles: ["profiles/acme/profile.yaml"] }]);
    expect(out.recipes.kept).toEqual([]);
    expect(await exists(path.join(t.forge, "recipes/pm-ado--acme.yaml"))).toBe(false);
  });

  it("13. another profile's malformed block: read as written, warned once", async () => {
    const t = await pruned(3, pruneSpec(SELECTS, [{ name: "globex", recipes: ["pm-ado"], targets: ["claude-code"], integrations: { pm: "x" } }]));
    expect(t.r.code).toBe(0);
    const out = JSON.parse(t.r.stdout);
    expect(out.recipes.kept).toEqual([{ recipe: "pm-ado--acme", reason: "profile acme selects it through integrations" }]);
    expect(out.warnings.filter((w: string) => w === "profile globex: integrations.pm is not a mapping — its recipes are read as written")).toHaveLength(1);
  });

  it("14. pruneCandidates carries the names", async () => {
    const { forge } = await forgeOf(3, pruneSpec(SELECTS));
    const f = await loadForge(forge);
    const c = await pruneCandidates(f, "rule/wf" as `${string}/${string}`, "rule/wf--acme" as `${string}/${string}`, "acme");
    expect(c.map((x) => [x.recipe, x.sibling, x.profiles, x.viaIntegrations])).toEqual([["pm-ado--acme", "pm-ado", [], ["acme"]]]);
  });

  it("9b. (M5 test) with CRAFTAR_NO_REGISTRY, the reason is still the integration reason", async () => {
    const t = await forgeOf(3, pruneSpec(SELECTS));
    const ws = path.join(t.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(runCli(["sync", "--workspace", ws], { env: t.env }).code).toBe(0);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", t.forge, "--json"], { env: { ...t.env, CRAFTAR_NO_REGISTRY: "1" } });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.recipes.kept).toEqual([{ recipe: "pm-ado--acme", reason: "profile acme selects it through integrations" }]);
  });
});
