import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import type { Extraction } from "../src/core/extract.js";
import { checkParamWrites } from "../src/core/param-writes.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const ext = (key: string, def: string, value: string): Extraction => ({ key, default: def, value, sites: [{ file: "rule.md", hunk: 1 }], reused: false });

function spec(over: Partial<ForgeSpec> = {}): ForgeSpec {
  return {
    ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" }), ...(over.ingredients ?? [])],
    recipes: over.recipes ?? [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
    profiles: over.profiles ?? [profile("acme", ["base--acme"]), profile("globex", ["base"])],
  };
}

async function forgeOf(s: ForgeSpec, files: Record<string, string> = {}) {
  const root = await tmpDir("craftar-param-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await makeForge(root, s);
  await writeFiles(root, files);
  return loadForge(root);
}

async function check(forge: Awaited<ReturnType<typeof forgeOf>>, extractions: Extraction[], p = "acme") {
  return checkParamWrites(forge, forge.ingredients.get("rule/deploy")!, forge.ingredients.get("rule/deploy--acme")!, p, extractions);
}
const err = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

describe("checkParamWrites — the YAML edits (spec 09 §6.4)", () => {
  it("declares the default in ingredient.yaml and sets the value in the profile, quoting what YAML would retype", async () => {
    const forge = await forgeOf(spec());
    const w = await check(forge, [ext("deploy.api", "globex-api", "acme-api"), ext("port", "8080", "9090")]);
    expect(w.ingredientYaml!.content).toBe("type: rule\nname: deploy\nparams:\n  deploy.api:\n    default: globex-api\n  port:\n    default: \"8080\"\n");
    expect(YAML.parse(w.profile!.content).params).toEqual({ "deploy.api": "acme-api", port: "9090" });
    expect(w.mustHold).toEqual([w.profile!.abs]);
  });

  it("turns an imported profile's empty `params: {}` into a block map, and keeps CRLF", async () => {
    const forge = await forgeOf(spec(), { "profiles/acme/profile.yaml": "name: acme\r\nrecipes:\r\n  - base--acme\r\nparams: {}\r\n" });
    const w = await check(forge, [ext("k", "globex-api", "acme-api")]);
    expect(w.profile!.content).toBe("name: acme\r\nrecipes:\r\n  - base--acme\r\nparams:\r\n  k: acme-api\r\n");
  });

  it("keeps a comment and a BOM through the profile edit", async () => {
    const bom = String.fromCharCode(0xfeff);
    const forge = await forgeOf(spec(), { "profiles/acme/profile.yaml": `${bom}# the acme client\nname: acme\nrecipes:\n  - base--acme # its own recipe\n` });
    const w = await check(forge, [ext("k", "globex-api", "acme-api")]);
    expect(w.profile!.content).toBe(`${bom}# the acme client\nname: acme\nrecipes:\n  - base--acme # its own recipe\nparams:\n  k: acme-api\n`);
  });

  it("keeps a long untouched line on one line", async () => {
    const long = "x".repeat(160);
    const forge = await forgeOf(spec({ ingredients: [] }), { "ingredients/rules/deploy/ingredient.yaml": `type: rule\nname: deploy\ndescription: ${long}\n` });
    const w = await check(forge, [ext("k", "globex-api", "acme-api")]);
    expect(w.ingredientYaml!.content).toContain(`description: ${long}\n`);
  });

  it("writes nothing for a key already declared and valued exactly as needed", async () => {
    const forge = await forgeOf(
      spec({ ingredients: [], profiles: [profile("acme", ["base--acme"], ["claude-code"], { params: { k: "acme-api" } }), profile("globex", ["base"])] }),
      { "ingredients/rules/deploy/ingredient.yaml": "type: rule\nname: deploy\nparams:\n  k:\n    default: globex-api\n" },
    );
    const w = await check(forge, [ext("k", "globex-api", "acme-api")]);
    expect(w.ingredientYaml).toBeNull();
    expect(w.profile).toBeNull();
  });
});

describe("checkParamWrites — Forge-level refusals (spec 09 §6.3)", () => {
  it("P11: no such profile", async () => {
    expect(await err(check(await forgeOf(spec()), [ext("k", "g", "a")], "initech"))).toContain("no profile named initech");
  });

  it("P12: the variant is also used by another profile", async () => {
    const forge = await forgeOf(spec({ profiles: [profile("acme", ["base--acme"]), profile("globex", ["base--acme"])] }));
    expect(await err(check(forge, [ext("k", "g", "a")]))).toContain("is also used by profile globex");
  });

  it("P13: the key is declared with another default, or with none", async () => {
    const other = await forgeOf(spec({ ingredients: [] }), { "ingredients/rules/deploy/ingredient.yaml": "type: rule\nname: deploy\nparams:\n  k:\n    default: other\n" });
    expect(await err(check(other, [ext("k", "globex-api", "acme-api")]))).toContain("already declares k");
    const none = await forgeOf(spec({ ingredients: [] }), { "ingredients/rules/deploy/ingredient.yaml": "type: rule\nname: deploy\nparams:\n  k:\n    description: d\n" });
    expect(await err(check(none, [ext("k", "globex-api", "acme-api")]))).toContain("already declares k (default none)");
  });

  it("P14: the base cites the key undeclared, or the variant cites it", async () => {
    const b = await forgeOf(spec({ ingredients: [] }), { "ingredients/rules/deploy/rule.md": "use globex-api {{k}}\n" });
    expect(await err(check(b, [ext("k", "globex-api", "acme-api")]))).toContain("rule/deploy already uses {{k}}");
    const v = await forgeOf(spec({ ingredients: [] }), { "ingredients/rules/deploy--acme/rule.md": "use acme-api {{k}}\n" });
    expect(await err(check(v, [ext("k", "globex-api", "acme-api")]))).toContain("rule/deploy--acme already uses {{k}}");
  });

  it("P15, P16: a recipe or another profile sets the key to another value", async () => {
    const r = await forgeOf(spec({ recipes: [recipe("base", ["rule/deploy"], { params: { k: { default: "x" } } }), recipe("base--acme", ["rule/deploy--acme"])] }));
    expect(await err(check(r, [ext("k", "globex-api", "acme-api")]))).toContain("recipe base declares k");
    const p = await forgeOf(spec({ profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"], ["claude-code"], { params: { k: "x" } })] }));
    expect(await err(check(p, [ext("k", "globex-api", "acme-api")]))).toContain("profile globex sets k");
  });

  it("P17: the profile already sets the key to another value", async () => {
    const forge = await forgeOf(spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { params: { k: "x" } }), profile("globex", ["base"])] }));
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toContain("profile acme already sets k");
  });

  it("P18: another ingredient of the Forge cites the key", async () => {
    const forge = await forgeOf(spec({ ingredients: [rule("other", "see {{k}}\n")] }));
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toContain("rule/other also uses {{k}}");
  });

  it("P19: a hand-formatted file, or params behind an alias", async () => {
    const aligned = await forgeOf(spec(), { "profiles/acme/profile.yaml": "name: acme      # the client\nrecipes:\n    - base--acme\n" });
    expect(await err(check(aligned, [ext("k", "globex-api", "acme-api")]))).toContain("does not round-trip");
    const alias = await forgeOf(spec(), { "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\nx: &p {}\nparams: *p\n" });
    expect(await err(check(alias, [ext("k", "globex-api", "acme-api")]))).toContain("params is an alias");
  });
});

describe("checkParamWrites — section values cite keys too (spec 11 §6.11)", () => {
  it("P14: another profile's section value for the base's key cites the undeclared key — the default would start rendering it", async () => {
    const forge = await forgeOf(
      spec({
        profiles: [
          profile("acme", ["base--acme"]),
          profile("globex", ["base"], ["claude-code"], { sections: { "rule/deploy": { flavors: "| `{{k}}` | backend |\n" } } }),
        ],
      }),
    );
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toContain("unify: profile globex section flavors of rule/deploy already uses {{k}}");
  });

  it("P14 stays quiet when the key is already declared: the value already renders its default", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"], ["claude-code"], { sections: { "rule/deploy": { flavors: "{{k}}\n" } } })] }),
      { "ingredients/rules/deploy/ingredient.yaml": "type: rule\nname: deploy\nparams:\n  k:\n    default: globex-api\n" },
    );
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toBe("no error");
  });

  it("P18: the profile's section value for another ingredient cites the key — its text would change", async () => {
    const forge = await forgeOf(
      spec({
        ingredients: [rule("notes", "Notes.\n")],
        recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme", "rule/notes"])],
        profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/notes": { extra: "see {{k}}\n" } } }), profile("globex", ["base"])],
      }),
    );
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toContain("unify: profile acme section extra of rule/notes also uses {{k}} — its text would change");
  });

  it("P18 reads only the unifying profile's values: another profile citing the key elsewhere is not its business", async () => {
    const forge = await forgeOf(
      spec({
        ingredients: [rule("notes", "Notes.\n")],
        profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"], ["claude-code"], { sections: { "rule/notes": { extra: "see {{k}}\n" } } })],
      }),
    );
    expect(await err(check(forge, [ext("k", "globex-api", "acme-api")]))).toBe("no error");
  });
});

