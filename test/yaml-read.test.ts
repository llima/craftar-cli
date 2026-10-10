import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listFiles, loadForge } from "../src/core/forge.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { manifestWithSections } from "../src/core/manifest-edit.js";
import { parseWorkspaceYaml } from "../src/core/workspace-yaml.js";
import { YamlSyntaxError, parseYamlText, yamlFault } from "../src/core/yaml-read.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";

// A YAML error or warning never carries the source text: a line can hold a credential (tech debt 2026-10-10).

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

// Assembled at runtime; it must never come back in a message or a warning.
const M = ["ZZ", "MARKER", "ZZ"].join("");
const URL = `https://user:${M}@pkgs.example.com/x`;
/** Three lines whose third is a sequence item indented one column short — MISSING_CHAR on that line, column 1. */
const BROKEN = `zz:\n  - k: v\n   url: ${URL}\n`;
const caught = (run: () => unknown): Error => {
  try {
    run();
  } catch (e) {
    return e as Error;
  }
  throw new Error("did not throw");
};
/** Every yaml warning channel, recorded instead of printed. */
function silenced() {
  const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => [...emit.mock.calls, ...warn.mock.calls];
}

describe("parseYamlText", () => {
  it("a syntax error names the file, the code and the place — never the line", () => {
    const e = caught(() => parseYamlText("profiles/acme/profile.yaml", BROKEN));
    expect(e).toBeInstanceOf(YamlSyntaxError);
    expect(e.message).toBe("invalid profiles/acme/profile.yaml: MISSING_CHAR at line 3, column 1");
    expect((e as YamlSyntaxError).fault).toBe("MISSING_CHAR at line 3, column 1");
    expect(yamlFault(e)).toBe("MISSING_CHAR at line 3, column 1");
  });

  it.each([
    ["a duplicate key", `a: 1\na: ${URL}\n`, "invalid x.yaml: DUPLICATE_KEY at line 2, column 1"],
    ["an alias with no anchor (the package gives no code and no place)", `a: *${M}\n`, "invalid x.yaml: YAML syntax error"],
    ["an unclosed quote", `a: "${URL}\nb: 1\n`, null],
    ["an unclosed flow sequence", `a: [${URL}\n`, null],
    ["a tab as indentation", `a:\n\t- ${URL}\n`, null],
  ] as Array<[string, string, string | null]>)("%s: the message holds no source text", (_name, text, message) => {
    const e = caught(() => parseYamlText("x.yaml", text));
    expect(e).toBeInstanceOf(YamlSyntaxError);
    if (message !== null) expect(e.message).toBe(message);
    expect(e.message).toMatch(/^invalid x\.yaml: ([A-Z_]+ at line \d+, column \d+|YAML syntax error)$/);
    expect(e.message).not.toContain(M);
    expect(e.message).not.toContain("\n");
  });

  it("emits no yaml warning for an unresolved tag or a collection used as a key, and still returns the value", () => {
    const calls = silenced();
    expect(parseYamlText("x.yaml", `a: !secret ${URL}\n`)).toEqual({ a: URL });
    expect(Object.keys(parseYamlText("x.yaml", `? [${URL}, b]\n: 1\n`) as object)).toHaveLength(1);
    expect(calls()).toEqual([]);
  });

  it("strips a BOM, and reads an empty document as null (control)", () => {
    expect(parseYamlText("x.yaml", "\uFEFFa: 1\n")).toEqual({ a: 1 });
    expect(parseYamlText("x.yaml", "")).toBeNull();
  });

  it("parseWorkspaceYaml is the same function under its own name (control)", () => {
    expect(caught(() => parseWorkspaceYaml("craftar.yaml", BROKEN)).message).toBe("invalid craftar.yaml: MISSING_CHAR at line 3, column 1");
  });
});

