import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

// Tech-debt E32.4 (spec 44 §9, §12 item 4): at the gate, a `{{craftar.rules.index}}` left as written anywhere outside a
// rule or steering body is warned, naming each file once — descriptions, raw frontmatter, scripts, hooks, every skill
// file, services. An MCP server (spec 44 §7 item 16) and a hook's `registration` (open, spec 43 §8) are not.

const T = "{{craftar.rules.index}}";
const LEFT = "is expanded in rule and steering bodies only — left as written in ";

const ingredients: IngredientSpec[] = [
  { meta: { type: "rule", name: "readme", description: "Index" }, files: { "rule.md": `# Rules\n\n${T}\n` } },
  { meta: { type: "rule", name: "scoped", description: "Scoped", frontmatterRaw: `paths:\n  - "src/**"\n${T}\n` }, files: { "rule.md": "# Scoped\n" } },
  { meta: { type: "agent", name: "desc", description: `See ${T}` }, files: { "agent.md": "Help.\n" } },
  { meta: { type: "command", name: "cmd", description: `Run ${T}` }, files: { "command.md": "Do it.\n" } },
  { meta: { type: "command", name: "rawcmd", frontmatterRaw: `description: list ${T}\n` }, files: { "command.md": "Do it.\n" } },
  { meta: { type: "script", name: "run", files: ["run.sh"], targets: ["claude-code"] }, files: { "run.sh": `#!/bin/sh\r\n# ${T}\r\necho\r\n` } },
  { meta: { type: "hook", name: "guard", files: ["guard.sh"], targets: ["claude-code"] }, files: { "guard.sh": `#!/bin/sh\n${T}\n` } },
  {
    meta: { type: "hook", name: "reg", files: ["reg.sh"], targets: ["claude-code"], registration: [{ event: "PreToolUse", command: `echo ${T}` }] },
    files: { "reg.sh": "#!/bin/sh\necho\n" },
  },
  {
    meta: { type: "skill", name: "sk", layout: "dir" },
    files: { "SKILL.md": "---\nname: sk\ndescription: A skill\n---\nBody.\n", "notes.txt": `${T}\n`, "go.sh": `# ${T}\n` },
  },
  { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["x"], env: { LIST: T } } }, files: {} },
  { meta: { type: "service", name: "svc" }, files: { "compose.yaml": `# ${T}\nservices:\n  svc:\n    image: example/svc:1\n` } },
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planned(schema: number) {
  const refs = ingredients.map((i) => `${(i.meta as { type: string }).type}/${(i.meta as { name: string }).name}`);
  const s = await scenario(
    { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  return plan(ws);
}

describe("rules index: a placeholder left outside a body is warned (E32.4)", () => {
  it("at schema 7 one warning names every file that keeps it, each once, and no MCP or settings file", async () => {
    const p = await planned(7);
    const left = p.warnings.filter((w) => w.includes(LEFT));
    expect(left.length).toBe(1);
    const paths = left[0].slice(left[0].indexOf(LEFT) + LEFT.length).split(", ");
    expect(paths).toEqual([
      ".claude/agents/desc.md",
      ".claude/commands/cmd.md",
      ".claude/commands/rawcmd.md",
      ".claude/hooks/guard.sh",
      ".claude/rules/scoped.md",
      ".claude/scripts/run.sh",
      ".claude/skills/sk/go.sh",
      ".claude/skills/sk/notes.txt",
      ".craftar/services/svc/compose.yaml",
      ".kiro/agents/desc.json",
      ".kiro/skills/sk/go.sh",
      ".kiro/skills/sk/notes.txt",
      ".kiro/steering/commands/cmd.md",
      ".kiro/steering/commands/rawcmd.md",
    ]);
    // The rule body was expanded, so its own file is not named.
    expect(paths).not.toContain(".claude/rules/readme.md");
  });

  it("no emitted byte holds the list where the placeholder was left: the files keep it as written", async () => {
    const p = await planned(7);
    const run = p.files.find((f) => f.path === ".claude/scripts/run.sh")!;
    expect(run.content.toString("utf8")).toContain(T);
  });

  it("below the gate the warning is not raised (the literal warning of spec 44 §4.2 is unchanged)", async () => {
    const p = await planned(6);
    expect(p.warnings.filter((w) => w.includes(LEFT))).toEqual([]);
  });
});
