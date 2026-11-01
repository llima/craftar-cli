import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// Spec 35 §7 (read-only by construction), §10.2 (imports): what the server reaches for, as an allow-list of VALUE
// imports. `import type` is not counted. One level deep — the proof that nothing is written is test/mcp-cli.test.ts.
// The scan reads TypeScript's own syntax tree, so no spelling of an import can slip past it.

const SRC = path.resolve(__dirname, "../src");

interface Scan {
  /** Module specifier → the value names imported (`*` for a default or namespace import). */
  imports: Record<string, string[]>;
  /** Anything else that brings a module in, or reaches the process: each one is a finding. */
  other: string[];
}

/**
 * What a source text reaches for, read off TypeScript's own syntax tree — not off its lines, so the spelling of an
 * import (quotes, position on the line, line breaks, a comment-looking string beside it) cannot hide one.
 */
export function scan(source: string): Scan {
  const file = ts.createSourceFile("scanned.ts", source, ts.ScriptTarget.ESNext, true);
  const imports: Record<string, string[]> = {};
  const other: string[] = [];
  const add = (from: string, names: string[]) => (imports[from] = [...new Set([...(imports[from] ?? []), ...names])].sort());
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const from = (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = node.importClause;
      if (!clause) other.push(`side-effect import "${from}"`);
      else if (!clause.isTypeOnly) {
        if (clause.name) add(from, ["*"]);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) add(from, ["*"]);
        if (bindings && ts.isNamedImports(bindings)) {
          const names = bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
          if (names.length) add(from, names);
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) other.push(`re-export from "${(node.moduleSpecifier as ts.StringLiteral).text}"`);
    if (ts.isImportEqualsDeclaration(node)) other.push("import = require");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) other.push("dynamic import");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") other.push("require");
    }
    // The process and the console by name, the globals they hang from, and the two ways to evaluate a string. A key
    // computed at run time is not covered: this scan is one level deep, and the tree comparison is the proof.
    if (ts.isIdentifier(node) && ["process", "console", "globalThis", "global", "eval", "Function", "getBuiltinModule"].includes(node.text)) {
      const parent = node.parent;
      const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      if (!isKey) other.push(node.text);
    }
    if (ts.isStringLiteralLike(node) && ["process", "console"].includes(node.text) && ts.isElementAccessExpression(node.parent)) other.push(`["${node.text}"]`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, other: [...new Set(other)].sort() };
}
const fileScan = (file: string) => scan(readFileSync(path.join(SRC, file), "utf8"));

describe("craftar mcp — what the server may import", () => {
  it("src/mcp.ts imports nothing of the project but the protocol core; no node:fs, no readline, no process, no console", () => {
    expect(fileScan("mcp.ts")).toEqual({ imports: { "./core/mcp-protocol.js": ["handleLine"] }, other: [] });
  });

  it("src/core/mcp-protocol.ts imports only the readers named by the spec, and reaches neither process nor console", () => {
    expect(fileScan("core/mcp-protocol.ts")).toEqual({
      imports: {
        "./catalogue.js": ["catalogueContext", "checkType", "listIngredients", "listRecipes", "withLoadWarnings"],
        "./diff.js": ["renderDiff"],
        "./doctor.js": ["runDoctor", "workspaceReport"],
        "./drift.js": ["unmanaged"],
        "./report.js": ["cachedCopyLine", "diffReport", "explainFile", "notProduced", "statusPath", "statusReport", "targetsReport", "withEscapeLine"],
        "./schema-fault.js": ["errorText", "schemaFault"],
        "./sync.js": ["loadForgeFor", "plan", "readLock", "readWorkspaceConfig", "status"],
        zod: ["z"],
      },
      other: [],
    });
  });

  it("(control) the scan sees them where they are: src/cli.ts uses process and console, src/prompt.ts imports readline", () => {
    expect(fileScan("cli.ts").other).toEqual(expect.arrayContaining(["console", "process"]));
    expect(Object.keys(fileScan("prompt.ts").imports)).toEqual(["node:readline/promises"]);
  });
});

describe("the scan", () => {
  it("reads named, aliased, default, namespace and type-only imports, whatever their spelling", () => {
    const imports = (s: string) => scan(s).imports;
    expect(imports('import { a, b as c, type T } from "./m.js";')).toEqual({ "./m.js": ["a", "b"] });
    expect(imports("import { a } from './m.js'")).toEqual({ "./m.js": ["a"] });
    expect(imports('import d from "./m.js";')).toEqual({ "./m.js": ["*"] });
    expect(imports('import * as ns from "./m.js";')).toEqual({ "./m.js": ["*"] });
    expect(imports('import d, { a } from "./m.js";')).toEqual({ "./m.js": ["*", "a"] });
    expect(imports('import {\n  a,\n  b,\n} from "./m.js";')).toEqual({ "./m.js": ["a", "b"] });
    expect(imports('const y = 2; import { apply } from "./sync.js";')).toEqual({ "./sync.js": ["apply"] });
    expect(imports(';import { apply } from "./sync.js";')).toEqual({ "./sync.js": ["apply"] });
    expect(imports('const s = "/*";\nimport { promises as fs } from "node:fs";\nconst t = "*/";')).toEqual({ "node:fs": ["promises"] });
    expect(imports('import type { T } from "./m.js";\nimport type D from "./m.js";')).toEqual({});
    expect(imports('// import { apply } from "./sync.js";\n/* import x from "y"; */')).toEqual({});
  });

  it.each([
    ["a side-effect import", 'import "./core/sync.js";', 'side-effect import "./core/sync.js"'],
    ["a re-export", 'export { apply } from "./core/sync.js";', 're-export from "./core/sync.js"'],
    ["a re-export over several lines", 'export {\n  apply,\n} from "./core/sync.js";', 're-export from "./core/sync.js"'],
    ["a star re-export", "export * from './core/sync.js';", 're-export from "./core/sync.js"'],
    ["a dynamic import", 'const m = await import("./core/sync.js");', "dynamic import"],
    ["a dynamic import with a space", 'const m = await import ("node:fs");', "dynamic import"],
    ["require", 'const fs = require("node:fs");', "require"],
    ["process.getBuiltinModule", 'const fs = process.getBuiltinModule("node:fs");', "getBuiltinModule"],
    ["process, destructured", "const { stdout } = process;", "process"],
    ["process through globalThis", 'const p = globalThis["process"];', "globalThis"],
    ["console", 'console.error("x");', "console"],
    ["process through global", 'const k = "pro" + "cess"; const p = (global as any)[k];', "global"],
    ["process through Function", 'const p = Function("return process")();', "Function"],
    ["process through eval", 'const p = (0, eval)("process");', "eval"],
    ["a string key", 'const p = (0, eval)("this")["process"];', '["process"]'],
  ])("reports %s", (_name, source, finding) => {
    expect(scan(source).other).toContain(finding);
  });

  it("a word in a comment, a string or a property name is not a finding", () => {
    expect(scan('// process and console\nconst s = "process.exit"; const o = { process: 1 }; interface I { console: string }').other).toEqual([]);
  });
});
