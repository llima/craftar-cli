/**
 * Copilot emitter tests (spec 61 §3.4, §5.2): `.github/instructions/<name>.instructions.md`,
 * `.github/copilot-instructions.md`, `.github/agents/<name>.agent.md`, `.github/prompts/<name>.prompt.md`,
 * `.vscode/mcp.json`.
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
  // Test 1: always-on rules aggregated into .github/copilot-instructions.md
  it("1. always-on rules joined into .github/copilot-instructions.md", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
          {
            meta: { type: "rule", name: "tone", inclusion: "always" },
            files: { "rule.md": "Be brief.\n\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style", "rule/tone"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // No .github/instructions/style.instructions.md for always-on rules
    const styleFile = p.files.find((f) => f.path === ".github/instructions/style.instructions.md");
    expect(styleFile).toBeUndefined();

    // The copilot-instructions.md file
    const copilotFile = p.files.find((f) => f.path === ".github/copilot-instructions.md");
    expect(copilotFile).toBeDefined();
    expect(copilotFile!.content.toString("utf8")).toBe("Use tabs.\n\nBe brief.\n");
    expect(copilotFile!.ingredient).toBe("rule/*");
  });

  // Test 2: scoped rule with applyTo from fileMatchPattern
  it("2. scoped rule: applyTo from fileMatchPattern array joined with commas", async () => {
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
      '---\napplyTo: "src/**/*.ts,test/**"\n---\n\nAPI.\n'
    );
  });

  // Test 3: manual rule skipped with warning
  it("3. manual rule: no file, warning", async () => {
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

    // No file for manual rule
    const ruleFile = p.files.find((f) => f.path.includes("release"));
    expect(ruleFile).toBeUndefined();
    // Warning
    expect(p.warnings).toContain("copilot: rule rule/release (manual) has no Copilot equivalent — skipped");
  });

  // Test 4: agent with tools mapped to Copilot aliases
  it("4. agent: name, description, model, tools mapped to aliases", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "agent", name: "helper", description: "Helps", model: "sonnet", tools: ["Read", "Grep", "Bash", "Unknown"] },
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

    const agentFile = p.files.find((f) => f.path === ".github/agents/helper.agent.md");
    expect(agentFile).toBeDefined();
    expect(agentFile!.content.toString("utf8")).toBe(
      '---\nname: "helper"\ndescription: "Helps"\ntools: ["read","search","execute"]\nmodel: "sonnet"\n---\nHelp.\n'
    );
    // Warning about Unknown tool
    expect(p.warnings).toContain('copilot: agent "helper": tool "Unknown" has no Copilot alias; dropped');
  });

  // Test 4b: agent with __proto__ tool (no crash, dropped with warning)
  it("4b. agent: __proto__ tool dropped with warning, no crash", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "agent", name: "safe", description: "Safe agent", tools: ["__proto__", "constructor", "Read"] },
            files: { "agent.md": "Safe.\n" },
          },
        ],
        recipes: [recipe("base", ["agent/safe"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentFile = p.files.find((f) => f.path === ".github/agents/safe.agent.md");
    expect(agentFile).toBeDefined();
    // __proto__ and constructor dropped with warnings
    expect(p.warnings).toContain('copilot: agent "safe": tool "__proto__" has no Copilot alias; dropped');
    expect(p.warnings).toContain('copilot: agent "safe": tool "constructor" has no Copilot alias; dropped');
  });

  // Test 4c: agent with scoped tool (Bash(git status:*)) warns that scope is dropped
  it("4c. agent: scoped tool maps to alias but warns that scope is dropped", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "agent", name: "git-helper", description: "Git helper", tools: ["Bash(git status:*)"] },
            files: { "agent.md": "Git helper.\n" },
          },
        ],
        recipes: [recipe("base", ["agent/git-helper"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentFile = p.files.find((f) => f.path === ".github/agents/git-helper.agent.md");
    expect(agentFile).toBeDefined();
    // The scoped tool should map to execute and warn about scope being dropped
    expect(agentFile!.content.toString("utf8")).toBe(
      '---\nname: "git-helper"\ndescription: "Git helper"\ntools: ["execute"]\n---\nGit helper.\n'
    );
    // Warning about scope being dropped
    expect(p.warnings).toContain('copilot: agent "git-helper": tool "Bash(git status:*)" maps to execute; its scope is dropped');
  });

  // Test 5: command with description, argumentHint, and agent: agent
  it("5. command: description, argument-hint, agent: agent", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "command", name: "review", description: "Review", argumentHint: "[file]" },
            files: { "command.md": "Review it.\n" },
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
      '---\ndescription: "Review"\nargument-hint: "[file]"\nagent: agent\n---\nReview it.\n'
    );
  });

  // Test 6: MCP servers kept whole with ${NAME} -> ${env:NAME}
  it("6. MCP: servers kept whole, ${NAME} becomes ${env:NAME}", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "api",
              server: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${API_TOKEN}" } },
            },
          },
          {
            meta: {
              type: "mcp",
              name: "remote",
              server: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${KEY}" } },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/api", "mcp/remote"])],
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
        api: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${env:API_TOKEN}" } },
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${env:KEY}" } },
      },
    });
  });

  // Test 7: skill skipped with warning
  it("7. skill: skipped with warning", async () => {
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

    // No files for skill
    expect(p.files.filter((f) => f.path.includes("skill"))).toEqual([]);
    // One warning per type
    expect(p.warnings).toContain("copilot: 1 skill ingredient(s) have no Copilot equivalent — skipped: skill/docs");
  });

  // Test 8: credential in server -> plan() rejects without the secret in the message
  // mcpServers checks SUBSTITUTED leaves for credentials (values that came from params).
  it("8. credential in substituted value: plan() rejects without the secret", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "mcp",
              name: "api",
              params: { url: {} },
              server: { url: "{{url}}" },
            },
          },
        ],
        recipes: [recipe("base", ["mcp/api"])],
        profiles: [profile("acme", ["base"], ["copilot"], { params: { url: "https://user:s3cr3tP4ss@example.com/x" } })],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    await expect(plan(ws)).rejects.toThrow(/mcp\/api/);
    // The secret itself should not be in the error message
    try {
      await plan(ws);
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain("s3cr3tP4ss");
    }
  });

  // Test 9a: CRLF preserved
  it("9a. existing CRLF file: planned bytes use CRLF, status adopt", async () => {
    const crlfContent = "Use tabs.\r\n\r\nBe brief.\r\n";
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
          {
            meta: { type: "rule", name: "tone", inclusion: "always" },
            files: { "rule.md": "Be brief.\n\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style", "rule/tone"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" }, files: { ".github/copilot-instructions.md": crlfContent } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const ruleFile = p.files.find((f) => f.path === ".github/copilot-instructions.md");
    expect(ruleFile).toBeDefined();
    // Planned bytes should use CRLF
    expect(ruleFile!.content.toString("utf8")).toBe("Use tabs.\r\n\r\nBe brief.\r\n");
    // Status should be adopt (equal bytes)
    const ruleStatus = st.find((f) => f.path === ".github/copilot-instructions.md");
    expect(ruleStatus?.state).toBe("adopt");
  });

  // Test 9b: BOM stripped
  it("9b. existing file with BOM: planned bytes have no BOM", async () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = "Use tabs.\n\nBe brief.\n";
    const contentWithBom = Buffer.concat([BOM, Buffer.from(content, "utf8")]);

    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
          {
            meta: { type: "rule", name: "tone", inclusion: "always" },
            files: { "rule.md": "Be brief.\n\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style", "rule/tone"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" }, files: { ".github/copilot-instructions.md": contentWithBom } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const ruleFile = p.files.find((f) => f.path === ".github/copilot-instructions.md");
    expect(ruleFile).toBeDefined();
    // Planned bytes should have NO BOM
    expect(ruleFile!.content[0]).not.toBe(0xef);
    expect(ruleFile!.content.slice(0, 3).equals(BOM)).toBe(false);
  });

  // Test 9c: no backslash in planned paths
  it("9c. every planned path contains no backslash", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "fileMatch", fileMatchPattern: "src/**" },
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

  // Test 9d: glob with comma warning
  it("9d. glob with comma: warning", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api,test/**" },
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

    expect(p.warnings).toContain("copilot: rule rule/api: a glob holds a comma, which Copilot reads as a separator");
  });

  // Test 9e: case-fold (skip on case-sensitive file systems)
  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")("9e. case-fold: existing .GitHub/copilot-instructions.md reads adopt", async () => {
    const content = "Use tabs.\n\nBe brief.\n";
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "style", inclusion: "always" },
            files: { "rule.md": "Use tabs.\n" },
          },
          {
            meta: { type: "rule", name: "tone", inclusion: "always" },
            files: { "rule.md": "Be brief.\n\n" },
          },
        ],
        recipes: [recipe("base", ["rule/style", "rule/tone"])],
        profiles: [profile("acme", ["base"], ["copilot"])],
      },
      { config: { profile: "acme" }, files: { ".GitHub/copilot-instructions.md": content } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const ruleStatus = st.find((f) => f.path === ".github/copilot-instructions.md");
    expect(ruleStatus?.state).toBe("adopt");
  });

  // Test 10: diffReport with withholdMcp
  it("10. diffReport with withholdMcp: mcp file content is withheld", async () => {
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
    await fs.writeFile(mcpPath, JSON.stringify({ servers: { api: { command: "changed" } } }, null, 2) + "\n");

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

  // Test 11: [claude-code, copilot] - both targets write their files
  it("11. [claude-code, copilot]: both .claude/rules/api.md and .github/instructions/api.instructions.md", async () => {
    const s = kept(await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts"] },
            files: { "rule.md": "API.\n" },
          },
        ],
        recipes: [recipe("base", ["rule/api"])],
        profiles: [profile("acme", ["base"], ["claude-code", "copilot"])],
      },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));

    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // claude-code writes .claude/rules/api.md
    const claudeFile = p.files.find((f) => f.path === ".claude/rules/api.md");
    expect(claudeFile).toBeDefined();

    // copilot writes .github/instructions/api.instructions.md
    const copilotFile = p.files.find((f) => f.path === ".github/instructions/api.instructions.md");
    expect(copilotFile).toBeDefined();
  });
});
