import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { ForgeManifestSchema, FORGE_SCHEMA_SECTIONS, IngredientSchema, INGREDIENT_TYPES, ProfileSchema, RecipeSchema, RegistrySchema, UnifyPlanSchema, WorkspaceConfigSchema } from "../src/schema/index.js";
import { makeForge, tmpDir, writeFiles } from "./helpers/forge.js";

/** A minimal valid ingredient of each type. */
const MINIMAL: Record<(typeof INGREDIENT_TYPES)[number], Record<string, unknown>> = {
  rule: { type: "rule", name: "x" },
  agent: { type: "agent", name: "x" },
  command: { type: "command", name: "x" },
  skill: { type: "skill", name: "x" },
  mcp: { type: "mcp", name: "x", server: { command: "npx" } },
  script: { type: "script", name: "x", files: ["x.sh"] },
  steering: { type: "steering", name: "x" },
  hook: { type: "hook", name: "x", files: ["x.sh"] },
};

describe("strict ingredient keys", () => {
  for (const type of INGREDIENT_TYPES) {
    it(`accepts a minimal ${type} and refuses an unknown top-level key`, () => {
      expect(IngredientSchema.safeParse(MINIMAL[type]).success).toBe(true);
      const r = IngredientSchema.safeParse({ ...MINIMAL[type], foo: 1 });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["foo"], path: [] })]);
    });
  }

  it("refuses an unknown key inside origin", () => {
    const r = IngredientSchema.safeParse({ ...MINIMAL.rule, origin: { workspace: "acme", path: "a.md", line: 3 } });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["line"], path: ["origin"] })]);
  });

  it("reports every unknown key in one error", () => {
    const r = IngredientSchema.safeParse({ ...MINIMAL.rule, incluson: "always", origin: { workspace: "acme", path: "a.md", line: 3 } });
    expect(r.success).toBe(false);
    if (r.success) return;
    const keys = r.error.issues.filter((i) => i.code === "unrecognized_keys").map((i) => ({ path: i.path, keys: (i as { keys: string[] }).keys }));
    expect(keys).toEqual(expect.arrayContaining([{ path: [], keys: ["incluson"] }, { path: ["origin"], keys: ["line"] }]));
    expect(keys).toHaveLength(2);
  });

  it("refuses a top-level __proto__ key (spec 07 edge case 5)", () => {
    const input = JSON.parse('{"type":"rule","name":"x","__proto__":{"a":1}}');
    const r = IngredientSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["__proto__"] })]);
  });
});

describe("a Forge path never climbs out of its folder (0.17.3)", () => {
  it("refuses an as that climbs out, and keeps every spelling that does not", () => {
    const as = (v: string) => IngredientSchema.safeParse({ type: "rule", name: "r", as: v });
    for (const v of ["../../x", "..", "a/../../x", "..\\x", "a\\..\\..\\x", "/../../x", "//../x"]) {
      const r = as(v);
      expect(r.success, v).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.message), v).toEqual(['as must not climb out of its folder with a .. segment']);
    }
    for (const v of ["workflow", "frontend/react", "a/../b", "./x", "a..b"]) expect(as(v).success, v).toBe(true);
  });

  for (const type of ["script", "hook"] as const) {
    it(`refuses a ${type} file that climbs out of the ingredient directory, and keeps every spelling that does not`, () => {
      const files = (f: string) => IngredientSchema.safeParse({ type, name: "s", files: [f] });
      for (const f of ["../x.sh", "a/../../x.sh", "..", "..\\x.sh", "../s/run.sh", "/../../x.sh", "//../x.sh"]) {
        const r = files(f);
        expect(r.success, f).toBe(false);
        if (!r.success) expect(r.error.issues.map((i) => i.message), f).toEqual(['a files entry must not climb out of the ingredient directory with a .. segment']);
      }
      for (const f of ["run.sh", "./run.sh", "/run.sh", "a/../run.sh", "..run.sh"]) expect(files(f).success, f).toBe(true);
    });
  }
});

