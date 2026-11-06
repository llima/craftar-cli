/**
 * Spec 61 §10, criterion 6: a `.claude/rules/<x>.md` reference in a body a new target writes names the file that target writes for the
 * rule, else claude-code's, else the rule's place in AGENTS.md, else `<x> (rule not in this workspace)` with the target's one warning;
 * and the rules index is expanded in a new target's rule bodies with that target's names.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planned(targets: string[], ingredients: IngredientSpec[]) {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 15 }));
  const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
  const text = (rel: string) => p.files.find((f) => f.path === rel)!.content.toString("utf8");
  return { p, text };
}

const api = (body: string): IngredientSpec => ({ meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/**" }, files: { "rule.md": body } });
const style = (targets?: string[]): IngredientSpec => ({ meta: { type: "rule", name: "style", inclusion: "always", ...(targets ? { targets } : {}) }, files: { "rule.md": "Use tabs.\n" } });

describe("spec 61 §10 — references in cursor bodies", () => {
  it("[cursor]: a reference to a rule cursor writes names its .mdc, as a token and as a link", async () => {
    const { text } = await planned(["cursor"], [api("See .claude/rules/style.md and [Style](.claude/rules/style.md).\n"), style()]);
    expect(text(".cursor/rules/api.mdc")).toBe('---\nglobs: "src/**"\nalwaysApply: false\n---\n\nSee .cursor/rules/style.mdc and [Style](.cursor/rules/style.mdc).\n');
  });

  it("[cursor, claude-code]: a rule only claude-code writes keeps its .claude/rules/ path", async () => {
    const { text } = await planned(["cursor", "claude-code"], [api("See .claude/rules/style.md.\n"), style(["claude-code"])]);
    expect(text(".cursor/rules/api.mdc")).toContain("See .claude/rules/style.md.");
  });

  it("[cursor, agents-md]: a rule left to AGENTS.md is named by its place there", async () => {
    const { text } = await planned(["cursor", "agents-md"], [api("See .claude/rules/style.md.\n"), style()]);
    expect(text(".cursor/rules/api.mdc")).toContain("See AGENTS.md (rule: style).");
  });

  it("[cursor]: a name that is no rule is reworded and warned once", async () => {
    const { p, text } = await planned(["cursor"], [api("See .claude/rules/nope.md.\n")]);
    expect(text(".cursor/rules/api.mdc")).toContain("See nope (rule not in this workspace).");
    expect(p.warnings).toContain("cursor: 1 reference(s) to rule files this workspace does not have — reworded: .claude/rules/nope.md (in rule/api; no such rule)");
  });

  it("an agent body is resolved too", async () => {
    const helper: IngredientSpec = { meta: { type: "agent", name: "helper", description: "Helps" }, files: { "agent.md": "Read .claude/rules/style.md.\n" } };
    const { text } = await planned(["cursor"], [helper, style()]);
    expect(text(".cursor/agents/helper.md")).toContain("Read .cursor/rules/style.mdc.");
  });
});

describe("spec 61 §10 — references in copilot bodies", () => {
  it("[copilot]: an always-on rule is named by the aggregate; a manual rule copilot does not write is not in this workspace", async () => {
    const release: IngredientSpec = { meta: { type: "rule", name: "release", inclusion: "manual" }, files: { "rule.md": "Release.\n" } };
    const { text } = await planned(["copilot"], [api("See .claude/rules/style.md and .claude/rules/release.md.\n"), style(), release]);
    expect(text(".github/instructions/api.instructions.md")).toContain("See .github/copilot-instructions.md and release (rule not in this workspace).");
  });

  it("[copilot]: a scoped rule is named by its instructions file", async () => {
    const tone: IngredientSpec = { meta: { type: "rule", name: "tone", inclusion: "always" }, files: { "rule.md": "Mind .claude/rules/api.md.\n" } };
    const { text } = await planned(["copilot"], [api("API.\n"), tone]);
    expect(text(".github/copilot-instructions.md")).toBe("Mind .github/instructions/api.instructions.md.\n");
  });
});

describe("spec 61 §10 — the rules index in a new target's rule bodies (schema 15 includes 7)", () => {
  it("[cursor]: the placeholder alone on a line becomes the list, named as cursor names its rules", async () => {
    const readme: IngredientSpec = { meta: { type: "rule", name: "readme", inclusion: "always", description: "Start here" }, files: { "rule.md": "Rules:\n{{craftar.rules.index}}\n" } };
    const apiD: IngredientSpec = { meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/**", description: "API" }, files: { "rule.md": "API.\n" } };
    const { p, text } = await planned(["cursor"], [readme, apiD]);
    const body = text(".cursor/rules/readme.mdc");
    expect(body).not.toContain("{{craftar.rules.index}}");
    expect(body).toContain("`.cursor/rules/api.mdc`");
    expect(body).toContain("`.cursor/rules/readme.mdc`");
    expect(p.indexed.map((i) => i.path)).toContain(".cursor/rules/readme.mdc");
    expect(p.warnings.filter((w) => w.includes("craftar.rules.index"))).toEqual([]);
  });
});
