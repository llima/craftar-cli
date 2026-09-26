import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { resolve } from "../src/core/resolve.js";
import { profile, recipe, rule, scenario, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";

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
