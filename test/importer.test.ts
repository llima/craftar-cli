import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { exists } from "../src/core/forge.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-import-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (name: string) => path.join(root, name) };
}
const importInto = (forge: string, workspaceRoot: string, profileName: string) => importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName });
const yaml = async (file: string) => YAML.parse(await fs.readFile(file, "utf8"));

describe("import --from claude-code", () => {
  it("reuses identical ingredients and turns differing ones into variants", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow v1\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# Workflow v2\n" });
    await writeFiles(t.ws("c"), { ".claude/rules/workflow.md": "# Workflow v1\r\n" });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.variants).toEqual([{ name: "rule/workflow--b", reason: "differs from rule/workflow already in the Forge" }]);
    expect((await yaml(path.join(t.forge, "ingredients/rules/workflow--b/ingredient.yaml"))).as).toBe("workflow");
    const c = await importInto(t.forge, t.ws("c"), "c");
    expect(c.reused).toContain("rule/workflow");
  });

  it("groups a scoped rule and its reviewer into a stack recipe", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend-node.md": "# Backend\n",
      ".kiro/steering/backend-node.md": '---\ninclusion: fileMatch\nfileMatchPattern: "projects/acme-api/**"\n---\n\n<!-- GENERATED from .claude/rules/backend-node.md by craftar -- do not edit. -->\n\n# Backend\n',
      ".claude/agents/backend-node-reviewer.md": "---\nname: backend-node-reviewer\ndescription: Reviews acme-api.\ntools: Read, Grep\n---\n\nWalk `.claude/rules/backend-node.md`.\n",
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.recipes).toContain("stack-backend-node");
    expect((await yaml(path.join(t.forge, "recipes/stack-backend-node.yaml"))).ingredients).toEqual(["rule/backend-node", "agent/backend-node-reviewer"]);
    expect((await yaml(path.join(t.forge, "recipes/base.yaml"))).ingredients).not.toContain("agent/backend-node-reviewer");
  });

  it("rejects an MCP server whose env holds a token, without copying or reporting the value", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: TOKEN } }, playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.80"] } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "mcp/github", reason: "secret-like value (github-token) in .mcp.json → mcpServers.github.env.GITHUB_TOKEN" }]);
    expect(await exists(path.join(t.forge, "ingredients/mcp/github"))).toBe(false);
    expect(await exists(path.join(t.forge, "ingredients/mcp/playwright/ingredient.yaml"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((await yaml(path.join(t.forge, "recipes/base.yaml"))).ingredients).not.toContain("mcp/github");
  });

  it("never echoes .mcp.json content in a parse error, even when it holds a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"gh":{"env":{"T":' + TOKEN + "}}}}",
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(".mcp.json is not valid JSON — fix the file and re-run import");
    try {
      await importInto(t.forge, t.ws("api"), "api");
    } catch (e) {
      expect(String(e)).not.toContain("ghp_");
    }
  });

  it("rejects a rule with a token and reports the file line", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/deploy.md": "# Deploy\n\nkey " + "AKIA" + "ABCDEFGHIJKLMNOP" + "\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "rule/deploy", reason: "secret-like value (aws-access-key) in .claude/rules/deploy.md line 3" }]);
    expect(await exists(path.join(t.forge, "ingredients/rules/deploy"))).toBe(false);
  });

  it("reports the line in the source file for an agent body under frontmatter", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/agents/ops.md": "---\nname: ops\ndescription: Ops helper.\n---\n\nUse token " + TOKEN + "\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "agent/ops", reason: "secret-like value (github-token) in .claude/agents/ops.md line 6" }]);
  });

  it("rejects a skill-dir file read as a Buffer (non-allowlisted extension) holding a private key", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/skills/deploy-kit/SKILL.md": "# Deploy kit\n",
      ".claude/skills/deploy-kit/keys/deploy.pem": "-----BEGIN " + "RSA PRIVATE KEY-----\nabc\n",
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "skill/deploy-kit", reason: "secret-like value (private-key) in .claude/skills/deploy-kit/keys/deploy.pem line 1" }]);
    expect(await exists(path.join(t.forge, "ingredients/skills/deploy-kit"))).toBe(false);
  });

  it("rejects a hook file read as a Buffer (non-allowlisted extension) holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/hooks/deploy.bat": "set TOKEN=" + TOKEN + "\r\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "hook/deploy", reason: "secret-like value (github-token) in .claude/hooks/deploy.bat line 1" }]);
  });

  it("skips a binary skill-dir file (NUL byte) instead of scanning it as text", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/skills/asset-kit/SKILL.md": "# Asset kit\n",
      ".claude/skills/asset-kit/data.bin": Buffer.concat([Buffer.from("TOKEN=" + TOKEN), Buffer.from([0]), Buffer.from("tail")]),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    expect(await exists(path.join(t.forge, "ingredients/skills/asset-kit/ingredient.yaml"))).toBe(true);
  });

  it("rejects an MCP server whose headers hold a token, pattern-scanning fields beyond env/args", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer " + TOKEN } } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "mcp/remote", reason: "secret-like value (github-token) in .mcp.json → mcpServers.remote.headers.Authorization" }]);
  });

  it("does not apply the entropy rule outside env/args (a high-entropy header is not rejected)", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { remote2: { command: "npx", headers: { "X-Trace": "Xk9f2LmQ7pR4tZ8wB3nV" } } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    expect(await exists(path.join(t.forge, "ingredients/mcp/remote2/ingredient.yaml"))).toBe(true);
  });
});
