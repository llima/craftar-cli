/**
 * Cursor emitter tests (spec 61 §3.3, §5.2): `.cursor/rules/<name>.mdc`, `.cursor/agents/<name>.md`, `.cursor/mcp.json`.
 * Run against HEAD 8da3bc7 first to confirm failures, then fix cursor.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, apply, status, readLock } from "../src/core/sync.js";
import { diffReport } from "../src/core/report.js";
import { profile, recipe, scenario, writeFiles, type IngredientSpec, type Scenario } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("cursor emitter (spec 61 §3.3, §5.2)", () => {
  // Test 1: always-on rule
  it("1. always-on rule: alwaysApply: true, description in frontmatter", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".cursor/rules/style.mdc");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\ndescription: "Style guide"\nalwaysApply: true\n---\n\nUse tabs.\n'
    );
  });

  // Test 2: scoped rule (fileMatch) with globs
  it("2. scoped rule (fileMatch): globs from fileMatchPattern array, alwaysApply: false", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts", "test/**"] },
            files: { "rule.md": "API.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/api"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".cursor/rules/api.mdc");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\nglobs: "src/**/*.ts,test/**"\nalwaysApply: false\n---\n\nAPI.\n'
    );
  });

  // Test 3: manual rule (no description) -> alwaysApply: false only
  it("3. manual rule: no description, alwaysApply: false", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "release", inclusion: "manual" },
            files: { "rule.md": "Release.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/release"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".cursor/rules/release.mdc");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\nalwaysApply: false\n---\n\nRelease.\n'
    );
  });

  // Test 4: agent with tools warning
  it("4. agent: frontmatter with name, description, model; tools dropped with warning", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "agent", name: "helper", description: "Helps", model: "sonnet", tools: ["Read", "Bash"] },
            files: { "agent.md": "Help.\n" },
          },
        ],
        recipes: [recipe("base", ["agent/helper"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentFile = p.files.find((f) => f.path === ".cursor/agents/helper.md");
    expect(agentFile).toBeDefined();
    // serializeFrontmatter produces `key: value` with values formatted as String(v)
    expect(agentFile!.content.toString("utf8")).toBe(
      '---\nname: helper\ndescription: Helps\nmodel: sonnet\n---\nHelp.\n'
    );
    // Check warning about dropped tools
    expect(p.warnings).toContain('cursor: agent "helper": tools have no Cursor field and are dropped');
  });

  // Test 5: MCP with env reference transformation (including Cursor predefined variable)
  it("5. MCP: ${NAME} becomes ${env:NAME}, but workspaceFolder stays as-is, ingredient is mcp/*", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "api",
              server: { command: "npx", args: ["api", "${workspaceFolder}/x"], env: { TOKEN: "${API_TOKEN}", MODE: "${MODE:-dev}" } },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/api"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const mcpFile = p.files.find((f) => f.path === ".cursor/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpContent = JSON.parse(mcpFile!.content.toString("utf8"));
    expect(mcpContent).toEqual({
      mcpServers: {
        api: {
          command: "npx",
          args: ["api", "${workspaceFolder}/x"],
          env: { TOKEN: "${env:API_TOKEN}", MODE: "${MODE:-dev}" },
        },
      },
    });
    expect(mcpFile!.ingredient).toBe("mcp/*");
    // Bytes should end with }\n
    expect(mcpFile!.content.toString("utf8").endsWith("}\n")).toBe(true);
  });

  // Test 6: command and skill aimed at cursor -> skipped with warning
  it("6. command and skill: skipped with one warning per type", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "review", description: "Review code" },
            files: { "command.md": "Review.\n" },
          },
          {
            meta: { type: "skill", name: "docs", layout: "dir" },
            files: { "SKILL.md": "Docs.\n" },
          },
        ],
        recipes: [recipe("base", ["command/review", "skill/docs"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // No .cursor/ files for command or skill
    expect(p.files.filter((f) => f.path.startsWith(".cursor/") && (f.path.includes("command") || f.path.includes("skill")))).toEqual([]);
    // One warning per type
    expect(p.warnings).toContain("cursor: 1 command ingredient(s) have no Cursor equivalent — skipped: command/review");
    expect(p.warnings).toContain("cursor: 1 skill ingredient(s) have no Cursor equivalent — skipped: skill/docs");
  });

  // Test 6a: fileMatchPattern with comma warns
  it("6a. fileMatchPattern with comma in a pattern warns", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "fileMatch", fileMatchPattern: ["*.{ts,tsx}", "src/**"] },
            files: { "rule.md": "Style.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.warnings).toContain("cursor: rule rule/style: a glob holds a comma, which Cursor reads as a separator");
  });

  // Test 6b: Cursor's predefined variables are kept as-is
  it("6b. Cursor predefined variables (workspaceFolder etc) are kept, not transformed to env:", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "local",
              server: { command: "npx", args: ["${workspaceFolder}/x", "${userHome}/y"], env: { VAR: "${API_TOKEN}" } },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/local"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const mcpFile = p.files.find((f) => f.path === ".cursor/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpContent = JSON.parse(mcpFile!.content.toString("utf8"));
    // workspaceFolder and userHome should be kept as-is (predefined variables)
    expect(mcpContent.mcpServers.local.args).toEqual(["${workspaceFolder}/x", "${userHome}/y"]);
    // API_TOKEN should be transformed to ${env:API_TOKEN}
    expect(mcpContent.mcpServers.local.env.VAR).toBe("${env:API_TOKEN}");
  });

  // Test 7: MCP with params and credential check at schema 15
  it("7. MCP params with credential in url: plan rejects, error does not contain secret", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "secure",
              params: { url: {} },
              server: { url: "{{url}}" },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/secure"])],
        profiles: [profile("acme", ["base"], ["cursor"], { params: { url: "https://user:s3cr3tP4ss@example.com/x" } })],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    await expect(plan(ws)).rejects.toThrow();
    // The error message should not contain the actual credential value
    try {
      await plan(ws);
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cr3tP4ss");
    }
  });

  // Test 8a: CRLF line endings preserved
  it("8a. existing CRLF file: planned bytes use CRLF", async () => {
    const crlfContent = '---\r\ndescription: "Style guide"\r\nalwaysApply: true\r\n---\r\n\r\nUse tabs.\r\n';
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" }, files: { ".cursor/rules/style.mdc": crlfContent } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const ruleFile = p.files.find((f) => f.path === ".cursor/rules/style.mdc");
    expect(ruleFile).toBeDefined();
    // Planned bytes should use CRLF
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\r\ndescription: "Style guide"\r\nalwaysApply: true\r\n---\r\n\r\nUse tabs.\r\n'
    );
    // Status should be adopt (equal bytes)
    const ruleStatus = st.find((f) => f.path === ".cursor/rules/style.mdc");
    expect(ruleStatus?.state).toBe("adopt");
  });

  // Test 8b: BOM is stripped
  it("8b. existing file with BOM: planned bytes have no BOM", async () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = '---\ndescription: "Style guide"\nalwaysApply: true\n---\n\nUse tabs.\n';
    const contentWithBom = Buffer.concat([BOM, Buffer.from(content, "utf8")]);

    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" }, files: { ".cursor/rules/style.mdc": contentWithBom } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".cursor/rules/style.mdc");
    expect(ruleFile).toBeDefined();
    // Planned bytes should have NO BOM
    expect(ruleFile!.content[0]).not.toBe(0xef);
    expect(ruleFile!.content.slice(0, 3).equals(BOM)).toBe(false);
  });

  // Test 8c: hand-written .md file (not .mdc) is untouched
  it("8c. hand-written .md file: untouched after apply, not in lock", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" }, files: { ".cursor/rules/style.md": "Hand-written content.\n" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    await apply(ws, p, st, {});

    // The .md file should be untouched
    const mdContent = await fs.readFile(path.join(s.wsRoot, ".cursor/rules/style.md"), "utf8");
    expect(mdContent).toBe("Hand-written content.\n");

    // Read the lock after apply
    const newLock = await readLock(ws.root);
    // The .md file should not be in the lock
    const entries = newLock?.entries ?? [];
    expect(entries.some((e) => e.path === ".cursor/rules/style.md")).toBe(false);
  });

  // Test 8d: no backslash in planned paths
  it("8d. every planned path contains no backslash", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide" },
            files: { "rule.md": "Style.\n" },
          },
          {
            meta: { type: "agent", name: "helper", description: "Helps" },
            files: { "agent.md": "Help.\n" },
          },
          {
            meta: { type: "mcp", name: "api", server: { command: "npx" } },
          },
        ],
        recipes: [recipe("base", ["rule/style", "agent/helper", "mcp/api"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    for (const f of p.files) {
      expect(f.path).not.toContain("\\");
    }
  });

  // Test 9: diffReport with withholdMcp
  it("9. diffReport with withholdMcp: mcp file content is withheld", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "mcp", name: "api", server: { command: "npx", args: ["api"], env: { TOKEN: "${API_TOKEN}" } } },
          },
        ],
        recipes: [recipe("base", ["mcp/api"])],
        profiles: [profile("acme", ["base"], ["cursor"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    let st = await status(ws, p, lock);

    // First apply to create the lock
    await apply(ws, p, st, {});

    // Now hand-edit the MCP file
    const mcpPath = path.join(s.wsRoot, ".cursor/mcp.json");
    await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { api: { command: "changed" } } }, null, 2) + "\n");

    // Re-plan and status to detect drift
    const ws2 = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p2 = await plan(ws2);
    const lock2 = await readLock(ws2.root);
    st = await status(ws2, p2, lock2);

    const mcpStatus = st.find((f) => f.path === ".cursor/mcp.json");
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.state).toBe("drift");

    // diffReport with withholdMcp: true
    const report = await diffReport(ws2, st, { withholdMcp: true });
    const mcpRow = report.find((r) => r.path === ".cursor/mcp.json");
    expect(mcpRow).toBeDefined();
    expect(mcpRow!.note).toBe("content not shown: an MCP configuration file may hold a value typed by hand");
    expect(mcpRow!.disk).toBeNull();
    expect(mcpRow!.forge).toBeNull();
  });
});
