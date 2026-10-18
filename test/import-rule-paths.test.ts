import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode, rulePaths, secretIn } from "../src/importers/claude-code.js";
import { loadWorkspace, plan, status, apply, readLock } from "../src/core/sync.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-import-paths-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (name: string) => path.join(root, name) };
}

const importInto = (forge: string, workspaceRoot: string, profileName: string) =>
  importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName });

const yaml = async (file: string) => YAML.parse(await fs.readFile(file, "utf8"));

const ruleList = '---\npaths:\n  - "projects/acme-api/**"\n  - "projects/acme-web/**"\n---\n\n# Backend\n\nUse the acme conventions.\n';
const ruleString = '---\npaths: "projects/acme-api/**"\ndescription: Backend rules\n---\n# Backend\n';

describe("import --from claude-code — paths: frontmatter", () => {
  it("1. paths: as a list, no .kiro/ → fileMatch with list pattern, frontmatterRaw, body without fence", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/backend.md": ruleList });
    await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toEqual(["projects/acme-api/**", "projects/acme-web/**"]);
    expect(ingredientYaml.frontmatterRaw).toBe('paths:\n  - "projects/acme-api/**"\n  - "projects/acme-web/**"');

    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/backend/rule.md"), "utf8");
    expect(ruleMd).not.toContain("paths:");
    expect(ruleMd).toBe("\n# Backend\n\nUse the acme conventions.\n");

    // scoped rule goes to stack-backend, not base
    const stackRecipe = await yaml(path.join(t.forge, "recipes/stack-backend.yaml"));
    expect(stackRecipe.ingredients).toContain("rule/backend");
    const baseRecipe = await yaml(path.join(t.forge, "recipes/base.yaml"));
    expect(baseRecipe.ingredients).not.toContain("rule/backend");
  });

  it("2. paths: as a string with another key → string pattern, full frontmatterRaw", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/backend.md": ruleString });
    await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toBe("projects/acme-api/**");
    expect(ingredientYaml.frontmatterRaw).toBe('paths: "projects/acme-api/**"\ndescription: Backend rules');
  });

  it("3. hand-written steering wins over paths:", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md": '---\ninclusion: fileMatch\nfileMatchPattern: "projects/other/**"\n---\n\n# Backend\n',
    });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.fileMatchPattern).toBe("projects/other/**");
    // Even when steering wins, the frontmatter is split out (so kiro/AGENTS.md don't carry paths:)
    expect(ingredientYaml.frontmatterRaw).toBe('paths: "projects/acme-api/**"\ndescription: Backend rules');
    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/backend/rule.md"), "utf8");
    expect(ruleMd).toBe("# Backend\n");
    expect(report.warnings).toContain(
      "rule backend: .kiro/steering/backend.md and paths: in .claude/rules/backend.md disagree; the steering file's scope is kept"
    );
  });

  it("4. generated steering does not win over paths:", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md":
        '---\ninclusion: always\n---\n\n<!-- GENERATED from .claude/rules/backend.md by craftar -- do not edit. -->\n\n# Backend\n',
    });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toBe("projects/acme-api/**");
    expect(report.warnings).toContain(
      "rule backend: the generated .kiro/steering/backend.md disagrees with paths: in .claude/rules/backend.md; scope taken from paths:"
    );
  });

  it("5. steering without frontmatter: scope from paths:, warning", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md": "# Backend\n",
    });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toBe("projects/acme-api/**");
    expect(report.warnings).toContain(
      "rule backend: .kiro/steering/backend.md sets no inclusion; scope taken from paths: in .claude/rules/backend.md"
    );
  });

  it("6. unusable paths: → always, no frontmatterRaw, warning", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/backend.md": "---\npaths: []\n---\n# B\n" });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("always");
    expect(ingredientYaml.frontmatterRaw).toBeUndefined();

    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/backend/rule.md"), "utf8");
    expect(ruleMd).toBe("---\npaths: []\n---\n# B\n");

    expect(report.warnings).toContain(
      "rule backend: paths: in .claude/rules/backend.md is not a string or a list of strings; ignored"
    );
  });

  it("7. frontmatter but no paths → today's behaviour: always, no frontmatterRaw, no warning", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/backend.md": "---\ndescription: x\n---\n# B\n" });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/backend/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("always");
    expect(ingredientYaml.frontmatterRaw).toBeUndefined();

    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/backend/rule.md"), "utf8");
    expect(ruleMd).toBe("---\ndescription: x\n---\n# B\n");

    // No warning mentioning "backend"
    expect(report.warnings.filter((w) => w.includes("backend"))).toEqual([]);
  });

  it("8. warnings never contain the pattern value", async () => {
    const t = await setup();
    // Case 3
    await writeFiles(t.ws("api3"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md": '---\ninclusion: fileMatch\nfileMatchPattern: "projects/other/**"\n---\n\n# Backend\n',
    });
    const r3 = await importInto(path.join(t.root, "forge3"), t.ws("api3"), "api3");
    expect(JSON.stringify(r3.warnings)).not.toContain("projects/acme-api");

    // Case 4
    await writeFiles(t.ws("api4"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md":
        '---\ninclusion: always\n---\n\n<!-- GENERATED from .claude/rules/backend.md by craftar -- do not edit. -->\n\n# Backend\n',
    });
    const r4 = await importInto(path.join(t.root, "forge4"), t.ws("api4"), "api4");
    expect(JSON.stringify(r4.warnings)).not.toContain("projects/acme-api");

    // Case 5
    await writeFiles(t.ws("api5"), {
      ".claude/rules/backend.md": ruleString,
      ".kiro/steering/backend.md": "# Backend\n",
    });
    const r5 = await importInto(path.join(t.root, "forge5"), t.ws("api5"), "api5");
    expect(JSON.stringify(r5.warnings)).not.toContain("projects/acme-api");

    // Case 6
    await writeFiles(t.ws("api6"), { ".claude/rules/backend.md": "---\npaths: []\n---\n# B\n" });
    const r6 = await importInto(path.join(t.root, "forge6"), t.ws("api6"), "api6");
    expect(JSON.stringify(r6.warnings)).not.toContain("projects/acme-api");
  });

  it("9. end to end: import with CRLF, plan + status + apply, round-trip", async () => {
    const t = await setup();
    // Write with CRLF line endings
    const ruleListCRLF = ruleList.replace(/\n/g, "\r\n");
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend.md": ruleListCRLF,
      ".claude/rules/workflow.md": "# Workflow\n",
    });

    const report = await importInto(t.forge, t.ws("api"), "api");
    expect(report.created).toContain("rule/backend");

    // Set profile targets to all three
    const profilePath = path.join(t.forge, "profiles/api/profile.yaml");
    const profileYaml = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileYaml.targets = ["claude-code", "kiro", "agents-md"];
    await fs.writeFile(profilePath, YAML.stringify(profileYaml));

    // Write workspace config
    await writeFiles(t.ws("api"), {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "api" }),
    });

    // Plan and apply
    const ws = await loadWorkspace(t.ws("api"));
    const p = await plan(ws);
    const lock = await readLock(t.ws("api"));
    const st = await status(ws, p, lock);

    // .claude/rules/backend.md should be adopt or unchanged
    const backendEntry = st.find((e) => e.path === ".claude/rules/backend.md");
    expect(backendEntry).toBeDefined();
    expect(["adopt", "unchanged"]).toContain(backendEntry!.state);

    await apply(ws, p, st);

    // After apply, bytes should be exactly the original CRLF bytes
    const backendBytes = await fs.readFile(path.join(t.ws("api"), ".claude/rules/backend.md"));
    expect(Buffer.from(ruleListCRLF).equals(backendBytes)).toBe(true);

    // .kiro/steering/backend.md should start with CRLF frontmatter and not contain paths:
    const steeringContent = await fs.readFile(path.join(t.ws("api"), ".kiro/steering/backend.md"), "utf8");
    expect(steeringContent.startsWith("---\r\ninclusion: fileMatch\r\nfileMatchPattern: ")).toBe(true);
    expect(steeringContent).not.toContain("paths:");

    // AGENTS.md should not contain the rule body but should contain the scoped rule reference
    const agentsMd = await fs.readFile(path.join(t.ws("api"), "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("Use the acme conventions.");
    expect(agentsMd).toContain("## Scoped rules");
    expect(agentsMd).toContain("backend");

    // Second plan + status should show everything unchanged
    const ws2 = await loadWorkspace(t.ws("api"));
    const p2 = await plan(ws2);
    const lock2 = await readLock(t.ws("api"));
    const st2 = await status(ws2, p2, lock2);
    for (const e of st2) {
      expect(e.state, `${e.path} should be unchanged`).toBe("unchanged");
    }

    // B. Re-import into the same Forge: rule should be reused, no warning about backend
    const reimportReport = await importInto(t.forge, t.ws("api"), "api");
    expect(reimportReport.warnings.filter((w) => w.includes("backend"))).toEqual([]);
    expect(reimportReport.reused).toContain("rule/backend");
    expect(reimportReport.variants).toEqual([]);
  });

  // === A. Unquoted paths: globs ===

  it("A1. unquoted paths: list (YAML alias error) → fileMatch with list pattern", async () => {
    const t = await setup();
    // Unquoted globs cause YAML alias errors, but we should still parse them correctly
    const ruleUnquotedList = "---\npaths:\n  - **/*.ts\n  - src/**\n---\n# R\n";
    await writeFiles(t.ws("api"), { ".claude/rules/a.md": ruleUnquotedList });
    await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/a/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toEqual(["**/*.ts", "src/**"]);
    expect(ingredientYaml.frontmatterRaw).toBe("paths:\n  - **/*.ts\n  - src/**");

    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/a/rule.md"), "utf8");
    expect(ruleMd).toBe("# R\n");
  });

  it("A2. unquoted paths: single value → fileMatch with string pattern", async () => {
    const t = await setup();
    const ruleUnquotedString = "---\npaths: **/*.ts\n---\n# R\n";
    await writeFiles(t.ws("api"), { ".claude/rules/a.md": ruleUnquotedString });
    await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/a/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("fileMatch");
    expect(ingredientYaml.fileMatchPattern).toBe("**/*.ts");
  });

  it("A3. paths: with nested object (not a string or list) → unusable warning", async () => {
    const t = await setup();
    const ruleNestedObject = "---\npaths:\n  foo: bar\n---\n# R\n";
    await writeFiles(t.ws("api"), { ".claude/rules/a.md": ruleNestedObject });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/a/ingredient.yaml"));
    expect(ingredientYaml.inclusion).toBe("always");
    expect(ingredientYaml.frontmatterRaw).toBeUndefined();

    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/a/rule.md"), "utf8");
    expect(ruleMd).toBe("---\npaths:\n  foo: bar\n---\n# R\n");

    // The warning should mention the unusable paths
    expect(report.warnings.some((w) => w.includes("rule a") && w.includes("not a string or a list of strings"))).toBe(true);
  });

  // === C. Steering scope words and fallbacks ===

  it("C1. steering with fileMatchPattern but no inclusion → use steering's pattern", async () => {
    const t = await setup();
    // Steering file has fileMatchPattern but no inclusion (as main would have kept)
    await writeFiles(t.ws("api"), {
      ".claude/rules/b.md": "# B\n",
      ".kiro/steering/b.md": '---\nfileMatchPattern: "src/**"\n---\n# B\n',
    });
    const report = await importInto(t.forge, t.ws("api"), "api");

    const ingredientYaml = await yaml(path.join(t.forge, "ingredients/rules/b/ingredient.yaml"));
    // As on main: use the steering's pattern, but inclusion is "always" (no inclusion set)
    expect(ingredientYaml.inclusion).toBe("always");
    expect(ingredientYaml.fileMatchPattern).toBe("src/**");

    // No warning
    expect(report.warnings.filter((w) => w.includes("rule b"))).toEqual([]);
  });
});

