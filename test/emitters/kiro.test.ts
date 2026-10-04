import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { hasBom } from "../../src/core/text.js";
import { profile, recipe, rule, scenario, writeFiles, type IngredientSpec } from "../helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(ingredients: IngredientSpec[], profileExtra: Record<string, unknown> = {}, targets: string[] = ["kiro"]): Promise<Plan> {
  const s = await scenario(
    {
      ingredients,
      recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
      profiles: [profile("acme", ["base"], targets, profileExtra)],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}
const file = (p: Plan, rel: string) => p.files.find((f) => f.path === rel);

describe("kiro emitter", () => {
  it("emits an always rule as CRLF steering with the default banner and no BOM", async () => {
    const p = await planFor([rule("a", "# A\n")]);
    const f = file(p, ".kiro/steering/a.md")!;
    expect(f.content.toString("utf8")).toBe("---\r\ninclusion: always\r\n---\r\n\r\n<!-- GENERATED from .claude/rules/a.md by craftar -- do not edit. -->\r\n\r\n# A\r\n");
    expect(hasBom(f.content)).toBe(false);
  });

  it("uses the kiro.banner param", async () => {
    const p = await planFor([rule("a", "# A\n")], { params: { "kiro.banner": "<!-- X from {{source}} -->" } });
    expect(file(p, ".kiro/steering/a.md")!.content.toString("utf8")).toContain("<!-- X from .claude/rules/a.md -->");
  });

  it("writes fileMatch frontmatter", async () => {
    const p = await planFor([rule("b", "# B\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" })]);
    expect(file(p, ".kiro/steering/b.md")!.content.toString("utf8")).toMatch(/^---\r\ninclusion: fileMatch\r\nfileMatchPattern: "projects\/api\/\*\*"\r\n---\r\n\r\n/);
  });

  it("rewrites .claude/rules/ references to .kiro/steering/", async () => {
    const p = await planFor([rule("a", "see .claude/rules/b.md\n")]);
    expect(file(p, ".kiro/steering/a.md")!.content.toString("utf8")).toContain("see .kiro/steering/b.md");
  });

  it("maps agent tools and warns about the ones Kiro cannot express", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Task"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.tools).toEqual(["read"]);
    expect(json.prompt).toBe("# Rev");
    expect(p.warnings).toContain('kiro: tool "Task" has no Kiro equivalent; dropped');
  });

  it("emits a variant under its original name", async () => {
    const p = await planFor([rule("workflow--acme", "# W\n", { as: "workflow" })]);
    expect(p.files.map((f) => f.path)).toEqual([".kiro/steering/workflow.md"]);
  });

  it("stays BOM-less even when the steering on disk has a BOM", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
      { config: { profile: "acme" }, files: { ".kiro/steering/a.md": "\uFEFFold\r\n" } },
    );
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(hasBom(file(p, ".kiro/steering/a.md")!.content)).toBe(false);
  });

  it("warns when it skips a script or a hook", async () => {
    const p = await planFor([
      { meta: { type: "script", name: "hello", files: ["hello.ps1"], targets: "*" }, files: { "hello.ps1": "Write-Output hi\n" } },
      { meta: { type: "hook", name: "fmt", files: ["fmt.py"], targets: "*" }, files: { "fmt.py": "print('x')\n" } },
    ]);
    expect(p.warnings).toContain("kiro: script script/hello has no Kiro equivalent \u2014 skipped");
    expect(p.warnings).toContain("kiro: hook hook/fmt has no Kiro equivalent \u2014 skipped");
    expect(p.files).toEqual([]);
  });

  it("does not warn for a script scoped to claude-code", async () => {
    const p = await planFor([{ meta: { type: "script", name: "hello", files: ["hello.ps1"], targets: ["claude-code"] }, files: { "hello.ps1": "x\n" } }]);
    expect(p.warnings.filter((w) => w.startsWith("kiro: script"))).toEqual([]);
  });

  it("writes an MCP server exactly as the Forge holds it, Claude-only keys included (spec 07)", async () => {
    const server = { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30 };
    const p = await planFor([{ meta: { type: "mcp", name: "r", server } }]);
    expect(file(p, ".kiro/settings/mcp.json")!.content.toString("utf8")).toBe(JSON.stringify({ mcpServers: { r: server } }, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  });

  it("emits a server with only declared keys, in schema order, byte for byte as 0.2.4 did (AC 18)", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["pw"] } } }]);
    expect(file(p, ".kiro/settings/mcp.json")!.content.toString("utf8")).toBe('{\r\n  "mcpServers": {\r\n    "pw": {\r\n      "command": "npx",\r\n      "args": [\r\n        "pw"\r\n      ]\r\n    }\r\n  }\r\n}\r\n');
  });

  it("emits an MCP variant under its original server name", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "srv--acme", as: "srv", server: { command: "npx", args: ["acme-server"] } } }]);
    const f = file(p, ".kiro/settings/mcp.json")!;
    expect(f.content.toString("utf8")).toBe(JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  });

  it("warns when two MCP ingredients emit the same server name, instead of dropping one silently", async () => {
    const p = await planFor([
      { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["public-server"] } } },
      { meta: { type: "mcp", name: "srv--acme", as: "srv", server: { command: "npx", args: ["acme-server"] } } },
    ]);
    expect(p.warnings).toContain('kiro: two ingredients write the MCP server "srv" into .kiro/settings/mcp.json: mcp/srv and mcp/srv--acme (last wins)');
    expect(JSON.parse(file(p, ".kiro/settings/mcp.json")!.content.toString("utf8")).mcpServers).toEqual({ srv: { command: "npx", args: ["acme-server"] } });
  });
});

