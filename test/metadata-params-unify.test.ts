import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { diffIngredients, listVariants } from "../src/core/variants.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, tmpDir, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";

/** Spec 50 §5.5: `forge diff` and `forge unify` over the metadata fields of §5.2, at the gate only. */

const GATE = FORGE_SCHEMA_METADATA_PARAMS;
const BELOW = GATE - 1;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A Forge at `schema` (a git repository with one commit) and a workspace on profile `acme`. */
async function forgeOf(schema: number, spec: ForgeSpec, targets = ["claude-code", "kiro", "agents-md"]) {
  const root = await tmpDir("craftar-meta-unify-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  const ws = path.join(root, "ws");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await makeWorkspace(ws, forge, { config: { profile: "acme", targets } });
  execFileSync("git", ["init", "-q", forge]);
  git(forge, "config", "gc.auto", "0");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "init");
  return { root, forge, ws };
}

/** A base `<type>/x` and its variant `x--acme` for profile `acme`, same body, metadata as given. */
function pair(type: "rule" | "agent" | "command", baseMeta: Record<string, unknown>, variantMeta: Record<string, unknown>, extraBaseFiles: Record<string, string> = {}): ForgeSpec {
  const file = type === "rule" ? "rule.md" : type === "agent" ? "agent.md" : "command.md";
  const base: IngredientSpec = { meta: { type, name: "x", ...baseMeta }, files: { [file]: "Body.\n", ...extraBaseFiles } };
  const variant: IngredientSpec = { meta: { type, name: "x--acme", as: "x", ...variantMeta }, files: { [file]: "Body.\n" } };
  return {
    ingredients: [base, variant],
    recipes: [recipe("base", [`${type}/x`]), recipe("base--acme", [`${type}/x--acme`])],
    profiles: [profile("acme", ["base--acme"], ["claude-code", "kiro", "agents-md"]), profile("globex", ["base"], ["claude-code"])],
  };
}

async function diffOf(schema: number, spec: ForgeSpec, ref: string) {
  const { forge } = await forgeOf(schema, spec);
  const f = await loadForge(forge);
  return diffIngredients(f.ingredients.get(ref as never)!, f.ingredients.get(`${ref}--acme` as never)!, f.manifest.schema);
}