describe("checkParamWrites — sections (spec 12 §6.6)", () => {
  const sectionExt = (name: string, existing: boolean, value: string, key = "rule/deploy", file = "rule.md"): import("../src/core/unify.js").SectionExtraction => ({
    key,
    name,
    file,
    existing,
    default: existing ? null : "default content\n",
    value,
  });

  async function checkWithSections(
    forge: Awaited<ReturnType<typeof forgeOf>>,
    sections: import("../src/core/unify.js").SectionExtraction[],
    extractions: Extraction[] = [],
    p = "acme",
  ) {
    return checkParamWrites(forge, forge.ingredients.get("rule/deploy")!, forge.ingredients.get("rule/deploy--acme")!, p, extractions, sections);
  }

  it("a new section: the profile gains sections.<key>.<name>, sectionsWritten names it", async () => {
    const forge = await forgeOf(spec());
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "| row |\n")]);
    expect(w.profile).not.toBeNull();
    expect(YAML.parse(w.profile!.content).sections).toEqual({ "rule/deploy": { flavors: "| row |\n" } });
    expect(w.sectionsWritten).toEqual(["flavors"]);
  });

  it("a new section appended at end for a profile without sections (D8)", async () => {
    const forge = await forgeOf(spec());
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    // The sections block is appended at the end
    expect(w.profile!.content).toContain("sections:\n  rule/deploy:\n    flavors: |\n      row\n");
  });

  it("a new section into a profile with an existing sections block (block map)", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/other": { x: "y\n" } } }), profile("globex", ["base"])] }),
    );
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    const parsed = YAML.parse(w.profile!.content);
    expect(parsed.sections).toEqual({ "rule/other": { x: "y\n" }, "rule/deploy": { flavors: "row\n" } });
  });

  it("the manifest is rendered with schema: 2 for a new section (LF)", async () => {
    const forge = await forgeOf(spec());
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    expect(w.manifest).not.toBeNull();
    expect(w.manifest!.content).toBe("name: test-forge\nschema: 2\n");
    expect(w.mustHold).toContain(w.manifest!.abs);
  });

  it("the manifest is rendered with schema: 2 for a new section (CRLF)", async () => {
    const forge = await forgeOf(spec(), { "craftar.forge.yaml": "name: test-forge\r\nschema: 1\r\n" });
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    expect(w.manifest).not.toBeNull();
    expect(w.manifest!.content).toBe("name: test-forge\r\nschema: 2\r\n");
  });

  it("params + a section in one call: one profile edit holding both", async () => {
    const forge = await forgeOf(spec());
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")], [ext("k", "globex", "acme")]);
    expect(w.profile).not.toBeNull();
    const parsed = YAML.parse(w.profile!.content);
    expect(parsed.params).toEqual({ k: "acme" });
    expect(parsed.sections).toEqual({ "rule/deploy": { flavors: "row\n" } });
  });

  it("S13 (another profile sets the name)", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"], ["claude-code"], { sections: { "rule/deploy": { flavors: "other\n" } } })] }),
    );
    expect(await err(checkWithSections(forge, [sectionExt("flavors", false, "row\n")]))).toContain(
      "profile globex already sets section flavors of rule/deploy — it names no marker today and would start to apply",
    );
  });

  it("S14 for a new section (profile sets other content)", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/deploy": { flavors: "other\n" } } }), profile("globex", ["base"])] }),
    );
    expect(await err(checkWithSections(forge, [sectionExt("flavors", false, "row\n")]))).toContain("profile acme already sets section flavors of rule/deploy to other content");
  });

  it("S14 for an existing section (profile sets other content)", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/deploy": { flavors: "other\n" } } }), profile("globex", ["base"])] }),
    );
    expect(await err(checkWithSections(forge, [sectionExt("flavors", true, "row\n")]))).toContain("profile acme already sets section flavors of rule/deploy to other content");
  });

  it("equal case for new section: nothing written, not in sectionsWritten", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/deploy": { flavors: "row\n" } } }), profile("globex", ["base"])] }),
    );
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    expect(w.sectionsWritten).toEqual([]);
    // When nothing else changes, no profile edit
    expect(w.profile).toBeNull();
  });

  it("equal case for existing section: nothing written, not in sectionsWritten", async () => {
    const forge = await forgeOf(
      spec({ profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/deploy": { flavors: "row\n" } } }), profile("globex", ["base"])] }),
    );
    const w = await checkWithSections(forge, [sectionExt("flavors", true, "row\n")]);
    expect(w.sectionsWritten).toEqual([]);
  });

  it("S15: value cites {{k}} where base declares default and variant does not", async () => {
    const forge = await forgeOf(spec({ ingredients: [] }), {
      "ingredients/rules/deploy/ingredient.yaml": "type: rule\nname: deploy\nparams:\n  k:\n    default: x\n",
      "ingredients/rules/deploy/rule.md": "use globex-api\n",
      "ingredients/rules/deploy--acme/ingredient.yaml": "type: rule\nname: deploy--acme\nas: deploy\n",
      "ingredients/rules/deploy--acme/rule.md": "use acme-api\n",
    });
    expect(await err(checkWithSections(forge, [sectionExt("flavors", false, "see {{k}}\n")]))).toContain(
      "unify: section flavors would render {{k}} through rule/deploy's default, where rule/deploy--acme renders it without",
    );
  });

  it("aliased sections → S16 via editYamlText alias refusal", async () => {
    const forge = await forgeOf(spec(), { "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\nx: &s {}\nsections: *s\n" });
    expect(await err(checkWithSections(forge, [sectionExt("flavors", false, "row\n")]))).toContain("sections is an alias");
  });

  it("hand-aligned manifest → S16 via manifestWithSections", async () => {
    const forge = await forgeOf(spec(), { "craftar.forge.yaml": "name:   test-forge     # aligned\nschema:   1\n" });
    expect(await err(checkWithSections(forge, [sectionExt("flavors", false, "row\n")]))).toContain("cannot edit craftar.forge.yaml in place");
  });

  it("schema: 2 already: no manifest edit", async () => {
    const forge = await forgeOf(spec(), { "craftar.forge.yaml": "name: test-forge\nschema: 2\ndescription: d\n" });
    const w = await checkWithSections(forge, [sectionExt("flavors", false, "row\n")]);
    expect(w.manifest).toBeNull();
  });

  it("existing section only (no new section): no manifest edit even on schema: 1 Forge", async () => {
    const forge = await forgeOf(spec());
    const w = await checkWithSections(forge, [sectionExt("flavors", true, "row\n")]);
    expect(w.manifest).toBeNull();
  });
});
