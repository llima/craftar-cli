import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { loadWorkspace } from "../src/core/sync.js";
import { recipeOrder, resolve } from "../src/core/resolve.js";
import { loadForge } from "../src/core/forge.js";
import { profile, recipe, rule, scenario, type ForgeSpec, type WorkspaceSpec, makeForge, tmpDir } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("recipeOrder (spec 16 §5.2)", () => {
  it("expands extends depth-first and returns exactly the same order as resolve()", async () => {
    // Same Forge as resolve.test.ts "expands extends depth-first and applies each recipe once"
    const s = await scenario(
      {
        recipes: [recipe("base", []), recipe("stack-a", [], { extends: ["base"] }), recipe("stack-b", [], { extends: ["base"] })],
        profiles: [profile("acme", ["stack-a", "stack-b"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const forge = await loadForge(s.forgeRoot);
    const w = await loadWorkspace(s.wsRoot);
    const resolution = resolve(w.forge, w.config);
    const order = recipeOrder(forge, ["stack-a", "stack-b"], "profile acme");

    expect(order).toEqual(["base", "stack-a", "stack-b"]);
    expect(order).toEqual(resolution.recipes);
  });

  it("returns exactly the same order as resolve() with recipes.add and recipes.remove", async () => {
    const s = await scenario(
      { recipes: [recipe("base", []), recipe("extra", [])], profiles: [profile("acme", ["base", "extra"])] },
      { config: { profile: "acme", recipes: { remove: ["extra"] } } },
    );
    cleanups.push(s.cleanup);
    const forge = await loadForge(s.forgeRoot);
    const w = await loadWorkspace(s.wsRoot);
    const resolution = resolve(w.forge, w.config);
    // wanted = profile.recipes + add - remove = ["base", "extra"] + [] - ["extra"] = ["base"]
    const order = recipeOrder(forge, ["base"], "profile acme");

    expect(order).toEqual(["base"]);
    expect(order).toEqual(resolution.recipes);
  });

  it("throws on a recipe cycle with the same message as resolve()", async () => {
    const root = await tmpDir("craftar-resolve-order-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      recipes: [recipe("a", [], { extends: ["b"] }), recipe("b", [], { extends: ["a"] })],
      profiles: [profile("acme", ["a"])],
    });
    const forge = await loadForge(root);

    expect(() => recipeOrder(forge, ["a"], "profile acme")).toThrow("recipe cycle: a → b → a");
  });

  it("throws on an unknown parent with the same message as resolve()", async () => {
    const root = await tmpDir("craftar-resolve-order-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      recipes: [recipe("child", [], { extends: ["ghost"] })],
      profiles: [profile("acme", ["child"])],
    });
    const forge = await loadForge(root);

    expect(() => recipeOrder(forge, ["child"], "profile acme")).toThrow('recipe "ghost" not found (referenced by child)');
  });

  it("throws on an unknown top-level recipe with the origin as the reference", async () => {
    const root = await tmpDir("craftar-resolve-order-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      recipes: [],
      profiles: [profile("acme", [])],
    });
    const forge = await loadForge(root);

    expect(() => recipeOrder(forge, ["ghost"], "profile acme")).toThrow('recipe "ghost" not found (referenced by profile acme)');
  });
});
