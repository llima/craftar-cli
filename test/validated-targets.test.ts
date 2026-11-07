/**
 * Findings of the CLI validation of the native targets (2026-11-07, Copilot CLI 1.0.105):
 * - F1: the Copilot CLI reads `.github/mcp.json` (or `.mcp.json`) under `mcpServers`, never `.vscode/mcp.json`, and expands
 *   `${NAME}` but not `${env:NAME}` — so the copilot target also writes `.github/mcp.json`, servers as rendered, `${NAME}` kept,
 *   while `.vscode/mcp.json` (VS Code's) keeps its bytes.
 * - F2: the claude-code emitter wrote `tools: ` (YAML null) for an agent with no tools and no raw frontmatter, which the
 *   Copilot CLI rejects when it reads `.claude/agents/`; the key is now left out when the list is empty.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, apply, status, readLock } from "../src/core/sync.js";
import { diffReport } from "../src/core/report.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

const API = { type: "mcp", name: "api", server: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${API_TOKEN}" } } };
const REMOTE = { type: "mcp", name: "remote", server: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${KEY}" } } };

async function copilotWs(ingredients: IngredientSpec[], refs: string[], files?: Record<string, string>) {
  const s = kept(await scenario(
    { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["copilot"])] },
    { config: { profile: "acme" }, ...(files ? { files } : {}) },
  ));
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
  return s;
}

describe("F1 — copilot also writes .github/mcp.json for the Copilot CLI", () => {
  it("writes .github/mcp.json under mcpServers, ${NAME} kept, beside an unchanged .vscode/mcp.json", async () => {
    const s = await copilotWs([{ meta: API }, { meta: REMOTE }], ["mcp/api", "mcp/remote"]);
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));

    const cli = p.files.find((f) => f.path === ".github/mcp.json");
    expect(cli).toBeDefined();
    expect(cli!.target).toBe("copilot");
    expect(cli!.ingredient).toBe("mcp/*");
    const text = cli!.content.toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        api: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${API_TOKEN}" } },
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${KEY}" } },
      },
    });
    expect(text).not.toContain("${env:");

    // VS Code's file keeps its shape and its ${env:NAME} rewrite.
    const vscode = p.files.find((f) => f.path === ".vscode/mcp.json");
    expect(JSON.parse(vscode!.content.toString("utf8"))).toEqual({
      servers: {
        api: { command: "npx", args: ["${workspaceFolder}/api"], env: { TOKEN: "${env:API_TOKEN}" } },
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "${env:KEY}" } },
      },
    });
  });

  it("writes no .github/mcp.json when no MCP ingredient reaches copilot", async () => {
    const s = await copilotWs([{ meta: { type: "rule", name: "style", inclusion: "always" }, files: { "rule.md": "Tabs.\n" } }], ["rule/style"]);
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(p.files.find((f) => f.path === ".github/mcp.json")).toBeUndefined();
  });

  it("keeps the CRLF of a .github/mcp.json it replaces and drops its BOM", async () => {
    const existing = "﻿" + '{\r\n  "mcpServers": {}\r\n}\r\n';
    const s = await copilotWs([{ meta: API }], ["mcp/api"], { ".github/mcp.json": existing });
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    const text = p.files.find((f) => f.path === ".github/mcp.json")!.content.toString("utf8");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("is an MCP file on every surface: a hand edit is drift and its content is withheld", async () => {
    const s = await copilotWs([{ meta: API }], ["mcp/api"]);
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});

    await fs.writeFile(path.join(s.wsRoot, ".github/mcp.json"), JSON.stringify({ mcpServers: { api: { command: "changed" } } }) + "\n");
    const ws2 = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p2 = await plan(ws2);
    const st = await status(ws2, p2, await readLock(ws2.root));
    expect(st.find((f) => f.path === ".github/mcp.json")!.state).toBe("drift");

    const row = (await diffReport(ws2, st, { withholdMcp: true })).find((r) => r.path === ".github/mcp.json");
    expect(row!.note).toBe("content not shown: an MCP configuration file may hold a value typed by hand");
    expect(row!.disk).toBeNull();
    expect(row!.forge).toBeNull();
  });

  it("the copilot × mcp cell names both files", () => {
    expect(CAPABILITIES.copilot.mcp.output).toEqual([".vscode/mcp.json", ".github/mcp.json"]);
  });
});

describe("F2 — claude-code leaves out an empty tools list", () => {
  async function claudeAgent(meta: Record<string, unknown>) {
    const s = kept(await scenario(
      {
        ingredients: [{ meta: { type: "agent", name: "helper", description: "Helps.", ...meta }, files: { "agent.md": "Help.\n" } }],
        recipes: [recipe("base", ["agent/helper"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      },
      { config: { profile: "acme" } },
    ));
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    return p.files.find((f) => f.path === ".claude/agents/helper.md")!.content.toString("utf8");
  }

  it("writes no tools key for an agent with no tools and no raw frontmatter", async () => {
    expect(await claudeAgent({})).toBe("---\nname: helper\ndescription: Helps.\n---\nHelp.\n");
  });

  it("still writes the tools it has", async () => {
    expect(await claudeAgent({ tools: ["Read", "Grep"] })).toBe("---\nname: helper\ndescription: Helps.\ntools: Read, Grep\n---\nHelp.\n");
  });

  it("keeps a raw frontmatter verbatim, an empty tools line included", async () => {
    expect(await claudeAgent({ frontmatterRaw: "name: helper\ntools: " })).toBe("---\nname: helper\ntools: \n---\nHelp.\n");
  });
});
