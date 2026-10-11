import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { checkParamWrites } from "../src/core/param-writes.js";
import { applyPlan, planFrom } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 34 §9 — forge unify: a param a server cites as declared is never written into a profile.

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