describe("MCP server: validated, loaded as the original object (spec 07, Ruling 7)", () => {
  it("returns the same object, undeclared keys and source key order included", () => {
    const server = { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30, disabled: false };
    const parsed = IngredientSchema.parse({ type: "mcp", name: "r", server });
    if (parsed.type !== "mcp") throw new Error("expected an mcp ingredient");
    expect(parsed.server).toBe(server);
    expect(Object.keys(parsed.server)).toEqual(["type", "url", "headers", "timeout", "disabled"]);
  });

  it("keeps a __proto__ key under server and under env as an own property", () => {
    const meta = YAML.parse("type: mcp\nname: r\nserver:\n  command: npx\n  __proto__: { a: 1 }\n  env:\n    __proto__: x\n");
    const parsed = IngredientSchema.parse(meta);
    if (parsed.type !== "mcp") throw new Error("expected an mcp ingredient");
    expect(Object.hasOwn(parsed.server, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed.server.env ?? {}, "__proto__")).toBe(true);
  });

  it("still validates the declared keys, with their paths", () => {
    const r = IngredientSchema.safeParse({ type: "mcp", name: "r", server: { command: "npx", env: { PORT: 8080 } } });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path)).toEqual([["server", "env", "PORT"]]);
  });

  it("refuses a missing server and a non-object server", () => {
    for (const server of [undefined, []]) {
      const r = IngredientSchema.safeParse({ type: "mcp", name: "r", server });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues[0].path).toEqual(["server"]);
    }
  });
});

describe("ingredient params and the param hunk decision (spec 09 §5.3)", () => {
  it("accepts declared params with a scalar default, and refuses an unknown field or an object default", () => {
    expect(IngredientSchema.safeParse({ ...MINIMAL.rule, params: { "deploy.api": { default: "globex-api", description: "API repo" } } }).success).toBe(true);
    expect(IngredientSchema.safeParse({ ...MINIMAL.rule, params: { port: { default: 8080 } } }).success).toBe(true);
    expect(IngredientSchema.safeParse({ ...MINIMAL.rule, params: { k: { default: "x", deflt: "y" } } }).success).toBe(false);
    expect(IngredientSchema.safeParse({ ...MINIMAL.rule, params: { k: { default: { a: 1 } } } }).success).toBe(false);
  });

  it("leaves an ingredient without params exactly as before (no default added)", () => {
    expect(IngredientSchema.parse(MINIMAL.rule)).not.toHaveProperty("params");
  });

  it("accepts take: param with params on a hunk, and refuses a bad key or an empty token", () => {
    const plan = (params: unknown) => ({
      schema: 1, base: "rule/w", profile: "acme", variant: "rule/w--acme", baseFingerprint: "a", variantFingerprint: "b",
      files: [{ file: "rule.md", hunks: [{ hunk: 1, take: "param", params }] }],
    });
    expect(UnifyPlanSchema.safeParse(plan([{ token: "globex-api", key: "deploy.api" }])).success).toBe(true);
    expect(UnifyPlanSchema.safeParse(plan([{ token: "globex-api", key: "deploy-api" }])).success).toBe(false);
    expect(UnifyPlanSchema.safeParse(plan([{ token: "", key: "k" }])).success).toBe(false);
    expect(UnifyPlanSchema.safeParse(plan([{ token: "t", key: "k", extra: 1 }])).success).toBe(false);
    const oneSided = { ...plan([]), files: [{ file: "x.md", onlyIn: "variant", take: "param" }] };
    expect(UnifyPlanSchema.safeParse(oneSided).success).toBe(false);
  });
});

