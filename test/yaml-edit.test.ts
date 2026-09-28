import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { editYamlText } from "../src/core/yaml-edit.js";

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
      "import: cannot edit profiles/acme/profile.yaml in place (it does not round-trip unchanged through the YAML writer) — reformat it by hand, commit, and re-run",
    );
    expect(err(() => editYamlText("x: &r [a]\nrecipes: *r\n", opts, () => {}))).toContain("import: cannot edit profiles/acme/profile.yaml in place (recipes is an alias)");
  });
});
