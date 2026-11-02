import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { acmeMeta } from "./helpers/metadata-params.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { loadWorkspace, plan, unsetDeclared } from "../src/core/sync.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../src/schema/index.js";

/** Spec 50 Part B: params in an ingredient's metadata, at the gate (§5.1–§5.4; §11 items 13–15). */

const GATE = FORGE_SCHEMA_METADATA_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
type Scenario = Awaited<ReturnType<typeof scenario>>;
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

async function planOf(s: Scenario) {
  const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
  // LF throughout: kiro writes CRLF, which these assertions do not test.
  const files = new Map(p.files.map((f) => [f.path, f.content.toString("utf8").replace(/\r\n/g, "\n")]));
  return { p, files };
}

/** A one-ingredient Forge at `schema`, the profile's params given, the workspace on claude-code, kiro and agents-md. */
async function one(spec: IngredientSpec, params: Record<string, unknown>, schema = GATE, targets = ["claude-code", "kiro", "agents-md"]) {
  const ref = `${spec.meta.type}/${spec.meta.name}`;
  const s = kept(await scenario({ ingredients: [spec], recipes: [recipe("base", [ref])], profiles: [profile("acme", ["base"], targets, { params })] }, { config: { profile: "acme" } }));
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}

describe("spec 50 §5.2–§5.3: every field renders at the gate", () => {
  it("renders each row of §5.2 in each file that carries it (§11 item 13)", async () => {
    const s = kept(await acmeMeta({ schema: GATE }));
    const { p, files } = await planOf(s);
    expect(files.get(".claude/rules/paths.md")).toBe("---\npaths: src/**\n---\n# Paths\nKeep acme code tidy.\n");
    expect(files.get(".kiro/steering/paths.md")).toContain('fileMatchPattern: "src/**"');
    expect(files.get("AGENTS.md")).toContain("— applies to `src/**`");
    expect(files.get(".claude/agents/helper.md")).toContain("description: Helps acme engineers");
    expect(files.get(".kiro/agents/helper.json")).toContain('"description": "Helps acme engineers"');
    expect(files.get(".claude/agents/raw.md")).toContain("description: Reviews acme changes");
    expect(files.get(".claude/commands/ship.md")).toContain("description: Ship an acme release\nargument-hint: <acme-version>");
    expect(files.get(".kiro/steering/commands/ship.md")).toContain("description: Ship an acme release\nargument-hint: <acme-version>");
    for (const text of files.values()) expect(text).not.toMatch(/\{\{(org|glob)\}\}/);
    expect(p.warnings.join("\n")).not.toMatch(/param "/);
    // A metadata citation is a citation: explain's params line names it (spec 50 §5.3).
    expect(p.params.get("command/ship")?.map((x) => x.key)).toEqual(["org"]);
  });

  it("renders a rule's description in the rules index", async () => {
    const s = kept(
      await one(
        { meta: { type: "rule", name: "readme", description: "Rules of {{org}}" }, files: { "rule.md": "# Rules\n\n{{craftar.rules.index}}\n" } },
        { org: "acme" },
      ),
    );
    const { files } = await planOf(s);
    expect(files.get(".claude/rules/readme.md")).toContain("Rules of acme");
  });

  it("leaves a list fileMatchPattern's elements rendered one by one, and Angular's {{ 'X' | localize }} as written", async () => {
    const s = kept(
      await one(
        { meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: ["{{dir}}/**", "test/**"], description: "{{ 'X' | localize }}" }, files: { "rule.md": "# API\n" } },
        { dir: "src" },
      ),
    );
    const { files } = await planOf(s);
    expect(files.get(".kiro/steering/api.md")).toContain('fileMatchPattern: "src/**,test/**"');
    expect(files.get("AGENTS.md")).toContain("applies to `src/**`, `test/**`");
  });

  it("keeps tools, model and an agent's resources literal", async () => {
    const s = kept(
      await one(
        { meta: { type: "agent", name: "ag", description: "For {{org}}", tools: ["Read"], model: "{{org}}", resources: ["file://{{org}}.md"] }, files: { "agent.md": "Body.\n" } },
        { org: "acme" },
      ),
    );
    const { files } = await planOf(s);
    expect(files.get(".claude/agents/ag.md")).toContain("model: {{org}}");
    expect(files.get(".kiro/agents/ag.json")).toContain('"file://{{org}}.md"');
  });
});

describe("spec 50 §5.3: a declared key with no value cited only in metadata", () => {
  it("refuses the sync on every surface (§11 item 14)", async () => {
    const s = kept(
      await one(
        { meta: { type: "rule", name: "paths", frontmatterRaw: "paths: {{glob}}", params: { glob: {} } }, files: { "rule.md": "# Paths\n" } },
        {},
      ),
    );
    const { p } = await planOf(s);
    expect(unsetDeclared(p).map((u) => u.key)).toEqual(["glob"]);
    const W = ["--workspace", s.wsRoot];
    expect(runCli(["sync", ...W]).code).toBe(1);
    expect(runCli(["sync", "--check", ...W]).code).toBe(1);
    expect(runCli(["status", ...W]).code).toBe(1);
    expect(runCli(["diff", "--exit-code", ...W]).code).toBe(1);
    const doctor = JSON.parse(runCli(["doctor", "--json", ...W]).stdout);
    expect(doctor.checks.find((c: { id: string }) => c.id === "params").level).toBe("error");
  });
});

