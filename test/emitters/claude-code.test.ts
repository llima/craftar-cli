import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { hasBom } from "../../src/core/text.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "../helpers/forge.js";

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

  it("writes an MCP server exactly as the Forge holds it: undeclared keys, in its own key order (spec 07)", async () => {
    const server = { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30 };
    const p = await planFor([{ meta: { type: "mcp", name: "r", server } }]);
    expect(text(p, ".mcp.json")).toBe(JSON.stringify({ mcpServers: { r: server } }, null, 2) + "\n");
  });

  it("emits a server with only declared keys, in schema order, byte for byte as 0.2.4 did (AC 18)", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["-y", "pw"] } } }]);
    expect(text(p, ".mcp.json")).toBe('{\n  "mcpServers": {\n    "pw": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "pw"\n      ]\n    }\n  }\n}\n');
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

describe("claude-code emitter — sections (spec 11 §10.2, AC 2)", () => {
  const SEC = "# T\n<!-- craftar:section s -->\ndefault\n<!-- /craftar:section -->\nend\n";
  async function sectionPlan(files?: WorkspaceSpec["files"]): Promise<Plan> {
    const ingredients: IngredientSpec[] = [
      rule("r", SEC),
      { meta: { type: "agent", name: "a", description: "An agent", frontmatterRaw: "name: a\ndescription: An agent" }, files: { "agent.md": SEC } },
      { meta: { type: "command", name: "c", description: "A command" }, files: { "command.md": SEC } },
      { meta: { type: "skill", name: "fs", layout: "file" }, files: { "SKILL.md": SEC } },
      { meta: { type: "skill", name: "ds" }, files: { "SKILL.md": SEC, "ref.md": SEC.replace("section s", "section t") } },
      { meta: { type: "script", name: "go", files: ["go.md"] }, files: { "go.md": SEC } },
    ];
    const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
    const values = Object.fromEntries(refs.map((r) => [r, { s: "value", t: "tvalue" }]));
    const s = await scenario(
      { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["claude-code"], { sections: values })] },
      { config: { profile: "acme" }, files },
    );
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: test-forge\nschema: 2\n" });
    return plan(await loadWorkspace(s.wsRoot));
  }

  it("no output holds a marker: rule, agent, command, file skill, dir skill, script", async () => {
    const p = await sectionPlan();
    const paths = [".claude/rules/r.md", ".claude/agents/a.md", ".claude/commands/c.md", ".claude/skills/fs.md", ".claude/skills/ds/SKILL.md", ".claude/skills/ds/ref.md", ".claude/scripts/go.md"];
    for (const rel of paths) {
      const t = text(p, rel)!;
      expect(t, rel).not.toContain("craftar:section");
      expect(t, rel).toMatch(/# T\nt?value\nend\n$/);
    }
    expect(text(p, ".claude/skills/ds/ref.md")).toBe("# T\ntvalue\nend\n");
  });

  it("keeps a CRLF/BOM existing file's framing around the expanded text", async () => {
    const p = await sectionPlan({ ".claude/rules/r.md": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# old\r\n")]) });
    const f = p.files.find((x) => x.path === ".claude/rules/r.md")!;
    expect(hasBom(f.content)).toBe(true);
    expect(f.content.subarray(3).toString("utf8")).toBe("# T\r\nvalue\r\nend\r\n");
  });
});

describe("claude-code emitter — authEnv example file (spec 27)", () => {
  const EX = ".claude/settings.craftar.example.json";

  it("1. no declaring ingredient → no example file", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "pw", server: { command: "npx" } } }]);
    expect(p.files.map((f) => f.path)).toEqual([".mcp.json"]);
  });

  it("2. two declaring ingredients, names out of order and one shared", async () => {
    const a = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN", "ACME_SHARED"], server: { command: "npx" } } };
    const b = { meta: { type: "mcp", name: "idp", authEnv: ["ACME_SHARED", "ACME_IDP_TOKEN"], server: { url: "https://idp.example.com/mcp" } } };
    const p = await planFor([a, b] as any);
    expect(text(p, EX)).toBe('{\n  "env": {\n    "ACME_IDP_TOKEN": "",\n    "ACME_SHARED": "",\n    "ACME_TRACKER_TOKEN": ""\n  }\n}\n');
    const f = p.files.find((f) => f.path === EX)!;
    expect(f.ingredient).toBe("mcp/*");
    expect(f.target).toBe("claude-code");
  });

  it("3. .mcp.json is byte-identical with and without the declaration", async () => {
    const a = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN", "ACME_SHARED"], server: { command: "npx" } } };
    const b = { meta: { type: "mcp", name: "idp", authEnv: ["ACME_SHARED", "ACME_IDP_TOKEN"], server: { url: "https://idp.example.com/mcp" } } };
    const p1 = await planFor([a, b] as any);
    const aNo = { meta: { type: "mcp", name: "tracker", server: { command: "npx" } } };
    const bNo = { meta: { type: "mcp", name: "idp", server: { url: "https://idp.example.com/mcp" } } };
    const p2 = await planFor([aNo, bNo]);
    expect(text(p1, ".mcp.json")).toBe(text(p2, ".mcp.json"));
    expect(text(p1, ".mcp.json")!.includes("authEnv")).toBe(false);
    // Repeat for kiro target
    const k1 = await planFor([a, b] as any, undefined, ["kiro"]);
    const k2 = await planFor([aNo, bNo], undefined, ["kiro"]);
    expect(Buffer.from(k1.files.find((f) => f.path === ".kiro/settings/mcp.json")!.content).equals(
      Buffer.from(k2.files.find((f) => f.path === ".kiro/settings/mcp.json")!.content)
    )).toBe(true);
  });

  it("4. two ingredients writing one server name — only the survivor counts", async () => {
    const p = await planFor([
      { meta: { type: "mcp", name: "srv", authEnv: ["DROPPED"], server: { command: "a" } } },
      { meta: { type: "mcp", name: "srv--b", as: "srv", authEnv: ["KEPT"], server: { command: "b" } } },
    ] as any);
    expect(text(p, EX)).toBe('{\n  "env": {\n    "KEPT": ""\n  }\n}\n');
  });

  it("5. declaring ingredient has targets: [kiro] → no file at EX for claude-code", async () => {
    const ing = { meta: { type: "mcp", name: "tracker", authEnv: ["TOKEN"], targets: ["kiro"], server: { command: "npx" } } };
    const p = await planFor([ing] as any, undefined, ["claude-code", "kiro"]);
    expect(p.files.some((f) => f.path === EX)).toBe(false);
    // kiro-only workspace → also no example file
    const pk = await planFor([ing] as any, undefined, ["kiro"]);
    expect(pk.files.some((f) => f.path === EX)).toBe(false);
  });

  it("6. the emitter never reads the environment", async () => {
    const orig = process.env.ACME_TRACKER_TOKEN;
    try {
      process.env.ACME_TRACKER_TOKEN = "MARKER_VALUE_27";
      const a = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx" } } };
      const p = await planFor([a] as any);
      expect(p.files.every((f) => !f.content.includes("MARKER_VALUE_27"))).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.ACME_TRACKER_TOKEN;
      else process.env.ACME_TRACKER_TOKEN = orig;
    }
  });

  it("7. an existing CRLF + BOM file at EX keeps both", async () => {
    const a = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_SHARED", "ACME_TRACKER_TOKEN"], server: { command: "npx" } } };
    const files = { [EX]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\r\n")]) };
    const p = await planFor([a] as any, files);
    const f = p.files.find((f) => f.path === EX)!;
    expect(hasBom(f.content)).toBe(true);
    expect(f.content.subarray(3).toString("utf8")).toBe('{\r\n  "env": {\r\n    "ACME_SHARED": "",\r\n    "ACME_TRACKER_TOKEN": ""\r\n  }\r\n}\r\n');
  });

  it("8. authEnv: [\"__proto__\", \"A\"] → both are keys", async () => {
    const a = { meta: { type: "mcp", name: "tracker", authEnv: ["__proto__", "A"], server: { command: "npx" } } };
    const p = await planFor([a] as any);
    expect(text(p, EX)).toBe('{\n  "env": {\n    "A": "",\n    "__proto__": ""\n  }\n}\n');
  });

  it("9. authEnv: [] alone → no file at EX", async () => {
    const a = { meta: { type: "mcp", name: "tracker", authEnv: [], server: { command: "npx" } } };
    const p = await planFor([a] as any);
    expect(p.files.some((f) => f.path === EX)).toBe(false);
  });
});