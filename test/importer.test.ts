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
const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const utf16be = (text: string) => {
  const le = Buffer.from(text, "utf16le");
  le.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
};
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

  it("rejects .mcp.json containing only null", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": "null",
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      ".mcp.json has no valid mcpServers object — fix the file and re-run import",
    );
  });

  it("rejects .mcp.json whose mcpServers is not an object", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":"x"}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      ".mcp.json has no valid mcpServers object — fix the file and re-run import",
    );
  });

  it("rejects a null MCP server entry instead of throwing a raw TypeError", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"a":null}}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      '.mcp.json server "a" is not an object — fix the file and re-run import',
    );
    expect(await exists(path.join(t.forge, "ingredients/mcp"))).toBe(false);
  });

  it("rejects a non-object (string) MCP server entry", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"a":"x"}}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      '.mcp.json server "a" is not an object — fix the file and re-run import',
    );
    expect(await exists(path.join(t.forge, "ingredients/mcp"))).toBe(false);
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

  it("rejects an allowlisted script saved as UTF-16LE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/scripts/deploy.ps1": utf16le("# deploy\r\n$token = '" + TOKEN + "'\r\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "script/deploy", reason: "secret-like value (github-token) in .claude/scripts/deploy.ps1 line 2" }]);
    expect(await exists(path.join(t.forge, "ingredients/scripts/deploy"))).toBe(false);
  });

  it("rejects a non-allowlisted hook saved as UTF-16LE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/hooks/deploy.bat": utf16le("set TOKEN=" + TOKEN + "\r\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "hook/deploy", reason: "secret-like value (github-token) in .claude/hooks/deploy.bat line 1" }]);
    expect(await exists(path.join(t.forge, "ingredients/hooks/deploy"))).toBe(false);
  });

  it("rejects a rule saved as UTF-16BE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/deploy.md": utf16be("# Deploy\n\nkey " + "AKIA" + "ABCDEFGHIJKLMNOP" + "\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "rule/deploy", reason: "secret-like value (aws-access-key) in .claude/rules/deploy.md line 3" }]);
  });

  it("stores a clean UTF-16 file exactly as before (the decode is for scanning only)", async () => {
    const t = await setup();
    const script = utf16le("Write-Host 'hello'\r\n");
    const hook = utf16le("echo hello\r\n");
    await writeFiles(t.ws("api"), { ".claude/scripts/hello.ps1": script, ".claude/hooks/hello.bat": hook });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    const stored = await fs.readFile(path.join(t.forge, "ingredients/scripts/hello/hello.ps1"), "utf8");
    expect(stored).toBe(script.toString("utf8").replace(/\r\n?/g, "\n"));
    expect(await fs.readFile(path.join(t.forge, "ingredients/hooks/hello/hello.bat"))).toEqual(hook);
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

describe("import --from claude-code — nested MCP configuration", () => {
  it("turns an MCP server that differs only inside its config into a variant, instead of reusing the first", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["public-server"] } } }),
    });
    await writeFiles(t.ws("b"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }),
    });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.reused).not.toContain("mcp/srv");
    expect(b.variants.map((v) => v.name)).toContain("mcp/srv--b");
    expect((await yaml(path.join(t.forge, "ingredients/mcp/srv--b/ingredient.yaml"))).server.args).toEqual(["acme-server"]);
    expect((await yaml(path.join(t.forge, "ingredients/mcp/srv/ingredient.yaml"))).server.args).toEqual(["public-server"]);
  });

  it("still reuses an MCP server whose config is identical", async () => {
    const t = await setup();
    const same = JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["public-server"], env: { TOKEN_VAR: "T" } } } });
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": same });
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": same });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.reused).toContain("mcp/srv");
    expect(await exists(path.join(t.forge, "ingredients/mcp/srv--b"))).toBe(false);
  });
});
