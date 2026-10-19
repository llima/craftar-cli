import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadForge } from "../src/core/forge.js";
import { newProfile, ownedBy, profileName, withProfile } from "../src/core/new-profile.js";
import { namedForProfile } from "../src/core/promote.js";
import { ProfileSchema } from "../src/schema/index.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 38 §3, §4.4, §5.1, §5.2, §6 cases 7–8 — the pure part of a new profile. Nothing here writes into a Forge.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const MARK = "zq" + "mark";

async function forgeOf(spec: ForgeSpec, schema = 1) {
  const root = await fs.realpath(await tmpDir("craftar-new-profile-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await makeForge(root, spec);
  if (schema !== 1) await fs.writeFile(path.join(root, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return loadForge(root);
}
const fault = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

const BASE_SPEC: ForgeSpec = {
  ingredients: ["a", "b", "c", "fa", "fb"].map((n) => rule(n, `# ${n}\n`)),
  recipes: [
    recipe("base", ["rule/a"]),
    recipe("stack-node", ["rule/b"]),
    recipe("extra", ["rule/c"]),
    recipe("front-a", ["rule/fa"], { slot: "front" }),
    recipe("front-b", ["rule/fb"], { slot: "front" }),
  ],
  profiles: [
    profile("acme", ["base", "stack-node", "front-a"], ["claude-code", "kiro"], {
      description: `ACME ${MARK}`,
      params: { "acme.org": `org-${MARK}` },
      sections: { "rule/a": { intro: `intro ${MARK}` } },
      repos: [{ name: "api", url: `https://git.example.com/${MARK}/api.git` }],
      scm: { kind: "github", org: MARK },
    }),
    profile("globex", ["base"], ["kiro"]),
  ],
};

describe("profileName — P3 (§5.1)", () => {
  it("accepted", () => {
    for (const n of ["initech", "acme-portal", "a1", "0"]) expect(() => profileName(n)).not.toThrow();
  });
  it("refused: not a profile name", () => {
    for (const n of ["Acme", "acme--x", "-acme", "acme-", "a/b", "a.b", "..", "", "a b", "a_b"])
      expect(fault(() => profileName(n)), n).toBe(`"${n}" is not a profile name — lowercase letters and digits, in groups joined by one "-"`);
  });
  it("refused: a device name on Windows, on every platform", () => {
    for (const n of ["con", "nul", "com1", "lpt9", "aux", "prn"]) expect(fault(() => profileName(n)), n).toBe(`"${n}" is a device name on Windows — pick another`);
  });
});

describe("namedForProfile and ownedBy — the owned-recipe test (§3)", () => {
  it("namedForProfile: <anything>--<q> or <q>-steering", () => {
    expect(namedForProfile("base--acme", "acme")).toBe(true);
    expect(namedForProfile("acme-steering", "acme")).toBe(true);
    expect(namedForProfile("base", "acme")).toBe(false);
    expect(namedForProfile("base--acmex", "acme")).toBe(false);
  });
  it("ownedBy: owned recipes belong to a profile of the Forge; others to no one", async () => {
    const forge = await forgeOf(BASE_SPEC);
    for (const r of ["base--acme", "stack-api--acme", "acme-steering", "tools--acme"]) expect(ownedBy(forge, r), r).toBe("acme");
    for (const r of ["base", "stack-node", "base--nobody"]) expect(ownedBy(forge, r), r).toBeNull();
  });
  it("ownedBy: two matches — the longer profile name wins", async () => {
    const forge = await forgeOf({ ...BASE_SPEC, profiles: [profile("b", ["base"]), profile("x--b", ["base"])] });
    expect(ownedBy(forge, "r--x--b")).toBe("x--b");
  });
  it("withProfile: a copy holding the new profile; the loaded Forge is not mutated", async () => {
    const forge = await forgeOf(BASE_SPEC);
    const p = ProfileSchema.parse({ name: "initech", recipes: ["base"], targets: ["claude-code"] });
    const copy = withProfile(forge, p);
    expect(copy.profiles.get("initech")).toBe(p);
    expect(forge.profiles.has("initech")).toBe(false);
    expect([...copy.profiles.keys()].sort()).toEqual(["acme", "globex", "initech"]);
  });
});

describe("newProfile — the file of §4.4", () => {
  it("no template: no recipe, the default target", async () => {
    const forge = await forgeOf(BASE_SPEC);
    const r = newProfile(forge, { name: "initech" });
    expect(r.text).toBe("name: initech\nrecipes: []\ntargets:\n  - claude-code\n");
    expect(r.profile.recipes).toEqual([]);
    expect(r.blockNote).toBeNull();
  });
  it("--like: the template's written recipes and targets, plus an add, nothing of its values", async () => {
    const forge = await forgeOf(BASE_SPEC);
    const r = newProfile(forge, { name: "initech", like: "acme", add: ["extra"] });
    expect(r.text).toBe("name: initech\nrecipes:\n  - base\n  - stack-node\n  - front-a\n  - extra\ntargets:\n  - claude-code\n  - kiro\n");
    expect(r.text.includes(MARK)).toBe(false);
    const parsed = ProfileSchema.parse(YAML.parse(r.text));
    expect(parsed.recipes).toEqual(["base", "stack-node", "front-a", "extra"]);
    expect(parsed.targets).toEqual(["claude-code", "kiro"]);
    expect(Object.keys(YAML.parse(r.text))).toEqual(["name", "recipes", "targets"]);
  });
  it("--remove-recipe, --targets", async () => {
    const forge = await forgeOf(BASE_SPEC);
    const r = newProfile(forge, { name: "initech", like: "acme", remove: ["stack-node"], targets: ["kiro"] });
    expect(r.text).toBe("name: initech\nrecipes:\n  - base\n  - front-a\ntargets:\n  - kiro\n");
  });
  it("--replace on a held slot", async () => {
    const forge = await forgeOf(BASE_SPEC);
    const r = newProfile(forge, { name: "initech", like: "acme", add: ["front-b"], replace: true });
    expect(r.profile.recipes).toEqual(["base", "stack-node", "front-b"]);
  });
  it("P11: spec 22's own refusals — an unknown recipe, a held slot without --replace", async () => {
    const forge = await forgeOf(BASE_SPEC);
    expect(fault(() => newProfile(forge, { name: "initech", add: ["nope"] }))).toMatch(/^recipe "nope" not found in this Forge \(/);
    expect(fault(() => newProfile(forge, { name: "initech", like: "acme", add: ["front-b"] }))).toMatch(/front/);
  });
  it("P9: --like a profile the Forge does not have", async () => {
    const forge = await forgeOf(BASE_SPEC);
    expect(fault(() => newProfile(forge, { name: "initech", like: "nope" }))).toBe('--like: profile "nope" not found in Forge (acme, globex)');
  });
});

describe("newProfile — P10, an owned recipe in the list (§6 case 7)", () => {
  const SPEC: ForgeSpec = {
    ...BASE_SPEC,
    recipes: [...(BASE_SPEC.recipes ?? []), recipe("base--acme", ["rule/a"]), recipe("x--initech", ["rule/a"])],
    profiles: [profile("acme", ["base--acme", "stack-node"]), profile("globex", ["base"])],
  };
  it("brought by the template, or named by --add-recipe: refused, the recipe and the profile named", async () => {
    const forge = await forgeOf(SPEC);
    const msg = "recipe base--acme is named for profile acme — a new profile cannot use it; leave it out and add the shared recipe it stands for";
    expect(fault(() => newProfile(forge, { name: "initech", like: "acme" }))).toBe(msg);
    expect(fault(() => newProfile(forge, { name: "initech", add: ["base--acme"] }))).toBe(msg);
  });
  it("passes once the owned recipe is removed and the shared one added", async () => {
    const forge = await forgeOf(SPEC);
    const r = newProfile(forge, { name: "initech", like: "acme", remove: ["base--acme"], add: ["base"] });
    expect(r.profile.recipes).toEqual(["stack-node", "base"]);
  });
  it("a recipe named for the new profile itself belongs to no one: the loaded Forge decides", async () => {
    const forge = await forgeOf(SPEC);
    expect(newProfile(forge, { name: "initech", add: ["x--initech"] }).profile.recipes).toEqual(["x--initech"]);
  });
});

describe("newProfile — a template's integrations block (§6 case 8, Ruling 3)", () => {
  const SPEC = (block: unknown, recipes: string[] = ["base"]): ForgeSpec => ({
    ...BASE_SPEC,
    recipes: [...(BASE_SPEC.recipes ?? []), recipe("pm-azure", ["rule/c"]), recipe("idp-backstage", ["rule/b"])],
    profiles: [profile("acme", recipes, ["claude-code"], { integrations: block }), profile("globex", ["base"])],
  });
  it("schema 3: a recipe only the block selects is not copied — one note with the count, singular and plural", async () => {
    const one = await forgeOf(SPEC({ pm: { kind: "azure", org: MARK } }), 3);
    const r1 = newProfile(one, { name: "initech", like: "acme" });
    expect(r1.profile.recipes).toEqual(["base"]);
    expect(r1.blockNote).toBe("integrations of acme not copied — 1 recipe it selects is not in initech");
    expect(r1.text.includes(MARK) || (r1.blockNote ?? "").includes(MARK)).toBe(false);
    const two = await forgeOf(SPEC({ pm: { kind: "azure" }, idp: { kind: "backstage" } }), 3);
    expect(newProfile(two, { name: "initech", like: "acme" }).blockNote).toBe("integrations of acme not copied — 2 recipes it selects are not in initech");
  });
  it("no note when every recipe the block selects is in the final list — written by the template, or added", async () => {
    const f = await forgeOf(SPEC({ pm: { kind: "azure" } }, ["base", "pm-azure"]), 3);
    expect(newProfile(f, { name: "initech", like: "acme" }).blockNote).toBeNull();
    const g = await forgeOf(SPEC({ pm: { kind: "azure" } }), 3);
    expect(newProfile(g, { name: "initech", like: "acme", add: ["pm-azure"] }).blockNote).toBeNull();
  });
  it("schema 2: the block is not read — no note", async () => {
    const f = await forgeOf(SPEC({ pm: { kind: "azure" } }), 2);
    expect(newProfile(f, { name: "initech", like: "acme" }).blockNote).toBeNull();
  });
  it("a block that does not read: the list, the other wording, nothing of the resolver's message", async () => {
    const f = await forgeOf(SPEC({ pm: MARK }), 3);
    const r = newProfile(f, { name: "initech", like: "acme" });
    expect(r.profile.recipes).toEqual(["base"]);
    expect(r.blockNote).toBe("integrations of acme not copied — the block does not read, so what it selects is not known");
  });
});

describe("newProfile — recipe names YAML would misread (review round 2)", () => {
  it("a recipe named 123, true or null is written quoted and reads back as that string", async () => {
    const forge = await forgeOf({ ...BASE_SPEC, recipes: [...(BASE_SPEC.recipes ?? []), recipe("123", ["rule/a"]), recipe("true", ["rule/b"]), recipe("null", ["rule/c"])] });
    const r = newProfile(forge, { name: "initech", add: ["123", "true", "null"] });
    const back = YAML.parse(r.text);
    expect(back.recipes).toEqual(["123", "true", "null"]);
    expect(ProfileSchema.parse(back).recipes).toEqual(r.profile.recipes);
    expect(r.text).toContain('  - "123"\n');
  });
  it("plain names stay unquoted (the §4.4 bytes)", async () => {
    const forge = await forgeOf(BASE_SPEC);
    expect(newProfile(forge, { name: "initech", like: "acme" }).text).toContain("  - base\n  - stack-node\n");
  });
});
