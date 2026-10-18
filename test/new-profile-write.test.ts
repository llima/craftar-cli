import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgeSource, planInit } from "../src/core/init.js";
import { NewProfileLateFailure, NewProfileRaceLost, reproveFromDisk, writeNewProfile } from "../src/core/new-profile-write.js";
import { loadForgeSource } from "../src/core/sync.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 38 §5.3 steps 3–4 and §4.6 — the profile write and the second proof, with injected hooks standing for a second
// run or an edit between the steps (the seams §10 asks for). In-process; temp dirs only.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
  recipes: [recipe("base", ["rule/a"]), recipe("stack-node", ["rule/b"])],
  profiles: [profile("acme", ["base", "stack-node"], ["claude-code"])],
};
async function setup(spec: ForgeSpec = SPEC) {
  const parent = await fs.realpath(await tmpDir("craftar-np-write-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  await makeForge(forge, spec);
  const ws = path.join(parent, "ws");
  await fs.mkdir(ws);
  const loaded = await loadForgeSource(ws, forgeSource(ws, forge), null, { mode: "sync" });
  // Only use like: "acme" when the spec has the acme profile
  const like = spec.profiles?.some((p) => p.name === "acme") ? "acme" : undefined;
  const init = await planInit(ws, { forge, profile: "initech", newProfile: { name: "initech", like }, loaded });
  return { parent, forge, ws, init };
}
const TEXT = "name: initech\nrecipes:\n  - base\n  - stack-node\ntargets:\n  - claude-code\n";

describe("writeNewProfile — step 3", () => {
  it("writes the file with its text, journals the profile's own directory only, before the mkdir", async () => {
    const s = await setup();
    const journal = await writeNewProfile(s.forge, s.init);
    expect(await fs.readFile(path.join(s.forge, "profiles", "initech", "profile.yaml"), "utf8")).toBe(TEXT);
    expect(journal).toEqual([{ abs: path.join(s.forge, "profiles", "initech"), created: true }]);
  });
  it("a Forge with no profiles/: created with the profile's directory; profiles is never journalled", async () => {
    const s = await setup({ ...SPEC, profiles: [] });
    const init = await planInit(s.ws, {
      forge: s.forge,
      profile: "initech",
      newProfile: { name: "initech" },
      loaded: await loadForgeSource(s.ws, forgeSource(s.ws, s.forge), null, { mode: "sync" }),
    });
    const journal = await writeNewProfile(s.forge, init);
    expect(journal.map((j) => path.relative(s.forge, j.abs))).toEqual([path.join("profiles", "initech")]);
    expect(await fs.readFile(path.join(s.forge, "profiles", "initech", "profile.yaml"), "utf8")).toBe("name: initech\nrecipes: []\ntargets:\n  - claude-code\n");
  });
  it("another run made profiles/<name>/ first: NewProfileRaceLost with P7's first message; the other run's file untouched", async () => {
    const s = await setup();
    const other = path.join(s.forge, "profiles", "initech", "profile.yaml");
    const e = await writeNewProfile(s.forge, s.init, {
      beforeMkdir: async () => {
        await fs.mkdir(path.dirname(other), { recursive: true });
        await fs.writeFile(other, "name: initech\nrecipes: []\n# the other run\n");
      },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(NewProfileRaceLost);
    expect((e as Error).message).toBe("profile initech already exists in the Forge — use --profile initech");
    expect(await fs.readFile(other, "utf8")).toBe("name: initech\nrecipes: []\n# the other run\n");
  });
  it("the wx is the backstop: a file put there between the mkdir and the write is the same refusal", async () => {
    const s = await setup();
    const file = path.join(s.forge, "profiles", "initech", "profile.yaml");
    const e = await writeNewProfile(s.forge, s.init, { beforeWrite: async () => void (await fs.writeFile(file, "x\n")) }).catch((x) => x);
    expect(e).toBeInstanceOf(NewProfileRaceLost);
    expect(await fs.readFile(file, "utf8")).toBe("x\n");
  });
  it("profiles/ made by another run, with another profile in it, between the gate and the write: the run goes on", async () => {
    const s = await setup({ ...SPEC, profiles: [] });
    const init = await planInit(s.ws, {
      forge: s.forge,
      profile: "initech",
      newProfile: { name: "initech" },
      loaded: await loadForgeSource(s.ws, forgeSource(s.ws, s.forge), null, { mode: "sync" }),
    });
    await writeNewProfile(s.forge, init, {
      beforeMkdir: async () => {
        await fs.mkdir(path.join(s.forge, "profiles", "globex"), { recursive: true });
        await fs.writeFile(path.join(s.forge, "profiles", "globex", "profile.yaml"), "name: globex\n");
      },
    });
    expect((await fs.readdir(path.join(s.forge, "profiles"))).sort()).toEqual(["globex", "initech"]);
  });
  it("any other failure is a NewProfileLateFailure carrying the journal", async () => {
    const s = await setup();
    const e = await writeNewProfile(s.forge, s.init, { beforeWrite: async () => { throw Object.assign(new Error("EIO: disk"), { code: "EIO" }); } }).catch((x) => x);
    expect(e).toBeInstanceOf(NewProfileLateFailure);
    expect((e as NewProfileLateFailure).journal.map((j) => j.abs)).toEqual([path.join(s.forge, "profiles", "initech")]);
  });
});

describe("reproveFromDisk — step 4", () => {
  it("the Forge read back plans the same paths and bytes: the second plan is returned, with no recipe or target flag in craftar.yaml", async () => {
    const s = await setup();
    await writeNewProfile(s.forge, s.init);
    const second = await reproveFromDisk(s.ws, s.forge, s.init, {});
    expect(second.text).toBe("forge: ../forge\nprofile: initech\n");
    expect(second.plan.files.map((f) => f.path)).toEqual(s.init.plan.files.map((f) => f.path));
  });
  it("an unrelated file written between the steps changes nothing; a recipe edited does — a late failure", async () => {
    const s = await setup();
    await writeNewProfile(s.forge, s.init);
    await fs.writeFile(path.join(s.forge, "NOTES.md"), "unrelated\n");
    await expect(reproveFromDisk(s.ws, s.forge, s.init, {})).resolves.toBeTruthy();
    await fs.writeFile(path.join(s.forge, "ingredients", "rules", "a", "rule.md"), "# A, edited meanwhile\n");
    const e = await reproveFromDisk(s.ws, s.forge, s.init, {}).catch((x) => x);
    expect(e).toBeInstanceOf(NewProfileLateFailure);
    expect((e as Error).message).toBe("the Forge read back from disk does not plan what init proved in memory — a Forge file changed while init ran");
  });
});
