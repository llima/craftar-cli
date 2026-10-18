import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";
import YAML from "yaml";
import { git, gitEnv, remoteForge } from "./helpers/remote.js";

// Spec 38 §4.1–§4.6 through the command. Forges are local git repositories with a commit; no network, no push.

const WIN = process.platform === "win32";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("t", "# T {{token}}\n", { params: { token: { description: "nobody sets it" } } })],
  recipes: [recipe("base", ["rule/a"]), recipe("stack-node", ["rule/b"]), recipe("tokened", ["rule/t"])],
  profiles: [profile("acme", ["base", "stack-node"], ["claude-code", "kiro"])],
};
async function setup(spec: ForgeSpec = SPEC) {
  const parent = await fs.realpath(await tmpDir("craftar-np-cli-"));
  cleanups.push(async () => {
    await fs.chmod(parent, 0o755).catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  });
  const forge = path.join(parent, "forge");
  await makeForge(forge, spec);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "init");
  const ws = path.join(parent, "ws");
  const home = path.join(parent, "home");
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
  return { parent, forge, ws, home, run };
}
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(dir)) if (!rel.startsWith(".git/")) out[rel] = await fs.readFile(path.join(dir, rel), "utf8");
  return out;
}
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const MISSING = path.join(WIN ? "C:\\" : "/", "nonexistent-forge-zq");

