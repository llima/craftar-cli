import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { fakeGit, readCloneLog, type FakeGit } from "./helpers/fake-git.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";

// Spec 37 §4.1–§4.5 through the command: C1, C2, C6 before anything is loaded; the clone step after the first sync,
// its report and its exit; a refused first sync clones nothing. git is the fake of test/helpers/fake-git.ts — no real
// clone, no network. Every craftar child gets a PATH holding the fake alone (or nothing, for C6).

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REPOS = [
  { name: "portal-api", url: "https://git.example.com/acme/portal-api.git" },
  { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
];

async function setup(opts: { repos?: unknown[]; declared?: boolean } = {}) {
  const parent = await fs.realpath(await tmpDir("craftar-init-clone-cli-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  const extra = opts.declared ? { params: { token: { description: "a value nobody set" } } } : {};
  await makeForge(forge, {
    ingredients: [rule("a", opts.declared ? "# A {{token}}\n" : "# A\n", extra)],
    recipes: [recipe("base", ["rule/a"])],
    profiles: [profile("acme", ["base"], ["claude-code"], { repos: opts.repos ?? REPOS })],
  });
  const home = path.join(parent, "home");
  const ws = path.join(parent, "ws");
  const fg = await fakeGit();
  cleanups.push(fg.cleanup);
  return { parent, forge, home, ws, fg };
}
const run = (args: string[], env: NodeJS.ProcessEnv) => runCli(args, { env });
const withFake = (s: { fg: FakeGit; home: string }, extra: NodeJS.ProcessEnv = {}) => s.fg.env({ CRAFTAR_HOME: s.home, ...extra });
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

describe("refusals read off the arguments — before anything is loaded (C1, C2, C6)", () => {
  // A Forge that does not exist: had anything been loaded, the error would be the load's.
  const MISSING = path.join(path.sep === "\\" ? "C:\\" : "/", "nonexistent-forge-zq");
  it("C1: --clone and --no-clone, in either order", async () => {
    const s = await setup();
    for (const pair of [["--clone", "--no-clone"], ["--no-clone", "--clone"]]) {
      const r = run(["init", "--forge", MISSING, "--profile", "acme", "--workspace", s.ws, ...pair], withFake(s));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("error: pass --clone or --no-clone, not both\n");
      expect(await exists(s.ws)).toBe(false);
    }
  });
  it("C2: --clone with --offline", async () => {
    const s = await setup();
    const r = run(["init", "--forge", MISSING, "--profile", "acme", "--workspace", s.ws, "--clone", "--offline"], withFake(s));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --clone needs the network — drop --offline, or clone later with git\n");
    expect(await exists(s.ws)).toBe(false);
  });
  it("C6: --clone with no git on PATH — also for a profile whose first sync would be refused", async () => {
    for (const declared of [false, true]) {
      const s = await setup({ declared });
      const r = run(["init", "--forge", MISSING, "--profile", "acme", "--workspace", s.ws, "--clone"], { CRAFTAR_HOME: s.home, PATH: "", Path: "" });
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("error: cloning needs git — install it, or leave the clone out\n");
      expect(await exists(s.ws)).toBe(false);
    }
  });
});

describe("refusals after the plan, before anything is written (C3, C4, C5)", () => {
  it("C3: --clone on a profile with no entry", async () => {
    const s = await setup({ repos: [] });
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: profile acme lists no repositories — nothing to clone; drop --clone\n");
    expect(await exists(path.join(s.ws, "craftar.yaml"))).toBe(false);
  });
  it("C4: a password in a url — refused, and the password is in no byte printed", async () => {
    const PW = "zq" + "secret" + "pw";
    const s = await setup({ repos: [{ name: "a", url: `https://u:${PW}@git.example.com/acme/a.git` }] });
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: profile acme: repos[0]: url holds credentials — remove them and let git authenticate\n");
    expect(r.stdout + r.stderr).not.toContain(PW);
    expect(await readCloneLog(s.fg.log)).toEqual([]);
  });
  it("C5: a destination that exists — refused even when the first sync would be refused too", async () => {
    for (const declared of [false, true]) {
      const s = await setup({ declared });
      await fs.mkdir(path.join(s.ws, "portal-api"), { recursive: true });
      const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("error: cannot clone portal-api: portal-api already exists in the workspace — move it, or leave the clone out\n");
      expect(await exists(path.join(s.ws, "craftar.yaml"))).toBe(false);
      expect(await readCloneLog(s.fg.log)).toEqual([]);
    }
  });
});

describe("the clone step (§4.4)", () => {
  it("every clone succeeds: the report, the calls in order, exit 0; the workspace written, synced, registered", async () => {
    const s = await setup();
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s));
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    const at = lines.indexOf("craftar init — cloning 2 repositories of acme");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3)).toEqual(["  cloned  portal-api  → portal-api", "  cloned  portal-web  → apps/portal-web"]);
    const calls = await readCloneLog(s.fg.log);
    expect(calls.map((c) => c.args)).toEqual([
      ["clone", "--no-recurse-submodules", "--", "https://git.example.com/acme/portal-api.git", "portal-api"],
      ["clone", "--no-recurse-submodules", "--branch=release", "--", "git@git.example.com:acme/portal-web.git", "apps/portal-web"],
    ]);
    for (const c of calls) {
      expect(await fs.realpath(c.cwd)).toBe(await fs.realpath(s.ws));
      expect(c.allow).toBe("https:ssh");
      expect(c.prompt).toBe("0");
    }
    expect(await exists(path.join(s.ws, "portal-api", "CLONED"))).toBe(true);
    expect(await exists(path.join(s.ws, "apps", "portal-web", "CLONED"))).toBe(true);
    expect(await exists(path.join(s.ws, "craftar.lock"))).toBe(true);
    const reg = JSON.parse(await fs.readFile(path.join(s.home, "registry.json"), "utf8"));
    expect(reg.workspaces.map((w: { path: string }) => w.path)).toContain(await fs.realpath(s.ws));
    // The clone is the last thing init prints; the lock records nothing of it.
    expect(await fs.readFile(path.join(s.ws, "craftar.lock"), "utf8")).not.toContain("portal-");
  });
  it("one clone fails: exit 1, the others still tried, the by-hand line and the repos clone line; the workspace stays", async () => {
    const s = await setup();
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s, { CRAFTAR_TEST_CLONE_FAIL: "portal-api" }));
    expect(r.code).toBe(1);
    const lines = r.stdout.split("\n");
    const at = lines.indexOf("craftar init — cloning 2 repositories of acme");
    expect(lines.slice(at + 1, at + 6)).toEqual([
      "  failed  portal-api  → portal-api  (git exited 128)",
      "  cloned  portal-web  → apps/portal-web",
      `  1 of 2 cloned — clone the rest by hand, in ${s.ws}:`,
      '    git clone --no-recurse-submodules -- "https://git.example.com/acme/portal-api.git" "portal-api"',
      "  or, from the workspace: craftar repos clone portal-api",
    ]);
    expect((await readCloneLog(s.fg.log)).length).toBe(2);
    expect(await exists(path.join(s.ws, "craftar.yaml"))).toBe(true);
    expect(await exists(path.join(s.ws, "craftar.lock"))).toBe(true);
  });
  it("--no-sync --clone: written, not synced, cloned", async () => {
    const s = await setup();
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone", "--no-sync"], withFake(s));
    expect(r.code, r.stderr).toBe(0);
    expect(await exists(path.join(s.ws, "craftar.lock"))).toBe(false);
    expect((await readCloneLog(s.fg.log)).length).toBe(2);
  });
  it("a workspace directory that init creates: the clones land in it", async () => {
    const s = await setup();
    const ws = path.join(s.parent, "new", "ws");
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", ws, "--clone"], withFake(s));
    expect(r.code, r.stderr).toBe(0);
    expect(await exists(path.join(ws, "apps", "portal-web", "CLONED"))).toBe(true);
  });
  it("a first sync that would be refused clones nothing — with and without --no-sync", async () => {
    const s = await setup({ declared: true });
    const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, "--clone"], withFake(s));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  repositories: not cloned — the first sync is refused\n");
    expect(r.stdout).not.toContain("cloning");
    expect(await readCloneLog(s.fg.log)).toEqual([]);
    const t = await setup({ declared: true });
    const r2 = run(["init", "--forge", t.forge, "--profile", "acme", "--workspace", t.ws, "--clone", "--no-sync"], withFake(t));
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("  repositories: not cloned — the first sync is refused\n");
    expect(await readCloneLog(t.fg.log)).toEqual([]);
  });
});

describe("without --clone (Ruling 10)", () => {
  it("--no-clone, and no flag: the same stdout, nothing cloned, nothing said about repositories", async () => {
    const outs: string[] = [];
    for (const extra of [[], ["--no-clone"]]) {
      const s = await setup();
      const r = run(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, ...extra], withFake(s));
      expect(r.code, r.stderr).toBe(0);
      expect(await readCloneLog(s.fg.log)).toEqual([]);
      outs.push(r.stdout.split(s.parent).join("<P>"));
    }
    expect(outs[0]).toBe(outs[1]);
    expect(outs[0]).not.toMatch(/repositor|clone/);
  });
});
