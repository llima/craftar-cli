import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { exists, loadForge } from "../src/core/forge.js";
import { checkParamWrites } from "../src/core/param-writes.js";
import { applyPlan, metaDifferences, planFrom } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 34 §9 — forge unify: a param a server cites as declared is never written into a profile, and an MCP variant
// with no params stays under a base that declares some.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const manifest = (schema: number) => YAML.stringify({ name: "test-forge", schema });
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}
async function forgeOf(schema: number, spec: ForgeSpec) {
  const root = await tmpDir("craftar-server-unify-");
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
const message = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

/** A rule pair to extract `globex-api` into `key` from, beside an MCP ingredient whose server cites `{{key}}`. */
const withServer = (key: string, declared: boolean): ForgeSpec => ({
  ingredients: [
    rule("w", "x globex-api\n"),
    rule("w--acme", "x acme-api\n", { as: "w" }),
    { meta: { type: "mcp", name: "idp", server: { type: "http", url: `https://{{${key}}}/mcp` }, ...(declared ? { params: { [key]: {} } } : {}) } },
  ],
  recipes: [recipe("base", ["rule/w", "mcp/idp"]), recipe("base--acme", ["rule/w--acme", "mcp/idp"])],
  profiles: [profile("acme", ["base--acme"])],
});
/** The same pair beside a rule whose body cites the key. */
const withBody = (key: string): ForgeSpec => ({
  ingredients: [rule("w", "x globex-api\n"), rule("w--acme", "x acme-api\n", { as: "w" }), rule("other", `also {{${key}}}\n`)],
  recipes: [recipe("base", ["rule/w", "rule/other"]), recipe("base--acme", ["rule/w--acme", "rule/other"])],
  profiles: [profile("acme", ["base--acme"])],
});
async function writes(schema: number, spec: ForgeSpec, key: string) {
  const { forge } = await forgeOf(schema, spec);
  const f = await loadForge(forge);
  const base = f.ingredients.get("rule/w")!;
  const variant = f.ingredients.get("rule/w--acme")!;
  const diff = await diffIngredients(base, variant);
  const plan = await planFrom(base, variant, diff, "acme");
  Object.assign(plan.files[0].hunks![0], { take: "param", params: [{ token: "globex-api", key }] });
  const r = await applyPlan(base, variant, diff, plan, { forgeSchema: f.manifest.schema });
  return checkParamWrites(f, base, variant, "acme", r.params, r.sections);
}
const REFUSED = "unify: mcp/idp also uses {{deploy.api}} under profile acme — its text would change";

describe("take: param and a key a server cites (spec 34 §5.2)", () => {
  it("1. schema 4, the server declares and cites the key: refused", async () => {
    expect(await message(writes(4, withServer("deploy.api", true), "deploy.api"))).toBe(REFUSED);
  });

  it("2. schema 4, the server cites the key without declaring it: not refused", async () => {
    expect(await message(writes(4, withServer("deploy.api", false), "deploy.api"))).toBe("no error");
  });

  it("3. (control) schema 3, declared and cited: not refused", async () => {
    expect(await message(writes(3, withServer("deploy.api", true), "deploy.api"))).toBe("no error");
  });

  it("4. (control) a body citation is refused at every schema, as today", async () => {
    for (const schema of [3, 4]) {
      expect(await message(writes(schema, withBody("deploy.api"), "deploy.api")), `schema ${schema}`).toBe(
        "unify: rule/other also uses {{deploy.api}} under profile acme — its text would change",
      );
    }
  });

  it("5. the CLI passes the Forge's schema", async () => {
    const { root, forge, env } = await forgeOf(4, withServer("deploy.api", true));
    const planPath = path.join(root, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/w", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "param";
    plan.files[0].hunks[0].params = [{ token: "globex-api", key: "deploy.api" }];
    await fs.writeFile(planPath, YAML.stringify(plan));
    const r = runCli(["forge", "unify", "rule/w", "--profile", "acme", "--plan", planPath, "--forge", forge], { env });
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: ${REFUSED}\n`]);
    expect(git(forge, "status", "--porcelain")).toBe("");
  });
});

const K = { k: { default: "https://idp.example.com/mcp" } };
/** The pair of §6.18: `variant` is the base's server as written, with or without `params`. */
const pair = (o: { baseParams?: Record<string, unknown> | null; variantParams?: Record<string, unknown> | null; variantServer?: Record<string, unknown>; baseServer?: Record<string, unknown> } = {}): ForgeSpec => {
  const baseParams = o.baseParams === undefined ? K : o.baseParams;
  const variantParams = o.variantParams === undefined ? null : o.variantParams;
  return {
    ingredients: [
      { meta: { type: "mcp", name: "idp", server: o.baseServer ?? { type: "http", url: "{{k}}" }, ...(baseParams === null ? {} : { params: baseParams }) } },
      { meta: { type: "mcp", name: "idp--acme", as: "idp", server: o.variantServer ?? { type: "http", url: "{{k}}" }, ...(variantParams === null ? {} : { params: variantParams }) } },
    ],
    recipes: [recipe("base", ["mcp/idp"]), recipe("base--acme", ["mcp/idp--acme"])],
    profiles: [profile("acme", ["base--acme"])],
  };
};
const differs = async (schema: number, spec: ForgeSpec, pass = true) => {
  const { forge } = await forgeOf(schema, spec);
  const f = await loadForge(forge);
  const [b, v] = [f.ingredients.get("mcp/idp")!, f.ingredients.get("mcp/idp--acme")!];
  return pass ? metaDifferences(b, v, f.manifest.schema) : metaDifferences(b, v);
};
const FIRST = (fields: string) => `ingredient.yaml differs in ${fields} — unify cannot merge ingredient.yaml, so mcp/idp--acme stays; resolve it by hand, or use --take base to discard the variant`;
const SECOND = "mcp/idp--acme holds its server as a workspace wrote it; discarding it, or giving it the base's params, can make the next sync render those params into that workspace's MCP files";
const unify = (t: { forge: string; env: NodeJS.ProcessEnv }, ...args: string[]) => runCli(["forge", "unify", "mcp/idp", "--profile", "acme", ...args, "--forge", t.forge, "--json"], { env: t.env });
const OTHER = { type: "http", url: "https://other.example.com/mcp" };
const variantDir = (forge: string) => path.join(forge, "ingredients/mcp/idp--acme");
const KEYS = ["base", "profile", "resolved", "written", "removed", "unresolved", "variantRemoved", "recipes", "metaDiffers", "params", "sections", "manifestEdited", "profileEdited", "warnings", "impact"];

describe("an MCP variant that holds its server as a workspace wrote it (spec 34 §5.2)", () => {
  it("6. metaDifferences, the table", async () => {
    expect(await differs(4, pair())).toEqual(["params"]);
    expect(await differs(3, pair())).toEqual([]);
    expect(await differs(4, pair(), false)).toEqual([]);
    expect(await differs(4, pair({ variantServer: OTHER }))).toEqual(["params", "server"]);
    expect(await differs(3, pair({ variantServer: OTHER }))).toEqual(["server"]);
    expect(await differs(4, pair({ variantParams: {} }))).toEqual(["params"]);
    expect(await differs(3, pair({ variantParams: {} }))).toEqual(["params"]);
    expect(await differs(4, pair({ baseParams: {} }))).toEqual([]);
    expect(await differs(4, pair({ baseParams: null }))).toEqual([]);
    const { forge } = await forgeOf(4, {
      ingredients: [rule("w", "a\n", { params: { k: {} } }), rule("w--acme", "a\n", { as: "w" })],
      recipes: [recipe("base", ["rule/w"]), recipe("base--acme", ["rule/w--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const f = await loadForge(forge);
    expect(metaDifferences(f.ingredients.get("rule/w")!, f.ingredients.get("rule/w--acme")!, 4)).toEqual([]);
  });

  it("7. --take variant does not resolve it, and says why in two lines", async () => {
    const t = await forgeOf(4, pair());
    const r = unify(t, "--take", "variant");
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.warnings).toEqual([FIRST("params"), SECOND]);
    expect(await exists(variantDir(t.forge))).toBe(true);
    expect(git(t.forge, "status", "--porcelain")).toBe("");
    expect(out.resolved).toBe(false);
    expect(out.metaDiffers).toEqual(["params"]);
    expect(Object.keys(out)).toEqual(KEYS);
  });

  it("8. the same under --plan", async () => {
    const t = await forgeOf(4, pair());
    const planPath = path.join(t.root, "plan.yaml");
    expect(runCli(["forge", "unify", "mcp/idp", "--profile", "acme", "--save-plan", planPath, "--forge", t.forge], { env: t.env }).code).toBe(0);
    const r = unify(t, "--plan", planPath);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).warnings).toEqual([FIRST("params"), SECOND]);
    expect(await exists(variantDir(t.forge))).toBe(true);
  });

  it("9. no second line for a variant holding a literal server", async () => {
    const r = unify(await forgeOf(4, pair({ variantServer: OTHER })), "--take", "variant");
    expect(JSON.parse(r.stdout).warnings).toEqual([FIRST("params, server")]);
  });

  it("10. (control) none for a variant with params of its own whose server cites a base-declared key", async () => {
    const r = unify(await forgeOf(4, pair({ variantParams: { k: {} }, variantServer: { type: "http", url: "{{k}}", headers: { A: "1" } } })), "--take", "variant");
    expect(JSON.parse(r.stdout).warnings).toEqual([FIRST("params, server")]);
  });

  it("11. (control) none below 4, where the first line is there for a server difference", async () => {
    const r = unify(await forgeOf(3, pair({ variantServer: { type: "http", url: "{{k}}", headers: { A: "1" } } })), "--take", "variant");
    expect(JSON.parse(r.stdout).warnings).toEqual([FIRST("server")]);
  });

  it("12. none at 4 when the variant's server cites only keys the base does not declare", async () => {
    const r = unify(await forgeOf(4, pair({ variantServer: { type: "http", url: "{{other}}" } })), "--take", "variant");
    expect(JSON.parse(r.stdout).warnings).toEqual([FIRST("params, server")]);
  });

  it("13. (control) --take base deletes it, as today", async () => {
    const t = await forgeOf(4, pair());
    const r = unify(t, "--take", "base");
    expect(r.code, r.stderr).toBe(0);
    expect(await exists(variantDir(t.forge))).toBe(false);
    const warnings: string[] = JSON.parse(r.stdout).warnings;
    expect(warnings.filter((w) => w.startsWith("ingredient.yaml differs") || w === SECOND)).toEqual([]);
  });

  it("14. (control) at schema 3 the pair of case 7 resolves with zero decisions and the variant is deleted", async () => {
    const t = await forgeOf(3, pair());
    const r = unify(t, "--take", "variant");
    expect(r.code, r.stderr).toBe(0);
    expect(await exists(variantDir(t.forge))).toBe(false);
  });
});
