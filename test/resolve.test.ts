import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profileNotFoundMessage, resolve, substitute } from "../src/core/resolve.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function resolved(forge: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await scenario(forge, ws);
  cleanups.push(s.cleanup);
  const w = await loadWorkspace(s.wsRoot);
  return resolve(w.forge, w.config);
}

describe("resolve", () => {
  it("expands extends depth-first and applies each recipe once", async () => {
    const r = await resolved({
      recipes: [recipe("base", []), recipe("stack-a", [], { extends: ["base"] }), recipe("stack-b", [], { extends: ["base"] })],
      profiles: [profile("acme", ["stack-a", "stack-b"])],
    });
    expect(r.recipes).toEqual(["base", "stack-a", "stack-b"]);
  });

  it("rejects a recipe cycle", async () => {
    await expect(
      resolved({ recipes: [recipe("a", [], { extends: ["b"] }), recipe("b", [], { extends: ["a"] })], profiles: [profile("acme", ["a"])] }),
    ).rejects.toThrow(/recipe cycle/);
  });

  it("rejects two recipes on the same slot", async () => {
    await expect(
      resolved({
        recipes: [recipe("front-a", [], { slot: "frontend" }), recipe("front-b", [], { slot: "frontend" })],
        profiles: [profile("acme", ["front-a", "front-b"])],
      }),
    ).rejects.toThrow(/both occupy slot "frontend"/);
  });

  it("layers params: recipe default → profile → workspace", async () => {
    const r = await resolved(
      {
        recipes: [recipe("base", [], { params: { x: { default: "recipe" }, y: { default: "recipe" }, z: { default: "recipe" } } })],
        profiles: [profile("acme", ["base"], ["claude-code"], { params: { y: "profile", z: "profile" } })],
      },
      { config: { profile: "acme", overrides: { params: { z: "workspace" } } } },
    );
    expect(r.params).toEqual({ x: "recipe", y: "profile", z: "workspace" });
  });

  it("drops ingredients disabled by the workspace", async () => {
    const r = await resolved(
      { ingredients: [rule("a", "# A\n"), rule("b", "# B\n")], recipes: [recipe("base", ["rule/a", "rule/b"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme", overrides: { ingredients: { disable: ["rule/b"] } } } },
    );
    expect(r.ingredients.map((i) => i.ref)).toEqual(["rule/a"]);
    expect(r.disabled).toEqual(["rule/b"]);
  });

  it("removes a profile recipe listed in recipes.remove", async () => {
    const r = await resolved(
      { recipes: [recipe("base", []), recipe("extra", [])], profiles: [profile("acme", ["base", "extra"])] },
      { config: { profile: "acme", recipes: { remove: ["extra"] } } },
    );
    expect(r.recipes).toEqual(["base"]);
  });

  it("warns about a recipe referencing a missing ingredient", async () => {
    const r = await resolved({ recipes: [recipe("base", ["rule/ghost"])], profiles: [profile("acme", ["base"])] });
    expect(r.warnings).toContain('recipe "base" references missing ingredient rule/ghost');
  });

  it("fails on an unknown profile", async () => {
    await expect(resolved({ profiles: [profile("other", [])] })).rejects.toThrow(/profile "acme" not found/);
  });
});

describe("the ingredient default layer (spec 09 §5.4)", () => {
  async function rendered(extra: { recipeParams?: object; profileParams?: object; config?: object; local?: object } = {}) {
    const s = await scenario(
      {
        ingredients: [
          rule("a", "api: {{deploy.api}}\n", { params: { "deploy.api": { default: "ingredient" } } }),
          rule("b", "api: {{deploy.api}}\n"),
        ],
        recipes: [recipe("base", ["rule/a", "rule/b"], extra.recipeParams ? { params: extra.recipeParams } : {})],
        profiles: [profile("acme", ["base"], ["claude-code"], extra.profileParams ? { params: extra.profileParams } : {})],
      },
      { config: { profile: "acme", ...(extra.config ?? {}) }, local: extra.local },
    );
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    const text = (rel: string) => p.files.find((f) => f.path === rel)!.content.toString("utf8");
    return { a: text(".claude/rules/a.md"), b: text(".claude/rules/b.md"), warnings: p.warnings };
  }

  it("fills the declaring ingredient only; another ingredient's placeholder stays literal and warned", async () => {
    const r = await rendered();
    expect(r.a).toBe("api: ingredient\n");
    expect(r.b).toBe("api: {{deploy.api}}\n");
    expect(r.warnings.join("\n")).toContain('param "deploy.api" has no value in any layer — left verbatim (rule/b)');
  });

  it("is the weakest layer: recipe, profile, workspace and local each override it", async () => {
    expect((await rendered({ recipeParams: { "deploy.api": { default: "recipe" } } })).a).toBe("api: recipe\n");
    expect((await rendered({ profileParams: { "deploy.api": "profile" } })).a).toBe("api: profile\n");
    expect((await rendered({ profileParams: { "deploy.api": "profile" }, config: { overrides: { params: { "deploy.api": "workspace" } } } })).a).toBe("api: workspace\n");
    expect((await rendered({ config: { overrides: { params: { "deploy.api": "workspace" } } }, local: { overrides: { params: { "deploy.api": "local" } } } })).a).toBe("api: local\n");
  });
});

describe("substitute — own properties only", () => {
  it("leaves {{constructor}}, {{toString}} and {{__proto__}} literal and reports them missing", () => {
    const missing = new Set<string>();
    const text = "{{constructor}} {{toString}} {{__proto__}} {{k}}";
    expect(substitute(text, { k: "v" }, missing)).toBe("{{constructor}} {{toString}} {{__proto__}} v");
    expect([...missing].sort()).toEqual(["__proto__", "constructor", "toString"]);
  });
});

describe("section layers (spec 11 §6.3)", () => {
  const SEC = "A\n<!-- craftar:section a -->\nda\n<!-- /craftar:section -->\n<!-- craftar:section b -->\ndb\n<!-- /craftar:section -->\nB\n";
  async function sectioned(ws: Partial<WorkspaceSpec> = {}, profileSections: Record<string, unknown> = {}) {
    const s = await scenario(
      { ingredients: [rule("x", SEC)], recipes: [recipe("base", ["rule/x"])], profiles: [profile("acme", ["base"], ["claude-code"], { sections: profileSections })] },
      { config: { profile: "acme", ...(ws.config ?? {}) }, local: ws.local },
    );
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: test-forge\nschema: 2\n" });
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    return { r: p.resolution, out: p.files.find((f) => f.path === ".claude/rules/x.md")!.content.toString("utf8") };
  }

  it("profile → craftar.yaml → craftar.local.yaml, merged at (key, name) granularity (P4)", async () => {
    const { r, out } = await sectioned(
      { config: { overrides: { sections: { "rule/x": { b: "wb" } } } }, local: { overrides: { sections: { "rule/x": { a: "la" } } } } },
      { "rule/x": { a: "pa", b: "pb" } },
    );
    expect(r.sections).toEqual({ "rule/x": { a: "la", b: "wb" } });
    expect(r.sectionLayers.profile).toEqual({ "rule/x": { a: "pa", b: "pb" } });
    expect(out).toBe("A\nla\nwb\nB\n");
  });

  it("the profile's value applies when no workspace sets it, and the default otherwise", async () => {
    expect((await sectioned({}, { "rule/x": { a: "pa" } })).out).toBe("A\npa\ndb\nB\n");
    expect((await sectioned()).out).toBe("A\nda\ndb\nB\n");
  });

  it('"" empties a section, from any layer', async () => {
    expect((await sectioned({}, { "rule/x": { a: "" } })).out).toBe("A\ndb\nB\n");
    expect((await sectioned({ local: { overrides: { sections: { "rule/x": { b: "" } } } } }, { "rule/x": { b: "pb" } })).out).toBe("A\nda\nB\n");
  });

  it("a wrong-shape key fails the load, naming the file", async () => {
    await expect(sectioned({}, { "x.a": "v" })).rejects.toThrow(/invalid .*profiles.acme.profile\.yaml/);
    await expect(sectioned({ config: { overrides: { sections: { "x.a": "v" } } } })).rejects.toThrow(/^invalid craftar\.yaml:/);
    await expect(sectioned({ local: { overrides: { sections: { "x.a": "v" } } } })).rejects.toThrow(/^invalid craftar\.yaml \(merged with craftar\.local\.yaml\):/);
  });
});

describe("resolve — an unknown recipes.add name names craftar.yaml (spec 22 §14 item 7)", () => {
  const forge: ForgeSpec = { recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] };

  it("a recipes.add name the Forge does not hold is referenced by craftar.yaml recipes.add", async () => {
    await expect(resolved(forge, { config: { profile: "acme", recipes: { add: ["nope"], remove: [] } } })).rejects.toThrow(
      new Error('recipe "nope" not found (referenced by craftar.yaml recipes.add)'),
    );
  });

  it("a profile recipe the Forge does not hold is still referenced by the profile", async () => {
    await expect(
      resolved({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base", "nope"])] }),
    ).rejects.toThrow(new Error('recipe "nope" not found (referenced by profile acme)'));
  });

  it("an unknown name in both recipes.add and recipes.remove is filtered out, as before", async () => {
    const r = await resolved(forge, { config: { profile: "acme", recipes: { add: ["nope"], remove: ["nope"] } } });
    expect(r.recipes).toEqual(["base"]);
  });
});


describe("profileNotFoundMessage — profile order (spec 28 §5.2)", () => {
  // The helper must preserve the order of the given names (the Forge's own order), not sort them.
  // A hand-built map tests this reliably, since fs.readdir order is filesystem-dependent.
  it("lists profiles in Forge order, not sorted", async () => {
    // Create a Forge with profiles in order: zeta, acme (not sorted)
    const s = await scenario(
      { recipes: [recipe("base", [])], profiles: [profile("zeta", ["base"]), profile("acme", ["base"])] },
      { config: { profile: "nope" } },
    );
    cleanups.push(s.cleanup);
    const w = await loadWorkspace(s.wsRoot);

    // Reorder the profiles map: zeta first, then acme
    const newProfiles = new Map<string, typeof w.forge.profiles extends Map<string, infer V> ? V : never>();
    const zeta = w.forge.profiles.get("zeta")!;
    const acme = w.forge.profiles.get("acme")!;
    newProfiles.set("zeta", zeta);
    newProfiles.set("acme", acme);
    const forgeWithOrder = { ...w.forge, profiles: newProfiles };

    // resolve() is sync and should throw with the exact order: zeta, acme (not "acme, zeta")
    expect(() => resolve(forgeWithOrder, w.config)).toThrow(
      new Error('profile "nope" not found in Forge (zeta, acme)'),
    );
  });
});
