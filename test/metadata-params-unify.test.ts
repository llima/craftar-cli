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

/** Saves a plan, sets every hunk's take (params as pre-filled), and applies it. Returns the apply run. */
function unifyWith(forge: string, root: string, ref: string, take: (file: string) => string) {
  const planFile = path.join(root, `plan-${Math.random().toString(36).slice(2)}.yaml`);
  const saved = runCli(["forge", "unify", ref, "--profile", "acme", "--forge", forge, "--save-plan", planFile, "--no-impact"]);
  expect(saved.code, saved.stderr).toBe(0);
  return fs.readFile(planFile, "utf8").then(async (text) => {
    const doc = YAML.parse(text) as { files: Array<{ file: string; hunks?: Array<{ take: string }>; take?: string }> };
    for (const pf of doc.files) {
      if (pf.hunks) for (const h of pf.hunks) h.take = take(pf.file);
      else pf.take = take(pf.file);
    }
    await fs.writeFile(planFile, YAML.stringify(doc));
    return runCli(["forge", "unify", ref, "--profile", "acme", "--forge", forge, "--plan", planFile, "--no-impact"]);
  });
}

async function planned(ws: string, profileName: string, forge: string) {
  await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: path.relative(ws, forge), profile: profileName, targets: ["claude-code", "kiro", "agents-md"] }));
  const p = await plan(await loadWorkspace(ws, { home: process.env.CRAFTAR_HOME }));
  return new Map(p.files.map((f) => [f.path, f.content.toString("utf8")]));
}

describe("spec 50 §5.5: forge unify resolves a metadata entry (§11 items 17, 20, 22)", () => {
  /** A rule pair that differs in a body token and in `paths:` by a path component. */
  const bodyAndPaths = () =>
    pair("rule", { frontmatterRaw: "paths: lib/app/**" }, { frontmatterRaw: "paths: src/app/**" });
  const withBodies = (spec: ForgeSpec) => {
    spec.ingredients[0].files = { "rule.md": "Use beta_api.\n" };
    spec.ingredients[1].files = { "rule.md": "Use acme_api.\n" };
    return spec;
  };

  it("take: param on a body token and on paths: in one plan; every profile plans the same bytes before and after (item 17)", async () => {
    const { root, forge, ws } = await forgeOf(GATE, withBodies(bodyAndPaths()));
    const before = { acme: await planned(ws, "acme", forge), globex: await planned(ws, "globex", forge) };
    const run = await unifyWith(forge, root, "rule/x", () => "param");
    expect(run.code, run.stderr).toBe(0);
    const after = { acme: await planned(ws, "acme", forge), globex: await planned(ws, "globex", forge) };
    expect(after).toEqual(before);
    const meta = YAML.parse(await fs.readFile(path.join(forge, "ingredients/rules/x/ingredient.yaml"), "utf8"));
    expect(meta.frontmatterRaw).toMatch(/^paths: \{\{param\.[a-z_]+\}\}\/\*\*$/);
    await expect(fs.stat(path.join(forge, "ingredients/rules/x--acme"))).rejects.toThrow();
  });

  it("take: variant on a description alone writes the base's field and removes the variant", async () => {
    const { root, forge } = await forgeOf(GATE, pair("agent", { description: "Helps beta users" }, { description: "Helps acme users" }));
    const run = await unifyWith(forge, root, "agent/x", () => "variant");
    expect(run.code, run.stderr).toBe(0);
    const meta = YAML.parse(await fs.readFile(path.join(forge, "ingredients/agents/x/ingredient.yaml"), "utf8"));
    expect(meta.description).toBe("Helps acme users");
    await expect(fs.stat(path.join(forge, "ingredients/agents/x--acme"))).rejects.toThrow();
  });

  it("a tools difference still blocks take: param (item 20)", async () => {
    const { root, forge } = await forgeOf(GATE, pair("agent", { description: "Helps beta_api users", tools: ["Read"] }, { description: "Helps acme_api users", tools: ["Read", "Write"] }));
    const run = await unifyWith(forge, root, "agent/x", () => "param");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ingredient.yaml differs in tools");
    expect(git(forge, "status", "--porcelain")).toBe("");
  });

  it("take: section on a metadata entry is refused, the Forge untouched (item 22)", async () => {
    const { root, forge } = await forgeOf(GATE, pair("agent", { description: "Helps beta users" }, { description: "Helps acme users" }));
    const run = await unifyWith(forge, root, "agent/x", () => "section");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('"ingredient.yaml#description" is a metadata field — take: section');
    expect(git(forge, "status", "--porcelain")).toBe("");
  });

  it("the proof refuses, before its first write, a param that would stand under model in a raw block (§5.4)", async () => {
    const { root, forge } = await forgeOf(GATE, pair("agent", { frontmatterRaw: "name: x\nmodel: beta_m" }, { frontmatterRaw: "name: x\nmodel: acme_m" }));
    const run = await unifyWith(forge, root, "agent/x", () => "param");
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/in frontmatterRaw would break the file it is written to — it stands under model/);
    expect(run.stderr).not.toContain("acme_m");
    expect(git(forge, "status", "--porcelain")).toBe("");
  });

  it("a field left at keep holds the variant back as an undecided hunk, not as a field unify cannot merge", async () => {
    const { root, forge } = await forgeOf(GATE, pair("command", { description: "Ship beta", argumentHint: "<b>" }, { description: "Ship acme", argumentHint: "<a>" }));
    const run = await unifyWith(forge, root, "command/x", (file) => (file === "ingredient.yaml#description" ? "variant" : "keep"));
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("resolved no · unresolved 1");
    expect(run.stdout).not.toContain("unify cannot merge ingredient.yaml");
    const meta = YAML.parse(await fs.readFile(path.join(forge, "ingredients/commands/x/ingredient.yaml"), "utf8"));
    expect(meta).toMatchObject({ description: "Ship acme", argumentHint: "<b>" });
    await expect(fs.stat(path.join(forge, "ingredients/commands/x--acme"))).resolves.toBeDefined();
  });
});

