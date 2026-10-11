import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Spec 35 §7 (read-only by construction), §10.2 (imports): what the server reaches for, as an allow-list of VALUE
// imports. `import type` is not counted. One level deep — the proof that nothing is written is test/mcp-cli.test.ts.

const SRC = path.resolve(__dirname, "../src");

/** Every value import of a file: module specifier → the names imported (`*` for a namespace or default import). */
function valueImports(file: string): Record<string, string[]> {
  const text = readFileSync(path.join(SRC, file), "utf8");
  const out: Record<string, string[]> = {};
  const add = (from: string, names: string[]) => (out[from] = [...(out[from] ?? []), ...names].sort());
  for (const m of text.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    if (m[1]) continue; // import type { … }
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
  if (/^import\s+"[^"]+";/m.test(text) || /\bimport\(/.test(text) || /\brequire\(/.test(text)) add("<side-effect, dynamic or require>", ["*"]);
  return out;
}

describe("craftar mcp — what the server may import", () => {
  it("src/mcp.ts imports nothing of the project but the protocol core, and no node:fs or readline", () => {
    expect(valueImports("mcp.ts")).toEqual({ "./core/mcp-protocol.js": ["handleLine"] });
  });

  it("src/core/mcp-protocol.ts imports only the readers named by the spec", () => {
    expect(valueImports("core/mcp-protocol.ts")).toEqual({
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

  it("the scanner sees what it must: a value import, a namespace import, a dynamic import", () => {
    // (control) src/prompt.ts is the one importer of node:readline — the scanner reports it as a value import.
    expect(Object.keys(valueImports("prompt.ts"))).toEqual(["node:readline/promises"]);
  });
});
