import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { exists } from "../src/core/forge.js";
import { profile, recipe, rule, scenario, writeFiles, type IngredientSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(ingredients: IngredientSpec[], refs: string[], profileExtra: Record<string, unknown> = {}) {
  const s = await scenario(
    { ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], ["claude-code", "kiro"], profileExtra)] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}

const BODY = "Org: {{scm.org}}\nTitle: {{ 'X' | localize }}\n";

describe("plan warnings", () => {
  it("reports each unresolved param once, with the ingredients citing it", async () => {
    const p = await planFor([rule("a", BODY), rule("b", "Also {{scm.org}}\n")], ["rule/a", "rule/b"]);
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual(['param "scm.org" has no value in any layer — left verbatim (rule/a, rule/b)']);
    const a = p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8");
    expect(a).toContain("{{scm.org}}");
    expect(a).toContain("{{ 'X' | localize }}");
  });

  it("stays quiet when a layer provides the value", async () => {
    const p = await planFor([rule("a", BODY)], ["rule/a"], { params: { "scm.org": "acme" } });
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual([]);
    expect(p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8")).toContain("Org: acme");
  });

  it("warns when two ingredients write the same path", async () => {
    const p = await planFor([rule("x", "# X\n"), rule("x--p", "# X2\n", { as: "x" })], ["rule/x", "rule/x--p"]);
    expect(p.warnings).toContain("two ingredients write .claude/rules/x.md: rule/x and rule/x--p (last wins)");
  });
});

/* ------------------------------------------------------------------ */
/* Sections (spec 11 §10.2)                                             */
/* ------------------------------------------------------------------ */

const OPEN = (n: string) => `<!-- craftar:section ${n} -->`;
const CLOSE = "<!-- /craftar:section -->";
const SEC = ["# R", OPEN("flavors"), "| acme |", CLOSE, "end", ""].join("\n");

interface SectionCase {
  ingredients: IngredientSpec[];
  refs?: string[];
  profileExtra?: Record<string, unknown>;
  config?: Record<string, unknown>;
  local?: Record<string, unknown>;
  /** craftar.forge.yaml `schema`: 2 by default, "none" for no key. */
  schema?: 1 | 2 | "none";
  targets?: string[];
}

async function sectionScenario(c: SectionCase) {
  const refs = c.refs ?? c.ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = await scenario(
    { ingredients: c.ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], c.targets ?? ["claude-code", "kiro", "agents-md"], c.profileExtra ?? {})] },
    { config: { profile: "acme", ...(c.config ?? {}) }, local: c.local },
  );
  cleanups.push(s.cleanup);
  const schema = c.schema ?? 2;
  await writeFiles(s.forgeRoot, { "craftar.forge.yaml": schema === "none" ? "name: test-forge\n" : `name: test-forge\nschema: ${schema}\n` });
  return s;
}

async function sectionPlan(c: SectionCase) {
  return plan(await loadWorkspace((await sectionScenario(c)).wsRoot));
}

const out = (p: Awaited<ReturnType<typeof plan>>, rel: string) => p.files.find((f) => f.path === rel)?.content.toString("utf8");

