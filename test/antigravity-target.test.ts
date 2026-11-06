/**
 * Spec 61 slice 2: the `antigravity` target (§3.5, §5.2), behind Forge schema 16 and lock schema 5 (the plan's G1).
 * - `.agents/rules/<name>.md`, always with a `trigger` (the tool drops a rule without one, silently); with `agents-md` among the
 *   targets an always-on rule with the default targets is left to `AGENTS.md` (D3), which `explain` and the orphan reason name.
 * - `.agents/agents/<name>.md`: `name`, `description`, `model` (`inherit` unless Antigravity names it); `tools` dropped, warned.
 * - `.agents/mcp_config.json`: `mcpServers`, a remote server's `url` as `serverUrl`; withheld by the `diff` tool when hand-edited.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, orphanReason, plan, apply, readLock, status } from "../src/core/sync.js";
import { carriedFile, diffReport } from "../src/core/report.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function ws(schema: number, targets: string[], ingredients: IngredientSpec[]): Promise<Scenario> {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}
const load = (s: Scenario) => loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
const planOf = async (s: Scenario) => plan(await load(s));
const syncOf = async (s: Scenario) => {
  const w = await load(s);
  const p = await plan(w);
  return apply(w, p, await status(w, p, await readLock(w.root)), {});
};
const text = (p: Awaited<ReturnType<typeof plan>>, rel: string) => p.files.find((f) => f.path === rel)!.content.toString("utf8");

const rule = (name: string, meta: Record<string, unknown> = {}, body = `${name} body.\n`): IngredientSpec => ({ meta: { type: "rule", name, ...meta }, files: { "rule.md": body } });

describe("the gate", () => {
  it("schema 15 naming antigravity → the near miss names schema 16; at 16 it loads; a workspace naming it writes lock 5", { timeout: atLeastWin32(30_000) }, async () => {
    const low = await ws(15, ["claude-code"], [rule("style", { targets: ["antigravity"] })]);
    await expect(loadForge(low.forgeRoot)).rejects.toThrow("ingredients/rules/style/ingredient.yaml: targets: antigravity needs schema: 16 in craftar.forge.yaml");
    const ok = await ws(16, ["claude-code", "antigravity"], [rule("style")]);
    expect((await syncOf(ok)).lock.schema).toBe(5);
  });
});

describe("rules: .agents/rules/<name>.md, always with a trigger", () => {
  it("always_on, glob with globs, manual, model_decision — description whenever the rule has one", async () => {
    const p = await planOf(await ws(16, ["antigravity"], [
      rule("style"),
      rule("api", { inclusion: "fileMatch", fileMatchPattern: ["src/**", "lib/**"], description: "API" }),
      rule("release", { inclusion: "manual", description: "Release" }),
      rule("tone", { inclusion: "auto", description: "Writing tone" }),
    ]));
    expect(text(p, ".agents/rules/style.md")).toBe("---\ntrigger: always_on\n---\n\nstyle body.\n");
    expect(text(p, ".agents/rules/api.md")).toBe('---\ntrigger: glob\ndescription: "API"\nglobs: "src/**,lib/**"\n---\n\napi body.\n');
    expect(text(p, ".agents/rules/release.md")).toBe('---\ntrigger: manual\ndescription: "Release"\n---\n\nrelease body.\n');
    expect(text(p, ".agents/rules/tone.md")).toBe('---\ntrigger: model_decision\ndescription: "Writing tone"\n---\n\ntone body.\n');
  });

  it("an auto rule with no description is written manual and warned; a glob holding a comma is warned; a file over 24000 bytes is warned", async () => {
    const p = await planOf(await ws(16, ["antigravity"], [
      rule("tone", { inclusion: "auto" }),
      rule("api", { inclusion: "fileMatch", fileMatchPattern: "src/{a,b}/**" }),
      rule("big", {}, "x".repeat(24001) + "\n"),
    ]));
    expect(text(p, ".agents/rules/tone.md").startsWith("---\ntrigger: manual\n---\n")).toBe(true);
    expect(p.warnings).toContain("antigravity: rule rule/tone is auto with no description, which Antigravity needs to decide; written as manual");
    expect(p.warnings).toContain("antigravity: rule rule/api: a glob holds a comma, which Antigravity may read as a separator");
    expect(p.warnings).toContain("antigravity: rule rule/big is over 24000 bytes, Antigravity's limit for a rule file");
  });

  it("with agents-md, a default always-on rule is left to AGENTS.md (explain names it, exit-0 answer); a listed one is written to both", async () => {
    const s = await ws(16, ["antigravity", "agents-md"], [rule("style"), rule("both", { targets: ["antigravity", "agents-md"] })]);
    const p = await planOf(s);
    expect(p.files.map((f) => f.path)).not.toContain(".agents/rules/style.md");
    expect(p.files.map((f) => f.path)).toContain(".agents/rules/both.md");
    expect(text(p, "AGENTS.md")).toContain("style body.");
    expect(carriedFile(p, ".agents/rules/style.md")).toEqual({ path: ".agents/rules/style.md", writtenTo: "AGENTS.md", ingredient: "rule/style" });
  });

  it("an [antigravity] workspace that adds agents-md: the always-on rule's file is an orphan written to AGENTS.md only", { timeout: atLeastWin32(30_000) }, async () => {
    const s = await ws(16, ["antigravity"], [rule("style")]);
    await syncOf(s);
    const prof = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const doc = YAML.parse(await fs.readFile(prof, "utf8"));
    doc.targets = ["antigravity", "agents-md"];
    await fs.writeFile(prof, YAML.stringify(doc));
    const w = await load(s);
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    expect(st.find((x) => x.path === ".agents/rules/style.md")!.state).toBe("orphan");
    expect(orphanReason(p, st, ".agents/rules/style.md")).toBe("orphan: written to AGENTS.md only");
  });

  it("a .claude/rules/ reference names .agents/rules/<x>.md when antigravity writes the rule, as a token and as a link", async () => {
    const p = await planOf(await ws(16, ["antigravity"], [rule("api", { inclusion: "manual" }, "See .claude/rules/release.md and [R](.claude/rules/release.md).\n"), rule("release", { inclusion: "manual" })]));
    expect(text(p, ".agents/rules/api.md")).toContain("See .agents/rules/release.md and [R](.agents/rules/release.md).");
  });

  it("keeps the line endings of the file it replaces and never writes a BOM", { timeout: atLeastWin32(30_000) }, async () => {
    const s = await ws(16, ["antigravity"], [rule("style")]);
    await syncOf(s);
    const file = path.join(s.wsRoot, ".agents/rules/style.md");
    const lf = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "﻿" + lf.replace(/\n/g, "\r\n"));
    expect(text(await planOf(s), ".agents/rules/style.md")).toBe(lf.replace(/\n/g, "\r\n"));
  });
});

describe("agents: .agents/agents/<name>.md", () => {
  it("name, description and model; a model Antigravity names is kept, any other written inherit and warned; tools dropped and warned", async () => {
    const p = await planOf(await ws(16, ["antigravity"], [
      { meta: { type: "agent", name: "fast", description: "Quick", model: "flash" }, files: { "agent.md": "Be quick.\n" } },
      { meta: { type: "agent", name: "helper", description: "Helps", model: "sonnet", tools: ["Read"] }, files: { "agent.md": "Help.\n" } },
      { meta: { type: "agent", name: "bare" }, files: { "agent.md": "Bare.\n" } },
    ]));
    expect(text(p, ".agents/agents/fast.md")).toBe('---\nname: "fast"\ndescription: "Quick"\nmodel: flash\n---\nBe quick.\n');
    expect(text(p, ".agents/agents/helper.md")).toBe('---\nname: "helper"\ndescription: "Helps"\nmodel: inherit\n---\nHelp.\n');
    expect(p.warnings).toContain('antigravity: agent "helper": model is not one Antigravity names (inherit, flash, pro); inherit written');
    expect(p.warnings).toContain('antigravity: agent "helper": tools are not written (Antigravity\'s tool names are not measured); dropped');
    expect(p.warnings).toContain('antigravity: agent "bare" has no description, which Antigravity requires');
  });
});

describe("MCP: .agents/mcp_config.json", () => {
  const local: IngredientSpec = { meta: { type: "mcp", name: "local", server: { command: "npx", args: ["t"], env: { A: "${A_TOKEN}" } } } };
  const remote: IngredientSpec = { meta: { type: "mcp", name: "remote", server: { url: "https://mcp.example.com/mcp", headers: { X: "y" } } } };

  it("mcpServers, a stdio server kept whole, a remote server's url written as serverUrl in its place", async () => {
    const p = await planOf(await ws(16, ["antigravity"], [local, remote]));
    const f = p.files.find((x) => x.path === ".agents/mcp_config.json")!;
    expect(f.ingredient).toBe("mcp/*");
    expect(JSON.parse(f.content.toString("utf8"))).toEqual({
      mcpServers: { local: { command: "npx", args: ["t"], env: { A: "${A_TOKEN}" } }, remote: { serverUrl: "https://mcp.example.com/mcp", headers: { X: "y" } } },
    });
    expect(Object.keys(JSON.parse(f.content.toString("utf8")).mcpServers.remote)).toEqual(["serverUrl", "headers"]);
  });

  it("a hand-edited copy is withheld by the diff tool of craftar mcp", { timeout: atLeastWin32(30_000) }, async () => {
    const s = await ws(16, ["antigravity"], [local]);
    await syncOf(s);
    await fs.appendFile(path.join(s.wsRoot, ".agents/mcp_config.json"), "\n");
    await fs.writeFile(path.join(s.wsRoot, ".agents/mcp_config.json"), '{"mcpServers":{"local":{"command":"secret-by-hand"}}}\n');
    const w = await load(s);
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    void p;
    const r = await diffReport(w, st, { withholdMcp: true });
    const row = r.find((x) => x.path === ".agents/mcp_config.json")!;
    expect([row.disk, row.note === null]).toEqual([null, false]);
    expect(JSON.stringify(r)).not.toContain("secret-by-hand");
  });
});

describe("through cells", () => {
  it("a command and a skill warn only without agent-skills", async () => {
    const command: IngredientSpec = { meta: { type: "command", name: "review", description: "Review" }, files: { "command.md": "Review it.\n" } };
    const skill: IngredientSpec = { meta: { type: "skill", name: "docs", layout: "dir" }, files: { "SKILL.md": "---\nname: docs\ndescription: Docs\n---\nDocs.\n" } };
    const alone = await planOf(await ws(16, ["antigravity"], [command, skill]));
    expect(alone.warnings).toContain("antigravity: 1 command ingredient(s) have no Antigravity equivalent — skipped: command/review");
    expect(alone.warnings).toContain("antigravity: 1 skill ingredient(s) have no Antigravity equivalent — skipped: skill/docs");
    const carried = await planOf(await ws(16, ["antigravity", "agent-skills"], [command, skill]));
    expect(carried.warnings.filter((w) => w.startsWith("antigravity:"))).toEqual([]);
  });
});