describe("refusals read off the arguments, before any load (P1–P4, N2)", () => {
  it("P1, P2, P3, P4 — nothing read, nothing written", async () => {
    const s = await setup();
    const cases: Array<[string[], string]> = [
      [["--forge", MISSING, "--new-profile", "initech", "--profile", "acme"], "pass --profile or --new-profile, not both"],
      [["--forge", MISSING, "--profile", "acme", "--like", "acme"], "--like goes with --new-profile"],
      [["--forge", MISSING, "--new-profile", "Bad"], '"Bad" is not a profile name — lowercase letters and digits, in groups joined by one "-"'],
      [["--forge", MISSING, "--new-profile", "con"], '"con" is a device name on Windows — pick another'],
      [["--forge", "https://git.example.com/acme/forge.git", "--new-profile", "initech"], "a new profile is written into a Forge directory — clone the Forge, pass that directory as --forge, then commit and push the profile"],
    ];
    for (const [args, msg] of cases) {
      const r = s.run(["init", ...args, "--workspace", s.ws]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toBe(`error: ${msg}\n`);
      expect(await exists(s.ws)).toBe(false);
    }
  });
  it("off a terminal, --new-profile without --forge is N2's --forge line; --forge with --new-profile is not N2", async () => {
    const s = await setup();
    const r = s.run(["init", "--new-profile", "initech", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --forge is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked\n");
  });
  it("a --forge that does not exist is the load's error, not P6; N10 comes before the load", async () => {
    const s = await setup();
    const r = s.run(["init", "--forge", MISSING, "--new-profile", "initech", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Forge not found/);
    await fs.mkdir(s.ws);
    await fs.writeFile(path.join(s.ws, "craftar.local.yaml"), "profile: acme\n");
    const n10 = s.run(["init", "--forge", MISSING, "--new-profile", "initech", "--workspace", s.ws]);
    expect(n10.code).toBe(1);
    expect(n10.stderr).toMatch(/craftar\.local\.yaml/);
    expect(n10.stderr).not.toMatch(/Forge not found/);
  });
});

describe("the run (§4.4–§4.5)", () => {
  it("one new, uncommitted file in the Forge; the workspace synced on it; the output; HEAD and the branch unchanged", async () => {
    const s = await setup();
    const before = await tree(s.forge);
    const head = git(s.forge, "rev-parse", "HEAD");
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--like", "acme", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    const after = await tree(s.forge);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added).toEqual(["profiles/initech/profile.yaml"]);
    expect(after["profiles/initech/profile.yaml"]).toBe("name: initech\nrecipes:\n  - base\n  - stack-node\ntargets:\n  - claude-code\n  - kiro\n");
    for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);
    expect(git(s.forge, "status", "--porcelain")).toBe("?? profiles/initech/");
    expect(git(s.forge, "rev-parse", "HEAD")).toBe(head);
    expect(git(s.forge, "symbolic-ref", "--short", "HEAD")).toBe("main");
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `craftar init — created profile initech in ${s.forge}`,
      "  + profiles/initech/profile.yaml   (not committed — commit it in the Forge, on a branch, before anyone else syncs)",
      `craftar init — wrote craftar.yaml in ${s.ws}`,
      "  forge ../forge · profile initech · recipes base → stack-node · targets claude-code, kiro (from the profile)",
    ]);
    expect(r.stdout).not.toMatch(/again craftar init/);
    expect(await fs.readFile(path.join(s.ws, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: initech\n");
    const st = JSON.parse(s.run(["status", "--json", "--workspace", s.ws]).stdout);
    expect(st.statuses.every((x: { state: string }) => x.state === "unchanged")).toBe(true);
    // a second workspace of the same client starts with --profile
    const ws2 = path.join(s.parent, "ws2");
    expect(s.run(["init", "--forge", s.forge, "--profile", "initech", "--workspace", ws2]).code).toBe(0);
  });
  it("another workspace of the Forge plans the same after; recipes --json differs only by the new name", async () => {
    const s = await setup();
    const other = path.join(s.parent, "other");
    expect(s.run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", other]).code).toBe(0);
    const recipesBefore = JSON.parse(s.run(["recipes", "--json", "--workspace", other]).stdout);
    expect(s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--like", "acme", "--workspace", s.ws]).code).toBe(0);
    const st = JSON.parse(s.run(["status", "--json", "--workspace", other]).stdout);
    expect(st.statuses.every((x: { state: string }) => x.state === "unchanged")).toBe(true);
    const recipesAfter = JSON.parse(s.run(["recipes", "--json", "--workspace", other]).stdout);
    const strip = (j: { recipes: Array<{ name: string; profiles: string[] }> }) => j.recipes.map((r) => ({ ...r, profiles: r.profiles.filter((p) => p !== "initech") }));
    expect(strip(recipesAfter)).toEqual(strip(recipesBefore));
    expect(recipesAfter.recipes.find((r: { name: string }) => r.name === "base").profiles).toContain("initech");
  });
  it("--no-sync: both files, next sync printed, exit 0; a refused first sync: exit 1, both files stay", async () => {
    const s = await setup();
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--workspace", s.ws, "--no-sync"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/next sync:/);
    expect(await exists(path.join(s.ws, "craftar.lock"))).toBe(false);
    const t = await setup();
    const r2 = t.run(["init", "--forge", t.forge, "--new-profile", "initech", "--add-recipe", "tokened", "--workspace", t.ws]);
    expect(r2.code).toBe(1);
    expect(await exists(path.join(t.forge, "profiles", "initech", "profile.yaml"))).toBe(true);
    expect(await exists(path.join(t.ws, "craftar.yaml"))).toBe(true);
  });
  it("--ref with a Forge directory is N11; --offline is accepted and inert", async () => {
    const s = await setup();
    expect(s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--ref", "main", "--workspace", s.ws]).code).toBe(1);
    expect(s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--offline", "--workspace", s.ws]).code).toBe(0);
  });
  it("P7 at the command: an existing profile", async () => {
    const s = await setup();
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "acme", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: profile acme already exists in the Forge — use --profile acme\n");
  });
  it("--new-profile --clone is spec 37's C3, the Forge untouched", async () => {
    const s = await setup();
    const before = await tree(s.forge);
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--clone", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: profile initech lists no repositories — nothing to clone; drop --clone\n");
    expect(await tree(s.forge)).toEqual(before);
  });
  it("P5: a tree of craftar's Forge cache passed as --forge", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const s = await setup();
    const w0 = path.join(s.parent, "w0");
    await fs.mkdir(w0);
    await fs.writeFile(path.join(w0, "craftar.yaml"), `forge: ${rf.url}\nprofile: acme\n`);
    expect(s.run(["sync", "--workspace", w0]).code).toBe(0);
    const forges = path.join(s.home, "forges");
    const [entry] = await fs.readdir(forges);
    const trees = path.join(forges, entry, "trees");
    const [t] = (await fs.readdir(trees)).filter((n) => !n.endsWith(".ok"));
    const r = s.run(["init", "--forge", path.join(trees, t), "--new-profile", "initech", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory\n$/);
  });
});

describe("review round 1 (spec 38)", () => {
  it("the notes of step 1 are printed after the initLine line: spec 22's and the integrations block's", async () => {
    const spec: ForgeSpec = {
      ...SPEC,
      recipes: [...(SPEC.recipes ?? []), recipe("pm-jira", ["rule/a"])],
      profiles: [profile("acme", ["base", "stack-node"], ["claude-code"], { integrations: { pm: { kind: "jira" } } })],
    };
    const s = await setup(spec);
    await fs.writeFile(path.join(s.forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 3 }));
    git(s.forge, "commit", "-q", "-am", "schema 3");
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--like", "acme", "--add-recipe", "base", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  forge ../forge · profile initech"));
    expect(lines[at + 1]).toMatch(/^  note .*base/);
    expect(lines[at + 2]).toBe("  note integrations of acme not copied — 1 recipe it selects is not in initech");
  });
  it("a ref in craftar.local.yaml: init --new-profile behaves as init --profile — it succeeds, and craftar.yaml holds no ref", async () => {
    const s = await setup();
    await fs.mkdir(s.ws);
    await fs.writeFile(path.join(s.ws, "craftar.local.yaml"), "ref: some-branch\n");
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "globex", "--no-sync", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.ws, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: globex\n");
  });
});

describe("late failures (§4.6) — not run on Windows (chmod), reported as such", () => {
  it.skipIf(WIN || process.getuid?.() === 0)("craftar.yaml cannot be written after the profile was: the late-failure lines with clean -fd; running it restores the Forge", async () => {
    const s = await setup();
    await fs.mkdir(s.ws);
    await fs.chmod(s.ws, 0o555);
    cleanups.push(() => fs.chmod(s.ws, 0o755));
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`init had already started changing the Forge (${s.forge}) when this failed:\n  profiles/initech\nrecover with:\n  git -C ${s.forge} clean -fd -- profiles/initech\n`);
    expect(await exists(path.join(s.forge, "profiles", "initech", "profile.yaml"))).toBe(true);
    execFileSync("git", ["-C", s.forge, "clean", "-fd", "--", "profiles/initech"], { env: gitEnv() });
    expect(git(s.forge, "status", "--porcelain")).toBe("");
  });
  it.skipIf(WIN || process.getuid?.() === 0)("the profile write fails otherwise (a read-only profiles/): the late-failure lines, craftar.yaml not written", async () => {
    const s = await setup();
    const profiles = path.join(s.forge, "profiles");
    await fs.chmod(profiles, 0o555);
    cleanups.push(() => fs.chmod(profiles, 0o755));
    const r = s.run(["init", "--forge", s.forge, "--new-profile", "initech", "--workspace", s.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("recover with:");
    expect(await exists(path.join(s.ws, "craftar.yaml"))).toBe(false);
  });
});
