/**
 * Copilot emitter tests (spec 61 §3.4, §5.2): `.github/instructions/<name>.instructions.md`,
 * `.github/agents/<name>.md`, `.github/prompts/<name>.prompt.md`, `.vscode/mcp.json`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, apply, status, readLock } from "../src/core/sync.js";
import { diffReport } from "../src/core/report.js";
import { profile, recipe, scenario, type Scenario } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("copilot emitter (spec 61 §3.4, §5.2)", () => {
  // Test 1: always-on rule with description
  it("1. always-on rule: description in frontmatter, empty applyTo", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".github/instructions/style.instructions.md");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\ndescription: "Style guide"\n---\n\nUse tabs.\n'
    );
  });

  // Test 2: scoped rule (fileMatch) with applyTo
  it("2. scoped rule (fileMatch): applyTo from fileMatchPattern array", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts", "test/**"] },
            files: { "rule.md": "API.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/api"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".github/instructions/api.instructions.md");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\napplyTo: ["src/**/*.ts","test/**"]\n---\n\nAPI.\n'
    );
  });

  // Test 3: manual rule (no description) -> empty frontmatter
  it("3. manual rule: empty frontmatter block", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "release", inclusion: "manual" },
            files: { "rule.md": "Release.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/release"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".github/instructions/release.instructions.md");
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\n---\n\nRelease.\n'
    );
  });

  // Test 4: agent with tools warning
  it("4. agent: frontmatter with name, description; tools dropped with warning", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "agent", name: "helper", description: "Helps", tools: ["Read", "Bash"] },
            files: { "agent.md": "Help.\n" },
          },
        ],
        recipes: [recipe("base", ["agent/helper"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentFile = p.files.find((f) => f.path === ".github/agents/helper.md");
    expect(agentFile).toBeDefined();
    expect(agentFile!.content.toString("utf8")).toBe(
      '---\nname: helper\ndescription: Helps\n---\nHelp.\n'
    );
    // Check warning about dropped tools
    expect(p.warnings).toContain('copilot: agent "helper": tools have no Copilot field and are dropped');
  });

  // Test 5: command with description
  it("5. command: description in frontmatter, body unchanged", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "review", description: "Review code" },
            files: { "command.md": "Review.\n" },
          },
        ],
        recipes: [recipe("base", ["command/review"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const commandFile = p.files.find((f) => f.path === ".github/prompts/review.prompt.md");
    expect(commandFile).toBeDefined();
    expect(commandFile!.content.toString("utf8")).toBe(
      '---\ndescription: Review code\n---\nReview.\n'
    );
  });

  // Test 5b: command without description -> body only
  it("5b. command without description: body only, no frontmatter", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "build" },
            files: { "command.md": "Build.\n" },
          },
        ],
        recipes: [recipe("base", ["command/build"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const commandFile = p.files.find((f) => f.path === ".github/prompts/build.prompt.md");
    expect(commandFile).toBeDefined();
    expect(commandFile!.content.toString("utf8")).toBe('Build.\n');
  });

  // Test 6: MCP with type: stdio wrapper
  it("6. MCP: servers under servers key with type: stdio", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "api",
              server: { command: "npx", args: ["api-server", "--port", "8080"], env: { TOKEN: "${API_TOKEN}" } },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/api"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const mcpFile = p.files.find((f) => f.path === ".vscode/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpContent = JSON.parse(mcpFile!.content.toString("utf8"));
    expect(mcpContent).toEqual({
      servers: {
        api: {
          type: "stdio",
          command: "npx",
          args: ["api-server", "--port", "8080"],
          env: { TOKEN: "${API_TOKEN}" },
        },
      },
    });
    expect(mcpFile!.ingredient).toBe("mcp/*");
    expect(mcpFile!.content.toString("utf8").endsWith("}\n")).toBe(true);
  });

  // Test 6b: MCP without args and env omits those keys
  it("6b. MCP: omits args and env when empty", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "simple",
              server: { command: "my-server" },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/simple"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const mcpFile = p.files.find((f) => f.path === ".vscode/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpContent = JSON.parse(mcpFile!.content.toString("utf8"));
    expect(mcpContent).toEqual({
      servers: {
        simple: {
          type: "stdio",
          command: "my-server",
        },
      },
    });
  });

  // Test 7: skill aimed at copilot -> skipped with warning
  it("7. skill: skipped with one warning per type", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "skill", name: "docs", layout: "dir" },
            files: { "SKILL.md": "Docs.\n" },
          },
        ],
        recipes: [recipe("base", ["skill/docs"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // No .github/ files for skill
    expect(p.files.filter((f) => f.path.includes("skill"))).toEqual([]);
    // One warning per type
    expect(p.warnings).toContain("copilot: 1 skill ingredient(s) have no Copilot equivalent — skipped: skill/docs");
  });

  // Test 8a: CRLF line endings preserved
  it("8a. existing CRLF file: planned bytes use CRLF", async () => {
    const crlfContent = '---\r\ndescription: "Style guide"\r\n---\r\n\r\nUse tabs.\r\n';
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", description: "Style guide", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" }, files: { ".github/instructions/style.instructions.md": crlfContent } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const ruleFile = p.files.find((f) => f.path === ".github/instructions/style.instructions.md");
    expect(ruleFile).toBeDefined();
    // Planned bytes should use CRLF
    expect(ruleFile!.content.toString("utf8")).toBe(
      '---\r\ndescription: "Style guide"\r\n---\r\n\r\nUse tabs.\r\n'
    );
    // Status should be adopt (equal bytes)
    const ruleStatus = st.find((f) => f.path === ".github/instructions/style.instructions.md");
    expect(ruleStatus?.state).toBe("adopt");
  });

  // Test 8b: BOM is stripped
  it("8b. existing file with BOM: planned bytes have no BOM", async () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = '---\ndescription: "Style guide"\n---\n\nUse tabs.\n';
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
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" }, files: { ".github/instructions/style.instructions.md": contentWithBom } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".github/instructions/style.instructions.md");
    expect(ruleFile).toBeDefined();
    // Planned bytes should have NO BOM
    expect(ruleFile!.content[0]).not.toBe(0xef);
    expect(ruleFile!.content.slice(0, 3).equals(BOM)).toBe(false);
  });

  // Test 8c: every planned path contains no backslash
  it("8c. every planned path contains no backslash", async () => {
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
            meta: { type: "command", name: "review", description: "Review" },
            files: { "command.md": "Review.\n" },
          },
          {
            meta: { type: "mcp", name: "api", server: { command: "npx" } },
          },
        ],
        recipes: [recipe("base", ["rule/style", "agent/helper", "command/review", "mcp/api"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
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
        profiles: [profile("acme", ["base"], ["copilot"])],
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
    const mcpPath = path.join(s.wsRoot, ".vscode/mcp.json");
    await fs.writeFile(mcpPath, JSON.stringify({ servers: { api: { type: "stdio", command: "changed" } } }, null, 2) + "\n");

    // Re-plan and status to detect drift
    const ws2 = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p2 = await plan(ws2);
    const lock2 = await readLock(ws2.root);
    st = await status(ws2, p2, lock2);

    const mcpStatus = st.find((f) => f.path === ".vscode/mcp.json");
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.state).toBe("drift");

    // diffReport with withholdMcp: true
    const report = await diffReport(ws2, st, { withholdMcp: true });
    const mcpRow = report.find((r) => r.path === ".vscode/mcp.json");
    expect(mcpRow).toBeDefined();
    expect(mcpRow!.note).toBe("content not shown: an MCP configuration file may hold a value typed by hand");
    expect(mcpRow!.disk).toBeNull();
    expect(mcpRow!.forge).toBeNull();
  });
});