describe("spec 50 §5.4: a value that would break the file fails the plan, never naming the value (§11 item 15)", () => {
  const SECRETISH = "VALUE-NOT-PRINTED";
  const raw = (fm: string): IngredientSpec => ({ meta: { type: "agent", name: "ag", frontmatterRaw: fm }, files: { "agent.md": "Body.\n" } });
  const desc = (field: "description" | "argumentHint", text: string): IngredientSpec => ({
    meta: { type: "command", name: "cm", [field]: text },
    files: { "command.md": "Body.\n" },
  });

  async function fails(spec: IngredientSpec, value: string, field: string) {
    const s = await one(spec, { v: value });
    const e = await planOf(s).then(
      () => null,
      (x: Error) => x,
    );
    expect(e, `expected the plan to fail for ${JSON.stringify(value)}`).not.toBeNull();
    expect(e!.message).toContain(`{{v}} in ${field}`);
    expect(e!.message).toContain(`${spec.meta.type}/${spec.meta.name}`);
    expect(e!.message).not.toContain(SECRETISH);
    const r = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(SECRETISH);
  }
  async function passes(spec: IngredientSpec, value: string) {
    const s = await one(spec, { v: value });
    await expect(planOf(s)).resolves.toBeTruthy();
  }

  it.each([
    ['a "quote', "a quote"],
    ["a 'quote", "a quote"],
    ["key: value", "': '"],
    ["text #comment", "' #'"],
    ["ends:", "a final ':'"],
    ["two\nlines", "a line break"],
  ])("frontmatterRaw refuses %j", async (v) => {
    await fails(raw(`description: Reviews {{v}}`), `${SECRETISH} ${v}`, "frontmatterRaw");
  });

  it.each([["key: value"], ["text #comment"], ["ends:"], ["two\nlines"]])("an agent's or a command's description and argumentHint refuse %j", async (v) => {
    await fails(desc("description", "Ship {{v}}"), `${SECRETISH} ${v}`, "description");
    await fails(desc("argumentHint", "<{{v}}>"), `${SECRETISH} ${v}`, "argumentHint");
  });

  it("lets quotes through an agent's or a command's description, which is written unquoted", async () => {
    await passes(desc("description", "Ship {{v}}"), `it's "quoted"`);
  });

  it.each([['"'], ["'"], ["["], ["{"], ["*"], ["&"], ["!"], ["|"], [">"], ["%"], ["@"], ["#"]])(
    "refuses a value starting with %s where the placeholder opens an unquoted scalar",
    async (c) => {
      await fails(raw("description: {{v}}"), `${c}${SECRETISH}`, "frontmatterRaw");
      await fails(desc("description", "{{v}}"), `${c}${SECRETISH}`, "description");
    },
  );

  it.each([["tools"], ["allowed-tools"], ["model"]])("refuses a citation under a raw block's %s", async (key) => {
    const s = await one(raw(`name: ag\n${key}: {{v}}`), { v: "Read" });
    await expect(planOf(s)).rejects.toThrow(`it stands under ${key}`);
  });

  it("refuses a citation in a list under tools", async () => {
    const s = await one(raw("name: ag\ntools:\n  - {{v}}"), { v: "Read" });
    await expect(planOf(s)).rejects.toThrow("it stands under tools");
  });

  it("refuses a fileMatchPattern that renders empty or holds a line break", async () => {
    const rule = (p: string): IngredientSpec => ({ meta: { type: "rule", name: "r", inclusion: "fileMatch", fileMatchPattern: p }, files: { "rule.md": "# R\n" } });
    await expect(planOf(await one(rule("{{v}}"), { v: "" }))).rejects.toThrow("{{v}} in fileMatchPattern");
    await expect(planOf(await one(rule("{{v}}"), { v: "a\nb" }))).rejects.toThrow("{{v}} in fileMatchPattern");
  });

  it("passes **/*.ts in paths:, quoted and not, inline and as an item; ': ' in a rule's description; a literal in the Forge", async () => {
    const rule = (fm: string, d?: string): IngredientSpec => ({ meta: { type: "rule", name: "r", frontmatterRaw: fm, ...(d ? { description: d } : {}) }, files: { "rule.md": "# R\n" } });
    await passes(rule("paths: {{v}}"), "**/*.ts");
    await passes(rule('paths: "{{v}}"'), "**/*.ts");
    await passes(rule("paths:\n  - {{v}}"), "**/*.ts");
    await passes(rule("paths: src/**", "Scope: {{v}}"), "a: b");
    await passes(raw("description: a: b # literal"), "unused");
    await passes(raw('description: "{{v}}"'), "@acme/api inside");
    await passes(raw("description: The {{v}} package"), "@acme/api");
  });

  it("is not tested below the gate: the value is not written either", async () => {
    const s = await one(raw("description: {{v}}"), { v: "a: b" }, GATE - 1);
    const { files } = await planOf(s);
    expect(files.get(".claude/agents/ag.md")).toContain("description: {{v}}");
  });
});