describe("sections and the manifest schema (spec 11 §5.2)", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
  });

  it("loads a manifest at schema 1, at schema 2 and with no schema (read as 1); refuses schema 3", () => {
    expect(FORGE_SCHEMA_SECTIONS).toBe(2);
    expect(ForgeManifestSchema.parse({ name: "f", schema: 1 }).schema).toBe(1);
    expect(ForgeManifestSchema.parse({ name: "f", schema: 2 }).schema).toBe(2);
    expect(ForgeManifestSchema.parse({ name: "f" }).schema).toBe(1);
    expect(ForgeManifestSchema.safeParse({ name: "f", schema: 3 }).success).toBe(false);
  });

  it("a Forge whose manifest says schema: 3 fails the load, naming the file", async () => {
    const root = await tmpDir();
    cleanups.push(root);
    await writeFiles(root, { "craftar.forge.yaml": "name: f\nschema: 3\n" });
    await expect(loadForge(root)).rejects.toThrow(/craftar\.forge\.yaml/);
  });

  it("defaults sections to {} in a profile and in a workspace's overrides", () => {
    expect(ProfileSchema.parse({ name: "acme" }).sections).toEqual({});
    expect(WorkspaceConfigSchema.parse({ forge: ".", profile: "acme" }).overrides.sections).toEqual({});
    expect(WorkspaceConfigSchema.parse({ forge: ".", profile: "acme", overrides: {} }).overrides.sections).toEqual({});
  });

  it("accepts nested sections keyed <type>/<name>, strings only, and an empty string", () => {
    const sections = { "rule/review-posture": { flavors: "| a |\n", extra: "" }, "skill/pdf-tools": { notes: "x" } };
    expect(ProfileSchema.parse({ name: "acme", sections }).sections).toEqual(sections);
    expect(WorkspaceConfigSchema.parse({ forge: ".", profile: "acme", overrides: { sections } }).overrides.sections).toEqual(sections);
  });

  it("refuses a key of the wrong shape (spec 01's flat form), an unknown type and a bad section name", () => {
    expect(ProfileSchema.safeParse({ name: "acme", sections: { "review-posture.flavors": "x" } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ name: "acme", sections: { "review-posture": { flavors: "x" } } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ name: "acme", sections: { "widget/x": { flavors: "x" } } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ name: "acme", sections: { "rule/x": { "Flavors Table": "x" } } }).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse({ forge: ".", profile: "acme", overrides: { sections: { "review-posture.flavors": "x" } } }).success).toBe(false);
  });

  it("refuses a non-string value: a number, null, a list (Ruling 20)", () => {
    for (const v of [3, null, ["a"], { a: "b" }]) {
      expect(ProfileSchema.safeParse({ name: "acme", sections: { "rule/x": { flavors: v } } }).success).toBe(false);
    }
  });

  it("a profile.yaml with a wrong-shape sections key fails the Forge load, naming the file", async () => {
    const root = await tmpDir();
    cleanups.push(root);
    await makeForge(root, { profiles: [{ name: "acme", sections: { "review-posture.flavors": "x" } }] });
    await expect(loadForge(root)).rejects.toThrow(/invalid .*acme.profile\.yaml/);
  });
});