describe("kiro emitter — sections (spec 11 §10.2, AC 2)", () => {
  const SEC = "# T\n<!-- craftar:section s -->\ndefault\n<!-- /craftar:section -->\nsee .claude/rules/r.md\n";
  it("no output holds a marker: steering, rule steering, agent prompt, command, skill; all CRLF", async () => {
    const ingredients: IngredientSpec[] = [
      rule("r", SEC),
      { meta: { type: "steering", name: "st" }, files: { "steering.md": SEC } },
      { meta: { type: "agent", name: "a", description: "An agent" }, files: { "agent.md": SEC } },
      { meta: { type: "command", name: "c", description: "A command" }, files: { "command.md": SEC } },
      { meta: { type: "skill", name: "fs", layout: "file" }, files: { "SKILL.md": SEC } },
      { meta: { type: "skill", name: "ds" }, files: { "SKILL.md": SEC } },
    ];
    const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
    const s = await scenario(
      { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["kiro"], { sections: Object.fromEntries(refs.map((r) => [r, { s: "value" }])) })] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: test-forge\nschema: 2\n" });
    const p = await plan(await loadWorkspace(s.wsRoot));
    const paths = [".kiro/steering/r.md", ".kiro/steering/st.md", ".kiro/agents/a.json", ".kiro/steering/commands/c.md", ".kiro/skills/fs/SKILL.md", ".kiro/skills/ds/SKILL.md"];
    for (const rel of paths) {
      const f = file(p, rel)!;
      const t = f.content.toString("utf8");
      expect(t, rel).not.toContain("craftar:section");
      expect(t, rel).not.toMatch(/(?<!\r)\n/);
      expect(hasBom(f.content), rel).toBe(false);
    }
    expect(file(p, ".kiro/steering/r.md")!.content.toString("utf8")).toContain("# T\r\nvalue\r\nsee .kiro/steering/r.md\r\n");
    expect(JSON.parse(file(p, ".kiro/agents/a.json")!.content.toString("utf8")).prompt).toBe("# T\nvalue\nsee .kiro/steering/r.md");
  });
});