describe("spec 50 §5.3: a metadata citation counts in forge unify's cites (P18)", () => {
  it("refuses a take: param whose new profile value another ingredient's description cites", async () => {
    const spec = pair("rule", {}, {});
    spec.ingredients[0].files = { "rule.md": "Use beta_api.\n" };
    spec.ingredients[1].files = { "rule.md": "Use acme_api.\n" };
    spec.ingredients.push({ meta: { type: "agent", name: "other", description: "For {{param.beta_api}}" }, files: { "agent.md": "Body.\n" } });
    const { root, forge } = await forgeOf(GATE, spec);
    const run = await unifyWith(forge, root, "rule/x", () => "param");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("agent/other also uses {{param.beta_api}} under profile acme");
    expect(git(forge, "status", "--porcelain")).toBe("");
  });
});

describe("spec 50 §5.5: a CRLF ingredient.yaml (Windows-shaped)", () => {
  it("take: variant on a description keeps the base's CRLF line endings and changes only that line", async () => {
    const spec = pair("agent", { description: "Helps beta users" }, { description: "Helps acme users" });
    const { root, forge } = await forgeOf(GATE, spec);
    const file = path.join(forge, "ingredients/agents/x/ingredient.yaml");
    const lf = await fs.readFile(file, "utf8");
    await fs.writeFile(file, lf.replace(/\n/g, "\r\n"));
    // Keep the CRLF bytes in the blob whatever the developer's or the runner's core.autocrlf says.
    git(forge, "config", "core.autocrlf", "false");
    git(forge, "add", "--renormalize", "-A");
    git(forge, "commit", "-q", "-m", "crlf");
    const run = await unifyWith(forge, root, "agent/x", () => "variant");
    expect(run.code, run.stderr).toBe(0);
    const after = await fs.readFile(file, "utf8");
    expect(after).toBe(lf.replace("Helps beta users", "Helps acme users").replace(/\n/g, "\r\n"));
  });
});

