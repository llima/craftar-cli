import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { againLine, askInit, confirmInit, type InitIo } from "../src/core/init-flow.js";
import { planInit } from "../src/core/init.js";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 38 §4.3 — the interactive flow, through InitIo with scripted answers (spec 28 §9.2: the suite cannot drive a
// real terminal). Forge directories are git repositories with a commit unless a test says otherwise.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("c", "# C\n")],
  recipes: [recipe("base", ["rule/a"]), recipe("stack-node", ["rule/b"]), recipe("extra", ["rule/c"]), recipe("base--acme", ["rule/a"])],
  profiles: [profile("acme", ["base", "stack-node"], ["claude-code", "kiro"], { description: "ACME — portal and API" }), profile("globex", ["base"], ["kiro"])],
};
async function setup(opts: { spec?: ForgeSpec; git?: boolean } = {}) {
  const parent = await fs.realpath(await tmpDir("craftar-np-flow-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  await makeForge(forge, opts.spec ?? SPEC);
  if (opts.git !== false) {
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "init");
  }
  const ws = path.join(parent, "ws");
  await fs.mkdir(ws);
  return { parent, forge, ws, home: path.join(parent, "home") };
}
function script(answers: Array<string | null>) {
  const asked: string[] = [];
  const said: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    if (!answers.length) throw new Error(`no scripted answer left for: ${q}`);
    return answers.shift()!;
  };
  const io: InitIo = { ask: next, confirm: next, say: (l) => void said.push(l) };
  return { io, asked, said, left: () => answers.length };
}
const GIVEN = { addRecipes: [] as string[], removeRecipes: [] as string[], replace: false };
const LOCAL = { doc: null, keys: [] as never[] };
const ask = (s: { ws: string; home: string }, given: Record<string, unknown>, io: InitIo) =>
  askInit(s.ws, { ...GIVEN, ...given }, LOCAL, io, { home: s.home, registryOff: true, exists: existsSync });