describe("kiro emitter — rule references (spec 17)", () => {
  const lf = (p: Plan, rel: string) => file(p, rel)?.content.toString("utf8").replace(/\r\n/g, "\n");
  const kw = (p: Plan) => p.warnings.filter((w) => w.startsWith("kiro:"));
  const HUB = [
    "# hub", "",
    "- backticks: see `.claude/rules/style.md` and `.claude/rules/api.md`.",
    "- link: [the md-only rule](.claude/rules/md-only.md).",
    "- bare: .claude/rules/cc-only.md and .claude/rules/kiro-only.md",
    "- unknown name: `.claude/rules/handwritten.md`",
    "- pattern: `.claude/rules/<archetype>.md` and `.claude/rules/*.md`",
    "- not a rule: `.claude/agents/reviewer.md`, `.claude/commands/open-pr.md`", "",
  ].join("\n");
  const LINE = "cites `.claude/rules/style.md` (kiro writes), `.claude/rules/cc-only.md` (kiro does not), `.claude/rules/handwritten.md` (no rule), `.claude/rules/product.md` (steering), `.claude/rules/*.md` (pattern), `.claude/agents/reviewer.md`.";
  const LINE_K = "cites `.kiro/steering/style.md` (kiro writes), `cc-only (rule not in this workspace)` (kiro does not), `.kiro/steering/handwritten.md` (no rule), `.kiro/steering/product.md` (steering), `.kiro/steering/*.md` (pattern), `.claude/agents/reviewer.md`.";
  const LINE_KC = LINE_K.replace("`cc-only (rule not in this workspace)`", "`.claude/rules/cc-only.md`");
  const forge17 = (): IngredientSpec[] => [
    rule("hub", HUB),
    rule("style", "# style\n"),
    rule("api", "# api\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" }),
    rule("kiro-only", "# kiro-only\n", { inclusion: "fileMatch", fileMatchPattern: "projects/k/**", targets: ["kiro", "agents-md"] }),
    rule("md-only", "# md-only\n", { inclusion: "fileMatch", fileMatchPattern: "projects/m/**", targets: ["agents-md"] }),
    rule("cc-only", "# cc-only\n", { targets: ["claude-code"] }),
    { meta: { type: "agent", name: "reviewer", description: "Reviews per .claude/rules/cc-only.md" }, files: { "agent.md": `Agent ${LINE}\n` } },
    { meta: { type: "command", name: "open-pr", description: "Opens per .claude/rules/cc-only.md" }, files: { "command.md": `Command ${LINE}\n` } },
    { meta: { type: "skill", name: "howto" }, files: { "SKILL.md": `Skill ${LINE}\n` } },
    { meta: { type: "steering", name: "product" }, files: { "steering.md": `Steering ${LINE}\n` } },
  ];
  const hubFile = (list: string[]) =>
    ["---", "inclusion: always", "---", "", "<!-- GENERATED from .claude/rules/hub.md by craftar -- do not edit. -->", "", "# hub", "", ...list, ""].join("\n");
  const TODAY = {
    backticks: "- backticks: see `.kiro/steering/style.md` and `.kiro/steering/api.md`.",
    unknown: "- unknown name: `.kiro/steering/handwritten.md`",
    pattern: "- pattern: `.kiro/steering/<archetype>.md` and `.kiro/steering/*.md`",
    notRule: "- not a rule: `.claude/agents/reviewer.md`, `.claude/commands/open-pr.md`",
  };
  const DEAD_LINK = "- link: the md-only rule (md-only, rule not in this workspace).";
  const HANDWRITTEN = ["rule/hub", "agent/reviewer", "command/open-pr", "skill/howto"].map((c) => `.claude/rules/handwritten.md (in ${c})`).join(", ");
  const W1 =
    "kiro: 5 reference(s) to rule files this workspace does not have — reworded: .claude/rules/md-only.md (in rule/hub; rule/md-only reaches no target here), .claude/rules/cc-only.md (in rule/hub; rule/cc-only reaches no target here), .claude/rules/cc-only.md (in agent/reviewer; rule/cc-only reaches no target here), .claude/rules/cc-only.md (in command/open-pr; rule/cc-only reaches no target here), .claude/rules/cc-only.md (in skill/howto; rule/cc-only reaches no target here); 4 reference(s) to names that are no rule or steering here — rewritten to .kiro/steering/ as before: " +
    HANDWRITTEN;

  it("kiro only: §4.4's first block and §4.5's warning (spec 17 test 1)", async () => {
    const p = await planFor(forge17());
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile([TODAY.backticks, DEAD_LINK, "- bare: cc-only (rule not in this workspace) and .kiro/steering/kiro-only.md", TODAY.unknown, TODAY.pattern, TODAY.notRule]));
    expect(kw(p)).toEqual([W1]);
  });

  it("claude-code + kiro: a rule claude-code writes keeps its .claude/rules/ path (spec 17 test 2)", async () => {
    const p = await planFor(forge17(), {}, ["claude-code", "kiro"]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile([TODAY.backticks, DEAD_LINK, "- bare: .claude/rules/cc-only.md and .kiro/steering/kiro-only.md", TODAY.unknown, TODAY.pattern, TODAY.notRule]));
    expect(kw(p)).toEqual([
      "kiro: 1 reference(s) to rule files this workspace does not have — reworded: .claude/rules/md-only.md (in rule/hub; rule/md-only reaches no target here); 4 reference(s) to names that are no rule or steering here — rewritten to .kiro/steering/ as before: " + HANDWRITTEN,
    ]);
  });

  it("kiro + agents-md: a rule only AGENTS.md holds points there (spec 17 test 3)", async () => {
    const p = await planFor(forge17(), {}, ["kiro", "agents-md"]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile([TODAY.backticks, "- link: [the md-only rule](AGENTS.md).", "- bare: cc-only (rule not in this workspace) and .kiro/steering/kiro-only.md", TODAY.unknown, TODAY.pattern, TODAY.notRule]));
  });

  it("agent prompt, command body and skill file are resolved the same way (spec 17 test 4)", async () => {
    const k = await planFor(forge17());
    expect(JSON.parse(lf(k, ".kiro/agents/reviewer.json")!).prompt).toBe(`Agent ${LINE_K}`);
    expect(lf(k, ".kiro/steering/commands/open-pr.md")).toBe(`---\ninclusion: manual\n---\n\n---\ndescription: Opens per cc-only (rule not in this workspace)\n---\nCommand ${LINE_K}\n`);
    expect(lf(k, ".kiro/skills/howto/SKILL.md")).toBe(`Skill ${LINE_K}\n`);
    const kc = await planFor(forge17(), {}, ["claude-code", "kiro"]);
    expect(JSON.parse(lf(kc, ".kiro/agents/reviewer.json")!).prompt).toBe(`Agent ${LINE_KC}`);
    expect(lf(kc, ".kiro/steering/commands/open-pr.md")).toBe(`---\ninclusion: manual\n---\n\n---\ndescription: Opens per .claude/rules/cc-only.md\n---\nCommand ${LINE_KC}\n`);
    expect(lf(kc, ".kiro/skills/howto/SKILL.md")).toBe(`Skill ${LINE_KC}\n`);
  });

  it("descriptions are resolved; a hand-written command description gets the kiro rewrite too (spec 17 test 5)", async () => {
    const k = await planFor(forge17());
    expect(lf(k, ".kiro/agents/reviewer.json")).toContain('\n  "description": "Reviews per cc-only (rule not in this workspace)",\n');
    expect(lf(k, ".kiro/steering/commands/open-pr.md")).toContain("\ndescription: Opens per cc-only (rule not in this workspace)\n");
    const kc = await planFor(forge17(), {}, ["claude-code", "kiro"]);
    expect(lf(kc, ".kiro/agents/reviewer.json")).toContain('\n  "description": "Reviews per .claude/rules/cc-only.md",\n');
    expect(lf(kc, ".kiro/steering/commands/open-pr.md")).toContain("\ndescription: Opens per .claude/rules/cc-only.md\n");
    const c2 = await planFor([
      rule("style", "# style\n"),
      { meta: { type: "command", name: "c2", description: "Uses .claude/rules/style.md, .claude/rules/nope.md and .claude/rules/*.md" }, files: { "command.md": "C2\n" } },
    ]);
    expect(lf(c2, ".kiro/steering/commands/c2.md")).toContain("\ndescription: Uses .kiro/steering/style.md, .kiro/steering/nope.md and .kiro/steering/*.md\n");
    expect(kw(c2)).toEqual(["kiro: 1 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/nope.md (in command/c2)"]);
  });

  it("a Forge of the shape import produces keeps every kiro byte (spec 17 test 6)", async () => {
    const p = await planFor(
      [
        rule("hub", "# hub\n\nsee `.claude/rules/style.md`, [api](.claude/rules/api.md), .claude/rules/product.md and `.claude/rules/*.md`\n"),
        rule("style", "# style\n"),
        rule("api", "# api\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" }),
        { meta: { type: "steering", name: "product" }, files: { "steering.md": "# product\n" } },
      ],
      {},
      ["claude-code", "kiro"],
    );
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["see `.kiro/steering/style.md`, [api](.kiro/steering/api.md), .kiro/steering/product.md and `.kiro/steering/*.md`"]));
    expect(kw(p)).toEqual([]);
  });

  it("patterns and non-references keep the directory rewrite (spec 17 test 7)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n.claude/rules/*.md .claude/rules/<archetype>.md projects/web/.claude/rules/style.md .claude/rules/style.md.bak\n"), rule("style", "# style\n")]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile([".kiro/steering/*.md .kiro/steering/<archetype>.md projects/web/.kiro/steering/style.md .kiro/steering/style.md.bak"]));
    expect(kw(p)).toEqual([]);
  });

  it("an agent's resources do not move, while its prompt is resolved (spec 17 test 8)", async () => {
    const p = await planFor([
      rule("backend-api", "# backend-api\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**", targets: ["claude-code"] }),
      { meta: { type: "agent", name: "backend-reviewer" }, files: { "agent.md": "Follow .claude/rules/backend-api.md.\n" } },
    ]);
    const json = JSON.parse(lf(p, ".kiro/agents/backend-reviewer.json")!);
    expect(json.resources).toEqual(["file://.kiro/steering/backend-api.md"]);
    expect(json.prompt).toBe("Follow backend-api (rule not in this workspace).");
  });

  it("an unknown name alone gives the second form (spec 17 test 9)", async () => {
    const p = await planFor([rule("hub", "# hub\n\nSee .claude/rules/handwritten.md.\n")]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["See .kiro/steering/handwritten.md."]));
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/handwritten.md (in rule/hub)"]);
  });

  it("a steering body is emitted as written and reports nothing (spec 17 test 10)", async () => {
    const p = await planFor([{ meta: { type: "steering", name: "product" }, files: { "steering.md": `Steering ${LINE}\n` } }, rule("style", "# style\n")]);
    expect(lf(p, ".kiro/steering/product.md")).toBe(`Steering ${LINE}\n`);
    expect(kw(p)).toEqual([]);
  });

  it("a raw frontmatter block is resolved (spec 17 test 11)", async () => {
    const p = await planFor([
      rule("cc-only", "# cc-only\n", { targets: ["claude-code"] }),
      { meta: { type: "command", name: "raw", frontmatterRaw: "description: Uses .claude/rules/cc-only.md" }, files: { "command.md": "Raw\n" } },
    ]);
    expect(lf(p, ".kiro/steering/commands/raw.md")).toContain("description: Uses cc-only (rule not in this workspace)");
  });

  it("K3 as a token (spec 17 test 12)", async () => {
    const p = await planFor([rule("hub", "# hub\n\nSee `.claude/rules/md-only.md`.\n"), rule("md-only", "# md-only\n", { inclusion: "manual", targets: ["agents-md"] })], {}, ["kiro", "agents-md"]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["See `AGENTS.md (rule: md-only)`."]));
  });

  it("K2 as a link is left as the Forge wrote it (spec 17 test 13)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n[the rule](.claude/rules/cc-only.md)\n"), rule("cc-only", "# cc-only\n", { targets: ["claude-code"] })], {}, ["claude-code", "kiro"]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["[the rule](.claude/rules/cc-only.md)"]));
    expect(kw(p)).toEqual([]);
  });

  it("a dead reference alone gives the first form (spec 17 test 14)", async () => {
    const p = await planFor([rule("hub", "# hub\n\nSee .claude/rules/cc-only.md.\n"), rule("cc-only", "# cc-only\n", { targets: ["claude-code"] })]);
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to rule files this workspace does not have — reworded: .claude/rules/cc-only.md (in rule/hub; rule/cc-only reaches no target here)"]);
  });

  it("fragments: kept in K1, dropped in K3 (spec 17 test 15)", async () => {
    const p = await planFor(
      [rule("hub", "# hub\n\n[t](.claude/rules/style.md#part) [u](.claude/rules/md-only.md#part)\n"), rule("style", "# style\n"), rule("md-only", "# md-only\n", { inclusion: "manual", targets: ["agents-md"] })],
      {},
      ["kiro", "agents-md"],
    );
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["[t](.kiro/steering/style.md#part) [u](AGENTS.md)"]));
  });

  it("entries follow the order of each ingredient's texts (spec 17 test 16)", async () => {
    const p = await planFor([
      rule("md-only", "# md-only\n", { inclusion: "manual", targets: ["agents-md"] }),
      rule("cc-only", "# cc-only\n", { targets: ["claude-code"] }),
      { meta: { type: "agent", name: "a1", description: "Per .claude/rules/md-only.md" }, files: { "agent.md": "Per .claude/rules/cc-only.md\n" } },
      { meta: { type: "command", name: "c1", description: "Per .claude/rules/cc-only.md" }, files: { "command.md": "Per .claude/rules/md-only.md\n" } },
    ]);
    const e = (x: string, c: string) => `.claude/rules/${x}.md (in ${c}; rule/${x} reaches no target here)`;
    expect(kw(p)).toEqual([`kiro: 4 reference(s) to rule files this workspace does not have — reworded: ${[e("md-only", "agent/a1"), e("cc-only", "agent/a1"), e("cc-only", "command/c1"), e("md-only", "command/c1")].join(", ")}`]);
  });

  it("a skill's other text files are resolved; one entry per skill (spec 17 test 17)", async () => {
    const p = await planFor([
      rule("cc-only", "# cc-only\n", { targets: ["claude-code"] }),
      { meta: { type: "skill", name: "s1" }, files: { "SKILL.md": "See .claude/rules/cc-only.md.\n", "notes.md": "See .claude/rules/cc-only.md.\n" } },
    ]);
    expect(lf(p, ".kiro/skills/s1/SKILL.md")).toBe("See cc-only (rule not in this workspace).\n");
    expect(lf(p, ".kiro/skills/s1/notes.md")).toBe("See cc-only (rule not in this workspace).\n");
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to rule files this workspace does not have — reworded: .claude/rules/cc-only.md (in skill/s1; rule/cc-only reaches no target here)"]);
  });
});