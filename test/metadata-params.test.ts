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

  it("refuses it for a rule written to AGENTS.md alone, whose description reaches the rules index only", async () => {
    // agents-md is the only target: neither claude-code nor kiro reads this rule's metadata.
    const s = kept(
      await one(
        { meta: { type: "rule", name: "style", description: "Style of {{org}}", params: { org: {} } }, files: { "rule.md": "# Style\n\n{{craftar.rules.index}}\n" } },
        {},
        GATE,
        ["agents-md"],
      ),
    );
    const { p } = await planOf(s);
    expect(unsetDeclared(p).map((u) => u.key)).toEqual(["org"]);
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

describe("review round 1: metadataFault closes the §8 guard and the §5.4 list", async () => {
  const { metadataFault } = await import("../src/core/metadata-params.js");
  const agent = (frontmatterRaw: string) => ({ type: "agent", name: "a", frontmatterRaw, file: "agent.md", targets: "*" }) as never;
  const command = (description: string) => ({ type: "command", name: "c", description, file: "command.md", targets: "*" }) as never;
  it("a citation under a quoted guarded key, in key position, or on a flow mapping line is refused", () => {
    expect(metadataFault(agent('name: a\n"model": {{m}}'), { m: "opus" })?.why).toMatch(/model/);
    expect(metadataFault(agent("name: a\n'tools': {{m}}"), { m: "Read" })?.why).toMatch(/tools/);
    expect(metadataFault(agent("name: a\n{{k}}: opus"), { k: "model" })).not.toBeNull();
    expect(metadataFault(agent("{name: a, model: {{m}}}"), { m: "opus" })).not.toBeNull();
  });
  it("a value starting with '- ', '? ' or a backtick where it opens a scalar is refused", () => {
    for (const v of ["- run it", "? why", "`cmd`"]) {
      expect(metadataFault(command("{{d}}"), { d: v }), v).not.toBeNull();
      expect(metadataFault(agent("name: a\ndescription: {{d}}"), { d: v }), v).not.toBeNull();
    }
    expect(metadataFault(command("Run {{d}}"), { d: "- it" })).toBeNull();
  });
});

describe("review round 2: the §8 guard compares the raw block's structure, not its spellings", async () => {
  const { metadataFault } = await import("../src/core/metadata-params.js");
  const agent = (frontmatterRaw: string) => ({ type: "agent", name: "a", frontmatterRaw, file: "agent.md", targets: "*" }) as never;
  const command = (description: string) => ({ type: "command", name: "c", description, file: "command.md", targets: "*" }) as never;
  it.each([
    ["a key after a tab", "name: a\n{{k}}:\topus", { k: "model" }],
    ["a flow mapping opened on an earlier line", "{name: a,\n model: {{m}}}", { m: "opus" }],
    ["an anchor and an alias", "x: &v {{m}}\nmodel: *v", { m: "opus" }],
    ["an explicit key", "name: a\n? model\n: {{m}}", { m: "opus" }],
    ["a merge key", "base: &v\n  model: {{m}}\nagent:\n  <<: *v\n<<: *v", { m: "opus" }],
  ])("refuses %s", (_name, raw, params) => {
    const f = metadataFault(agent(raw), params as Record<string, unknown>);
    expect(f).not.toBeNull();
    expect(JSON.stringify(f)).not.toContain("opus");
  });
  it("still passes a citation elsewhere in a block whose guarded keys are literal", () => {
    expect(metadataFault(agent("name: a\nmodel: opus\ndescription: Reviews {{org}} changes"), { org: "acme" })).toBeNull();
    expect(metadataFault(({ type: "rule", name: "r", frontmatterRaw: "paths:\n  - {{v}}", file: "rule.md", targets: "*" }) as never, { v: "**/*.ts" })).toBeNull();
  });
  it("a tab where a space is tested, and a value starting with , ] or }", () => {
    expect(metadataFault(command("{{d}}"), { d: "x:\ty" })).not.toBeNull();
    expect(metadataFault(command("Run {{d}}"), { d: "x\t#y" })).not.toBeNull();
    for (const v of [",x", "]x", "}x"]) expect(metadataFault(command("{{d}}"), { d: v }), v).not.toBeNull();
  });
});

describe("review round 3: a second value cannot switch the guard to reading by lines", async () => {
  const { metadataFault } = await import("../src/core/metadata-params.js");
  const agent = (frontmatterRaw: string) => ({ type: "agent", name: "a", frontmatterRaw, file: "agent.md", targets: "*" }) as never;
  it.each([
    ["an alias", 'description: &a {{d}}\nmodel: *a\nnote: "{{e}}"'],
    ["a merge key", 'base: &b {model: {{d}}}\n<<: *b\nnote: "{{e}}"'],
    ["an explicit key", 'name: a\n? model\n: {{d}}\nnote: "{{e}}"'],
  ])("the structural guard refuses %s when another value makes the rendered block unreadable", async (_n, raw) => {
    const { guardedKeyMoved } = await import("../src/core/metadata-params.js");
    const f = guardedKeyMoved(raw, { d: "opus", e: "C:\\Users\\me" });
    expect(f).toMatchObject({ key: "d", why: "it reaches model, which a parameter may not change" });
    expect(JSON.stringify(f)).not.toContain("opus");
    expect(metadataFault(agent(raw), { d: "opus", e: "C:\\Users\\me" })).not.toBeNull();
  });
  it("names the key that reached the guarded key, not the first one cited", () => {
    expect(metadataFault(agent("when: {{x}}\nnote: &a {{d}}\nmodel: *a"), { x: "now", d: "opus" })?.key).toBe("d");
  });
  it("refuses a backslash inside a double-quoted value, and lets it through plain", () => {
    expect(metadataFault(agent('name: a\ndescription: "{{n}}"'), { n: "C:\\q" })?.why).toMatch(/backslash/);
    expect(metadataFault(({ type: "rule", name: "r", frontmatterRaw: "paths:\n  - {{p}}", file: "rule.md", targets: "*" }) as never, { p: "src\\x" })).toBeNull();
  });
  it("a citation on a comment line is not tested for its value", () => {
    expect(metadataFault(agent("name: a\n# see {{n}}"), { n: "a: b" })).toBeNull();
  });
  it("still passes **/*.ts as a paths: value and an item", () => {
    const rule = (fm: string) => ({ type: "rule", name: "r", frontmatterRaw: fm, file: "rule.md", targets: "*" }) as never;
    expect(metadataFault(rule("paths: {{v}}"), { v: "**/*.ts" })).toBeNull();
    expect(metadataFault(rule("paths:\n  - {{v}}\n  - lib/**"), { v: "**/*.ts" })).toBeNull();
  });
});

describe("review round 4: the paths: glob exemption is per citation", async () => {
  const { metadataFault } = await import("../src/core/metadata-params.js");
  const rule = (fm: string) => ({ type: "rule", name: "r", frontmatterRaw: fm, file: "rule.md", targets: "*" }) as never;
  it("a key cited in a description and as a paths: item passes with **/*.ts", () => {
    expect(metadataFault(rule("description: files under {{glob}}\npaths:\n  - {{glob}}"), { glob: "**/*.ts" })).toBeNull();
    expect(metadataFault(rule("# uses {{glob}}\npaths: {{glob}}"), { glob: "**/*.ts" })).toBeNull();
  });
  it("a double quote inside a single-quoted value does not count for the backslash check", () => {
    expect(metadataFault(rule(`description: 'say "{{k}}"'\npaths: src/x`), { k: "a\\b" })).toBeNull();
  });
});

describe("review round 5: one scan of the quoting state, and a flow element opens a scalar", async () => {
  const { metadataFault } = await import("../src/core/metadata-params.js");
  const rule = (fm: string) => ({ type: "rule", name: "r", frontmatterRaw: fm, file: "rule.md", targets: "*" }) as never;
  it("an apostrophe inside a double-quoted value keeps the backslash check, strict block or not", () => {
    expect(metadataFault(rule(`description: "it's under {{root}}"\npaths: src/x`), { root: "C:\\new" })?.why).toMatch(/backslash/);
    expect(metadataFault(rule(`description: "it's under {{root}}"\npaths: **/*.ts`), { root: "C:\\new" })?.why).toMatch(/backslash/);
    expect(metadataFault(rule(`description: 'say "{{k}}"'\npaths: src/x`), { k: "a\\b" })).toBeNull();
  });
  it("a flow element that a value would open is refused in a block read by lines", () => {
    expect(metadataFault(rule("paths: [{{v}}, **/*.md]"), { v: "*x" })).not.toBeNull();
    expect(metadataFault(rule("paths: [lib/**, {{v}}]\nnote: **"), { v: "]" })).not.toBeNull();
  });
});