describe("spec 50 §5.5: the metadata proof and a profile that does not resolve", () => {
  it("take: variant on a description passes when another profile does not resolve", async () => {
    const spec = pair("agent", { description: "Helps beta users" }, { description: "Helps acme users" });
    spec.profiles.push(profile("broken", ["no-such-recipe"], ["claude-code"]));
    const { root, forge } = await forgeOf(GATE, spec);
    const run = await unifyWith(forge, root, "agent/x", () => "variant");
    expect(run.code, run.stderr).toBe(0);
  });
});

describe("review round 1: a real ingredient.yaml#<field> file below the gate is an ordinary file in forge unify", () => {
  it("take: variant writes the skill's file and leaves the description alone (schema 8)", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        { meta: { type: "skill", name: "x", layout: "dir", description: "Base desc" }, files: { "SKILL.md": "---\nname: x\n---\nBody.\n", "ingredient.yaml#description": "one\ntwo\n" } },
        { meta: { type: "skill", name: "x--acme", as: "x", layout: "dir", description: "Base desc" }, files: { "SKILL.md": "---\nname: x\n---\nBody.\n", "ingredient.yaml#description": "one\ntwo\nTHREE\n" } },
      ],
      recipes: [recipe("base", ["skill/x"]), recipe("base--acme", ["skill/x--acme"])],
      profiles: [profile("acme", ["base--acme"], ["claude-code"])],
    };
    const { forge } = await forgeOf(BELOW, spec);
    const run = runCli(["forge", "unify", "skill/x", "--profile", "acme", "--forge", forge, "--take", "variant", "--no-impact"]);
    expect(run.code, run.stderr).toBe(0);
    expect(await fs.readFile(path.join(forge, "ingredients/skills/x/ingredient.yaml#description"), "utf8")).toBe("one\ntwo\nTHREE\n");
    expect(YAML.parse(await fs.readFile(path.join(forge, "ingredients/skills/x/ingredient.yaml"), "utf8")).description).toBe("Base desc");
  });
});

describe("review round 1: a field that differs only as forge diff normalises it does not hold the variant back", () => {
  it("a CRLF-only frontmatterRaw difference and a string against a one-element list resolve with take: variant", async () => {
    for (const [a, b] of [
      [{ frontmatterRaw: "paths: src/**\r\nkeep: 1" }, { frontmatterRaw: "paths: src/**\nkeep: 1" }],
      [{ inclusion: "fileMatch", fileMatchPattern: "src/**" }, { inclusion: "fileMatch", fileMatchPattern: ["src/**"] }],
    ] as const) {
      const { forge } = await forgeOf(GATE, pair("rule", a, b));
      const run = runCli(["forge", "unify", "rule/x", "--profile", "acme", "--forge", forge, "--take", "variant", "--no-impact", "--json"]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ resolved: true, metaDiffers: [] });
    }
  });
});

describe("review round 1: the metadata proof covers a profile that resolves the variant", () => {
  it("refuses a take: variant whose new description would break another profile resolving the variant", async () => {
    const spec = pair("command", { description: "Ship it" }, { description: "{{d}}" });
    spec.profiles = [profile("acme", ["base--acme"], ["claude-code"], { params: { d: "now" } }), profile("other", ["base--acme"], ["claude-code"], { params: { d: "- broken" } })];
    const { root, forge } = await forgeOf(GATE, spec);
    const run = await unifyWith(forge, root, "command/x", () => "variant");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("under profile other");
    expect(run.stderr).not.toContain("- broken");
    expect(git(forge, "status", "--porcelain")).toBe("");
  });
});
