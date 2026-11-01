import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { editYamlText, readBackDifference } from "../src/core/yaml-edit.js";

const opts = { command: "import", label: "profiles/acme/profile.yaml", keys: ["params", "recipes"] };
const err = (f: () => unknown) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("editYamlText (spec 10 §6.6)", () => {
  it("edits a file written with no folding, keeping a long line on one line", () => {
    const raw = `name: acme\ndescription: ${"x".repeat(120)}\n`;
    expect(editYamlText(raw, opts, (d) => d.setIn(["params", "k"], "v"))).toBe(`${raw}params:\n  k: v\n`);
  });

  it("edits a file written at yaml's default width, keeping its fold (the import-written profile)", () => {
    const raw = YAML.stringify({ name: "acme", description: `Imported from ${"a-very-long-workspace-name-".repeat(3)} on 2026-09-26.`, params: {} });
    expect(raw).toContain("\n  "); // folded by the default width
    const out = editYamlText(raw, opts, (d) => d.setIn(["params", "k"], "v"));
    expect(out).toBe(raw.replace("params: {}\n", "params:\n  k: v\n"));
  });

  it("keeps CRLF, a BOM and comments", () => {
    const bom = String.fromCharCode(0xfeff);
    const raw = `${bom}# client\r\nname: acme # the name\r\n`;
    expect(editYamlText(raw, opts, (d) => d.setIn(["params", "k"], "v"))).toBe(`${bom}# client\r\nname: acme # the name\r\nparams:\r\n  k: v\r\n`);
  });

  it("keeps an empty flow collection the edit does not touch on its line (params: {} survives a recipes edit)", () => {
    const raw = "name: acme\nrecipes:\n  - base--acme\ntargets: []\nparams: {}\nsections: {}\n";
    const o = { ...opts, keys: ["params", "sections", "recipes", "targets"] };
    const out = editYamlText(raw, o, (d) => {
      const seq = d.get("recipes", true) as YAML.YAMLSeq;
      seq.items = [d.createNode("base")];
    });
    expect(out).toBe("name: acme\nrecipes:\n  - base\ntargets: []\nparams: {}\nsections: {}\n");
    expect(editYamlText(raw, o, () => {})).toBe(raw);
  });

  it("turns an empty flow collection the edit fills into block form, as before", () => {
    const raw = "name: acme\ntargets: []\nparams: {}\nsections: {}\n";
    const o = { ...opts, keys: ["params", "sections", "targets"] };
    const out = editYamlText(raw, o, (d) => {
      d.setIn(["params", "k"], "v");
      d.setIn(["sections", "rule/review-posture", "flavors"], "| a |\n");
      (d.get("targets", true) as YAML.YAMLSeq).items.push(d.createNode("kiro"));
    });
    expect(out).toBe("name: acme\ntargets:\n  - kiro\nparams:\n  k: v\nsections:\n  rule/review-posture:\n    flavors: |\n      | a |\n");
  });

  it("refuses a document that round-trips under neither width, and an aliased key, naming the command", () => {
    expect(err(() => editYamlText("name: acme      # aligned\n", opts, () => {}))).toBe(
      "import: cannot edit profiles/acme/profile.yaml in place (it does not round-trip unchanged through the YAML writer: line 1, under name) — reformat it by hand, commit, and re-run",
    );
    expect(err(() => editYamlText("x: &r [a]\nrecipes: *r\n", opts, () => {}))).toContain("import: cannot edit profiles/acme/profile.yaml in place (recipes is an alias)");
  });
});

describe("editYamlText on a long one-line string (spec 50 Part C)", () => {
  const long = "line one of a section that is long enough\\nline two of it\\n";
  const edit = (raw: string) => editYamlText(raw, opts, (d) => d.setIn(["params", "k"], "v"));
  const cases: Array<[string, string]> = [
    ["a long string", `name: acme\nsections:\n  rule/x:\n    a: "${long}"\n`],
    ["an accent and a dash", `name: acme\nsections:\n  rule/x:\n    a: "café — ${long}"\n`],
    ["an escaped quote", `name: acme\nsections:\n  rule/x:\n    a: "say \\"hi\\" ${long}"\n`],
    ["beside a block", `name: acme\nsections:\n  rule/x:\n    a: "${long}"\n    b: |\n      one\n      two\n`],
    ["a width no fold reproduces", `name: acme\nsections:\n  rule/x:\n    a: "${"word ".repeat(30).trim()}\\n${"word ".repeat(30).trim()}"\n`],
  ];
  it.each(cases)("%s: only the new lines are added", (_n, raw) => {
    expect(edit(raw)).toBe(`${raw}params:\n  k: v\n`);
  });
  it("keeps CRLF", () => {
    const raw = `name: acme\nsections:\n  rule/x:\n    a: "${long}"\n`;
    expect(edit(raw.replace(/\n/g, "\r\n"))).toBe(`${raw}params:\n  k: v\n`.replace(/\n/g, "\r\n"));
  });
  it("a new value next to such a string reads back exactly", () => {
    const raw = `name: acme\nsections:\n  rule/x:\n    a: "${long}"\n`;
    const value = "first line of a new section value\nsecond line of it\n";
    const out = editYamlText(raw, opts, (d) => d.setIn(["sections", "rule/y", "z"], value));
    expect(out.startsWith(raw)).toBe(true);
    expect(YAML.parse(out).sections["rule/y"].z).toBe(value);
  });
  it("a document at the default width keeps its width", () => {
    const raw = YAML.stringify({ name: "acme", description: `Imported from ${"a-very-long-workspace-name-".repeat(3)}`, params: {} });
    expect(edit(raw)).toBe(raw.replace("params: {}\n", "params:\n  k: v\n"));
  });
});