describe("import --from claude-code — paths: with --prefer-kiro and the secret scan", () => {
  const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
  const banner = (n: string) => `<!-- GENERATED from .claude/rules/${n}.md by craftar -- do not edit. -->`;

  it("D1. a preferred steering body that still holds the fence keeps one frontmatter, and the Claude file round-trips", async () => {
    const t = await setup();
    const claude = "---\npaths: src/**\n---\n# A\n";
    await writeFiles(t.ws("api"), {
      ".claude/rules/a.md": claude,
      // what a craftar before this fix generated: inclusion always, the fence inside the body
      ".kiro/steering/a.md": `---\ninclusion: always\n---\n\n${banner("a")}\n\n---\npaths: src/**\n---\n# A\n`,
    });
    await importClaudeCode({ workspaceRoot: t.ws("api"), forgeRoot: t.forge, profileName: "api", preferKiro: ["a"], writeWorkspaceConfig: true });
    const ruleMd = await fs.readFile(path.join(t.forge, "ingredients/rules/a/rule.md"), "utf8");
    expect(ruleMd.match(/---\npaths:/g)).toHaveLength(1);
    expect((await yaml(path.join(t.forge, "ingredients/rules/a/ingredient.yaml"))).frontmatterRaw).toBeUndefined();
    const p = await plan(await loadWorkspace(t.ws("api")));
    expect(p.files.find((f) => f.path === ".claude/rules/a.md")?.content.toString("utf8")).toBe(claude);
  });

  it("D2. a secret in a preferred steering body is named at its line in the steering file", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/b.md": "---\npaths: src/**\n---\n# B\n",
      ".kiro/steering/b.md": `---\ninclusion: always\n---\n\n${banner("b")}\n\n# B\n${TOKEN}\n`,
    });
    const r = await importClaudeCode({ workspaceRoot: t.ws("api"), forgeRoot: t.forge, profileName: "api", preferKiro: ["b"] });
    expect(r.rejected).toEqual([{ name: "rule/b", reason: "secret-like value (github-token) in .kiro/steering/b.md line 8" }]);
  });

  it("D3. a secret in a split rule's body is named at its line in the Claude file", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/c.md": `---\npaths: src/**\n---\n# C\nx\n${TOKEN}\n` });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "rule/c", reason: "secret-like value (github-token) in .claude/rules/c.md line 6" }]);
  });
});

describe("import --from claude-code — paths: read by lines when YAML refuses it", () => {
  const imported = async (rule: string, steering?: string) => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/r.md": rule, ...(steering ? { ".kiro/steering/r.md": steering } : {}) });
    const report = await importInto(t.forge, t.ws("api"), "api");
    return { report, meta: await yaml(path.join(t.forge, "ingredients/rules/r/ingredient.yaml")) };
  };

  it("R1. a space after paths: still reads the list below it", async () => {
    const { meta } = await imported("---\npaths: \n  - **/*.ts\n---\n# R\n");
    expect(meta.fileMatchPattern).toEqual(["**/*.ts"]);
  });

  it("R2. a comment after a value is not part of the glob", async () => {
    expect((await imported("---\npaths: **/*.ts # tests\n---\n# R\n")).meta.fileMatchPattern).toBe("**/*.ts");
    expect((await imported("---\npaths:\n  - src/** # api\n  - '**/*.md'\n---\n# R\n")).meta.fileMatchPattern).toEqual(["src/**", "**/*.md"]);
  });

  it("R3. a list the line reader cannot read is ignored with the warning, not silently", async () => {
    const { report, meta } = await imported("---\npaths:\n  - **/*.ts\n    extra\n---\n# R\n");
    expect(meta.inclusion).toBe("always");
    expect(report.warnings).toContain("rule r: paths: in .claude/rules/r.md is not a string or a list of strings; ignored");
  });

  it("R4. a hand-written steering list equal to paths: is no disagreement", async () => {
    const { report } = await imported("---\npaths:\n  - a/**\n  - b/**\n---\n# R\n", '---\ninclusion: fileMatch\nfileMatchPattern: ["a/**", "b/**"]\n---\n\n# R\n');
    expect(report.warnings.filter((w) => w.includes("rule r:"))).toEqual([]);
  });

  it("R5. a variant's raw block is located in the Claude file its body came from", () => {
    const TOKEN = "ghp_" + "x".repeat(36);
    const meta = { type: "rule", name: "x--p", as: "x", inclusion: "fileMatch", fileMatchPattern: "a", frontmatterRaw: "paths: a", file: "rule.md", targets: "*", tags: [], origin: { workspace: "w", path: ".claude/rules/x.md" } } as unknown as Parameters<typeof secretIn>[0];
    expect(secretIn(meta, { "rule.md": `# X\nline\n${TOKEN}\n` })).toBe("secret-like value (github-token) in .claude/rules/x.md line 6");
  });

  it("R6. a list written at the key's own indent is read", async () => {
    expect((await imported("---\npaths:\n- **/*.ts\n- src/**\n---\n# R\n")).meta.fileMatchPattern).toEqual(["**/*.ts", "src/**"]);
  });

  it("R7. a block scalar is not a glob: unusable, warned", async () => {
    const { report, meta } = await imported("---\npaths: |\n  **/*.ts\n---\n# R\n");
    expect(meta.inclusion).toBe("always");
    expect(report.warnings).toContain("rule r: paths: in .claude/rules/r.md is not a string or a list of strings; ignored");
  });

  it("R8. a list paths: agrees with the mirror craftar generated for it", async () => {
    const banner = "<!-- GENERATED from .claude/rules/r.md by craftar -- do not edit. -->";
    const { report } = await imported("---\npaths:\n  - a/**\n  - b/**\n---\n# R\n", `---\ninclusion: fileMatch\nfileMatchPattern: "a/**,b/**"\n---\n\n${banner}\n\n# R\n`);
    expect(report.warnings.filter((w) => w.includes("rule r:"))).toEqual([]);
  });

  it("R9. rulePaths reads a CRLF block as an LF one", () => {
    expect(rulePaths("paths:\r\n  - **/*.ts\r\n").value).toEqual(["**/*.ts"]);
  });

  it("R10. a rule that is only its frontmatter, with no newline after the fence, is adopted as written", async () => {
    const t = await setup();
    const only = "---\npaths: src/**\n---";
    await writeFiles(t.ws("api"), { ".claude/rules/r.md": only });
    await importClaudeCode({ workspaceRoot: t.ws("api"), forgeRoot: t.forge, profileName: "api", writeWorkspaceConfig: true });
    const meta = await yaml(path.join(t.forge, "ingredients/rules/r/ingredient.yaml"));
    expect(meta.inclusion).toBe("fileMatch");
    const ws = await loadWorkspace(t.ws("api"));
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(t.ws("api")));
    expect(["adopt", "unchanged"]).toContain(st.find((e) => e.path === ".claude/rules/r.md")!.state);
  });

  it("R11. the line reader keeps a list at one indent", () => {
    expect(rulePaths("paths:\n  - **/*.ts\n- other\n").value).toBeUndefined();
  });
});