describe("sections — plan warnings (Ruling 12)", () => {
  it("a Forge without sections warns nothing new (AC 7)", async () => {
    const p = await sectionPlan({ ingredients: [rule("a", "# A\n")], schema: 1 });
    expect(p.warnings.filter((w) => /section/.test(w))).toEqual([]);
    expect(p.sections.size).toBe(0);
  });

  it("warns on a key that names no ingredient in the Forge, with its layer", async () => {
    const p = await sectionPlan({
      ingredients: [rule("r", SEC)],
      profileExtra: { sections: { "rule/nope": { flavors: "x" }, "rule/r--acme": { flavors: "y" } } },
      config: { overrides: { sections: { "agent/ghost": { a: "z" } } } },
    });
    expect(p.warnings).toContain("section key rule/nope in profile acme names no ingredient in the Forge");
    expect(p.warnings).toContain("section key rule/r--acme in profile acme names no ingredient in the Forge");
    expect(p.warnings).toContain("section key agent/ghost in the workspace names no ingredient in the Forge");
  });

  it("warns on a name a resolved ingredient does not declare, with the strongest layer", async () => {
    const p = await sectionPlan({
      ingredients: [rule("r", SEC)],
      profileExtra: { sections: { "rule/r": { other: "x", flavors: "| globex |" } } },
      local: { overrides: { sections: { "rule/r": { other: "y" } } } },
    });
    expect(p.warnings).toContain("the workspace sets section other of rule/r, which has no such marker");
    expect(p.warnings.filter((w) => /flavors/.test(w))).toEqual([]);
  });

  it("stays silent for a key whose ingredients are unresolved or disabled", async () => {
    const unresolved = await sectionPlan({ ingredients: [rule("r", SEC), rule("s", "# S\n")], refs: ["rule/r"], profileExtra: { sections: { "rule/s": { any: "x" } } } });
    expect(unresolved.warnings.filter((w) => /section/.test(w))).toEqual([]);
    const disabled = await sectionPlan({
      ingredients: [rule("r", SEC), rule("s", "# S\n")],
      profileExtra: { sections: { "rule/s": { any: "x" } } },
      config: { overrides: { ingredients: { disable: ["rule/s"] } } },
    });
    expect(disabled.warnings.filter((w) => /section/.test(w))).toEqual([]);
  });

  it("warns on a value keyed mcp/<name>: an MCP ingredient has no marker (edge case 11)", async () => {
    const p = await sectionPlan({ ingredients: [{ meta: { type: "mcp", name: "db", server: { command: "npx" } } }], profileExtra: { sections: { "mcp/db": { x: "y" } } } });
    expect(p.warnings).toContain("profile acme sets section x of mcp/db, which has no such marker");
  });

  it("markers in a file not every target renders are copied verbatim by both, and warned once (Ruling 17)", async () => {
    const run = ["#!/bin/sh", OPEN("x"), "echo hi", CLOSE, ""].join("\n");
    const p = await sectionPlan({
      ingredients: [{ meta: { type: "skill", name: "tool" }, files: { "SKILL.md": "# Tool\n", "run.sh": run } }],
      profileExtra: { sections: { "skill/tool": { x: "echo globex" } } },
      targets: ["claude-code", "kiro"],
    });
    expect(p.warnings.filter((w) => w.includes("run.sh"))).toEqual(["skill/tool run.sh: section markers are read only in files every target renders as text — copied with them"]);
    expect(out(p, ".claude/skills/tool/run.sh")).toBe(run);
    expect(out(p, ".kiro/skills/tool/run.sh")).toBe(run);
    expect(p.warnings).toContain("profile acme sets section x of skill/tool, which has no such marker");
  });

  it("warns on markers in a copied file whatever its extension (an .html in a skill dir)", async () => {
    const page = [OPEN("x"), "<p>hi</p>", CLOSE, ""].join("\n");
    const p = await sectionPlan({
      ingredients: [{ meta: { type: "skill", name: "tool" }, files: { "SKILL.md": "# Tool\n", "page.html": page } }],
      targets: ["claude-code", "kiro"],
    });
    expect(p.warnings.filter((w) => w.includes("page.html"))).toEqual(["skill/tool page.html: section markers are read only in files every target renders as text — copied with them"]);
    expect(out(p, ".claude/skills/tool/page.html")).toBe(page);
  });
});

describe("sections — parse errors and the output guard", () => {
  it("a malformed marker fails the plan naming the Forge file and line, whichever targets resolve (edge case 20)", async () => {
    const bad = rule("r", ["# R", OPEN("flavors"), "x", ""].join("\n"), { targets: ["kiro"] });
    await expect(sectionPlan({ ingredients: [bad], targets: ["claude-code"] })).rejects.toThrow(
      "section markers in ingredients/rules/r/rule.md:2: section flavors is never closed",
    );
  });

  it("a section value holding a marker line trips the output guard, naming the layer and the section", async () => {
    await expect(sectionPlan({ ingredients: [rule("r", SEC)], profileExtra: { sections: { "rule/r": { flavors: `| a |\n${CLOSE}\n` } } } })).rejects.toThrow(
      "rule/r rule.md: the rendered text holds a section marker on line 3 (from profile acme, section flavors) — a value cannot open or close a section",
    );
  });

  it("a multi-line param value holding a marker line trips the guard, naming the param (edge case 15)", async () => {
    await expect(sectionPlan({ ingredients: [rule("r", "# R\n{{notes}}\n")], profileExtra: { params: { notes: `a\n${OPEN("x")}` } }, schema: 1 })).rejects.toThrow(
      "rule/r rule.md: the rendered text holds a section marker on line 3 (from param notes) — a value cannot open or close a section",
    );
  });
});

