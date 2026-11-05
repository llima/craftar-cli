import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { hasBom, hashNormalized, toCrlf } from "../../src/core/text.js";
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
  it("emits an always rule as LF steering with the default banner and no BOM", async () => {
    const p = await planFor([rule("a", "# A\n")]);
    const f = file(p, ".kiro/steering/a.md")!;
    expect(f.content.toString("utf8")).toBe("---\ninclusion: always\n---\n\n<!-- GENERATED from .claude/rules/a.md by craftar -- do not edit. -->\n\n# A\n");
    expect(hasBom(f.content)).toBe(false);
  });

  it("uses the kiro.banner param", async () => {
    const p = await planFor([rule("a", "# A\n")], { params: { "kiro.banner": "<!-- X from {{source}} -->" } });
    expect(file(p, ".kiro/steering/a.md")!.content.toString("utf8")).toContain("<!-- X from .claude/rules/a.md -->");
  });

  it("writes fileMatch frontmatter", async () => {
    const p = await planFor([rule("b", "# B\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" })]);
    expect(file(p, ".kiro/steering/b.md")!.content.toString("utf8")).toMatch(/^---\ninclusion: fileMatch\nfileMatchPattern: "projects\/api\/\*\*"\n---\n\n/);
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
    expect(file(p, ".kiro/settings/mcp.json")!.content.toString("utf8")).toBe(JSON.stringify({ mcpServers: { r: server } }, null, 2) + "\n");
  });

  it("emits a server with only declared keys, in schema order, byte for byte as 0.2.4 did (AC 18)", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["pw"] } } }]);
    expect(file(p, ".kiro/settings/mcp.json")!.content.toString("utf8")).toBe('{\n  "mcpServers": {\n    "pw": {\n      "command": "npx",\n      "args": [\n        "pw"\n      ]\n    }\n  }\n}\n');
  });

  it("emits an MCP variant under its original server name", async () => {
    const p = await planFor([{ meta: { type: "mcp", name: "srv--acme", as: "srv", server: { command: "npx", args: ["acme-server"] } } }]);
    const f = file(p, ".kiro/settings/mcp.json")!;
    expect(f.content.toString("utf8")).toBe(JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }, null, 2) + "\n");
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
  it("no output holds a marker: steering, rule steering, agent prompt, command, skill; all LF when new", async () => {
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
      // New files are LF (spec 57)
      expect(t, rel).not.toContain("\r");
      expect(hasBom(f.content), rel).toBe(false);
    }
    expect(file(p, ".kiro/steering/r.md")!.content.toString("utf8")).toContain("# T\nvalue\nsee .kiro/steering/r.md\n");
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

  it("a raw frontmatter block wins: the unused description is neither emitted nor reported (spec 17 §4.5, review fix)", async () => {
    const p = await planFor([
      { meta: { type: "command", name: "raw2", description: "per .claude/rules/q-dead.md", frontmatterRaw: "argument-hint: per .claude/rules/z-dead.md\ndescription: per .claude/rules/a-dead.md" }, files: { "command.md": "Raw\n" } },
    ]);
    expect(lf(p, ".kiro/steering/commands/raw2.md")).toBe("---\ninclusion: manual\n---\n\n---\nargument-hint: per .kiro/steering/z-dead.md\ndescription: per .kiro/steering/a-dead.md\n---\nRaw\n");
    expect(kw(p)).toEqual([
      "kiro: 2 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/z-dead.md (in command/raw2), .claude/rules/a-dead.md (in command/raw2)",
    ]);
  });

  it("a link fragment keeps the directory rewrite, as on 0.8.4 (spec 17 §4.3, review fix)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n[t](.claude/rules/style.md#see-.claude/rules/z) [u](.claude/rules/nope.md#see-.claude/rules/z)\n"), rule("style", "# style\n")]);
    expect(lf(p, ".kiro/steering/hub.md")).toBe(hubFile(["[t](.kiro/steering/style.md#see-.kiro/steering/z) [u](.kiro/steering/nope.md#see-.kiro/steering/z)"]));
  });
});

