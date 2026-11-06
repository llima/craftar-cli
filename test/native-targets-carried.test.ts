/**
 * The carried skips of spec 61 §6.1 and §9 (criteria 5, 7, 9): with agents-md among the targets an always-on rule with the default
 * targets is left to AGENTS.md by cursor and copilot; with agent-skills, a command with the default targets is left to
 * .agents/skills/ by copilot. Nothing is written twice, nothing is written nowhere, and explain and the orphan reason name the carrier.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, orphanReason, plan, apply, status, readLock } from "../src/core/sync.js";
import { carriedFile } from "../src/core/report.js";
import { profile, recipe, scenario, type IngredientSpec, type Scenario } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const RULES: IngredientSpec[] = [
  { meta: { type: "rule", name: "style", inclusion: "always" }, files: { "rule.md": "Use tabs.\n" } },
  { meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/**" }, files: { "rule.md": "API.\n" } },
  { meta: { type: "rule", name: "tone", inclusion: "always", targets: ["cursor", "copilot"] }, files: { "rule.md": "Be brief.\n" } },
  { meta: { type: "rule", name: "both", inclusion: "always", targets: ["cursor", "agents-md"] }, files: { "rule.md": "Both.\n" } },
];
const COMMANDS: IngredientSpec[] = [
  { meta: { type: "command", name: "review", description: "Review" }, files: { "command.md": "Review it.\n" } },
  { meta: { type: "command", name: "fix", description: "Fix", targets: ["copilot", "agent-skills"] }, files: { "command.md": "Fix it.\n" } },
  { meta: { type: "skill", name: "docs", layout: "dir" }, files: { "SKILL.md": "---\nname: docs\ndescription: Docs\n---\nDocs.\n" } },
];

async function ws(targets: string[], extra: { primary?: boolean; ingredients?: IngredientSpec[] } = {}): Promise<Scenario> {
  const ingredients = extra.ingredients ?? [...RULES, ...COMMANDS];
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const prof = profile("acme", ["base"], targets);
  if (extra.primary) (prof as { params?: Record<string, unknown> }).params = { "agents-md.primary": true };
  const s = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [prof] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
  return s;
}
const planOf = async (s: Scenario) => plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
const paths = (p: Awaited<ReturnType<typeof plan>>) => p.files.map((f) => f.path).sort();

describe("spec 61 §6.1 — always-on rules left to AGENTS.md", () => {
  it("[cursor, agents-md]: style only in AGENTS.md; api, tone and both in .cursor/rules/; both also in AGENTS.md", async () => {
    const p = await planOf(await ws(["cursor", "agents-md"]));
    expect(paths(p).filter((x) => x.startsWith(".cursor/rules/"))).toEqual([".cursor/rules/api.mdc", ".cursor/rules/both.mdc", ".cursor/rules/tone.mdc"]);
    const agents = p.files.find((f) => f.path === "AGENTS.md")!.content.toString("utf8");
    expect(agents).toContain("Use tabs.");
    expect(agents).toContain("Both.");
    expect(agents).not.toContain("Be brief.");
    expect(p.carried).toEqual([{ path: ".cursor/rules/style.mdc", ingredient: "rule/style", writtenTo: "AGENTS.md" }]);
  });

  it("[cursor]: with no agents-md, style is written to .cursor/rules/ with alwaysApply: true", async () => {
    const p = await planOf(await ws(["cursor"]));
    expect(p.files.find((f) => f.path === ".cursor/rules/style.mdc")!.content.toString("utf8")).toBe("---\nalwaysApply: true\n---\n\nUse tabs.\n");
    expect(p.carried).toEqual([]);
  });

  it("[copilot, agents-md]: copilot-instructions.md holds tone only; style is in AGENTS.md alone", async () => {
    const p = await planOf(await ws(["copilot", "agents-md"]));
    expect(p.files.find((f) => f.path === ".github/copilot-instructions.md")!.content.toString("utf8")).toBe("Be brief.\n");
    expect(p.files.find((f) => f.path === "AGENTS.md")!.content.toString("utf8")).toContain("Use tabs.");
  });

  it("[copilot, agents-md] with only default always-on rules: no copilot-instructions.md, carried to AGENTS.md", async () => {
    const p = await planOf(await ws(["copilot", "agents-md"], { ingredients: [RULES[0]] }));
    expect(paths(p)).toEqual(["AGENTS.md"]);
    expect(p.carried).toEqual([{ path: ".github/copilot-instructions.md", ingredient: "rule/*", writtenTo: "AGENTS.md" }]);
  });
});

describe("spec 61 §9 — commands left to .agents/skills/", () => {
  it("[copilot, agent-skills]: review only as a skill; fix (listed for copilot) keeps its prompt file and is a skill too", async () => {
    const p = await planOf(await ws(["copilot", "agent-skills"]));
    expect(paths(p).filter((x) => x.startsWith(".github/prompts/"))).toEqual([".github/prompts/fix.prompt.md"]);
    expect(paths(p)).toContain(".agents/skills/review/SKILL.md");
    expect(paths(p)).toContain(".agents/skills/fix/SKILL.md");
    expect(p.carried).toContainEqual({ path: ".github/prompts/review.prompt.md", ingredient: "command/review", writtenTo: ".agents/skills/" });
  });

  it("[copilot]: with no agent-skills, review keeps its prompt file", async () => {
    const p = await planOf(await ws(["copilot"]));
    expect(paths(p).filter((x) => x.startsWith(".github/prompts/"))).toEqual([".github/prompts/fix.prompt.md", ".github/prompts/review.prompt.md"]);
  });
});

describe("spec 61 §6.1 — the \"through X\" cells warn only without their carrier", () => {
  it("[cursor, copilot]: the skill and cursor's commands are warned", async () => {
    const p = await planOf(await ws(["cursor", "copilot"]));
    expect(p.warnings).toContain("cursor: 1 command ingredient(s) have no Cursor equivalent — skipped: command/review");
    expect(p.warnings).toContain("cursor: 1 skill ingredient(s) have no Cursor equivalent — skipped: skill/docs");
    expect(p.warnings).toContain("copilot: 1 skill ingredient(s) have no Copilot equivalent — skipped: skill/docs");
  });

  it("[cursor, copilot, agent-skills]: nothing is said for them", async () => {
    const p = await planOf(await ws(["cursor", "copilot", "agent-skills"]));
    expect(p.warnings.filter((w) => /^(cursor|copilot): .* (command|skill) ingredient\(s\)/.test(w))).toEqual([]);
  });
});

describe("spec 61 §6.1 — explain and the orphan reason name the carrier (criterion 9)", () => {
  it("explain .cursor/rules/style.mdc exits 0 naming AGENTS.md; carriedFile answers {path, writtenTo, ingredient}", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(["cursor", "agents-md"]);
    const p = await planOf(s);
    expect(carriedFile(p, ".cursor/rules/style.mdc")).toEqual({ path: ".cursor/rules/style.mdc", writtenTo: "AGENTS.md", ingredient: "rule/style" });
    expect(carriedFile(p, ".cursor/rules/nope.mdc")).toBeNull();
    const r = runCli(["explain", ".cursor/rules/style.mdc", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("written to  AGENTS.md");
    expect(r.stdout).toContain("ingredient  rule/style");
    const none = runCli(["explain", ".cursor/rules/nope.mdc", "--workspace", s.wsRoot]);
    expect(none.code).toBe(1);
  });

  it("a [cursor] workspace that adds agents-md: .cursor/rules/style.mdc is an orphan written to AGENTS.md only", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(["cursor"]);
    let w = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    let p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(w.root)), {});
    const cfg = YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8"));
    cfg.targets = ["cursor", "agents-md"];
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify(cfg));
    w = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    expect(st.find((x) => x.path === ".cursor/rules/style.mdc")!.state).toBe("orphan");
    expect(orphanReason(p, st, ".cursor/rules/style.mdc")).toBe("orphan: written to AGENTS.md only");
    const d = runCli(["diff", ".cursor/rules/style.mdc", "--workspace", s.wsRoot]);
    expect(d.stdout).toContain("(forge: written to AGENTS.md only — sync removes it)");
  });

  it("under agents-md.primary, a .claude/rules/ orphan keeps the primary wording; the cursor file names AGENTS.md", async () => {
    const p = await planOf(await ws(["claude-code", "cursor", "agents-md"], { primary: true, ingredients: [RULES[0]] }));
    expect(paths(p)).toEqual(["AGENTS.md"]);
    expect(p.carried).toEqual([{ path: ".cursor/rules/style.mdc", ingredient: "rule/style", writtenTo: "AGENTS.md" }]);
  });
});

describe("spec 61 §6.1 — edge-14 depends on the workspace's targets", () => {
  const marked: IngredientSpec = {
    meta: { type: "rule", name: "style", inclusion: "always" },
    files: { "rule.md": "Intro.\n<!-- craftar:section tone targets=cursor -->\nTabs.\n<!-- /craftar:section -->\n" },
  };
  it("[cursor, agents-md]: a section marked targets=cursor in a rule left to AGENTS.md warns", async () => {
    const p = await planOf(await ws(["cursor", "agents-md"], { ingredients: [marked] }));
    expect(p.warnings.some((w) => w.includes("section tone reaches no target that writes rule/style"))).toBe(true);
  });
  it("[cursor]: the same Forge does not warn", async () => {
    const p = await planOf(await ws(["cursor"], { ingredients: [marked] }));
    expect(p.warnings.some((w) => w.includes("section tone reaches no target"))).toBe(false);
  });
});
