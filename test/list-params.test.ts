import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_LIST_PARAMS } from "../src/schema/index.js";
import { acmeLists, type Scenario } from "./helpers/list-params.js";

/** Spec 55 Part A §4.2–§4.5, tests 1–9 and 15: list params and their filters, in a body. */

const GATE = FORGE_SCHEMA_LIST_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (s: Scenario) => (cleanups.push(s.cleanup), s);

async function setParams(s: Scenario, params: Record<string, unknown>) {
  const p = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
  const doc = YAML.parse(await fs.readFile(p, "utf8"));
  await fs.writeFile(p, YAML.stringify({ ...doc, params }));
}
const rendered = async (s: Scenario, file = ".claude/rules/allow.md") => (await plan(await loadWorkspace(s.wsRoot))).files.find((f) => f.path === file)!.content.toString("utf8");
const planError = async (s: Scenario) => plan(await loadWorkspace(s.wsRoot)).then(() => "no error", (e: Error) => e.message);
const body = (text: string) => ({ body: text });

describe("list params in a body (spec 55 Part A)", () => {
  it("test 2: py, ps and sh write complete literals; with [] they stay valid", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("ALLOW = {{env | py}}\n$Allow = {{ env | ps }}\nARGS=( {{env|sh}} )\nJ={{env | json}}\nL={{ env | join: \", \" }}\n") }));
    expect(await rendered(s)).toBe('ALLOW = ["A", "B"]\n$Allow = @(\'A\', \'B\')\nARGS=( \'A\' \'B\' )\nJ=["A","B"]\nL=A, B\n');
    await setParams(s, { env: [], tags: ["a"] });
    expect(await rendered(s)).toBe("ALLOW = []\n$Allow = @()\nARGS=(  )\nJ=[]\nL=\n");
  });

  it.skipIf(!pythonAvailable())("test 2: the py form with [] parses as Python", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("ALLOW = {{env | py}}\nEMPTY = {{env | py}}\n") }));
    await setParams(s, { env: ["it's", 'say "hi"', "back\\slash"], tags: [] });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-py-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "x.py"), await rendered(s));
    const out = execFileSync("python3", ["-c", "import ast,sys; t=ast.parse(open(sys.argv[1]).read()); print(ast.literal_eval(t.body[0].value))", path.join(dir, "x.py")], { encoding: "utf8" });
    expect(out.trim()).toBe(`["it's", 'say "hi"', 'back\\\\slash']`);
  });

  it("test 3: quotes and backslashes round-trip through sh and json; ps doubles every single quote PowerShell reads", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | sh}}\n{{env | json}}\n{{env | ps}}\n") }));
    await setParams(s, { env: ["a 'b' c", "‘x’ ‚y‛"], tags: [] });
    const [sh, json, ps] = (await rendered(s)).split("\n");
    if (process.platform !== "win32") expect(execFileSync("bash", ["-c", `printf '%s|' ${sh}`], { encoding: "utf8" })).toBe("a 'b' c|‘x’ ‚y‛|");
    expect(JSON.parse(json)).toEqual(["a 'b' c", "‘x’ ‚y‛"]);
    expect(ps).toBe("@('a ''b'' c', '‘‘x’’ ‚‚y‛‛')");
  });

  it("test 4: an item holding a line break fails every format but json, naming the index, never the item", async () => {
    for (const f of ["py", "ps", "sh", 'join: ","']) {
      const s = kept(await acmeLists({ schema: GATE, declare: true, ...body(`X = {{env | ${f}}}\n`) }));
      await setParams(s, { env: ["ok", "SECRET\nVALUE"], tags: [] });
      const m = await planError(s);
      expect(m).toContain("rule/allow rule.md: line 1: list param env: item 1 holds a line break");
      expect(m).not.toContain("SECRET");
    }
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("X = {{env | json}}\n") }));
    await setParams(s, { env: ["a\nb"], tags: [] });
    expect(await rendered(s)).toBe('X = ["a\\nb"]\n');
  });

  it("test 5: Angular pipes on keys that are not list keys keep every byte at the gate", async () => {
    const text = "{{ 'X' | localize }}\n{{ value | date: 'short' }}\n{{tags | translate}}\n";
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body(text) }));
    expect(await rendered(s)).toBe(text);
  });

  it("test 6: a list key with no filter, an unknown filter, or a malformed one fails, naming the line and the key", async () => {
    const cases: Array<[string, string]> = [
      ["A\n{{env}}\n", "line 2: list param env: cited with no filter"],
      ["{{env | nope}}\n", 'list param env: "nope" is not a filter craftar has'],
      ['{{env | join: "a}}\n', "list param env: a filter not shaped like a name is not a filter craftar has"],
      ['{{env | join: "{"}}\n', "list param env: its filter is malformed"],
      ["x {{env | yaml-items}}\n", 'yaml-items stands alone after "- " on its own line'],
    ];
    for (const [text, want] of cases) {
      const s = kept(await acmeLists({ schema: GATE, declare: true, ...body(text) }));
      expect(await planError(s)).toContain(want);
    }
  });

  it("test 7: a scalar for a list key, a number item, and conflicting declarations each fail the plan", async () => {
    const scalar = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}}\n") }));
    await setParams(scalar, { env: "A", tags: [] });
    expect(await planError(scalar)).toContain("list param env: profile acme gives it a value that is not a sequence");
    const number = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}}\n") }));
    await setParams(number, { env: ["A", 3], tags: [] });
    expect(await planError(number)).toContain("list param env: profile acme gives item 1, which is not a string");
    const conflict = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}}\n") }));
    const r = path.join(conflict.forgeRoot, "recipes/core.yaml");
    await fs.writeFile(r, YAML.stringify({ ...YAML.parse(await fs.readFile(r, "utf8")), params: { env: { description: "a scalar here" } } }));
    expect(await planError(conflict)).toContain("list param env: rule/allow declares it type: list and recipe core declares it without");
  });

  it("a value from a parent profile is named by the parent, in the refusal and in the undeclared-list warning (spec 54 §5.3)", async () => {
    const family = async (params: Record<string, unknown>) => {
      const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}}\nTags: {{tags}}\n") }));
      const p = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
      await fs.writeFile(p, YAML.stringify({ ...YAML.parse(await fs.readFile(p, "utf8")), abstract: true, params }));
      await fs.mkdir(path.join(s.forgeRoot, "profiles/globex"), { recursive: true });
      await fs.writeFile(path.join(s.forgeRoot, "profiles/globex/profile.yaml"), YAML.stringify({ name: "globex", extends: "acme" }));
      const c = path.join(s.wsRoot, "craftar.yaml");
      await fs.writeFile(c, YAML.stringify({ ...YAML.parse(await fs.readFile(c, "utf8")), profile: "globex" }));
      return s;
    };
    expect(await planError(await family({ env: "A", tags: [] }))).toContain("list param env: profile acme gives it a value that is not a sequence");
    const p = await plan(await loadWorkspace((await family({ env: ["A"], tags: ["a", "b"] })).wsRoot));
    expect(p.warnings.filter((w) => w.includes("but no ingredient or recipe declares it type: list"))).toEqual([
      'params: tags is a list in profile acme but no ingredient or recipe declares it type: list — it renders as the items joined by ","',
    ]);
  });

  it("test 8: a YAML list for an undeclared key renders a,b and warns once at the gate", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}}\nTags: {{tags}}\n") }));
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.files.find((f) => f.path === ".claude/rules/allow.md")!.content.toString("utf8")).toContain("Tags: a,b\n");
    expect(p.warnings.filter((w) => w.includes("but no ingredient or recipe declares it type: list"))).toEqual([
      'params: tags is a list in profile acme but no ingredient or recipe declares it type: list — it renders as the items joined by ","',
    ]);
  });

  it("a recipe's list default sits under the profile's list, which replaces it whole", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | json}}\n") }));
    const r = path.join(s.forgeRoot, "recipes/core.yaml");
    await fs.writeFile(r, YAML.stringify({ ...YAML.parse(await fs.readFile(r, "utf8")), params: { env: { type: "list", default: ["R1", "R2", "R3"] } } }));
    expect(await rendered(s)).toBe('["A","B"]\n');
  });

  it("test 9: below the gate a filtered placeholder is left as written; type: list fails the load naming the schema", async () => {
    const below = kept(await acmeLists({ schema: GATE - 1, ...body("{{env | py}}\n") }));
    expect(await rendered(below)).toBe("{{env | py}}\n");
    const declared = kept(await acmeLists({ schema: GATE - 1, declare: true, ...body("{{env | py}}\n") }));
    await expect(loadForge(declared.forgeRoot)).rejects.toThrow(`ingredients/rules/allow/ingredient.yaml: params.env: type: list needs schema: ${GATE} in craftar.forge.yaml`);
    const inRecipe = kept(await acmeLists({ schema: GATE - 1, ...body("{{env | py}}\n") }));
    const r = path.join(inRecipe.forgeRoot, "recipes/core.yaml");
    await fs.writeFile(r, YAML.stringify({ ...YAML.parse(await fs.readFile(r, "utf8")), params: { env: { type: "list" } } }));
    await expect(loadForge(inRecipe.forgeRoot)).rejects.toThrow(`recipes/core.yaml: params.env: type: list needs schema: ${GATE} in craftar.forge.yaml`);
  });

  it("test 1 (body form): yaml-items expands one quoted line per item and removes the line for []", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("globs:\n  - {{ env | yaml-items }}\nend\n") }));
    expect(await rendered(s)).toBe('globs:\n  - "A"\n  - "B"\nend\n');
    await setParams(s, { env: [], tags: [] });
    expect(await rendered(s)).toBe("globs:\nend\n");
  });

  it("test 14: a CRLF body keeps CRLF on every line yaml-items writes", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("x\r\n  - {{ env | yaml-items }}\r\ny\r\n") }));
    // The body is read as LF before it renders, so the claude-code file (which keeps a new file LF) shows the lines yaml-items
    // wrote; kiro then writes CRLF on every line as always (spec 55 §7 item 5).
    expect(await rendered(s)).toBe('x\n  - "A"\n  - "B"\ny\n');
    expect(await rendered(s, ".kiro/steering/allow.md")).toContain('  - "A"\r\n  - "B"\r\ny');
  });

  it("test 15: one pass with yaml-items — an item holding {{tags}} or {{env}} is written as it is", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("globs:\n  - {{ env | yaml-items }}\n") }));
    await setParams(s, { env: ["{{tags}}", "{{env}}"], tags: "SECRET" });
    expect(await rendered(s)).toBe('globs:\n  - "{{tags}}"\n  - "{{env}}"\n');
  });

  it("test 15: one pass — an item holding {{tags}} is written as it is", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, ...body("{{env | py}} {{tags}}\n") }));
    await setParams(s, { env: ["{{tags}}"], tags: "T" });
    expect(await rendered(s)).toBe('["{{tags}}"] T\n');
  });
});

describe("one spelling of the filter grammar (spec 55 §4.3)", () => {
  it("no file under src/ but list-params.ts spells a filter name in a regular expression", async () => {
    const { listFiles } = await import("../src/core/forge.js");
    const src = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || f === "core/list-params.ts") continue;
      const text = await fs.readFile(path.join(src, f), "utf8");
      if (/py\|ps\|sh|\(py\||yaml-items\\s|join\\s\*:/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
