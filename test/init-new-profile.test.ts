import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgeSource, planInit } from "../src/core/init.js";
import { loadForgeSource } from "../src/core/sync.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 38 §5.2 — planInit with `newProfile`: always handed the loaded Forge, plans the workspace on the copy that
// holds the new profile, and writes nothing. The command's writes (§5.3) are tested at the CLI.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("c", "# C\n")],
  recipes: [recipe("base", ["rule/a"]), recipe("stack-node", ["rule/b"]), recipe("extra", ["rule/c"]), recipe("broken", ["rule/a"], { extends: ["nope"] })],
  profiles: [profile("acme", ["base", "stack-node"], ["claude-code", "kiro"], { params: { org: "zqmark" } })],
};
async function setup(spec: ForgeSpec = SPEC) {
  const parent = await fs.realpath(await tmpDir("craftar-np-plan-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  await makeForge(forge, spec);
  const ws = path.join(parent, "ws");
  await fs.mkdir(ws);
  const loaded = await loadForgeSource(ws, forgeSource(ws, forge), null, { mode: "sync" });
  return { parent, forge, ws, loaded };
}
const files = (p: { files: Array<{ path: string; content: Buffer | string }> }) =>
  Object.fromEntries(p.files.map((f) => [f.path, Buffer.from(f.content as Buffer).toString("base64")]));

describe("planInit with newProfile", () => {
  it("plans what the same profile written by hand plans; craftar.yaml holds no recipes and no targets; the loaded Forge is not mutated", async () => {
    const s = await setup();
    const init = await planInit(s.ws, {
      forge: s.forge,
      profile: "initech",
      newProfile: { name: "initech", like: "acme" },
      addRecipes: ["extra"],
      targets: ["kiro"],
      loaded: s.loaded,
    });
    expect(init.newProfile).toEqual({
      path: "profiles/initech/profile.yaml",
      text: "name: initech\nrecipes:\n  - base\n  - stack-node\n  - extra\ntargets:\n  - kiro\n",
      blockNote: null,
    });
    expect(init.text).toBe("forge: ../forge\nprofile: initech\n");
    expect(s.loaded.forge.profiles.has("initech")).toBe(false);
    expect(init.repos).toEqual([]);

    const t = await setup();
    await fs.mkdir(path.join(t.forge, "profiles", "initech"));
    await fs.writeFile(path.join(t.forge, "profiles", "initech", "profile.yaml"), init.newProfile!.text);
    const byHand = await planInit(t.ws, { forge: t.forge, profile: "initech" });
    expect(files(init.plan)).toEqual(files(byHand.plan));
    expect(Object.keys(files(init.plan)).sort()).toEqual([".kiro/steering/a.md", ".kiro/steering/b.md", ".kiro/steering/c.md"]);
  });
  it("the new profile carries none of the template's params", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech", like: "acme" }, loaded: s.loaded });
    expect(init.newProfile!.text.includes("zqmark")).toBe(false);
    expect(init.ws.forge.profiles.get("initech")!.params).toEqual({});
  });
  it("spec 22's notes reach InitPlan.notes", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech", like: "acme" }, addRecipes: ["base"], loaded: s.loaded });
    expect(init.notes.length).toBe(1);
    expect(init.notes[0]).toMatch(/base/);
  });
  it("P12 / P11: a new profile whose recipes do not resolve is refused — nothing written", async () => {
    const s = await setup();
    await expect(planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech" }, addRecipes: ["broken"], loaded: s.loaded })).rejects.toThrow(/^recipe "nope" not found/);
    expect(await fs.readdir(path.join(s.forge, "profiles"))).toEqual(["acme"]);
    expect(await fs.readdir(s.ws)).toEqual([]);
  });
  it("N10 unchanged: a local targets with no --targets is merged into the workspace; with --targets it is refused", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.ws, "craftar.local.yaml"), "targets: [claude-code]\n");
    const init = await planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech", like: "acme" }, loaded: s.loaded });
    expect(Object.keys(files(init.plan)).every((p) => p.startsWith(".claude/"))).toBe(true);
    expect(init.newProfile!.text).toContain("targets:\n  - claude-code\n  - kiro\n");
    await expect(
      planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech" }, targets: ["kiro"], loaded: s.loaded }),
    ).rejects.toThrow(/craftar\.local\.yaml/);
  });
});