describe("the profile list gains `0) a new profile` (§4.3)", () => {
  it("a Forge directory that passes P5/P6: the entry; 0 starts the new-profile questions", async () => {
    const s = await setup();
    const sc = script(["0", "initech", "acme", "", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    expect(sc.said).toContain("  0) a new profile");
    expect(sc.asked).toEqual([
      "Profile: ",
      "New profile's name: ",
      "Start from an existing profile [none]: ",
      "Adjust the recipes [no]: ",
      "Targets — claude-code, kiro, agents-md, separated by commas [claude-code, kiro, from acme]: ",
    ]);
    expect(sc.said).toContain("Recipes of initech (from acme): base → stack-node");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.profile).toBe("initech");
    expect(r.input.newProfile).toEqual({ name: "initech", like: "acme" });
  });
  it("a Forge directory that is not a git repository: no entry, P6's text as the line under the list", async () => {
    const s = await setup({ git: false });
    const sc = script(["acme", "", ""]);
    await ask(s, { forge: s.forge }, sc.io);
    expect(sc.said.some((l) => l.includes("0) a new profile"))).toBe(false);
    expect(sc.said).toContain(`cannot create a profile in ${s.forge}: it is not a git repository with a commit — git is how a Forge write is undone`);
  });
  it("a URL Forge: no entry, one line", async () => {
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const s = await setup();
    const sc = script(["", "acme", "", ""]);
    await ask(s, { forge: r.url }, sc.io);
    expect(sc.said.some((l) => l.includes("0) a new profile"))).toBe(false);
    expect(sc.said).toContain("a new profile needs a Forge directory");
  });
  it("a profile literally named 0 wins over the entry", async () => {
    const s = await setup({ spec: { ...SPEC, profiles: [profile("0", ["base"]), ...(SPEC.profiles ?? [])] } });
    const sc = script(["0", "", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.profile).toBe("0");
    expect(r.input.newProfile).toBeUndefined();
  });
});

describe("the new-profile questions (§4.3)", () => {
  it("the name is re-asked on an empty answer, P3 and P7", async () => {
    const s = await setup();
    const sc = script(["0", "", "Bad", "acme", "initech", "", "", ""]);
    await ask(s, { forge: s.forge }, sc.io);
    expect(sc.asked.filter((q) => q === "New profile's name: ").length).toBe(4);
    expect(sc.said).toContain('"Bad" is not a profile name — lowercase letters and digits, in groups joined by one "-"');
    expect(sc.said).toContain("profile acme already exists in the Forge — use --profile acme");
  });
  it("no template: the Forge's recipes, then `Add [none]: ` directly; the targets' default says `default`", async () => {
    const s = await setup();
    const sc = script(["0", "initech", "", "extra", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    expect(sc.asked).toContain("Add [none]: ");
    expect(sc.asked).not.toContain("Adjust the recipes [no]: ");
    expect(sc.asked.at(-1)).toBe("Targets — claude-code, kiro, agents-md, separated by commas [claude-code, default]: ");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech" });
    expect(r.input.addRecipes).toEqual(["extra"]);
  });
  it("an unknown template is said and asked again (P9); a number picks from the list", async () => {
    const s = await setup();
    const sc = script(["0", "initech", "nope", "1", "", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    expect(sc.said).toContain('--like: profile "nope" not found in Forge (acme, globex)');
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech", like: "acme" });
  });
  it("P10: an owned recipe in the list is said, and the recipes question asked again opening on Remove", async () => {
    const spec = { ...SPEC, profiles: [profile("acme", ["base--acme", "stack-node"]), profile("globex", ["base"])] };
    const s = await setup({ spec });
    const sc = script(["0", "initech", "acme", "", "base--acme", "base", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    expect(sc.said).toContain("recipe base--acme is named for profile acme — a new profile cannot use it; leave it out and add the shared recipe it stands for");
    const i = sc.asked.indexOf("Adjust the recipes [no]: ");
    expect(sc.asked[i + 1]).toBe("Remove [none]: ");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.removeRecipes).toEqual(["base--acme"]);
    expect(r.input.addRecipes).toEqual(["base"]);
  });
  it("a Forge directory with no profile goes straight to the questions", async () => {
    const s = await setup({ spec: { ...SPEC, profiles: [] } });
    const sc = script(["initech", "", ""]);
    const r = await ask(s, { forge: s.forge }, sc.io);
    expect(sc.said).toContain("the Forge has no profile yet — creating the first one");
    expect(sc.asked[0]).toBe("New profile's name: ");
    expect(sc.asked).not.toContain("Start from an existing profile [none]: ");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech" });
  });
  it("--new-profile typed, --forge asked: the list is printed before the template question; a typed name failing P7 is a refusal", async () => {
    const s = await setup();
    const sc = script([s.forge, "", "", ""]);
    const r = await ask(s, { newProfile: "initech" }, sc.io);
    expect(sc.asked[0]).toBe("Forge — a directory or a git URL: ");
    const listAt = sc.said.indexOf(`Profiles in ${s.forge}:`);
    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(sc.asked).toContain("Start from an existing profile [none]: ");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech" });
    const t = await setup();
    await expect(ask(t, { forge: t.forge, newProfile: "acme" }, script([]).io)).rejects.toThrow("profile acme already exists in the Forge — use --profile acme");
  });
});

describe("confirmInit and againLine with a new profile (§4.3)", () => {
  it("the confirmation names both writes; the again line is the next workspace's run", async () => {
    const s = await setup();
    const { loadForgeSource } = await import("../src/core/sync.js");
    const { forgeSource } = await import("../src/core/init.js");
    const loaded = await loadForgeSource(s.ws, forgeSource(s.ws, s.forge), null, { mode: "sync" });
    const init = await planInit(s.ws, { forge: s.forge, profile: "initech", newProfile: { name: "initech", like: "acme" }, loaded });
    const sc = script([""]);
    expect(await confirmInit(init, s.ws, sc.io, { sync: true })).toBe("confirmed");
    expect(sc.said[0]).toBe(`craftar init — about to create profile initech in ${s.forge} and write craftar.yaml in ${s.ws}`);
    expect(sc.asked).toEqual(["Create profiles/initech/profile.yaml (not committed), write craftar.yaml and sync [yes]: "]);
    const sc2 = script([""]);
    await confirmInit(init, s.ws, sc2.io, { sync: false });
    expect(sc2.asked).toEqual(["Create profiles/initech/profile.yaml (not committed) and write craftar.yaml [yes]: "]);
    expect(
      againLine({ forge: "../forge", profile: "initech", addRecipes: [], removeRecipes: [], replace: false }, { sync: true, offline: false }),
    ).toBe("  again craftar init --forge ../forge --profile initech");
  });
});

describe("review round 1 (spec 38 §4.2, §4.3)", () => {
  it("a template in a Forge at schema 3: the draft goes through ProfileSchema — no raw TypeError", async () => {
    const spec: ForgeSpec = {
      ...SPEC,
      recipes: [...(SPEC.recipes ?? []), recipe("pm-jira", ["rule/a"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } })],
    };
    const s = await setup({ spec });
    await fs.writeFile(path.join(s.forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 3 }));
    git(s.forge, "commit", "-q", "-am", "schema 3");
    const sc = script(["", ""]);
    const r = await ask(s, { forge: s.forge, newProfile: "initech", like: "acme" }, sc.io);
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech", like: "acme" });
    expect(sc.said).toContain("Recipes of initech (from acme): base");
  });
  it("flags typed with --new-profile answer their questions: nothing is asked for them", async () => {
    const s = await setup();
    const sc = script([]);
    const r = await ask(s, { forge: s.forge, newProfile: "initech", like: "acme", addRecipes: ["extra"], targets: ["kiro"] }, sc.io);
    expect(sc.asked).toEqual([]);
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.addRecipes).toEqual(["extra"]);
    expect(r.input.targets).toEqual(["kiro"]);
  });
  it("a typed --like the Forge does not have is refused before any question (P9)", async () => {
    const s = await setup();
    await expect(ask(s, { forge: s.forge, newProfile: "initech", like: "nope" }, script([]).io)).rejects.toThrow('--like: profile "nope" not found in Forge (acme, globex)');
  });
  it("--new-profile typed, the Forge asked: a URL answer is P4, said and asked again — nothing fetched", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const s = await setup();
    const sc = script([rf.url, s.forge, "", "", ""]);
    const r = await ask(s, { newProfile: "initech" }, sc.io);
    expect(sc.said).toContain("a new profile is written into a Forge directory — clone the Forge, pass that directory as --forge, then commit and push the profile");
    expect(sc.asked.filter((q) => q.startsWith("Forge")).length).toBe(2);
    expect(await fs.lstat(path.join(s.home, "forges")).then(() => true, () => false)).toBe(false);
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.forge).toBe(s.forge);
  });
  it("--new-profile typed, the Forge asked: a directory that is not a git repository is said and asked again", async () => {
    const bad = await setup({ git: false });
    const s = await setup();
    const sc = script([bad.forge, s.forge, "", "", ""]);
    const r = await ask(s, { newProfile: "initech" }, sc.io);
    const p6 = `cannot create a profile in ${bad.forge}: it is not a git repository with a commit — git is how a Forge write is undone`;
    expect(sc.said.filter((l) => l === p6).length).toBe(1);
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.forge).toBe(s.forge);
  });
  it("a Forge directory with no profile that fails P6, the Forge asked: said once, and the Forge asked again", async () => {
    const bad = await setup({ spec: { ...SPEC, profiles: [] }, git: false });
    const s = await setup({ spec: { ...SPEC, profiles: [] } });
    const sc = script([bad.forge, s.forge, "initech", "", ""]);
    const r = await ask(s, {}, sc.io);
    const p6 = `cannot create a profile in ${bad.forge}: it is not a git repository with a commit — git is how a Forge write is undone`;
    expect(sc.said.filter((l) => l === p6).length).toBe(1);
    expect(sc.said).toContain("the Forge has no profile yet — creating the first one");
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.newProfile).toEqual({ name: "initech" });
  });
  it("a held slot in the new profile's recipes asks `replace <holder>`, as spec 28 does", async () => {
    const spec: ForgeSpec = {
      ...SPEC,
      recipes: [...(SPEC.recipes ?? []), recipe("front-a", ["rule/b"], { slot: "front" }), recipe("front-b", ["rule/c"], { slot: "front" })],
      profiles: [profile("acme", ["base", "front-a"], ["claude-code"]), profile("globex", ["base"], ["kiro"])],
    };
    const s = await setup({ spec });
    const sc = script(["yes", "", "front-b", "yes", ""]);
    const r = await ask(s, { forge: s.forge, newProfile: "initech", like: "acme" }, sc.io);
    expect(sc.asked).toContain('front-b takes the slot "front" that front-a holds — replace front-a [no]: ');
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.addRecipes).toEqual(["front-b"]);
    expect(r.input.replace).toBe(true);
  });
});
