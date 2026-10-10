import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listFiles } from "../src/core/forge.js";
import { SchemaError, errorText, schemaFault, schemaIssues, shownSchema } from "../src/core/schema-fault.js";
import { ForgeManifestSchema, IngredientSchema, ProfileSchema, WorkspaceConfigSchema } from "../src/schema/index.js";

const M = ["ZZ", "MARKER", "ZZ"].join("");

function refusal(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown): unknown {
  const r = schema.safeParse(value);
  if (r.success) throw new Error("expected the schema to refuse the value");
  return r.error;
}

describe("schemaFault words a refusal without the value", () => {
  const cases: Array<[string, unknown, string]> = [
    ["an enum", refusal(ProfileSchema, { name: "acme", scm: { kind: M } }), "scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'"],
    ["an enum inside an array", refusal(WorkspaceConfigSchema, { forge: ".", profile: "acme", targets: [M] }), "targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md'"],
    ["a union of literals", refusal(ForgeManifestSchema, { name: "f", schema: M }), "schema: Invalid input (Invalid literal value, expected 1 | Invalid literal value, expected 2)"],
    ["a union of an array and a literal", refusal(IngredientSchema, { type: "rule", name: "s", targets: M }), 'targets: Invalid input (Expected array, received string | Invalid literal value, expected "*")'],
    ["an enum inside a union", refusal(IngredientSchema, { type: "rule", name: "s", targets: [M] }), "targets: Invalid input (Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md' | Invalid literal value, expected \"*\")"],
    ["a discriminator", refusal(IngredientSchema, { type: M, name: "s" }), "type: Invalid discriminator value. Expected 'rule' | 'agent' | 'command' | 'skill' | 'mcp' | 'script' | 'steering' | 'hook'"],
    ["a literal", refusal(z.object({ schema: z.literal(1) }), { schema: M }), "schema: Invalid literal value, expected 1"],
    ["several issues, in zod's order", refusal(ProfileSchema, { scm: { kind: M } }), "name: Required; scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'"],
    ["a wrong type", refusal(z.object({ profile: z.string() }), { profile: 3 }), "profile: Expected string, received number"],
    ["the top level", refusal(z.string(), 1), "top level: Expected string, received number"],
  ];

  it.each(cases)("%s", (_name, error, fault) => {
    expect(JSON.stringify(error)).toBeTypeOf("string");
    expect(schemaFault(error)).toBe(fault);
    expect(schemaFault(error)).not.toContain(M);
    expect(schemaFault(error)).not.toContain("\n");
  });

  it("the cases above would leak through zod's own message — the test discriminates", () => {
    const leaking = cases.filter(([, error]) => (error as Error).message.includes(M)).map(([name]) => name);
    expect(leaking).toEqual(["an enum", "an enum inside an array", "a union of literals", "a union of an array and a literal", "an enum inside a union", "a literal", "several issues, in zod's order"]);
  });

  it("an unrecognized key is named — the name is what the user must fix", () => {
    expect(schemaFault(refusal(IngredientSchema, { type: "rule", name: "s", extra: 1 }))).toBe("top level: Unrecognized key(s) in object: 'extra'");
  });

  it("a message of ours is kept as written", () => {
    expect(schemaFault(refusal(ProfileSchema, JSON.parse('{"name":"acme","params":{"__proto__":1}}')))).toBe("params.__proto__: a __proto__ key is not allowed");
  });

  it("an issue list that is not zod's yields no field but the path and a message", () => {
    expect(schemaFault({ issues: [{ code: "invalid_enum_value", path: ["a", 0], received: M }] })).toBe("a.0: Invalid enum value. Expected ");
    expect(schemaFault({ issues: [{ code: "x", path: "nope", message: 7, received: M }] })).toBe("top level: Invalid input");
    expect(schemaIssues(new Error(M))).toEqual([]);
    expect(schemaIssues(null)).toEqual([]);
  });
});

describe("SchemaError and errorText", () => {
  const error = refusal(ProfileSchema, { scm: { kind: M } });

  it("SchemaError is `<what>: <fault>` on one line and keeps its issues", () => {
    const e = new SchemaError("invalid profiles/acme/profile.yaml", error);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SchemaError");
    expect(e.what).toBe("invalid profiles/acme/profile.yaml");
    expect(e.message).toBe("invalid profiles/acme/profile.yaml: name: Required; scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'");
    expect(e.issues).toEqual([
      { path: "name", text: "Required" },
      { path: "scm.kind", text: "Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'" },
    ]);
    expect(schemaIssues(e)).toBe(e.issues);
  });

  it("errorText never returns zod's dump", () => {
    expect(errorText(error)).toBe("name: Required; scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'");
    expect(errorText(new SchemaError("invalid x", error))).toBe("invalid x: name: Required; scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'");
    expect(errorText(new Error("plain"))).toBe("plain");
    expect(errorText("text")).toBe("text");
  });
});

describe("shownSchema prints a schema number only when it is one", () => {
  it("a whole number is printed; anything else is not", () => {
    expect(shownSchema(3)).toBe("3");
    expect(shownSchema(0)).toBe("0");
    expect(shownSchema(M)).toBe("(not a whole number)");
    expect(shownSchema(1.5)).toBe("(not a whole number)");
    expect(shownSchema({ k: M })).toBe("(not a whole number)");
    expect(shownSchema(null)).toBe("(not a whole number)");
  });
});

describe("no file under src/ prints zod's own message or a JSON.parse message", () => {
  const src = path.resolve(__dirname, "..", "src");
  const scan = async (pattern: RegExp, skip: string[] = []) => {
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || skip.includes(f)) continue;
      const lines = (await fs.readFile(path.join(src, f), "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    return offenders;
  };

  it("a safeParse result's error is never read for its message", async () => {
    expect(await scan(/\.error\.message\b/)).toEqual([]);
  });

  it("the line that calls JSON.parse on a file does not build a message from the error", async () => {
    expect(await scan(/JSON\.parse\(.*\.message/)).toEqual([]);
  });
});