describe("sections — order: sections first, then params (spec 11 §6.4)", () => {
  it("a value citing {{k}} renders k from the ingredient's declared default", async () => {
    const p = await sectionPlan({
      ingredients: [rule("r", SEC, { params: { "deploy.api": { default: "acme-api" } } })],
      profileExtra: { sections: { "rule/r": { flavors: "| {{deploy.api}} |" } } },
      targets: ["claude-code"],
    });
    expect(out(p, ".claude/rules/r.md")).toBe("# R\n| acme-api |\nend\n");
  });

  it("an Angular pipe survives in a default, a value and the outside text", async () => {
    const body = ["{{ 'A' | localize }}", OPEN("a"), "{{ 'B' | localize }}", CLOSE, OPEN("b"), "x", CLOSE, ""].join("\n");
    const p = await sectionPlan({ ingredients: [rule("r", body)], profileExtra: { sections: { "rule/r": { b: "{{ 'C' | localize }}" } } }, targets: ["claude-code"] });
    expect(out(p, ".claude/rules/r.md")).toBe("{{ 'A' | localize }}\n{{ 'B' | localize }}\n{{ 'C' | localize }}\n");
  });

  it("the unresolved-param warning counts the expanded text: a replaced default's key is not reported, a value's is", async () => {
    const body = ["# R", OPEN("a"), "{{gone}}", CLOSE, ""].join("\n");
    const p = await sectionPlan({ ingredients: [rule("r", body)], profileExtra: { sections: { "rule/r": { a: "{{kept}}" } } }, targets: ["claude-code"] });
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual(['param "kept" has no value in any layer — left verbatim (rule/r)']);
  });

  it("records each section's layer for explain", async () => {
    const body = ["# R", OPEN("a"), "x", CLOSE, OPEN("b"), "y", CLOSE, OPEN("c"), "z", CLOSE, ""].join("\n");
    const p = await sectionPlan({
      ingredients: [rule("r", body)],
      profileExtra: { sections: { "rule/r": { a: "pa", b: "pb" } } },
      config: { overrides: { sections: { "rule/r": { b: "wb" } } } },
      targets: ["claude-code"],
    });
    expect(p.sections.get("rule/r")).toEqual([
      { file: "rule.md", name: "a", layer: "profile" },
      { file: "rule.md", name: "b", layer: "workspace" },
      { file: "rule.md", name: "c", layer: "default" },
    ]);
  });

  it("a variant emitting under the base's name reads the base's key (Ruling 3, edge case 12)", async () => {
    const p = await sectionPlan({
      ingredients: [rule("r--acme", SEC, { as: "r" })],
      profileExtra: { sections: { "rule/r": { flavors: "| acme-v |" } } },
      targets: ["claude-code"],
    });
    expect(out(p, ".claude/rules/r.md")).toBe("# R\n| acme-v |\nend\n");
    expect(p.warnings.filter((w) => /section/.test(w))).toEqual([]);
  });
});

describe("sections — the schema gate (Ruling 7, AC 14)", () => {
  const GATE =
    "craftar.forge.yaml declares schema: 1, but ingredients/rules/r/rule.md:2 holds a section marker — set schema: 2 in craftar.forge.yaml, so that craftar 0.6.2 and older refuse this Forge instead of emitting the markers";

  for (const schema of [1, "none"] as const) {
    it(`fails status, sync, diff, explain and ls with exit 1 when the manifest says ${schema === 1 ? "schema: 1" : "no schema"}`, async () => {
      const s = await sectionScenario({ ingredients: [rule("r", SEC)], schema, targets: ["claude-code"] });
      for (const args of [["status"], ["sync"], ["diff"], ["explain", ".claude/rules/r.md"], ["ls"]]) {
        const r = runCli([...args, "--workspace", s.wsRoot]);
        expect(r.code, args[0]).toBe(1);
        expect(r.stderr, args[0]).toContain(GATE);
      }
      expect(await exists(path.join(s.wsRoot, ".claude"))).toBe(false);
    });
  }

  it("the same Forge at schema: 2 syncs, with no marker in the output", async () => {
    const s = await sectionScenario({ ingredients: [rule("r", SEC)], targets: ["claude-code"] });
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/r.md"), "utf8")).toBe("# R\n| acme |\nend\n");
  });

  it("a schema: 2 Forge with no marker syncs (edge case 24)", async () => {
    const p = await sectionPlan({ ingredients: [rule("r", "# R\n")], targets: ["claude-code"] });
    expect(out(p, ".claude/rules/r.md")).toBe("# R\n");
  });

  it("a marker in an ingredient the workspace does not resolve does not trip the gate (Ruling 21)", async () => {
    const p = await sectionPlan({ ingredients: [rule("r", SEC), rule("s", "# S\n")], refs: ["rule/s"], schema: 1, targets: ["claude-code"] });
    expect(out(p, ".claude/rules/s.md")).toBe("# S\n");
  });

  it("a malformed marker in a schema: 1 Forge reports the malformed marker, not the schema", async () => {
    await expect(sectionPlan({ ingredients: [rule("r", SEC), rule("s", "<!--craftar:section x-->\n")], schema: 1 })).rejects.toThrow(
      /^section markers in ingredients\/rules\/s\/rule\.md:1: malformed section marker/,
    );
  });

  it("status and sync fail with exit 1 on a parse error", async () => {
    const s = await sectionScenario({ ingredients: [rule("r", `# R\n${CLOSE}\n`)], targets: ["claude-code"] });
    for (const cmd of ["status", "sync"]) {
      const r = runCli([cmd, "--workspace", s.wsRoot]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("section markers in ingredients/rules/r/rule.md:2: a closing marker with no open section");
    }
  });

  it("forge variants and forge diff read a schema: 1 Forge with markers without error", async () => {
    const s = await sectionScenario({ ingredients: [rule("r", SEC), rule("r--globex", "# R\n| globex |\nend\n", { as: "r" })], refs: ["rule/r"], schema: 1 });
    const v = runCli(["forge", "variants", "--forge", s.forgeRoot]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain("rule/r");
    const d = runCli(["forge", "diff", "rule/r", "--against", "globex", "--forge", s.forgeRoot]);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain(OPEN("flavors"));
  });
});
