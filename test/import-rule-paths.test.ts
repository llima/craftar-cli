import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
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

describe("import --from claude-code — paths: frontmatter (spec 35)", () => {
  it("1. paths: as a list, no .kiro/ → fileMatch with list pattern, frontmatterRaw, body without fence", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/backend.md": ruleList });
    const report = await importInto(t.forge, t.ws("api"), "api");

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
      "rule backend: .kiro/steering/backend.md has no frontmatter; scope taken from paths: in .claude/rules/backend.md"
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
      "rule backend: paths: in .claude/rules/backend.md is not a string or a list of strings; read as always"
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

    const report = await importInto(t.forge, t.ws("api"), "api", );
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
    const st = await status(ws, p);

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
    const st2 = await status(ws2, p2);
    for (const e of st2) {
      expect(e.state).toBe("unchanged");
    }
  });
});
