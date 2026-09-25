import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { hasBom } from "../../src/core/text.js";
import { profile, recipe, rule, scenario, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "../helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(ingredients: IngredientSpec[], files?: WorkspaceSpec["files"], targets = ["claude-code"]): Promise<Plan> {
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], targets)],
  };
  const s = await scenario(forge, { config: { profile: "acme" }, files });
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}
const text = (p: Plan, rel: string) => p.files.find((f) => f.path === rel)?.content.toString("utf8");

describe("claude-code emitter", () => {
  it("writes a new file with LF", async () => {
    const p = await planFor([rule("a", "# A\n\nbody\n")]);
    expect(text(p, ".claude/rules/a.md")).toBe("# A\n\nbody\n");
  });

  it("keeps the CRLF of the file it replaces", async () => {
    const p = await planFor([rule("a", "# A\n\nbody\n")], { ".claude/rules/a.md": "# old\r\n" });
    expect(text(p, ".claude/rules/a.md")).toBe("# A\r\n\r\nbody\r\n");
  });

  it("serializes agent frontmatter verbatim from frontmatterRaw", async () => {
    const raw = "name: rev\ndescription: Reviews a, b — c\ntools: Read, Grep";
    const p = await planFor([
      { meta: { type: "agent", name: "rev", description: "Reviews a, b — c", tools: ["Read", "Grep"], frontmatterRaw: raw }, files: { "agent.md": "\n# Rev\n" } },
    ]);
    expect(text(p, ".claude/agents/rev.md")).toBe(`---\n${raw}\n---\n\n# Rev\n`);
  });

  it("emits a variant under its original name", async () => {
    const p = await planFor([rule("workflow--acme", "# W\n", { as: "workflow" })]);
    expect(p.files.map((f) => f.path)).toEqual([".claude/rules/workflow.md"]);
  });

  it("collects MCP ingredients into .mcp.json", async () => {
    const p = await planFor([
      { meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["-y", "pw"] } } },
      { meta: { type: "mcp", name: "docs", server: { url: "https://mcp.example.com/sse" } } },
    ]);
    expect(text(p, ".mcp.json")).toBe(JSON.stringify({ mcpServers: { pw: { command: "npx", args: ["-y", "pw"] }, docs: { url: "https://mcp.example.com/sse" } } }, null, 2) + "\n");
  });

  it("emits an MCP variant under its original server name", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "srv--acme", as: "srv", server: { command: "npx", args: ["acme-server"] } } }]);
    expect(text(p, ".mcp.json")).toBe(JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }, null, 2) + "\n");
  });

  it("names each dropped writer once when three MCP ingredients emit the same server name", async () => {
    const p = await planFor([
      { meta: { type: "mcp", name: "srv", server: { command: "a" } } },
      { meta: { type: "mcp", name: "srv--b", as: "srv", server: { command: "b" } } },
      { meta: { type: "mcp", name: "srv--c", as: "srv", server: { command: "c" } } },
    ]);
    expect(p.warnings.filter((w) => w.includes('MCP server "srv"'))).toEqual([
      'claude-code: two ingredients write the MCP server "srv" into .mcp.json: mcp/srv and mcp/srv--b (last wins)',
      'claude-code: two ingredients write the MCP server "srv" into .mcp.json: mcp/srv--b and mcp/srv--c (last wins)',
    ]);
    expect(text(p, ".mcp.json")).toBe(JSON.stringify({ mcpServers: { srv: { command: "c" } } }, null, 2) + "\n");
  });

  it("warns when two MCP ingredients emit the same server name, instead of dropping one silently", async () => {
    const p = await planFor([
      { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["public-server"] } } },
      { meta: { type: "mcp", name: "srv--acme", as: "srv", server: { command: "npx", args: ["acme-server"] } } },
    ]);
    expect(p.warnings).toContain('claude-code: two ingredients write the MCP server "srv" into .mcp.json: mcp/srv and mcp/srv--acme (last wins)');
    expect(text(p, ".mcp.json")).toBe(JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }, null, 2) + "\n");
  });

  it("keeps the BOM of the file it replaces", async () => {
    const p = await planFor([rule("a", "# A\n")], { ".claude/rules/a.md": "\uFEFF# old\n" });
    const f = p.files.find((x) => x.path === ".claude/rules/a.md")!;
    expect(hasBom(f.content)).toBe(true);
    expect(f.content.subarray(3).toString("utf8")).toBe("# A\n");
  });

  it("writes a new file without a BOM", async () => {
    const p = await planFor([rule("a", "# A\n")]);
    expect(hasBom(p.files.find((x) => x.path === ".claude/rules/a.md")!.content)).toBe(false);
  });

  it("agents-md inherits BOM preservation through textFile", async () => {
    const p = await planFor([rule("a", "# A\n")], { "AGENTS.md": "\uFEFFold\n" }, ["agents-md"]);
    expect(hasBom(p.files.find((x) => x.path === "AGENTS.md")!.content)).toBe(true);
  });

  it("warns for a steering ingredient aimed at claude-code with targets \"*\", and emits nothing for it", async () => {
    const p = await planFor([rule("a", "# A\n"), { meta: { type: "steering", name: "product", file: "steering.md", targets: "*" }, files: { "steering.md": "# P\n" } }]);
    expect(p.warnings).toContain("claude-code: steering steering/product has no Claude Code equivalent — skipped");
    expect(p.files.map((f) => f.path)).toEqual([".claude/rules/a.md"]);
  });

  it("does not warn for a steering ingredient left at its kiro-only default", async () => {
    const p = await planFor([{ meta: { type: "steering", name: "product", file: "steering.md" }, files: { "steering.md": "# P\n" } }]);
    expect(p.warnings.filter((w) => w.startsWith("claude-code:"))).toEqual([]);
    expect(p.files).toEqual([]);
  });
});
