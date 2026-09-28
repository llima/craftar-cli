import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { citedKeys, expandedTexts, infer, readBase, renderMap, renderedFingerprint } from "../src/core/template-import.js";
import { fingerprintOf } from "../src/core/fingerprint.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";
import { IngredientSchema } from "../src/schema/index.js";
import { fingerprintDir } from "../src/core/fingerprint.js";
import { listFiles } from "../src/core/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const one = (t: string, s: string, holes: string[], map: Record<string, unknown> = {}) =>
  infer(new Map([["rule.md", t + "\n"]]), new Map([["rule.md", s + "\n"]]), new Set(holes), map);
const tag = (r: ReturnType<typeof infer>) => ("values" in r ? r.values : r.fallback);

describe("infer — spec 10 §6.3 examples", () => {
  it("E1, E2: one and two holes", () => {
    expect(tag(one("Deploy `{{deploy.api}}` first.", "Deploy `initech-api` first.", ["deploy.api"]))).toEqual({ "deploy.api": "initech-api" });
    expect(tag(one("Deploy `{{deploy.api}}` and `{{deploy.web}}` together.", "Deploy `initech-api` and `initech-web` together.", ["deploy.api", "deploy.web"]))).toEqual({
      "deploy.api": "initech-api",
      "deploy.web": "initech-web",
    });
  });

  it("E3, E5: more than one split is ambiguous (F6)", () => {
    expect(tag(one("use {{a}} and {{b}}", "use x and y and z", ["a", "b"]))).toBe("F6");
    expect(tag(one("{{a}} {{b}}", "x y z", ["a", "b"]))).toBe("F6");
  });

  it("E4: adjacent holes are ambiguous whatever the source (F4)", () => {
    const r = one("{{a}}{{b}}", "xy", ["a", "b"]);
    expect(tag(r)).toBe("F4");
    expect("reason" in r && r.reason).toBe("inference ambiguous: {{a}}{{b}} are adjacent on line 1 of rule.md");
  });

  it("E6, E7: one key across lines takes one value", () => {
    const t = "Build `{{k}}`.\nDeploy `{{k}}`.";
    expect(tag(infer(new Map([["rule.md", t]]), new Map([["rule.md", "Build `initech-api`.\nDeploy `initech-api`."]]), new Set(["k"]), {}))).toEqual({ k: "initech-api" });
    expect(tag(infer(new Map([["rule.md", t]]), new Map([["rule.md", "Build `initech-api`.\nDeploy `umbrella-api`."]]), new Set(["k"]), {}))).toBe("F5");
  });

  it("E8, E9, E13: a changed literal, a line count, braces", () => {
    expect(tag(one("Deploy `{{k}}` first.", "Ship `initech-api` first.", ["k"]))).toBe("F5");
    expect(tag(infer(new Map([["r", "Port {{p}}.\n"]]), new Map([["r", "Port 80\n81.\n"]]), new Set(["p"]), {}))).toBe("F5");
    expect(tag(one("cfg {{k}} end", "cfg {x} end", ["k"]))).toBe("F7");
  });

  it("E10: an empty value is not a solution (F7 names it)", () => {
    const r = one("Deploy `{{k}}` first.", "Deploy `` first.", ["k"]);
    expect(tag(r)).toBe("F7");
    expect("reason" in r && r.reason).toBe('k would be "", which a parameter cannot carry');
  });

  it("E11, E12: an Angular pipe and an undeclared placeholder are literal text", () => {
    expect(tag(one("Labels read {{ 'Save' | localize }} on {{host}}.", "Labels read {{ 'Save' | localize }} on acme.dev.", ["host"]))).toEqual({ host: "acme.dev" });
    expect(tag(one("Hi {{title}} on {{host}}.", "Hi {{title}} on acme.dev.", ["host"]))).toEqual({ host: "acme.dev" });
  });

  it("E14: a repeated key makes the split unique", () => {
    expect(tag(one("{{a}}-{{a}}", "x-y-x-y", ["a"]))).toEqual({ a: "x-y" });
  });

  it("a fixed key renders with the map before matching", () => {
    expect(tag(one("{{host}}: {{k}}", "acme.dev: initech-api", ["k"], { host: "acme.dev" }))).toEqual({ k: "initech-api" });
    expect(tag(one("{{host}}: {{k}}", "other.dev: initech-api", ["k"], { host: "acme.dev" }))).toBe("F5");
  });

  it("edge whitespace is refused (F7)", () => {
    expect(tag(one("a {{k}}|", "a  x|", ["k"]))).toBe("F7");
  });
});

