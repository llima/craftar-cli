import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Spec 35 §7 (read-only by construction), §10.2 (imports): what the server reaches for, as an allow-list of VALUE
// imports. `import type` is not counted. One level deep — the proof that nothing is written is test/mcp-cli.test.ts.
// The scan is a parity check: every line that could bring a module in must be one it understood, so an import
// spelled another way fails the test instead of slipping past it.

const SRC = path.resolve(__dirname, "../src");

/** The text without its comments: a word in a comment is not code. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

/** Every value import of a source text: module specifier → the names imported (`*` for a default or namespace import). */
export function valueImports(source: string): Record<string, string[]> {
  const text = code(source);
  const out: Record<string, string[]> = {};
  const add = (from: string, names: string[]) => (out[from] = [...new Set([...(out[from] ?? []), ...names])].sort());
  let understood = 0;
  for (const m of text.matchAll(/^import\s+(type\s+(?=[{*\w]))?([^"';]*?)\s+from\s+"([^"]+)";?[ \t]*$/gm)) {
    understood++;
    // `import type { … }` and `import type X from …` bring no value
    if (m[1]) continue;
    const clause = m[2].trim();
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (!braces) {
      add(m[3], ["*"]);
      continue;
    }
    if (clause.replace(braces[0], "").replace(",", "").trim() !== "") add(m[3], ["*"]); // a default import beside the braces
    const names = braces[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0]);
    if (names.length) add(m[3], names);
  }
  // Anything else that can bring a module in is not understood, and says so: a single-quoted or side-effect import,
  // a re-export, a dynamic import, require, process.getBuiltinModule, an import this scanner could not parse.
  const statements = (text.match(/^\s*import\b(?!\s*\()/gm) ?? []).length;
  const other = /\bimport\s*\(|\brequire\s*\(|\bgetBuiltinModule\b|^\s*import\s*["']|^\s*export\b[^\n]*\bfrom\b/m.test(text);
  if (other || statements !== understood) add("<not understood>", ["*"]);
  return out;
}
const fileImports = (file: string) => valueImports(readFileSync(path.join(SRC, file), "utf8"));
/** `console` or `process` used as a value, comments aside. */
const prints = (file: string) => /\b(console|process)\s*[.[(]/.test(code(readFileSync(path.join(SRC, file), "utf8")));

describe("craftar mcp — what the server may import", () => {
  it("src/mcp.ts imports nothing of the project but the protocol core, and no node:fs or readline", () => {
    expect(fileImports("mcp.ts")).toEqual({ "./core/mcp-protocol.js": ["handleLine"] });
  });

  it("src/core/mcp-protocol.ts imports only the readers named by the spec", () => {
    expect(fileImports("core/mcp-protocol.ts")).toEqual({
      "./catalogue.js": ["catalogueContext", "checkType", "listIngredients", "listRecipes", "withLoadWarnings"],
      "./diff.js": ["renderDiff"],
      "./doctor.js": ["runDoctor", "workspaceReport"],
      "./drift.js": ["unmanaged"],
      "./report.js": ["cachedCopyLine", "diffReport", "explainFile", "notProduced", "statusPath", "statusReport", "targetsReport"],
      "./schema-fault.js": ["errorText", "schemaFault"],
      "./sync.js": ["loadForgeFor", "plan", "readLock", "readWorkspaceConfig", "status"],
      zod: ["z"],
    });
  });

  it("neither module touches console or process", () => {
    expect(prints("mcp.ts")).toBe(false);
    expect(prints("core/mcp-protocol.ts")).toBe(false);
    expect(prints("cli.ts")).toBe(true); // (control) the scan sees them where they are
  });
});

describe("the scanner", () => {
  const scan = (line: string) => valueImports(`import { z } from "zod";\n${line}\nexport const x = 1;\n`);
  const understood = { zod: ["z"] };

  it("reads what it understands: named, aliased, default, namespace and type-only imports", () => {
    expect(scan('import { a, b as c, type T } from "./m.js";')).toEqual({ ...understood, "./m.js": ["a", "b"] });
    expect(scan('import d from "./m.js";')).toEqual({ ...understood, "./m.js": ["*"] });
    expect(scan('import * as ns from "./m.js";')).toEqual({ ...understood, "./m.js": ["*"] });
    expect(scan('import d, { a } from "./m.js";')).toEqual({ ...understood, "./m.js": ["*", "a"] });
    expect(scan('import {\n  a,\n  b,\n} from "./m.js";')).toEqual({ ...understood, "./m.js": ["a", "b"] });
    expect(scan('import type { T } from "./m.js";')).toEqual(understood);
    expect(scan('import type D from "./m.js";')).toEqual(understood);
    expect(scan('import { a } from "./m.js"')).toEqual({ ...understood, "./m.js": ["a"] }); // no semicolon
    expect(scan('// import { apply } from "./sync.js";')).toEqual(understood); // a comment is not code
  });

  it.each([
    ["a single-quoted import", "import { apply } from './core/sync.js';"],
    ["a single-quoted builtin", "import { promises as fs } from 'node:fs';"],
    ["a side-effect import", 'import "./core/sync.js";'],
    ["a single-quoted side-effect import", "import './core/sync.js';"],
    ["a re-export", 'export { apply } from "./core/sync.js";'],
    ["a star re-export", 'export * from "./core/sync.js";'],
    ["a dynamic import", 'const m = await import("./core/sync.js");'],
    ["a dynamic import with a space", 'const m = await import ("node:fs");'],
    ["require", 'const fs = require("node:fs");'],
    ["process.getBuiltinModule", 'const fs = process.getBuiltinModule("node:fs");'],
  ])("fails closed on %s", (_name, line) => {
    expect(scan(line)["<not understood>"]).toEqual(["*"]);
  });
});