describe("spec 50 §5.5: forge diff shows a metadata field as ingredient.yaml#<field>, at the gate only (§11 item 16)", () => {
  it("a value hunk with param.<slug> when the tokens are identifier-like", async () => {
    const d = await diffOf(GATE, pair("agent", { description: "Helps beta_api users" }, { description: "Helps acme_api users" }), "agent/x");
    const entry = d.files.find((f) => f.file === "ingredient.yaml#description");
    expect(entry?.hunks).toHaveLength(1);
    expect(entry!.hunks[0].suggestion.class).toBe("value");
    expect(entry!.hunks[0].suggestion.tokens?.[0]).toMatchObject({ a: "beta_api", b: "acme_api", param: expect.stringMatching(/^param\./) });
  });

  it("an evolution hunk for src/** against lib/** in frontmatterRaw, diffed by lines and CRLF-normalised", async () => {
    const d = await diffOf(GATE, pair("rule", { frontmatterRaw: "paths: lib/**\r\nkeep: 1" }, { frontmatterRaw: "paths: src/**\nkeep: 1" }), "rule/x");
    const entry = d.files.find((f) => f.file === "ingredient.yaml#frontmatterRaw");
    expect(entry?.hunks).toHaveLength(1);
    expect(entry!.hunks[0].a.lines).toEqual(["paths: lib/**"]);
    expect(entry!.hunks[0].b.lines).toEqual(["paths: src/**"]);
    expect(entry!.hunks[0].suggestion.class).toBe("evolution");
  });

  it("a list fileMatchPattern by element, and a field on one side only as a hunk against nothing", async () => {
    const d = await diffOf(
      GATE,
      pair("command", { description: "Ship" }, { description: "Ship", argumentHint: "<v>" }),
      "command/x",
    );
    const hint = d.files.find((f) => f.file === "ingredient.yaml#argumentHint");
    expect(hint?.hunks).toHaveLength(1);
    expect(hint!.hunks[0].a.lines).toEqual([]);
    expect(hint!.hunks[0].b.lines).toEqual(["<v>"]);
    const r = await diffOf(
      GATE,
      pair("rule", { inclusion: "fileMatch", fileMatchPattern: ["lib/**", "test/**"] }, { inclusion: "fileMatch", fileMatchPattern: ["src/**", "test/**"] }),
      "rule/x",
    );
    const fmp = r.files.find((f) => f.file === "ingredient.yaml#fileMatchPattern");
    expect(fmp?.hunks).toHaveLength(1);
    expect(fmp!.hunks[0].a.lines).toEqual(["lib/**"]);
    expect(fmp!.hunks[0].b.lines).toEqual(["src/**"]);
  });

  it("no such entry below the gate, and no entry for an equal field", async () => {
    const below = await diffOf(BELOW, pair("agent", { description: "Helps beta_api users" }, { description: "Helps acme_api users" }), "agent/x");
    expect(below.files.map((f) => f.file)).toEqual([]);
    const equal = await diffOf(GATE, pair("agent", { description: "Same" }, { description: "Same" }), "agent/x");
    expect(equal.files.map((f) => f.file)).toEqual([]);
  });

  it("leaves the entries out of forge variants' distance, which stays meta only", async () => {
    for (const schema of [BELOW, GATE]) {
      const { forge } = await forgeOf(schema, pair("agent", { description: "Helps beta_api users" }, { description: "Helps acme_api users" }));
      const v = (await listVariants(await loadForge(forge))).groups[0].variants[0];
      expect(v.distance).toEqual({ lines: 0, hunks: 0, sameBodyDifferentMeta: true, identicalAfterNormalization: false });
      expect(v.classes).toEqual({ evolution: 0, value: 0, block: 0 });
    }
  });

  it("the CLI prints the entry and carries it in --json", async () => {
    const { forge } = await forgeOf(GATE, pair("agent", { description: "Helps beta_api users" }, { description: "Helps acme_api users" }));
    const text = runCli(["forge", "diff", "agent/x", "--forge", forge]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("  ingredient.yaml#description\n");
    const json = JSON.parse(runCli(["forge", "diff", "agent/x", "--forge", forge, "--json"]).stdout);
    expect(json[0].diff.files.map((f: { file: string }) => f.file)).toEqual(["ingredient.yaml#description"]);
  });
});

describe("spec 50 §5.5 / §15 item 11: a real file named ingredient.yaml#<field>, at the gate", () => {
  const spec = () => pair("rule", { description: "a" }, { description: "b" }, { "ingredient.yaml#description": "x\n" });

  it("fails forge diff and the plan, naming it", async () => {
    const { forge, ws } = await forgeOf(GATE, spec());
    const f = await loadForge(forge);
    await expect(diffIngredients(f.ingredients.get("rule/x")!, f.ingredients.get("rule/x--acme")!, f.manifest.schema)).rejects.toThrow(/rule\/x: .*ingredient\.yaml#description/);
    // The workspace of profile globex resolves the base.
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: path.relative(ws, forge), profile: "globex" }));
    await expect(plan(await loadWorkspace(ws, { home: process.env.CRAFTAR_HOME }))).rejects.toThrow(/rule\/x: .*ingredient\.yaml#description/);
  });

  it("is an ordinary file below the gate", async () => {
    const { forge, ws } = await forgeOf(BELOW, spec());
    const f = await loadForge(forge);
    await expect(diffIngredients(f.ingredients.get("rule/x")!, f.ingredients.get("rule/x--acme")!, f.manifest.schema)).resolves.toBeDefined();
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: path.relative(ws, forge), profile: "globex" }));
    await expect(plan(await loadWorkspace(ws, { home: process.env.CRAFTAR_HOME }))).resolves.toBeDefined();
  });
});
