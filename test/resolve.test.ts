import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../src/core/sync.js";
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