describe("loadForge on a Forge file with a YAML syntax error", () => {
  const HEADS: Record<string, string> = {
    "craftar.forge.yaml": "name: test-forge\nschema: 1\n",
    "recipes/base.yaml": "name: base\ningredients: [rule/style]\n",
    "profiles/acme/profile.yaml": "name: acme\nrecipes: [base]\n",
    "ingredients/rules/style/ingredient.yaml": "type: rule\nname: style\n",
  };
  it.each(Object.keys(HEADS))("%s: names the file and the place, never the line", async (rel) => {
    const root = await tmpDir("craftar-yaml-read-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] });
    await writeFiles(root, { [rel]: HEADS[rel] + BROKEN });
    const e = await loadForge(root).then(
      () => null,
      (x: Error) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e!.message.startsWith("invalid ")).toBe(true);
    expect(e!.message.endsWith(`${path.basename(rel)}: MISSING_CHAR at line 5, column 1`)).toBe(true);
    expect(e!.message).not.toContain(M);
    expect(e!.message).not.toContain("\n");
  });

  it("a file that loads emits no yaml warning (an unresolved tag on a line holding a URL)", async () => {
    const root = await tmpDir("craftar-yaml-read-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] });
    await writeFiles(root, { "profiles/acme/profile.yaml": `name: acme\nrecipes: [base]\ndescription: !secret ${URL}\n` });
    const calls = silenced();
    const forge = await loadForge(root);
    expect(forge.profiles.get("acme")!.description).toBe(URL);
    expect(calls()).toEqual([]);
  });

  it("a schema error keeps its message: the file and the fields (control)", async () => {
    const root = await tmpDir("craftar-yaml-read-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] });
    await writeFiles(root, { "recipes/base.yaml": "name: 7\ningredients: []\n" });
    const e = await loadForge(root).then(
      () => null,
      (x: Error) => x,
    );
    expect(e!.message).toMatch(/^invalid .*base\.yaml: name: /);
    expect(e!.message).toContain("Expected string, received number");
  });
});

describe("the other readers", () => {
  it("frontmatter: a tag YAML cannot resolve emits no warning, and the data is what it was", () => {
    const calls = silenced();
    const parsed = parseFrontmatter(`---\ndescription: !secret ${URL}\n---\nbody\n`);
    expect(parsed.data).toEqual({ description: URL });
    expect(parsed.body).toBe("body\n");
    expect(calls()).toEqual([]);
  });

  it("frontmatter YAML rejects still falls back to the loose parser (control)", () => {
    expect(parseFrontmatter("---\ntools: Read, Grep: x\nname: a\n---\nb\n").data).toEqual({ tools: "Read, Grep: x", name: "a" });
  });

  it("manifestWithSections: a manifest that does not parse is refused with the place, never the line", () => {
    const e = caught(() => manifestWithSections(`name: f\nschema: 1\n${BROKEN}`, "import"));
    expect(e.message).toContain("it does not parse: MISSING_CHAR at line 5, column 1");
    expect(e.message).not.toContain(M);
    expect(e.message).not.toContain("\n");
  });
});

describe("yamlFault prints only a code and numbers", () => {
  it("a code that is not upper-case letters and underscores is not printed", () => {
    expect(yamlFault({ code: `bad ${M}`, linePos: [{ line: 1, col: 2 }] })).toBe("YAML syntax error");
    expect(yamlFault({ code: 7 })).toBe("YAML syntax error");
  });

  it("a position that is not two integers is not printed", () => {
    expect(yamlFault({ code: "MISSING_CHAR", linePos: [{ line: M, col: 1 }] })).toBe("MISSING_CHAR");
    expect(yamlFault({ code: "MISSING_CHAR", linePos: [{ line: 3, col: 1 }] })).toBe("MISSING_CHAR at line 3, column 1");
  });
});

describe("one caller of YAML.parse", () => {
  it("src/core/yaml-read.ts is the only file under src/ that calls YAML.parse(", async () => {
    const src = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || f === "core/yaml-read.ts") continue;
      if (/\bYAML\.parse\(/.test(await fs.readFile(path.join(src, f), "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("no file under src/ imports a named parse from the yaml package", async () => {
    const src = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts")) continue;
      if (/import\s*(?:YAML\s*,\s*)?\{[^}]*\bparse\b[^}]*\}\s*from\s*"yaml"/.test(await fs.readFile(path.join(src, f), "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
