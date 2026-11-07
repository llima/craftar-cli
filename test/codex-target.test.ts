/**
 * Spec 61 slice 2: the `codex` target and its gates (the plan's G1, ruled 2026-11-06 — "Schema 16 + lock 5").
 * - A Forge file naming `codex` needs `schema: 16`; below it, a near miss naming 16 (an ingredient's or a profile's `targets`, a
 *   section's `targets=`).
 * - `craftar.lock` is written at schema 5 exactly when its `targets` or an entry names `codex`; a lock read as 4 refuses `codex`.
 * - `.codex/agents/<name>.toml`: `name`, `description`, `developer_instructions`, through the one TOML writer, read back by a real
 *   TOML parser; rules reach Codex through `agents-md`, commands and skills through `agent-skills`, MCP is unsupported (D5).
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan, apply, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, tmpDir, writeFiles, type IngredientSpec } from "./helpers/forge.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

async function ws(schema: number, targets: string[], ingredients: IngredientSpec[]): Promise<Scenario> {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = kept(await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme" } }));
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}
const planOf = async (s: Scenario) => plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
const syncOf = async (s: Scenario) => {
  const w = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(w);
  return apply(w, p, await status(w, p, await readLock(w.root)), {});
};

const reviewer = (extra: Record<string, unknown> = {}, body = "Review the diff.\nBe brief.\n"): IngredientSpec => ({
  meta: { type: "agent", name: "reviewer", description: "Reviews changes", ...extra },
  files: { "agent.md": body },
});
const style: IngredientSpec = { meta: { type: "rule", name: "style", inclusion: "always" }, files: { "rule.md": "Use tabs.\n" } };

describe("the gate: Forge schema 16 (G1)", () => {
  it("schema 15, an ingredient naming codex → the load fails, naming the file and schema 16", async () => {
    const s = await ws(15, ["claude-code"], [{ ...style, meta: { ...style.meta, targets: ["codex"] } }]);
    await expect(loadForge(s.forgeRoot)).rejects.toThrow("ingredients/rules/style/ingredient.yaml: targets: codex needs schema: 16 in craftar.forge.yaml");
  });

  it("schema 15, a profile naming codex → the load fails, naming the profile file and schema 16", async () => {
    const s = await ws(15, ["claude-code", "codex"], [style]);
    await expect(loadForge(s.forgeRoot)).rejects.toThrow("profiles/acme/profile.yaml: targets: codex needs schema: 16 in craftar.forge.yaml");
  });

  it("schema 15, a section marked targets=codex → the plan fails as a near miss naming schema 16; slice 1's names still pass at 15", async () => {
    const marked = (t: string): IngredientSpec => ({
      meta: { type: "rule", name: "tone" },
      files: { "rule.md": `# Tone\n\n<!-- craftar:section intro targets=${t} -->\nBe friendly.\n<!-- /craftar:section -->\n` },
    });
    await expect(planOf(await ws(15, ["claude-code"], [marked("codex")]))).rejects.toThrow("section intro targets=: codex needs schema: 16 in craftar.forge.yaml");
    await expect(planOf(await ws(15, ["claude-code"], [marked("cursor")]))).resolves.toBeDefined();
  });

  it("schema 16 → an ingredient, a profile and a section naming codex load and plan", async () => {
    const s = await ws(16, ["claude-code", "codex"], [
      { ...reviewer(), meta: { ...reviewer().meta, targets: ["codex"] } },
      { meta: { type: "rule", name: "tone" }, files: { "rule.md": "<!-- craftar:section intro targets=codex -->\nHi.\n<!-- /craftar:section -->\n" } },
    ]);
    const p = await planOf(s);
    expect(p.files.map((f) => f.path)).toContain(".codex/agents/reviewer.toml");
  });

  it("a workspace naming codex over a schema-14 Forge (craftar.yaml is not gated) plans and writes lock schema 5", { timeout: atLeastWin32(30_000) }, async () => {
    const s = await ws(14, ["claude-code"], [reviewer()]);
    const cfg = YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8"));
    cfg.targets = ["claude-code", "codex"];
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify(cfg));
    const r = await syncOf(s);
    expect(r.lock.schema).toBe(5);
  });
});

describe("the lock: schema 5 (G1)", () => {
  it("a workspace naming codex writes schema 5; with slice-1 targets alone it stays 4; with legacy ones alone 2", { timeout: atLeastWin32(60_000) }, async () => {
    expect((await syncOf(await ws(16, ["claude-code", "codex"], [reviewer()]))).lock.schema).toBe(5);
    expect((await syncOf(await ws(16, ["claude-code", "cursor"], [reviewer()]))).lock.schema).toBe(4);
    expect((await syncOf(await ws(16, ["claude-code"], [reviewer()]))).lock.schema).toBe(2);
  });

  it("a hand-edited codex file kept as drift keeps lock 5 after the workspace drops codex", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(16, ["claude-code", "codex"], [reviewer()]);
    await syncOf(s);
    await fs.appendFile(path.join(s.wsRoot, ".codex/agents/reviewer.toml"), "# by hand\n");
    const prof = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const p = YAML.parse(await fs.readFile(prof, "utf8"));
    p.targets = ["claude-code"];
    await fs.writeFile(prof, YAML.stringify(p));
    const r = await syncOf(s);
    expect(r.lock.files.find((e) => e.path === ".codex/agents/reviewer.toml")?.target).toBe("codex");
    expect(r.lock.schema).toBe(5);
  });

  it("a lock read as 4 refuses codex in its targets or an entry; read as 5 it holds them", async () => {
    const lockDir = async (lock: unknown) => {
      const dir = await tmpDir();
      cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
      await writeFiles(dir, { "craftar.lock": JSON.stringify(lock) });
      return dir;
    };
    const base = { forge: { source: ".", ref: null, commit: null }, profile: "acme", recipes: [], generatedAt: "x" };
    await expect(readLock(await lockDir({ schema: 4, ...base, targets: ["codex"], files: [] }))).rejects.toThrow(/not a valid lock/);
    await expect(readLock(await lockDir({ schema: 4, ...base, targets: [], files: [{ path: "a", hash: "h", target: "codex", ingredient: "agent/x" }] }))).rejects.toThrow(/not a valid lock/);
    await expect(readLock(await lockDir({ schema: 5, ...base, targets: ["codex"], files: [{ path: "a", hash: "h", target: "codex", ingredient: "agent/x" }] }))).resolves.toMatchObject({ schema: 5 });
  });
});

describe("the codex emitter", () => {
  it("writes .codex/agents/<name>.toml with name, description and developer_instructions, read back by a TOML parser", async () => {
    const p = await planOf(await ws(16, ["codex"], [reviewer({}, 'Review the diff.\nQuote """carefully""".\n')]));
    const f = p.files.find((x) => x.path === ".codex/agents/reviewer.toml")!;
    expect(f.target).toBe("codex");
    const text = f.content.toString("utf8");
    expect(text.startsWith('name = "reviewer"\ndescription = "Reviews changes"\ndeveloper_instructions = """\n')).toBe(true);
    expect(parseToml(text)).toEqual({ name: "reviewer", description: "Reviews changes", developer_instructions: 'Review the diff.\nQuote """carefully""".\n' });
    expect(f.content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it("a model, tools and a missing description are each said, never a value of the body", async () => {
    const p = await planOf(await ws(16, ["codex"], [{ meta: { type: "agent", name: "helper", model: "sonnet", tools: ["Read"] }, files: { "agent.md": "secret body line\n" } }]));
    expect(p.warnings).toContain('codex: agent "helper" has no description, which Codex requires; written empty');
    expect(p.warnings).toContain('codex: agent "helper": model is not written (the Forge names Claude Code\'s models); dropped');
    expect(p.warnings).toContain('codex: agent "helper": tools have no Codex field and are dropped');
    expect(p.warnings.join("\n")).not.toContain("secret body line");
    expect(parseToml(p.files.find((x) => x.path === ".codex/agents/helper.toml")!.content.toString("utf8")).description).toBe("");
  });

  it("keeps the line endings of the file it replaces and never writes a BOM", { timeout: atLeastWin32(30_000) }, async () => {
    const s = await ws(16, ["codex"], [reviewer()]);
    await syncOf(s);
    const file = path.join(s.wsRoot, ".codex/agents/reviewer.toml");
    const lf = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "﻿" + lf.replace(/\n/g, "\r\n"));
    const p = await planOf(s);
    const out = p.files.find((x) => x.path === ".codex/agents/reviewer.toml")!.content.toString("utf8");
    expect(out.startsWith("﻿")).toBe(false);
    expect(out).toBe(lf.replace(/\n/g, "\r\n"));
  });

  it("a .claude/rules/ reference in the body names claude-code's file, else the rule's place in AGENTS.md", async () => {
    const body = "Read .claude/rules/style.md first.\n";
    const withCc = await planOf(await ws(16, ["claude-code", "codex"], [reviewer({}, body), style]));
    expect(withCc.files.find((x) => x.path === ".codex/agents/reviewer.toml")!.content.toString("utf8")).toContain("Read .claude/rules/style.md first.");
    const withMd = await planOf(await ws(16, ["agents-md", "codex"], [reviewer({}, body), style]));
    expect(withMd.files.find((x) => x.path === ".codex/agents/reviewer.toml")!.content.toString("utf8")).toContain("Read AGENTS.md (rule: style) first.");
  });

  it("a Markdown link to a rule resolves too, and never fails the plan: claude-code's file, AGENTS.md, or not in this workspace", async () => {
    const body = "See [Style](.claude/rules/style.md) and [Nope](.claude/rules/nope.md).\n";
    const text = async (targets: string[]) =>
      (await planOf(await ws(16, targets, [reviewer({}, body), style]))).files.find((x) => x.path === ".codex/agents/reviewer.toml")!.content.toString("utf8");
    expect(await text(["claude-code", "codex"])).toContain("See [Style](.claude/rules/style.md)");
    expect(await text(["agents-md", "codex"])).toContain("See [Style](AGENTS.md)");
    expect(await text(["agents-md", "codex"])).toContain("rule not in this workspace");
  });

  it("through cells: a rule warns only without agents-md (or when its targets leave agents-md out); a command and a skill only without agent-skills", async () => {
    const command: IngredientSpec = { meta: { type: "command", name: "review", description: "Review" }, files: { "command.md": "Review it.\n" } };
    const skill: IngredientSpec = { meta: { type: "skill", name: "docs", layout: "dir" }, files: { "SKILL.md": "---\nname: docs\ndescription: Docs\n---\nDocs.\n" } };
    const alone = await planOf(await ws(16, ["codex"], [style, command, skill]));
    expect(alone.warnings).toContain("codex: 1 rule ingredient(s) have no Codex equivalent — skipped: rule/style");
    expect(alone.warnings).toContain("codex: 1 command ingredient(s) have no Codex equivalent — skipped: command/review");
    expect(alone.warnings).toContain("codex: 1 skill ingredient(s) have no Codex equivalent — skipped: skill/docs");
    const carried = await planOf(await ws(16, ["codex", "agents-md", "agent-skills"], [style, command, skill]));
    expect(carried.warnings.filter((w) => w.startsWith("codex:"))).toEqual([]);
    const listed = await planOf(await ws(16, ["codex", "agents-md"], [{ ...style, meta: { ...style.meta, targets: ["codex"] } }]));
    expect(listed.warnings).toContain("codex: 1 rule ingredient(s) have no Codex equivalent — skipped: rule/style");
  });

  it("an MCP server is unsupported (D5): warned, no Codex file", async () => {
    const mcp: IngredientSpec = { meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["t"] } } };
    const p = await planOf(await ws(16, ["codex"], [mcp]));
    expect(p.files.some((f) => f.path.startsWith(".codex/"))).toBe(false);
    expect(p.warnings).toContain("codex: 1 mcp ingredient(s) have no Codex equivalent — skipped: mcp/tracker");
  });
});