describe("kiro agent permissions", () => {
  const R = (c: string) => ({ capability: c, effect: "allow" });
  const FALLBACK = { capability: "fs_read", match: ["./**"], effect: "allow" };
  const MCP = (...m: string[]) => ({ capability: "mcp", match: m, effect: "allow" });
  const kw = (p: Plan) => p.warnings.filter((w) => w.startsWith("kiro:"));

  it("tools [Read,Grep,Glob,Bash] → [fs_read, shell, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Grep", "Glob", "Bash"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("shell"), R("skill")]);
  });

  it("tools [Read,Grep,Glob,Bash,Write] → [fs_read, fs_write, shell, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Grep", "Glob", "Bash", "Write"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("fs_write"), R("shell"), R("skill")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [Bash,Write,Read] → [fs_read, fs_write, shell, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Bash", "Write", "Read"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("fs_write"), R("shell"), R("skill")]);
  });

  it("tools [read,web_fetch] → [fs_read, web_fetch, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["read", "web_fetch"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("web_fetch"), R("skill")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [Grep] → [fs_read]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Grep"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read")]);
  });

  it("tools [Glob,Grep] → [fs_read]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Glob", "Grep"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read")]);
  });

  it("tools [Bash] → [shell, FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Bash"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("shell"), FALLBACK]);
  });

  it("tools [Edit] → [fs_write, FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Edit"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_write"), FALLBACK]);
  });

  it("tools [WebSearch] → [web_search, FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["WebSearch"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("web_search"), FALLBACK]);
  });

  it("tools [] → [FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: [] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([FALLBACK]);
  });

  it("tools [Write,WebFetch,WebSearch,todo_list,use_aws] → [fs_write, web_fetch, web_search, FALLBACK] with warnings", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Write", "WebFetch", "WebSearch", "todo_list", "use_aws"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_write"), R("web_fetch"), R("web_search"), FALLBACK]);
    expect(json.tools).toEqual(["write", "web_fetch", "web_search", "todo_list", "use_aws"]);
    expect(kw(p)).toContain('kiro: agent "rev": tool "todo_list" has no Kiro permission capability; no rule written');
    expect(kw(p)).toContain('kiro: agent "rev": tool "use_aws" has no Kiro permission capability; no rule written');
  });

  it("tools [Read,mcp__acme__search] → [fs_read, skill] with warning for mcp__acme__search", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "mcp__acme__search"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("skill")]);
    expect(json.tools).toContain("mcp__acme__search");
    expect(kw(p)).toContain('kiro: agent "rev": tool "mcp__acme__search" has no Kiro permission capability; no rule written');
  });

  it("duplicate tools [Read,Read,read] → [fs_read, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Read", "read"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("skill")]);
  });

  it("full file round-trip for tools [Read,Grep,Glob,Bash]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["Read", "Grep", "Glob", "Bash"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const f = file(p, ".kiro/agents/rev.json")!;
    const content = f.content.toString("utf8");
    const json = JSON.parse(content);

    // Check key order
    expect(Object.keys(json)).toEqual(["name", "description", "prompt", "tools", "allowedTools", "resources", "permissions"]);

    // New files are LF (spec 57 — no CR)
    expect(content).not.toContain("\r");

    // Check no BOM
    expect(hasBom(f.content)).toBe(false);

    // Check no kiroUpgrade
    expect(content).not.toContain("kiroUpgrade");

    // Build expected content from parsed values and compare (LF for new files)
    const { name, description, prompt, tools, allowedTools, resources, permissions } = json;
    const expected = JSON.stringify({ name, description, prompt, tools, allowedTools, resources, permissions }, null, 2) + "\n";
    expect(content).toBe(expected);
  });

  // Kiro's own tool names
  it("tools [fs_read] → [fs_read, skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["fs_read"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("skill")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [execute_bash,fs_write] → [fs_write, shell, FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["execute_bash", "fs_write"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_write"), R("shell"), FALLBACK]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  // Wildcard *
  it("tools [*] → [all]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["*"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("all")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [*,read] → [all]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["*", "read"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("all")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  // @server tools
  it("tools [@acme] → [mcp(acme/*), FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["@acme"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([MCP("acme/*"), FALLBACK]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [@acme/search] → [mcp(acme/search), FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["@acme/search"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([MCP("acme/search"), FALLBACK]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [web_search,@acme,read,shell] → [fs_read, shell, web_search, mcp(acme/*), skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["web_search", "@acme", "read", "shell"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), R("shell"), R("web_search"), MCP("acme/*"), R("skill")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [@zeta,read,@alpha] → [fs_read, mcp(alpha/*, zeta/*), skill]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["@zeta", "read", "@alpha"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([R("fs_read"), MCP("alpha/*", "zeta/*"), R("skill")]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [@acme,@acme] → [mcp(acme/*), FALLBACK]", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["@acme", "@acme"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([MCP("acme/*"), FALLBACK]);
    expect(kw(p).filter((w) => w.includes("permission capability"))).toEqual([]);
  });

  it("tools [web] → [FALLBACK] with warning", async () => {
    const p = await planFor([{ meta: { type: "agent", name: "rev", description: "Reviews.", tools: ["web"] }, files: { "agent.md": "\n# Rev\n" } }]);
    const json = JSON.parse(file(p, ".kiro/agents/rev.json")!.content.toString("utf8"));
    expect(json.permissions.rules).toEqual([FALLBACK]);
    expect(kw(p)).toContain('kiro: agent "rev": tool "web" has no Kiro permission capability; no rule written');
  });
});

describe("kiro emitter — references inside link text (spec 20)", () => {
  const LINES = [
    "1 [`.claude/rules/cc.md`](.claude/rules/cc.md)",
    "2 [.claude/rules/cc.md](.claude/rules/cc.md#part)",
    "3 [`.claude/rules/k.md`](.claude/rules/k.md)",
    "4 [see .claude/rules/cc.md](.claude/rules/a.md)",
    "5 [.claude/rules/md.md](.claude/rules/md.md)",
    "6 [see .claude/rules/a.md](.claude/rules/cc.md)",
    "7 [see .claude/rules/*.md](.claude/rules/cc.md)",
    "8 [see .claude/rules/cc.md](.claude/rules/cc.md)",
    "9 [.claude/rules/cc.md#part](.claude/rules/cc.md#part)",
    "10 [.claude/rules/zz.md](.claude/rules/zz.md)",
  ];
  const forge20 = (): IngredientSpec[] => [
    rule("hub", "# hub\n\n" + LINES.join("\n") + "\n"),
    rule("a", "# a\n"),
    rule("cc", "# cc\n", { targets: ["claude-code"] }),
    rule("md", "# md\n", { inclusion: "manual", targets: ["agents-md"] }),
    rule("k", "# k\n", { inclusion: "manual", targets: ["kiro", "agents-md"] }),
  ];
  const numbered = (p: Plan) => file(p, ".kiro/steering/hub.md")!.content.toString("utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => /^\d+ /.test(l));
  const kw = (p: Plan) => p.warnings.filter((w) => w.startsWith("kiro:"));
  const D = (x: string) => `${x} (rule not in this workspace)`;

  it("kiro only (spec 20 §4.4)", async () => {
    const p = await planFor(forge20());
    expect(numbered(p)).toEqual([
      "1 `" + D("cc") + "`",
      "2 " + D("cc"),
      "3 [`.kiro/steering/k.md`](.kiro/steering/k.md)",
      "4 [see " + D("cc") + "](.kiro/steering/a.md)",
      "5 " + D("md"),
      "6 see .kiro/steering/a.md (cc, rule not in this workspace)",
      "7 see .kiro/steering/*.md (cc, rule not in this workspace)",
      "8 see " + D("cc") + " (cc, rule not in this workspace)",
      "9 " + D("cc") + "#part (cc, rule not in this workspace)",
      "10 [.kiro/steering/zz.md](.kiro/steering/zz.md)",
    ]);
    expect(kw(p)).toEqual([
      "kiro: 2 reference(s) to rule files this workspace does not have — reworded: .claude/rules/cc.md (in rule/hub; rule/cc reaches no target here), .claude/rules/md.md (in rule/hub; rule/md reaches no target here); 1 reference(s) to names that are no rule or steering here — rewritten to .kiro/steering/ as before: .claude/rules/zz.md (in rule/hub)",
    ]);
  });

  it("claude-code + kiro: a K2 link keeps its non-references, its text references resolve (spec 20 §4.1, Ruling 4)", async () => {
    const p = await planFor(forge20(), {}, ["claude-code", "kiro"]);
    expect(numbered(p)).toEqual([
      "1 [`.claude/rules/cc.md`](.claude/rules/cc.md)",
      "2 [.claude/rules/cc.md](.claude/rules/cc.md#part)",
      "3 [`.kiro/steering/k.md`](.kiro/steering/k.md)",
      "4 [see .claude/rules/cc.md](.kiro/steering/a.md)",
      "5 " + D("md"),
      "6 [see .kiro/steering/a.md](.claude/rules/cc.md)",
      "7 [see .claude/rules/*.md](.claude/rules/cc.md)",
      "8 [see .claude/rules/cc.md](.claude/rules/cc.md)",
      "9 [.claude/rules/cc.md#part](.claude/rules/cc.md#part)",
      "10 [.kiro/steering/zz.md](.kiro/steering/zz.md)",
    ]);
  });

  it("claude-code + kiro + agents-md: K3 text (spec 20 §4.4)", async () => {
    const p = await planFor(forge20(), {}, ["claude-code", "kiro", "agents-md"]);
    expect(numbered(p)[4]).toBe("5 [AGENTS.md (rule: md)](AGENTS.md)");
  });

  it("pin: an imported-shape Forge keeps its kiro bytes and warning (spec 20 §5)", async () => {
    const p = await planFor(
      [rule("hub", "# hub\n\n1 [see .claude/rules/b.md](.claude/rules/a.md)\n2 [`.claude/rules/a.md`](.claude/rules/a.md)\n3 [t](.claude/rules/zz.md)\n"), rule("a", "# a\n"), rule("b", "# b\n")],
      {},
      ["claude-code", "kiro", "agents-md"],
    );
    expect(numbered(p)).toEqual(["1 [see .kiro/steering/b.md](.kiro/steering/a.md)", "2 [`.kiro/steering/a.md`](.kiro/steering/a.md)", "3 [t](.kiro/steering/zz.md)"]);
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/zz.md (in rule/hub)"]);
  });

  it("a reference in a link's text is reported before the link's target (spec 20 §4.3)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n1 [see .claude/rules/yy.md](.claude/rules/zz.md)\n")]);
    expect(numbered(p)).toEqual(["1 [see .kiro/steering/yy.md](.kiro/steering/zz.md)"]);
    expect(kw(p)).toEqual([
      "kiro: 2 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/yy.md (in rule/hub), .claude/rules/zz.md (in rule/hub)",
    ]);
  });

  it("an imported-shape Forge keeps its kiro bytes; an unknown name in link text adds one entry (spec 20 §5)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n1 [see .claude/rules/zz.md](.claude/rules/a.md)\n"), rule("a", "# a\n")], {}, ["claude-code", "kiro", "agents-md"]);
    expect(numbered(p)).toEqual(["1 [see .kiro/steering/zz.md](.kiro/steering/a.md)"]);
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/zz.md (in rule/hub)"]);
  });

  it("an unknown name in the text of a link kept for claude-code is rewritten and reported (spec 20 §4.1)", async () => {
    const p = await planFor([rule("hub", "# hub\n\n1 [see .claude/rules/zz.md](.claude/rules/cc.md)\n"), rule("cc", "# cc\n", { targets: ["claude-code"] })], {}, ["claude-code", "kiro"]);
    expect(numbered(p)).toEqual(["1 [see .kiro/steering/zz.md](.claude/rules/cc.md)"]);
    expect(kw(p)).toEqual(["kiro: 1 reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: .claude/rules/zz.md (in rule/hub)"]);
  });
});


/**
 * Spec 57: Kiro keeps the EOL of the file it replaces — LF when new, existing file's EOL when updating.
 * Tests T1–T6 cover the new textFile(ctx, ..., { keepBom: false }) behaviour.
 */
describe("spec 57: kiro keeps the EOL of the file it replaces", () => {
  const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  // The exact LF bytes each kiro file kind writes into a fresh workspace. T1 asserts these; T2 asserts their
  // CRLF form (toCrlf) when the file on disk is CRLF. One source of truth so the two cannot drift apart.
  const EXPECTED_LF = {
    steering: "---\ninclusion: always\n---\n\n<!-- GENERATED from .claude/rules/a.md by craftar -- do not edit. -->\n\n# A\n",
    agent:
      '{\n  "name": "rev",\n  "description": "Reviews.",\n  "prompt": "# Rev",\n  "tools": [],\n  "allowedTools": [],\n  "resources": [\n    "file://.kiro/steering/**/*.md"\n  ],\n  "permissions": {\n    "rules": [\n      {\n        "capability": "fs_read",\n        "match": [\n          "./**"\n        ],\n        "effect": "allow"\n      }\n    ]\n  }\n}\n',
    command: "---\ninclusion: manual\n---\n\n---\ndescription: A command\n---\n# Cmd\n",
    fileSkill: "# Skill\n",
    dirSkillNotes: "# Notes\n",
    mcp: '{\n  "mcpServers": {\n    "srv": {\n      "command": "npx",\n      "args": [\n        "srv"\n      ]\n    }\n  }\n}\n',
  } as const;

  // Ingredients that produce each expected file, reused by T1 and T2 so both drive the same inputs.
  const agentIngredient: IngredientSpec = { meta: { type: "agent", name: "rev", description: "Reviews." }, files: { "agent.md": "\n# Rev\n" } };
  const mcpIngredient: IngredientSpec = { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["srv"] } } };

  // T1: empty workspace — new files are LF without BOM, exact bytes
  describe("T1: empty workspace writes LF without BOM", () => {
    it("steering file (.kiro/steering/a.md) is the exact LF bytes without BOM", async () => {
      const p = await planFor([rule("a", "# A\n")]);
      const f = file(p, ".kiro/steering/a.md")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.steering);
      expect(hasBom(f.content)).toBe(false);
      expect(f.content[0]).not.toBe(0xef);
    });

    it("agent JSON (.kiro/agents/rev.json) is the exact LF bytes without BOM", async () => {
      const p = await planFor([agentIngredient]);
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.agent);
      expect(hasBom(f.content)).toBe(false);
    });

    it("command mirror (.kiro/steering/commands/c.md) is the exact LF bytes without BOM", async () => {
      const p = await planFor([{ meta: { type: "command", name: "c", description: "A command" }, files: { "command.md": "# Cmd\n" } }]);
      const f = file(p, ".kiro/steering/commands/c.md")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.command);
      expect(hasBom(f.content)).toBe(false);
    });

    it("file skill (.kiro/skills/s/SKILL.md) is the exact LF bytes without BOM", async () => {
      const p = await planFor([{ meta: { type: "skill", name: "s", layout: "file" }, files: { "SKILL.md": "# Skill\n" } }]);
      const f = file(p, ".kiro/skills/s/SKILL.md")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.fileSkill);
      expect(hasBom(f.content)).toBe(false);
    });

    it("directory skill text file (.kiro/skills/d/notes.md) is the exact LF bytes without BOM", async () => {
      const p = await planFor([{ meta: { type: "skill", name: "d" }, files: { "SKILL.md": "# Skill\n", "notes.md": "# Notes\n" } }]);
      const f = file(p, ".kiro/skills/d/notes.md")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.dirSkillNotes);
      expect(hasBom(f.content)).toBe(false);
    });

    it("mcp.json (.kiro/settings/mcp.json) is the exact LF bytes without BOM", async () => {
      const p = await planFor([mcpIngredient]);
      const f = file(p, ".kiro/settings/mcp.json")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.mcp);
      expect(hasBom(f.content)).toBe(false);
    });
  });

  // T2: EOL detection — keeps the existing file's EOL
  describe("T2: keeps existing file's EOL", () => {
    it("CRLF file on disk → the exact T1 LF bytes with every \\n turned into \\r\\n", async () => {
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": "---\r\ninclusion: always\r\n---\r\n\r\nold\r\n" } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      expect(f.content.toString("utf8")).toBe(toCrlf(EXPECTED_LF.steering));
      expect(hasBom(f.content)).toBe(false);
    });

    it("LF file on disk → the exact T1 LF bytes", async () => {
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": "---\ninclusion: always\n---\n\nold\n" } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.steering);
    });

    it("3 CRLF + 1 LF → CRLF (majority wins)", async () => {
      const mixed = "a\r\nb\r\nc\r\nd\n"; // 3 CRLF, 1 LF
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": mixed } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      const text = f.content.toString("utf8");
      // CRLF majority → output is CRLF
      expect(text).not.toMatch(/(?<!\r)\n/);
    });

    it("1 CRLF + 3 LF → LF (majority wins)", async () => {
      const mixed = "a\r\nb\nc\nd\n"; // 1 CRLF, 3 LF
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": mixed } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      const text = f.content.toString("utf8");
      // LF majority → output is LF
      expect(text).not.toContain("\r");
    });

    it("empty existing file → LF", async () => {
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": "" } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      const text = f.content.toString("utf8");
      // Empty file → default to LF
      expect(text).not.toContain("\r");
    });

    it("CRLF agent JSON on disk → the exact T1 LF bytes with every \\n turned into \\r\\n", async () => {
      const s = await scenario(
        { ingredients: [agentIngredient], recipes: [recipe("base", ["agent/rev"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/agents/rev.json": '{\r\n  "name": "old"\r\n}\r\n' } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).toBe(toCrlf(EXPECTED_LF.agent));
      expect(hasBom(f.content)).toBe(false);
    });

    it("LF agent JSON on disk → the exact T1 LF bytes", async () => {
      const s = await scenario(
        { ingredients: [agentIngredient], recipes: [recipe("base", ["agent/rev"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/agents/rev.json": '{\n  "name": "old"\n}\n' } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.agent);
    });

    it("agent JSON 3 CRLF + 1 LF on disk → CRLF (majority wins), the exact T1 LF bytes as CRLF", async () => {
      const s = await scenario(
        { ingredients: [agentIngredient], recipes: [recipe("base", ["agent/rev"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/agents/rev.json": '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3\n}' } }, // 3 CRLF, 1 LF
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).toBe(toCrlf(EXPECTED_LF.agent));
    });

    it("agent JSON 1 CRLF + 3 LF on disk → LF (majority wins), the exact T1 LF bytes", async () => {
      const s = await scenario(
        { ingredients: [agentIngredient], recipes: [recipe("base", ["agent/rev"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/agents/rev.json": '{\r\n  "a": 1,\n  "b": 2,\n  "c": 3\n}' } }, // 1 CRLF, 3 LF
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).toBe(EXPECTED_LF.agent);
    });

    it("CRLF mcp.json on disk → the exact T1 LF bytes with every \\n turned into \\r\\n", async () => {
      const s = await scenario(
        { ingredients: [mcpIngredient], recipes: [recipe("base", ["mcp/srv"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/settings/mcp.json": '{\r\n  "old": true\r\n}\r\n' } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/settings/mcp.json")!;
      expect(f.content.toString("utf8")).toBe(toCrlf(EXPECTED_LF.mcp));
      expect(hasBom(f.content)).toBe(false);
    });
  });

  // T3: BOM is stripped from output even when existing file has BOM
  describe("T3: BOM is stripped from output", () => {
    it("steering file with BOM+CRLF → CRLF without BOM", async () => {
      const withBom = Buffer.concat([UTF8_BOM, Buffer.from("---\r\ninclusion: always\r\n---\r\n\r\nold\r\n")]);
      const s = await scenario(
        { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/steering/a.md": withBom } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/steering/a.md")!;
      // CRLF is kept
      expect(f.content.toString("utf8")).not.toMatch(/(?<!\r)\n/);
      // BOM is NOT in output
      expect(hasBom(f.content)).toBe(false);
      expect(f.content[0]).not.toBe(0xef);
    });

    it("agent JSON with BOM+CRLF → CRLF without BOM", async () => {
      const withBom = Buffer.concat([UTF8_BOM, Buffer.from('{\r\n  "name": "old"\r\n}\r\n')]);
      const s = await scenario(
        { ingredients: [{ meta: { type: "agent", name: "rev", description: "Reviews." }, files: { "agent.md": "\n# Rev\n" } }], recipes: [recipe("base", ["agent/rev"])], profiles: [profile("acme", ["base"], ["kiro"])] },
        { config: { profile: "acme" }, files: { ".kiro/agents/rev.json": withBom } },
      );
      cleanups.push(s.cleanup);
      const p = await plan(await loadWorkspace(s.wsRoot));
      const f = file(p, ".kiro/agents/rev.json")!;
      expect(f.content.toString("utf8")).not.toMatch(/(?<!\r)\n/);
      expect(hasBom(f.content)).toBe(false);
    });
  });

  // T4/T5: sync-level test — editing one rule only writes that rule, EOL preserved
  describe("T4/T5: sync-level — EOL preserved across updates", () => {
    it("CRLF workspace: editing one rule writes only that rule; all files stay CRLF", async () => {
      const s = await scenario(
        {
          ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
          recipes: [recipe("base", ["rule/a", "rule/b"])],
          profiles: [profile("acme", ["base"], ["kiro"])],
        },
        { config: { profile: "acme" } },
      );
      cleanups.push(s.cleanup);

      // First, write CRLF files to disk before the first sync (simulating .gitattributes Windows checkout)
      const { promises: fsPromises } = await import("node:fs");
      await fsPromises.mkdir(path.join(s.wsRoot, ".kiro/steering"), { recursive: true });
      await fsPromises.writeFile(path.join(s.wsRoot, ".kiro/steering/a.md"), "---\r\ninclusion: always\r\n---\r\n\r\n<!-- GENERATED from .claude/rules/a.md by craftar -- do not edit. -->\r\n\r\n# A\r\n");
      await fsPromises.writeFile(path.join(s.wsRoot, ".kiro/steering/b.md"), "---\r\ninclusion: always\r\n---\r\n\r\n<!-- GENERATED from .claude/rules/b.md by craftar -- do not edit. -->\r\n\r\n# B\r\n");

      // Load, plan, get status before first sync to make the lock adopt them
      const { apply, readLock, status } = await import("../../src/core/sync.js");
      const ws1 = await loadWorkspace(s.wsRoot);
      const p1 = await plan(ws1);
      const st1 = await status(ws1, p1, null);
      await apply(ws1, p1, st1);

      // Read lock hashes for files before edit (lock.files is an array of {path, hash, …})
      const lock1 = await readLock(s.wsRoot);
      const lockHash = (lock: Awaited<ReturnType<typeof readLock>>, rel: string) => lock?.files.find((e) => e.path === rel)?.hash;
      const hashB1 = lockHash(lock1, ".kiro/steering/b.md");
      const bytesB1 = await fsPromises.readFile(path.join(s.wsRoot, ".kiro/steering/b.md"));

      // The lock hash is EOL/BOM-normalized, so an untouched file's hash equals hashNormalized of the plan's
      // own (LF) bytes for it — the CRLF on disk and the LF plan hash to the same thing.
      const plannedB1 = p1.files.find((f) => f.path === ".kiro/steering/b.md")!;
      expect(hashB1).toBeDefined();
      expect(hashB1).toBe(hashNormalized(plannedB1.content));

      // Now edit rule A in the Forge
      await fsPromises.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "# A edited\n");

      // Plan and apply again
      const ws2 = await loadWorkspace(s.wsRoot);
      const p2 = await plan(ws2);
      const lock2 = await readLock(s.wsRoot);
      const st2 = await status(ws2, p2, lock2);
      await apply(ws2, p2, st2);

      // Only rule A should be updated
      const updatedPaths = st2.filter((e) => e.state === "update").map((e) => e.path);
      expect(updatedPaths).toContain(".kiro/steering/a.md");
      expect(updatedPaths).not.toContain(".kiro/steering/b.md");

      // Rule A is still CRLF
      const bytesA2 = await fsPromises.readFile(path.join(s.wsRoot, ".kiro/steering/a.md"));
      expect(bytesA2.toString("utf8")).not.toMatch(/(?<!\r)\n/);
      expect(bytesA2.toString("utf8")).toContain("# A edited");

      // Rule B is byte-identical
      const bytesB2 = await fsPromises.readFile(path.join(s.wsRoot, ".kiro/steering/b.md"));
      expect(bytesB2.equals(bytesB1)).toBe(true);

      // Lock hash for B is unchanged
      const lock3 = await readLock(s.wsRoot);
      expect(lockHash(lock3, ".kiro/steering/b.md")).toBe(hashB1);
    });
  });

  // T6: import --prefer-kiro over LF vs CRLF steering gives the same rule text
  describe("T6: import --prefer-kiro normalizes EOL", () => {
    it("LF and CRLF steering files produce the same rule text", async () => {
      const { importClaudeCode } = await import("../../src/importers/claude-code.js");
      const { tmpDir, writeFiles: wf } = await import("../helpers/forge.js");
      const { promises: fsPromises } = await import("node:fs");

      const banner = "<!-- GENERATED from .claude/rules/workflow.md by craftar -- do not edit. -->";
      // A line only the Kiro steering files hold — the .claude/rules/ source does NOT — so finding it in the
      // Forge rule proves --prefer-kiro took the steering text, not the .claude/rules/workflow.md fallback.
      const kiroOnly = "Kiro-only line for spec 57.";
      const body = `# Workflow\n\n${kiroOnly}\n\nSee .kiro/steering/style.md.\n`;
      const steeringLF = `---\ninclusion: always\n---\n\n${banner}\n\n${body}`;
      const steeringCRLF = steeringLF.replace(/\n/g, "\r\n");

      // Setup LF workspace
      const rootLF = await tmpDir("craftar-t6-lf-");
      cleanups.push(() => fsPromises.rm(rootLF, { recursive: true, force: true }));
      const wsLF = path.join(rootLF, "ws");
      const forgeLF = path.join(rootLF, "forge");
      await wf(wsLF, {
        ".claude/rules/workflow.md": "# Workflow\n\nSee .claude/rules/style.md.\n",
        ".claude/rules/style.md": "# Style\n",
        ".kiro/steering/workflow.md": steeringLF,
        ".kiro/steering/style.md": steeringLF.replace("workflow", "style").replace("# Workflow\n\nSee .kiro/steering/style.md.\n", "# Style\n"),
      });
      const rLF = await importClaudeCode({ workspaceRoot: wsLF, forgeRoot: forgeLF, profileName: "acme", preferKiro: ["workflow"] });

      // Setup CRLF workspace
      const rootCRLF = await tmpDir("craftar-t6-crlf-");
      cleanups.push(() => fsPromises.rm(rootCRLF, { recursive: true, force: true }));
      const wsCRLF = path.join(rootCRLF, "ws");
      const forgeCRLF = path.join(rootCRLF, "forge");
      await wf(wsCRLF, {
        ".claude/rules/workflow.md": "# Workflow\n\nSee .claude/rules/style.md.\n",
        ".claude/rules/style.md": "# Style\n",
        ".kiro/steering/workflow.md": steeringCRLF,
        ".kiro/steering/style.md": steeringCRLF.replace("workflow", "style").replace("# Workflow\r\n\r\nSee .kiro/steering/style.md.\r\n", "# Style\r\n"),
      });
      const rCRLF = await importClaudeCode({ workspaceRoot: wsCRLF, forgeRoot: forgeCRLF, profileName: "acme", preferKiro: ["workflow"] });

      // Both should succeed
      expect(rLF.rejected).toEqual([]);
      expect(rCRLF.rejected).toEqual([]);

      // The rule text should be identical
      const ruleLF = await fsPromises.readFile(path.join(forgeLF, "ingredients/rules/workflow/rule.md"), "utf8");
      const ruleCRLF = await fsPromises.readFile(path.join(forgeCRLF, "ingredients/rules/workflow/rule.md"), "utf8");
      // --prefer-kiro took the steering text: the Kiro-only line (absent from .claude/rules/workflow.md) is present in both.
      expect(ruleLF).toContain(kiroOnly);
      expect(ruleCRLF).toContain(kiroOnly);
      expect(ruleLF).toBe(ruleCRLF);
    });
  });
});