describe("plan section (spec 12)", () => {
  /** Helper to build a plan with a hunk entry for testing. */
  const plan = (hunk: Record<string, unknown>) => ({
    schema: 1,
    base: "rule/w",
    profile: "acme",
    variant: "rule/w--acme",
    baseFingerprint: "sha256:a",
    variantFingerprint: "sha256:b",
    files: [{ file: "rule.md", hunks: [{ hunk: 1, at: "lines 1–5", take: "section", ...hunk }] }],
  });

  it("accepts take: section with section: { name } and with lines: '<from>-<to>'", () => {
    expect(UnifyPlanSchema.safeParse(plan({ section: { name: "flavors" } })).success).toBe(true);
    expect(UnifyPlanSchema.safeParse(plan({ section: { name: "flavors", lines: "5-10" } })).success).toBe(true);
    expect(UnifyPlanSchema.safeParse(plan({ section: { name: "flavors", lines: "1-1" } })).success).toBe(true);
    expect(UnifyPlanSchema.safeParse(plan({ section: { name: "review-table-2", lines: "12-99" } })).success).toBe(true);
  });

  it("accepts take: section with no section object (S1 is the engine's refusal)", () => {
    const noSection = plan({});
    delete (noSection.files[0].hunks[0] as Record<string, unknown>).section;
    expect(UnifyPlanSchema.safeParse(noSection).success).toBe(true);
  });

  it("accepts take: keep with a section field (the engine ignores it, the schema does not strip it)", () => {
    const withKeep = plan({ take: "keep", section: { name: "flavors" } });
    const parsed = UnifyPlanSchema.parse(withKeep);
    expect(parsed.files[0].hunks![0].take).toBe("keep");
    expect(parsed.files[0].hunks![0].section).toEqual({ name: "flavors" });
  });

  it("refuses a name with a space", () => {
    const r = UnifyPlanSchema.safeParse(plan({ section: { name: "Flavors Table" } }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.message.includes("slug-like"))).toBe(true);
  });

  it("refuses lines: '5' (no range)", () => {
    const r = UnifyPlanSchema.safeParse(plan({ section: { name: "flavors", lines: "5" } }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.message.includes("<from>-<to>"))).toBe(true);
  });

  it("refuses lines: '0-3' (zero-based start)", () => {
    const r = UnifyPlanSchema.safeParse(plan({ section: { name: "flavors", lines: "0-3" } }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.message.includes("<from>-<to>"))).toBe(true);
  });

  it("refuses lines: 'a-b' (non-numeric)", () => {
    const r = UnifyPlanSchema.safeParse(plan({ section: { name: "flavors", lines: "a-b" } }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.message.includes("<from>-<to>"))).toBe(true);
  });

  it("refuses an unknown field inside section (PlanSectionSchema is strict)", () => {
    const r = UnifyPlanSchema.safeParse(plan({ section: { name: "x", extra: 1 } }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("refuses a one-sided file entry with take: section (TakeSchema unchanged)", () => {
    const oneSided = {
      schema: 1,
      base: "rule/w",
      profile: "acme",
      variant: "rule/w--acme",
      baseFingerprint: "sha256:a",
      variantFingerprint: "sha256:b",
      files: [{ file: "x.md", onlyIn: "variant", take: "section" }],
    };
    const r = UnifyPlanSchema.safeParse(oneSided);
    expect(r.success).toBe(false);
    if (r.success) return;
    // TakeSchema is base | variant | keep — "section" is not valid there.
    expect(r.error.issues.some((i) => i.path.includes("take"))).toBe(true);
  });

  it("an existing plan with take: param and params still parses exactly as before", () => {
    const paramPlan = {
      schema: 1,
      base: "rule/w",
      profile: "acme",
      variant: "rule/w--acme",
      baseFingerprint: "sha256:a",
      variantFingerprint: "sha256:b",
      files: [{ file: "rule.md", hunks: [{ hunk: 1, take: "param", params: [{ token: "globex-api", key: "deploy.api" }] }] }],
    };
    const parsed = UnifyPlanSchema.parse(paramPlan);
    expect(parsed.files[0].hunks![0].take).toBe("param");
    expect(parsed.files[0].hunks![0].params).toEqual([{ token: "globex-api", key: "deploy.api" }]);
    expect(parsed.files[0].hunks![0]).not.toHaveProperty("section");
  });
});

describe("the workspace registry (spec 21 §5.2)", () => {
  const entry = {
    path: "/home/dev/work/acme-portal",
    profile: "acme",
    forge: { kind: "path", source: "../acme-forge", key: "/home/dev/work/acme-forge", ref: null, commit: null, fromLocalFile: false },
    recipes: ["base"],
    stack: {},
    targets: ["claude-code"],
    lastSync: "2026-10-07T00:00:00.000Z",
  };

  it("keeps keys it does not declare, at every level, and reads an unknown target as a string", () => {
    const raw = {
      schema: 1,
      workspaces: [{ ...entry, forge: { ...entry.forge, later: 1 }, targets: ["claude-code", "cursor"], extra: "x" }],
      top: true,
    };
    const parsed = RegistrySchema.parse(raw);
    expect(parsed).toEqual(raw);
    expect(Object.keys(parsed.workspaces[0]).at(-1)).toBe("extra");
  });

  it("refuses another schema, and an entry missing a declared key", () => {
    expect(RegistrySchema.safeParse({ schema: 2, workspaces: [] }).success).toBe(false);
    const { lastSync: _, ...noLastSync } = entry;
    expect(RegistrySchema.safeParse({ schema: 1, workspaces: [noLastSync] }).success).toBe(false);
  });
});

describe("__proto__ key refusal (tech-debt 2026-09-25-zod)", () => {
  // Each of these records silently dropped __proto__ before the fix. The test confirms the key is now refused.

  it("profile params: refuses __proto__ key", () => {
    const input = YAML.parse("name: x\nparams:\n  __proto__: x\n  k: v\n");
    const r = ProfileSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("profile params: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("name: x\nparams:\n  k: v\n");
    expect(ProfileSchema.safeParse(input).success).toBe(true);
  });

  it("profile integrations: refuses __proto__ key", () => {
    const input = YAML.parse("name: x\nintegrations:\n  __proto__: x\n  k: v\n");
    const r = ProfileSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("profile integrations: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("name: x\nintegrations:\n  k: v\n");
    expect(ProfileSchema.safeParse(input).success).toBe(true);
  });

  it("profile repos: refuses __proto__ key in an inner record", () => {
    const input = YAML.parse("name: x\nrepos:\n  - __proto__: x\n    k: v\n");
    const r = ProfileSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("profile repos: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("name: x\nrepos:\n  - k: v\n");
    expect(ProfileSchema.safeParse(input).success).toBe(true);
  });

  it("recipe params: refuses __proto__ key", () => {
    const input = YAML.parse("name: r\nparams:\n  __proto__: {default: 1}\n  k: {default: 2}\n");
    const r = RecipeSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("recipe params: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("name: r\nparams:\n  k: {default: 2}\n");
    expect(RecipeSchema.safeParse(input).success).toBe(true);
  });

  it("workspace overrides.params: refuses __proto__ key", () => {
    const input = YAML.parse("forge: ../f\nprofile: x\noverrides:\n  params:\n    __proto__: x\n    k: v\n");
    const r = WorkspaceConfigSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("workspace overrides.params: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("forge: ../f\nprofile: x\noverrides:\n  params:\n    k: v\n");
    expect(WorkspaceConfigSchema.safeParse(input).success).toBe(true);
  });

  it("ingredient params: refuses __proto__ key", () => {
    const input = YAML.parse("type: rule\nname: a\nparams:\n  __proto__: {default: 1}\n  k: {default: 2}\n");
    const r = IngredientSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes("__proto__"))).toBe(true);
  });

  it("ingredient params: accepts the same input without __proto__ (guard)", () => {
    const input = YAML.parse("type: rule\nname: a\nparams:\n  k: {default: 2}\n");
    expect(IngredientSchema.safeParse(input).success).toBe(true);
  });
});

describe("authEnv (spec 27)", () => {
  const MCP = { type: "mcp", name: "acme-tracker", server: { command: "npx" } };

  it("1. accepts authEnv with valid names", () => {
    const r = IngredientSchema.safeParse({ ...MCP, authEnv: ["ACME_TRACKER_TOKEN"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.authEnv).toEqual(["ACME_TRACKER_TOKEN"]);
  });

  it("2. an MCP ingredient without authEnv has no authEnv property (pins existing behaviour)", () => {
    const r = IngredientSchema.safeParse(MCP);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(Object.hasOwn(r.data, "authEnv")).toBe(false);
  });

  it("3. accepts an empty authEnv array", () => {
    const r = IngredientSchema.safeParse({ ...MCP, authEnv: [] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.authEnv).toEqual([]);
  });

  it("4. refuses invalid variable names", () => {
    for (const authEnv of [["ACME-TOKEN"], ["${ACME_TOKEN}"], [""], ["1ACME"]]) {
      const r = IngredientSchema.safeParse({ ...MCP, authEnv });
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.map((i) => i.path)).toEqual([["authEnv", 0]]);
    }
  });

  it("5. refuses authEnv as a string (not an array)", () => {
    const r = IngredientSchema.safeParse({ ...MCP, authEnv: "ACME_TOKEN" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0].path).toEqual(["authEnv"]);
  });

  it("6. refuses authEnv on a rule ingredient (strict schema)", () => {
    const r = IngredientSchema.safeParse({ type: "rule", name: "r", authEnv: ["X"] });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["authEnv"], path: [] })]);
  });

  it("7. accepts __proto__ as a valid authEnv item", () => {
    const r = IngredientSchema.safeParse({ ...MCP, authEnv: ["__proto__", "A"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.authEnv).toEqual(["__proto__", "A"]);
  });

  it("8. refuses known token formats, message never holds the item", () => {
    const gh = "ghp_" + "x".repeat(36);
    const aws = "AKIA" + "A".repeat(16);
    for (const t of [gh, aws]) {
      const r = IngredientSchema.safeParse({ ...MCP, authEnv: ["OK_NAME", t] });
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.map((i) => i.path)).toEqual([["authEnv", 1]]);
      const expectedKind = t === gh ? "github-token" : "aws-access-key";
      expect(r.error.issues[0].message).toBe(`looks like a token (${expectedKind}) — an authEnv item is a variable NAME`);
      expect(JSON.stringify(r.error.issues).includes(t)).toBe(false);
    }
  });

  it("9. long ordinary names load (entropy rule is NOT used)", () => {
    for (const name of [
      "GITHUB_PERSONAL_ACCESS_TOKEN_V2",
      "MICROSOFT_GRAPH_OAUTH2_CLIENT_SECRET_KEY",
      "ACME_JIRA_CLOUD_OAUTH2_REFRESH_TOKEN",
      "acmeTrackerOauth2RefreshTokenProd",
    ]) {
      const r = IngredientSchema.safeParse({ ...MCP, authEnv: [name] });
      expect(r.success).toBe(true);
    }
  });

  it("10. pinned limits: github_pat_for_the_acme_tracker_server refused, MY_ prefix loads", () => {
    const gh = "ghp_" + "x".repeat(36);
    // A name the pattern takes for a token is refused
    const r1 = IngredientSchema.safeParse({ ...MCP, authEnv: ["github_pat_for_the_acme_tracker_server"] });
    expect(r1.success).toBe(false);
    if (!r1.success) expect(r1.error.issues.map((i) => i.path)).toEqual([["authEnv", 0]]);

    // A known token with a prefix loads
    const r2 = IngredientSchema.safeParse({ ...MCP, authEnv: ["MY_" + gh] });
    expect(r2.success).toBe(true);
  });

  it("11. ENV_NAME and FORGE_ONLY_KEYS are exported with correct values", async () => {
    const { ENV_NAME, FORGE_ONLY_KEYS } = await import("../src/schema/index.js");
    expect(ENV_NAME).toBe("[A-Za-z_][A-Za-z0-9_]*");
    expect(FORGE_ONLY_KEYS).toEqual(["params", "authEnv"]);
  });

  it("12. authEnv token refusal at Forge load includes path, index, and kind; never the item", async () => {
    const gh = "ghp_" + "x".repeat(36);
    const { parseYaml } = await import("../src/core/forge.js");
    const { IngredientSchema } = await import("../src/schema/index.js");
    // At parseYaml level: message includes the file and the path
    const file = "ingredients/mcp/tracker/ingredient.yaml";
    const yaml = `type: mcp\nname: tracker\nauthEnv:\n  - OK_NAME\n  - ${gh}\nserver:\n  command: npx`;
    // The error message includes: the file path, the path authEnv.1, and "github-token"
    expect(() => parseYaml(file, yaml, IngredientSchema)).toThrow(/ingredient\.yaml/);
    expect(() => parseYaml(file, yaml, IngredientSchema)).toThrow(/authEnv\.1:/);
    expect(() => parseYaml(file, yaml, IngredientSchema)).toThrow(/github-token/);
    // The token value itself is never in the message
    try {
      parseYaml(file, yaml, IngredientSchema);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(gh);
    }
  });
});