describe("editYamlText's refusal names where (spec 50 §6.2)", () => {
  const prefix = "import: cannot edit profiles/acme/profile.yaml in place (it does not round-trip unchanged through the YAML writer";
  it("an escape the writer does not reproduce: the line and the key, never the value", () => {
    const m = err(() => editYamlText('name: acme\nsections:\n  rule/x:\n    a: "SECRETVALUE caf\\u00e9"\n', opts, () => {}));
    expect(m).toBe(`${prefix}: line 4, under sections › rule/x › a) — write that value as a | block or without its escape, commit, and re-run`);
    expect(m).not.toContain("SECRETVALUE");
  });
  it("counts lines of a CRLF file with a BOM", () => {
    const m = err(() => editYamlText(`${String.fromCharCode(0xfeff)}name: acme\r\nb: "caf\\u00e9"\r\n`, opts, () => {}));
    expect(m).toContain(": line 2, under b)");
  });
  it("a line that is no double-quoted value keeps the old fix", () => {
    expect(err(() => editYamlText("name: acme      # aligned\n", opts, () => {}))).toBe(`${prefix}: line 1, under name) — reformat it by hand, commit, and re-run`);
  });
  it("a key not shaped like a key, or holding a token, is named by its position", () => {
    const token = "ghp_" + "x".repeat(36);
    for (const key of [token, "two words"]) {
      const m = err(() => editYamlText(`first: 1\n${key}: "caf\\u00e9"\n`, opts, () => {}));
      expect(m).toContain(": line 2, under #2)");
      expect(m).not.toContain(key);
    }
  });
  it("an item of a list is named by its position", () => {
    expect(err(() => editYamlText('recipes:\n  - a\n  - "caf\\u00e9"\n', opts, () => {}))).toContain(": line 3, under recipes › #2)");
  });
  it("a line under no key says the line only", () => {
    expect(err(() => editYamlText("\n\n\n# a comment\nname: acme\n", opts, () => {}))).toContain(`${prefix}: line 1) — reformat`);
  });
  it("a syntax error keeps the bare refusal and prints nothing of the line", () => {
    const m = err(() => editYamlText('name: "SECRETVALUE\n', opts, () => {}));
    expect(m).toBe(`${prefix}) — reformat it by hand, commit, and re-run`);
  });
  it("a key that is no name, an email-shaped one, is named by its position", () => {
    const m = err(() => editYamlText('first: 1\nsomeone@example.com: "caf\\u00e9"\n', opts, () => {}));
    expect(m).toContain(": line 2, under #2)");
    expect(m).not.toContain("example.com");
  });
});

describe("readBackDifference (spec 50 §6.2)", () => {
  it("names the first difference and its kind, never a value", () => {
    expect(readBackDifference({ a: { b: "SECRET" } }, { a: { b: "OTHER" } })).toBe("a › b reads back changed");
    expect(readBackDifference({ a: "\n" }, { a: "  \n" })).toBe("a reads back changed, whitespace only");
    expect(readBackDifference({}, { a: 1 })).toBe("a reads back missing");
    expect(readBackDifference({ a: 1 }, {})).toBe("a reads back added");
    expect(readBackDifference({ l: [1] }, { l: [1, 2] })).toBe("l › #2 reads back missing");
    expect(readBackDifference({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeNull();
    expect(readBackDifference("SECRET", "OTHER")).toBe("the document reads back changed");
    expect(readBackDifference({ ["ghp_" + "x".repeat(36)]: 1 }, {})).toBe("#1 reads back added");
  });
});
