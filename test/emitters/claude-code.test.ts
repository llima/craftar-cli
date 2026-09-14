import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
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
});