describe("renderedFingerprint — identity with fingerprintDir (spec 10 AC 1, 2)", () => {
  const GOLDEN = path.resolve(__dirname, "golden");
  const reader = {
    readText: (abs: string) => fs.readFile(abs, "utf8"),
    readBytes: (abs: string) => fs.readFile(abs),
    list: (dir: string) => listFiles(dir),
  };

  it("equals fingerprintDir for every ingredient with nothing declared and nothing set", async () => {
    for (const forge of ["forge-unify", "forge-param", "import-acme-portal-expected"]) {
      const root = path.join(GOLDEN, forge, "ingredients");
      for (const type of await fs.readdir(root)) {
        for (const name of await fs.readdir(path.join(root, type))) {
          const dir = path.join(root, type, name);
          expect(renderedFingerprint(await readBase(dir, reader), {}), dir).toBe(await fingerprintDir(dir));
        }
      }
    }
  });

  it("renders a declared default and cites its keys", async () => {
    const dir = path.join(GOLDEN, "forge-param-expected/ingredients/rules/deploy");
    const base = await readBase(dir, reader);
    expect([...citedKeys(base.texts)].sort()).toEqual(["deploy.api", "deploy.web"]);
    const map = renderMap(base.meta, { "deploy.api": "acme-api" }, {});
    expect(map["deploy.api"]).toBe("acme-api");
    expect(map["deploy.web"]).toBe("globex-web");
    expect(renderedFingerprint(base, map)).not.toBe(renderedFingerprint(base, {}));
  });
});

describe("the render with sections (spec 11 §6.7)", () => {
  const reader = {
    readText: (abs: string) => fs.readFile(abs, "utf8"),
    readBytes: (abs: string) => fs.readFile(abs),
    list: (dir: string) => listFiles(dir),
  };
  const BODY = "# Review\n\n<!-- craftar:section flavors -->\n| `acme-api` | {{reviewer}} |\n<!-- /craftar:section -->\n\nNever edit {{target}}.\n";
  async function forgeWith(files: Record<string, string>) {
    const root = await tmpDir("craftar-ti-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await writeFiles(root, { "ingredients/rules/review/ingredient.yaml": "type: rule\nname: review\n", ...files });
    return { root, dir: path.join(root, "ingredients/rules/review") };
  }
  const fp = (text: string) => fingerprintOf(IngredientSchema.parse({ type: "rule", name: "review" }), { "rule.md": text });

  it("expands before substituting: with no value the render is the body without its marker lines", async () => {
    const { root, dir } = await forgeWith({ "ingredients/rules/review/rule.md": BODY });
    const base = await readBase(dir, reader, root);
    expect(base.parsed.get("rule.md")!.sections.map((s) => s.name)).toEqual(["flavors"]);
    expect(renderedFingerprint(base, { reviewer: "bob", target: "x" })).toBe(fp("# Review\n\n| `acme-api` | bob |\n\nNever edit x.\n"));
  });

  it("renders a section value, which may cite a key the map sets", async () => {
    const { root, dir } = await forgeWith({ "ingredients/rules/review/rule.md": BODY });
    const base = await readBase(dir, reader, root);
    expect(renderedFingerprint(base, { target: "x", owner: "ann" }, { flavors: "| `globex-api` | {{owner}} |" })).toBe(fp("# Review\n\n| `globex-api` | ann |\n\nNever edit x.\n"));
  });

  it("C(X) is read over the expanded text: a key cited only by a replaced default is not cited, one in the value is", async () => {
    const { root, dir } = await forgeWith({ "ingredients/rules/review/rule.md": BODY });
    const base = await readBase(dir, reader, root);
    expect([...citedKeys(expandedTexts(base))].sort()).toEqual(["reviewer", "target"]);
    expect([...citedKeys(expandedTexts(base, { flavors: "{{owner}}\n" }))].sort()).toEqual(["owner", "target"]);
  });

  it("I12: a malformed marker, or a name declared twice across files, refuses naming the Forge-relative file and line", async () => {
    const bad = await forgeWith({ "ingredients/rules/review/rule.md": "a\n<!-- craftar:section flavors -->\nx\n" });
    await expect(readBase(bad.dir, reader, bad.root)).rejects.toThrow("import: ingredients/rules/review/rule.md:2: section flavors is never closed — fix the Forge and re-run");
    const twice = await forgeWith({
      "ingredients/rules/review/ingredient.yaml": "type: skill\nname: review\nlayout: dir\n",
      "ingredients/rules/review/SKILL.md": "<!-- craftar:section a -->\n<!-- /craftar:section -->\n",
      "ingredients/rules/review/reference.md": "<!-- craftar:section a -->\n<!-- /craftar:section -->\n",
    });
    await expect(readBase(twice.dir, reader, twice.root)).rejects.toThrow("import: ingredients/rules/review/reference.md:1: section a is declared twice in skill/review (also ingredients/rules/review/SKILL.md:1)");
  });
});
