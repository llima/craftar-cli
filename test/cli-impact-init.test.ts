import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles, type IngredientSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge } from "./helpers/remote.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";
import { exists, listFiles } from "../src/core/forge.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { cacheKey, ensureTree, UNVOUCHED_HIDDEN } from "../src/core/remote.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Every file under root with its content, so a before/after comparison catches an in-place edit. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files = (await listFiles(root)).filter((f) => f !== ".git" && !f.startsWith(".git/"));
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")] as const)));
}

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

describe("cli — forge impact (spec 25 §4.1)", () => {
  const SPEC = {
    ingredients: [rule("style", "# Style\n")],
    recipes: [recipe("base", ["rule/style"])],
    profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
  };

  /** A temporary root with its own CRAFTAR_HOME, a path Forge, and workspaces made on demand. */
  async function setup() {
    const root = await tmpDir("craftar-forge-impact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const ws = async (name: string, profileName: string) => {
      const dir = path.join(root, name);
      await writeFiles(dir, { "craftar.yaml": `forge: ../forge\nprofile: ${profileName}\n` });
      return dir;
    };
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const registry = path.join(home, "registry.json");
    return { root, home, forge, ws, run, registry };
  }

  it("test 1: two path workspaces in sync", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  unchanged\n` +
      `  ${padB}  ${padGlobex}  unchanged\n`
    );
  });

  it("test 2: edit Forge rule → both lines show 1 update", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    // Edit the Forge ingredient
    await fs.writeFile(path.join(s.forge, "ingredients/rules/style/rule.md"), "# Style!\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  1 update\n` +
      `  ${padB}  ${padGlobex}  1 update\n`
    );
  });

  it("test 3: delete workspace → its line says missing; --json asserted whole", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    // Delete workspace b
    await fs.rm(b, { recursive: true });

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  unchanged\n` +
      `  ${padB}  ${padGlobex}  missing\n`
    );

    const j = s.run(["forge", "impact", "--forge", s.forge, "--json"]);
    expect(j.code).toBe(0);
    expect(j.stderr).toBe("");
    const out = JSON.parse(j.stdout);
    expect(out).toEqual({
      forge: realForge,
      registry: "partial",
      workspaces: [
        { path: realA, profile: "acme", match: "path", via: null, ref: null, state: "unchanged", counts: {}, error: null },
        { path: realB, profile: "globex", match: "path", via: null, ref: null, state: "missing", counts: {}, error: null },
      ],
    });
  });

  it("test 4: break craftar.yaml → its line says error: <message>", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realForge = await fs.realpath(s.forge);

    // Break the craftar.yaml
    await fs.writeFile(path.join(a, "craftar.yaml"), "profile: [\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Error message copied from a run: BAD_INDENT at line 2, column 1
    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 1 registered workspace (1 by path)\n` +
      `  ${realA}  acme  error: invalid craftar.yaml: BAD_INDENT at line 2, column 1\n`
    );
  });

  it("test 5: a remote workspace → after push (origin); with ref: main → pins main", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const root = await tmpDir("craftar-forge-impact-remote-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });

    const run = (args: string[]) => runCli(args, { env: { CRAFTAR_HOME: home } });
    expect(run(["sync", "--workspace", ws]).code).toBe(0);
    const realWs = await fs.realpath(ws);
    const realSrc = await fs.realpath(rf.src);

    const r = run(["forge", "impact", "--forge", rf.src]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `craftar forge impact — ${realSrc} · 1 registered workspace (1 by remote)\n` +
      `  ${realWs}  acme  unchanged · after push (origin)\n`
    );

    // With ref: main → pins main
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${rf.url}\nref: main\nprofile: acme\n`);
    expect(run(["sync", "--workspace", ws]).code).toBe(0);
    const r2 = run(["forge", "impact", "--forge", rf.src]);
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe("");
    expect(r2.stdout).toBe(
      `craftar forge impact — ${realSrc} · 1 registered workspace (1 by remote)\n` +
      `  ${realWs}  acme  unchanged · after push (origin), pins main\n`
    );
  });

  it("test 6: no registered workspace → specific message; CRAFTAR_NO_REGISTRY=1 → registry off message", async () => {
    const s = await setup();
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge}\n` +
      `  no registered workspace reads this Forge on this machine\n`
    );

    const off = s.run(["forge", "impact", "--forge", s.forge], { CRAFTAR_NO_REGISTRY: "1" });
    expect(off.code).toBe(0);
    expect(off.stderr).toBe("");
    expect(off.stdout).toBe(
      `craftar forge impact — ${realForge}\n` +
      `  the registry is off (CRAFTAR_NO_REGISTRY)\n`
    );
  });

  it("test 7: unreadable registry → code 1, stdout empty, stderr error message", async () => {
    const s = await setup();
    await fs.mkdir(s.home, { recursive: true });
    await fs.writeFile(s.registry, "not json\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // The error comes from readRegistry which reports "not valid JSON" without the parse message
    expect(r.stderr).toBe(`error: cannot read ${s.registry}: not valid JSON\n`);
  });

  it("test 8: --workspace with remote Forge → code 1, exact error message", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const root = await tmpDir("craftar-forge-impact-remote-ws-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });

    const r = runCli(["forge", "impact", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: the Forge of this workspace is remote (${rf.url}) — clone it and pass --forge <dir>\n`);
  });

  it("test 9: writes nothing — snapshot before/after unchanged", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);

    const beforeA = await snapshot(a);
    const beforeB = await snapshot(b);
    const beforeForge = await snapshot(s.forge);
    const beforeHome = await snapshot(s.home);

    expect(s.run(["forge", "impact", "--forge", s.forge]).code).toBe(0);
    expect(s.run(["forge", "impact", "--forge", s.forge, "--json"]).code).toBe(0);

    expect(await snapshot(a)).toEqual(beforeA);
    expect(await snapshot(b)).toEqual(beforeB);
    expect(await snapshot(s.forge)).toEqual(beforeForge);
    expect(await snapshot(s.home)).toEqual(beforeHome);
  });

  it("test 10: lock with schema: 9 → error row, not failed command; exit 0, whole stdout", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    // Rewrite workspace b's lock to have schema: 9 (unknown)
    const lockPath = path.join(b, "craftar.lock");
    const lock = await fs.readFile(lockPath, "utf8");
    // Lock is JSON, so we replace "schema": 2 with "schema": 9
    await fs.writeFile(lockPath, lock.replace('"schema": 2', '"schema": 9'));

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  unchanged\n` +
      `  ${padB}  ${padGlobex}  error: craftar.lock declares schema 9, which this craftar does not read — upgrade craftar\n`
    );

    // --json: the error row has state: "error" and error message
    const j = s.run(["forge", "impact", "--forge", s.forge, "--json"]);
    expect(j.code).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.workspaces[1].state).toBe("error");
    expect(out.workspaces[1].error).toBe("craftar.lock declares schema 9, which this craftar does not read — upgrade craftar");
  });

  it("test 11: broken craftar.yaml → registry partial in --json", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);

    // Break the craftar.yaml
    await fs.writeFile(path.join(a, "craftar.yaml"), "profile: [\n");

    const j = s.run(["forge", "impact", "--forge", s.forge, "--json"]);
    expect(j.code).toBe(0);
    const out = JSON.parse(j.stdout);
    // A workspace whose config doesn't load → registry is partial (spec 25 §3)
    expect(out.registry).toBe("partial");
  });

  it("test 12: --forge symlink → --json forge equals real path", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    const realForge = await fs.realpath(s.forge);

    // Create a symlink to the Forge
    const link = path.join(s.root, "forge-link");
    await fs.symlink(s.forge, link, process.platform === "win32" ? "junction" : "dir");

    const j = s.run(["forge", "impact", "--forge", link, "--json"]);
    expect(j.code).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.forge).toBe(realForge);
  });
});

describe("cli — forge unify impact (spec 25 §4.2–§4.3)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  /**
   * Fixture: temp root with Forge containing rules wf (base), wf--acme (variant), and other;
   * recipes base=[rule/wf--acme] and other=[rule/other]; profiles acme=[base] and globex=[other].
   * Workspaces a/ (acme) and g/ (globex) created and synced on demand.
   */
  async function setup() {
    const root = await tmpDir("craftar-forge-unify-impact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("other", "o\n")],
      recipes: [recipe("base", ["rule/wf--acme"]), recipe("other", ["rule/other"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["other"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const wsA = path.join(root, "a");
    const wsG = path.join(root, "g");
    await writeFiles(wsA, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    await writeFiles(wsG, { "craftar.yaml": `forge: ../forge\nprofile: globex\n` });

    const env = { CRAFTAR_HOME: home };
    const run = (args: string[], e: NodeJS.ProcessEnv = {}) => runCli(args, { env: { ...env, ...e } });

    // Sync both workspaces to register them
    expect(run(["sync", "--workspace", wsA]).code).toBe(0);
    expect(run(["sync", "--workspace", wsG]).code).toBe(0);

    return { root, forge, home, wsA, wsG, env, run };
  }

  it("test 1: impact lines — unify --take base → stdout ends with impact lines, no next: line, no removed-variant warning (registry read, no one disables)", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);
    const realG = await fs.realpath(s.wsG);

    // Unify wf base <- wf--acme with --take base: changes acme's .claude/rules/wf.md from b to a, globex unchanged
    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge]);
    expect(r.code, r.stderr).toBe(0);

    // Build expected stdout: header, file touch, resolved, impact lines, no next: line, no warnings
    expect(r.stdout).toContain(`  impact: ${realA} (acme) 1 file changes — .claude/rules/wf.md\n`);
    expect(r.stdout).toContain(`  impact: ${realG} (globex) no effect\n`);
    // No next: line when at least one workspace was checked
    expect(r.stdout).not.toContain("next:");
    // No removed-variant warning (none concerned, registry read)
    expect(r.stdout).not.toContain("was removed");
  });

  it("spec 29: a workspace whose sync is refused does not turn unify's passes into an error — they compare planned bytes", async () => {
    const s = await setup();
    const realG = await fs.realpath(s.wsG);
    // globex's rule now cites and declares `org`, with no value anywhere: its sync is refused
    await writeFiles(s.forge, {
      "ingredients/rules/other/rule.md": "Org: {{org}}\n",
      "ingredients/rules/other/ingredient.yaml": "type: rule\nname: other\nparams:\n  org:\n    description: the organisation\n",
    });
    gitCommitAll(s.forge, "other declares org");
    const impact = JSON.parse(s.run(["forge", "impact", "--forge", s.forge, "--json"]).stdout);
    expect(impact.workspaces.find((w: { path: string }) => w.path === realG).state).toBe("error");

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).impact.find((w: { path: string }) => w.path === realG)).toEqual({
      path: realG, profile: "globex", match: "path", via: null, ref: null, state: "no-effect", files: [], error: null,
    });
  });

  it("test 2: --json: impact array with correct shape", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);
    const realG = await fs.realpath(s.wsG);

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    expect(out.impact).toEqual([
      { path: realA, profile: "acme", match: "path", via: null, ref: null, state: "changed", files: [".claude/rules/wf.md"], error: null },
      { path: realG, profile: "globex", match: "path", via: null, ref: null, state: "no-effect", files: [], error: null },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("test 3: --no-impact: today's output with removed-variant warning, next: hint, impact: []", async () => {
    const s = await setup();

    // Run with --no-impact
    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--no-impact"]);
    expect(r.code, r.stderr).toBe(0);

    // Has the removed-variant warning with old text ending "; unify cannot reach workspaces" (no suffix, because --no-impact)
    expect(r.stdout).toContain(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces\n",
    );
    // Has the next: hint
    expect(r.stdout).toContain("next: run `craftar status --workspace <dir>` in a workspace on profile acme to see what moved");
    // No impact lines
    expect(r.stdout).not.toContain("impact:");

    // --json shows impact: []
    // Need fresh Forge setup for JSON test
    const s2 = await setup();
    const j = s2.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s2.forge, "--no-impact", "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.impact).toEqual([]);
  });

  it("test 4: unreadable registry → unify exits 0, warning about registry, removed-variant warning with registry suffix, impact: [], next: hint", async () => {
    const s = await setup();
    // Break the registry
    await fs.mkdir(s.home, { recursive: true });
    const registryPath = path.join(s.home, "registry.json");
    await fs.writeFile(registryPath, "not json\n");

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge]);
    expect(r.code, r.stderr).toBe(0);

    // Warning about registry unreadable (copy error message from output)
    expect(r.stdout).toContain("the registry could not be read");
    expect(r.stdout).toContain("no workspace was checked");

    // Removed-variant warning ends with "(the registry could not be read)"
    expect(r.stdout).toContain(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry could not be read)",
    );

    // Has the next: hint
    expect(r.stdout).toContain("next:");

    // --json shows impact: []
    const s2 = await setup();
    await fs.mkdir(s2.home, { recursive: true });
    await fs.writeFile(path.join(s2.home, "registry.json"), "not json\n");
    const j = s2.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s2.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.impact).toEqual([]);
  });

  it("test 5: workspace config does not load → its impact entry is error, unify exits 0", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);

    // Break g's craftar.yaml
    await fs.writeFile(path.join(s.wsG, "craftar.yaml"), "profile: [\n");

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // wsA should be changed, wsG should be error
    expect(out.impact[0]).toEqual({
      path: realA,
      profile: "acme",
      match: "path",
      via: null,
      ref: null,
      state: "changed",
      files: [".claude/rules/wf.md"],
      error: null,
    });
    expect(out.impact[1].state).toBe("error");
    expect(out.impact[1].error).toContain("invalid craftar.yaml");

    // The removed-variant warning should end with "(the registry could not check 1 workspace)"
    expect(out.warnings[0]).toContain("(the registry could not check 1 workspace)");
  });

  it("test 6: conditional warnings, removed variant — workspace disables it → named in concerned", async () => {
    const s = await setup();
    const realG = await fs.realpath(s.wsG);

    // Add overrides.ingredients.disable to g's craftar.yaml
    await fs.writeFile(
      path.join(s.wsG, "craftar.yaml"),
      `forge: ../forge\nprofile: globex\noverrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );
    // Re-sync to update the registration (not necessary for the test, but keeps registry consistent)
    expect(s.run(["sync", "--workspace", s.wsG]).code).toBe(0);

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name the concerned workspace
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realG} (craftar.yaml)`,
    );
  });

  it("test 6b: conditional warnings, removed variant — in craftar.local.yaml → named with (craftar.local.yaml)", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);

    // Add overrides.ingredients.disable to a's craftar.local.yaml
    await fs.writeFile(
      path.join(s.wsA, "craftar.local.yaml"),
      `overrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name the concerned workspace with (craftar.local.yaml)
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realA} (craftar.local.yaml)`,
    );
  });

  it("test 6c: concerned plus one missing workspace → warning includes unchecked count", async () => {
    const s = await setup();
    const realG = await fs.realpath(s.wsG);

    // Create and sync a third workspace, then delete it
    const wsM = path.join(s.root, "m");
    await writeFiles(wsM, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", wsM]).code).toBe(0);
    await fs.rm(wsM, { recursive: true });

    // Add overrides.ingredients.disable to g's craftar.yaml
    await fs.writeFile(
      path.join(s.wsG, "craftar.yaml"),
      `forge: ../forge\nprofile: globex\noverrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );
    expect(s.run(["sync", "--workspace", s.wsG]).code).toBe(0);

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name concerned and mention unchecked
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realG} (craftar.yaml) (the registry could not check 1 workspace)`,
    );
  });

  it("test 7: none concerned + missing → warning with unchecked suffix; no registered workspace → none suffix; registry off → off suffix", async () => {
    // Test 7a: missing workspace → unchecked suffix
    const s = await setup();

    // Create and sync a third workspace, then delete it (no one disables the variant)
    const wsM = path.join(s.root, "m");
    await writeFiles(wsM, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", wsM]).code).toBe(0);
    await fs.rm(wsM, { recursive: true });

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // None concerned, partial state → warning with unchecked suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry could not check 1 workspace)",
    );
  });

  it("test 7b: no registered workspace → none suffix", async () => {
    // Fresh setup with empty home
    const root = await tmpDir("craftar-forge-unify-impact-empty-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", forge, "--json"], { env: { CRAFTAR_HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    // No registered workspace → warning with none suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (no workspace of this Forge is registered on this machine)",
    );
  });

  it("test 7c: CRAFTAR_NO_REGISTRY=1 → registry off suffix", async () => {
    const s = await setup();

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"], { CRAFTAR_NO_REGISTRY: "1" });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    // Registry off → warning with off suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry is off)",
    );
  });

  it("test 8a: W1 (param) — workspace with overrides.params → concerned", async () => {
    // This test requires take: param. Use the same forge shape as the spec 09 tests.
    const root = await tmpDir("craftar-forge-unify-param-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Create a workspace with overrides.params.deploy.api
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\noverrides:\n  params:\n    deploy.api: test\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Save a plan and apply it with take: param
    const planDir = await tmpDir("craftar-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    // The hunk's pre-filled params should have globex-api → key
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // W1 warning should name the concerned workspace — whole string assertion
    const w1Warning = out.warnings.find((w: string) => w.includes("is now a parameter of"));
    expect(w1Warning).toEqual(
      `deploy.api is now a parameter of rule/deploy — a workspace that sets overrides.params.deploy.api (craftar.yaml or ` +
        `craftar.local.yaml) now overrides rule/deploy too — concerned: ${realWs} (craftar.yaml)`,
    );
  });

  it("test 8b: W1 (param) — none concerned with registry read → no W1 warning", async () => {
    const root = await tmpDir("craftar-forge-unify-param-none-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Create a workspace without overrides.params.deploy.api
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Save and modify a plan for take: param
    const planDir = await tmpDir("craftar-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // No W1 warning (none concerned, registry read)
    const w1Warning = out.warnings.find((w: string) => w.includes("is now a parameter of"));
    expect(w1Warning).toBeUndefined();
  });

  it("test 8c: W3 (section) — (a) workspace with overrides.sections → concerned, (b) without → no warning", async () => {
    // Inline the sectionForge fixture: rule/review-posture, variant --acme, section flavors
    const baseBody = "# Review posture\n\nDispatch reviewers.\n\nshared line\n";
    const variantBody = "# Review posture\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend |\n\nshared line\n";

    // Case (a): workspace with overrides.sections → W3 warning names the concerned workspace
    {
      const root = await tmpDir("craftar-forge-unify-section-a-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forge = path.join(root, "forge");
      const homeDir = path.join(root, "home");
      await makeForge(forge, {
        ingredients: [
          rule("review-posture", baseBody),
          rule("review-posture--acme", variantBody, { as: "review-posture" }),
        ],
        recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
        profiles: [profile("acme", ["base--acme"])],
      });
      gitInit(forge);
      gitCommitAll(forge, "init");

      const ws = path.join(root, "ws");
      await writeFiles(ws, {
        "craftar.yaml": `forge: ../forge\nprofile: acme\noverrides:\n  sections:\n    rule/review-posture:\n      flavors: override content\n`,
      });
      const env = { CRAFTAR_HOME: homeDir };
      expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
      const realWs = await fs.realpath(ws);

      // Save and edit plan for take: section
      const planDir = path.join(root, "plan");
      await fs.mkdir(planDir, { recursive: true });
      const planPath = path.join(planDir, "plan.yaml");
      expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", forge]).code).toBe(0);
      const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
      const editedPath = path.join(planDir, "edited.yaml");
      await fs.writeFile(editedPath, YAML.stringify(plan));

      const j = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
      expect(j.code, j.stderr).toBe(0);
      const out = JSON.parse(j.stdout);

      // W3 warning should name the concerned workspace — whole string assertion
      const w3Warning = out.warnings.find((w: string) => w.includes("is now a section of"));
      expect(w3Warning).toEqual(
        `flavors is now a section of rule/review-posture — a workspace that sets overrides.sections.rule/review-posture.flavors (craftar.yaml or ` +
          `craftar.local.yaml) now applies there — concerned: ${realWs} (craftar.yaml)`,
      );
    }

    // Case (b): workspace without the section override → no W3 warning, but sections were created
    {
      const root = await tmpDir("craftar-forge-unify-section-b-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forge = path.join(root, "forge");
      const homeDir = path.join(root, "home");
      await makeForge(forge, {
        ingredients: [
          rule("review-posture", baseBody),
          rule("review-posture--acme", variantBody, { as: "review-posture" }),
        ],
        recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
        profiles: [profile("acme", ["base--acme"])],
      });
      gitInit(forge);
      gitCommitAll(forge, "init");

      const ws = path.join(root, "ws");
      await writeFiles(ws, {
        "craftar.yaml": `forge: ../forge\nprofile: acme\n`,
      });
      const env = { CRAFTAR_HOME: homeDir };
      expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

      // Save and edit plan for take: section
      const planDir = path.join(root, "plan");
      await fs.mkdir(planDir, { recursive: true });
      const planPath = path.join(planDir, "plan.yaml");
      expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", forge]).code).toBe(0);
      const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
      const editedPath = path.join(planDir, "edited.yaml");
      await fs.writeFile(editedPath, YAML.stringify(plan));

      const j = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
      expect(j.code, j.stderr).toBe(0);
      const out = JSON.parse(j.stdout);

      // No W3 warning (none concerned, registry read)
      const w3Warning = out.warnings.find((w: string) => w.startsWith("flavors is now a section of"));
      expect(w3Warning).toBeUndefined();

      // But sections array should have the created section with written: true
      expect(out.sections.length).toBe(1);
      expect(out.sections[0].written).toBe(true);
    }
  });

  it("test 9: concerned() tests merged config — local array replaces base (spec 25 §4.3)", async () => {
    // Arrays replace on merge, so with:
    //   craftar.yaml: overrides.ingredients.disable: [rule/wf--acme]
    //   craftar.local.yaml: overrides.ingredients.disable: []
    // The merged config has disable: [], so the workspace is NOT concerned.
    const s = await setup();

    // Add overrides.ingredients.disable to g's craftar.yaml
    await fs.writeFile(
      path.join(s.wsG, "craftar.yaml"),
      `forge: ../forge\nprofile: globex\noverrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );
    // Add overrides.ingredients.disable to g's craftar.local.yaml that empties the array
    await fs.writeFile(
      path.join(s.wsG, "craftar.local.yaml"),
      `overrides:\n  ingredients:\n    disable: []\n`,
    );
    expect(s.run(["sync", "--workspace", s.wsG]).code).toBe(0);

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // The workspace is NOT concerned because the merged disable array is []
    // When no workspace is concerned and the registry was fully checked,
    // ALL concerned-based warnings vanish (spec 25 §4.3).
    expect(out.warnings).toEqual([]);
  });
});

describe("cli — forge unify --prune-recipes (spec 25 §4.4)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn().catch(() => {});
  });

  // Fixture: Forge with base variant that can be unified to match its sibling
  async function pruneFixture() {
    const root = await tmpDir("craftar-prune-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Base and variant with identical content after --take base
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    return { root, forge, home };
  }

  it("test 1: proven prune — recipe file deleted, profile repointed, every plan identical", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Recipe file should be gone
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(false);

    // Profile should be repointed — whole value assertion
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toBe("name: acme\nrecipes:\n  - base\ntargets:\n  - claude-code\n");

    // JSON output
    expect(out.recipes).toEqual({
      rewritten: ["base--acme"],
      identicalToSibling: ["base--acme"],
      pruned: [{ recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] }],
      kept: [],
    });

    // Warning about coverage
    expect(out.warnings).toEqual([
      "pruned against the 1 workspace registered on this machine — a workspace synced elsewhere (CI, another machine, CRAFTAR_NO_REGISTRY) is not covered",
    ]);

    // Next sync should update the file (because the base has "a" not "b")
    const status = runCli(["status", "--workspace", ws, "--json"], { env });
    expect(status.code, status.stderr).toBe(0);
    const statuses = JSON.parse(status.stdout).statuses;
    const fileUpdate = statuses.find((s: { path: string }) => s.path === ".claude/rules/wf.md");
    expect(fileUpdate.path).toBe(".claude/rules/wf.md");
    expect(fileUpdate.state).toBe("update");
  });

  it("spec 29: a registered workspace whose sync is refused does not stop the proof — it compares planned bytes", async () => {
    const root = await tmpDir("craftar-prune-refused-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const env = { CRAFTAR_HOME: path.join(root, "home") };
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("other", "Org: {{org}}\n")],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"]), recipe("other", ["rule/other"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["other"])],
    });
    const wsA = path.join(root, "a");
    const wsG = path.join(root, "g");
    await writeFiles(wsA, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    await writeFiles(wsG, { "craftar.yaml": `forge: ../forge\nprofile: globex\n` });
    expect(runCli(["sync", "--workspace", wsA], { env }).code).toBe(0);
    expect(runCli(["sync", "--workspace", wsG], { env }).code).toBe(0);
    // globex's rule now declares the key it cites, with no value anywhere: its sync is refused
    await writeFiles(forge, { "ingredients/rules/other/ingredient.yaml": "type: rule\nname: other\nparams:\n  org:\n    description: the organisation\n" });
    gitInit(forge);
    gitCommitAll(forge, "init");
    expect(runCli(["sync", "--check", "--workspace", wsG], { env }).code).toBe(1);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.recipes.pruned).toEqual([{ recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] }]);
    expect(out.recipes.kept).toEqual([]);
    expect(out.warnings).toEqual([
      "pruned against the 2 workspaces registered on this machine — a workspace synced elsewhere (CI, another machine, CRAFTAR_NO_REGISTRY) is not covered",
    ]);
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(false);
  });

  it("test 2: text mode of test 1 — whole stdout", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge], { env });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      `craftar forge unify rule/wf ↔ acme\n` +
        `  resolved yes · unresolved 0\n` +
        `  removed variant rule/wf--acme\n` +
        `  recipes rewritten: base--acme\n` +
        `  recipes now identical to a sibling: base--acme\n` +
        `  pruned recipe base--acme → base (profiles/acme/profile.yaml)\n` +
        `  warn pruned against the 1 workspace registered on this machine — a workspace synced elsewhere (CI, another machine, CRAFTAR_NO_REGISTRY) is not covered\n` +
        `  impact: ${realWs} (acme) 1 file changes — .claude/rules/wf.md\n`,
    );
  });

  it("test 3: refused — extends — a recipe extends the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    // Add a recipe that extends base--acme
    await writeFiles(forge, {
      "recipes/stack.yaml": `name: stack\nextends: [base--acme]\ningredients: []\n`,
    });
    gitCommitAll(forge, "add stack");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: "recipe stack extends it" }]);
    expect(out.recipes.pruned).toEqual([]);

    // Recipe file should still exist
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(true);
  });

  it("test 4: refused — recipes.add in craftar.yaml names the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    // Add the candidate to recipes.add
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - base--acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs} names it in recipes.add (craftar.yaml)` }]);
    expect(out.recipes.pruned).toEqual([]);
  });

  it("test 4b: refused — recipes.remove in craftar.local.yaml names the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Add the candidate to recipes.remove in local file
    await writeFiles(ws, { "craftar.local.yaml": `recipes:\n  remove:\n    - base--acme\n` });

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs} names it in recipes.remove (craftar.local.yaml)` }]);
  });

  it("test 4c: refused — entry order matters: remove in earlier entry beats add in later", async () => {
    // forgeWorkspaces sorts entries by path using localeCompare, so "a" < "b".
    // Workspace `a` has recipes.remove, workspace `b` has recipes.add.
    // The first concerned entry in entry order should win: `a`'s remove.
    const { root, forge, home } = await pruneFixture();
    const wsA = path.join(root, "a"); // earlier in localeCompare order
    const wsB = path.join(root, "b"); // later in localeCompare order
    await writeFiles(wsA, { "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  remove:\n    - base--acme\n` });
    await writeFiles(wsB, { "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - base--acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", wsA], { env }).code).toBe(0);
    expect(runCli(["sync", "--workspace", wsB], { env }).code).toBe(0);
    const realA = await fs.realpath(wsA);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Entry A (remove) should win over entry B (add) because A comes first in entry order
    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realA} names it in recipes.remove (craftar.yaml)` }]);
  });

  it("test 4d: the kind reads from the same file concerned named — local remove vs base add", async () => {
    // Regression: craftar.local.yaml has recipes.remove and craftar.yaml has recipes.add.
    // concerned() reports local first → first.file = "craftar.local.yaml".
    // The kind must come from the same file (local), not from (local OR base).
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    // craftar.yaml adds, craftar.local.yaml removes
    await writeFiles(ws, {
      "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - base--acme\n`,
      "craftar.local.yaml": `recipes:\n  remove:\n    - base--acme\n`,
    });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // The file is craftar.local.yaml (local checked first), the kind is remove (from that file)
    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs} names it in recipes.remove (craftar.local.yaml)` }]);
  });

  it("test 4e: check 3 reads the MERGED config — local empty array replaces base's add (spec 25 §4.3)", async () => {
    // Arrays replace on merge, so with:
    //   craftar.yaml: recipes.add: [base--acme]
    //   craftar.local.yaml: recipes.add: []
    // The merged config has recipes.add: [], so the workspace is NOT concerned by check 3.
    // The prune should succeed (proceed to the proof, which passes since the workspace plans the same).
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    // craftar.yaml adds, craftar.local.yaml empties the array
    await writeFiles(ws, {
      "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - base--acme\n`,
      "craftar.local.yaml": `recipes:\n  add: []\n`,
    });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Check 3 does NOT refuse the workspace: the merged recipes.add is [], not [base--acme].
    // The prune succeeds (proof passes since the workspace plans the same files).
    expect(out.recipes.pruned).toEqual([{ recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] }]);
    expect(out.recipes.kept).toEqual([]);
  });

  it("test 5: refused — the proof fails because a param default would move", async () => {
    const root = await tmpDir("craftar-prune-param-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Fixture: base and base--acme with a variant, plus recipe p between them with different param.
    // Profile: [base--acme, p, base] — removing base--acme means p becomes last-wins for tone.
    // The proof should fail because after editing, the workspace's plan differs.
    await makeForge(forge, {
      ingredients: [
        rule("wf", "tone is {{tone}}\n"),
        rule("wf--acme", "tone is {{tone}}\n", { as: "wf" }),
      ],
      recipes: [
        recipe("base", ["rule/wf"], { params: { tone: { default: "base" } } }),
        recipe("base--acme", ["rule/wf--acme"], { params: { tone: { default: "base" } } }),
        recipe("p", [], { params: { tone: { default: "p" } } }),
      ],
      profiles: [profile("acme", ["base--acme", "p", "base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Currently: [base--acme, p, base] → last wins is "base" (from recipe base).
    // After prune (remove base--acme): [base, p] → last wins is "p".
    // So the file would change from "tone is base\n" to "tone is p\n".
    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // The prune should be refused because after removing base--acme, the param order changes
    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs}: .claude/rules/wf.md would change` }]);
  });

  it("test 6: refused — no registered workspace", async () => {
    const { root, forge } = await pruneFixture();
    // Use a fresh home with no registry
    const freshHome = path.join(root, "fresh-home");
    await fs.mkdir(freshHome, { recursive: true });
    const env = { CRAFTAR_HOME: freshHome };

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: "no workspace of this Forge is registered on this machine" }]);
  });

  it("test 6b: refused — a workspace whose configuration does not load", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Make the workspace's configuration fail to load by breaking the YAML syntax
    await fs.writeFile(path.join(ws, "craftar.yaml"), "forge: ../forge\nprofile: {{invalid\n");

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Should be kept with an error message about unchecked workspaces
    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: "the registry could not check 1 workspace" }]);
  });

  it("test 6c: refused — a workspace whose plan throws after unify", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Make the workspace's plan throw by adding a nonexistent recipe
    // This loads OK but plan() throws: "recipe \"nonexistent\" not found (referenced by craftar.yaml recipes.add)"
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add: [nonexistent]\n` });

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Should be kept with the workspace path and error message
    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs}: recipe "nonexistent" not found (referenced by craftar.yaml recipes.add)` }]);
  });

  it("test 7: profile list shapes — sibling after suffixed", async () => {
    const root = await tmpDir("craftar-prune-shape-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Profile: [base--acme, x, base] → [base, x]
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("x", []),
      ],
      profiles: [profile("acme", ["base--acme", "x", "base"])],
    });
    // Add a trailing comment to the recipe list item to prove comment survives
    const profilePath = path.join(forge, "profiles/acme/profile.yaml");
    const originalProfile = await fs.readFile(profilePath, "utf8");
    const profileWithComment = originalProfile.replace("- base--acme\n", "- base--acme # keep\n");
    await fs.writeFile(profilePath, profileWithComment);
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.pruned.length).toBe(1);
    const profileText = await fs.readFile(profilePath, "utf8");
    // The whole profile text with the comment on the renamed item
    expect(profileText).toBe("name: acme\nrecipes:\n  - base # keep\n  - x\ntargets:\n  - claude-code\n");
  });

  it("test 7b: profile list shapes — sibling before suffixed", async () => {
    const root = await tmpDir("craftar-prune-shape-before-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Profile: [base, x, base--acme] → [base, x]
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("x", []),
      ],
      profiles: [profile("acme", ["base", "x", "base--acme"])],
    });
    // Add a trailing comment to the suffixed item to prove comment survives (it will be removed)
    const profilePath = path.join(forge, "profiles/acme/profile.yaml");
    const originalProfile = await fs.readFile(profilePath, "utf8");
    const profileWithComment = originalProfile.replace("- base--acme\n", "- base--acme # keep\n");
    await fs.writeFile(profilePath, profileWithComment);
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.pruned.length).toBe(1);
    const profileText = await fs.readFile(profilePath, "utf8");
    // The whole profile text — the suffixed item is removed (sibling comes first)
    expect(profileText).toBe("name: acme\nrecipes:\n  - base\n  - x\ntargets:\n  - claude-code\n");
  });

  it("test 8: a candidate whose profile unify also edits for take: param — both edits land", async () => {
    const root = await tmpDir("craftar-prune-param-edit-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Fixture with a param hunk
    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Save and apply a plan with take: param
    const planDir = path.join(root, "plan");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Both edits should land: param extraction AND prune
    expect(out.params.length).toBe(1);
    expect(out.params[0].key).toBe("deploy.api");
    expect(out.recipes.pruned.length).toBe(1);

    // Profile should have both the param AND the repointed recipe (whole text)
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toBe("name: acme\nrecipes:\n  - base\ntargets:\n  - claude-code\nparams:\n  deploy.api: acme-api\n");
  });

  it("test 9: --prune-recipes --no-impact is refused before anything is read", async () => {
    const root = await tmpDir("craftar-prune-noimpact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Snapshot the Forge before
    const forgeBefore = await snapshot(forge);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--no-impact", "--forge", forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --prune-recipes needs the impact passes — drop --no-impact\n");

    // Forge should be unchanged
    const forgeAfter = await snapshot(forge);
    expect(forgeAfter).toEqual(forgeBefore);
  });

  it("test 10: a profile file git does not hold refuses the whole unify before any write", async () => {
    const root = await tmpDir("craftar-prune-unheld-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Forge with acme profile that uses base--acme
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    // Add the profile directory to .gitignore BEFORE committing
    await fs.writeFile(path.join(forge, ".gitignore"), "profiles/acme/\n");
    gitCommitAll(forge, "init");
    // Now the profile exists but is ignored by git

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Snapshot
    const forgeBefore = await snapshot(forge);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(r.code).toBe(1);
    // Should report the profile is not held by git (whole first line)
    const firstLine = r.stderr.split("\n")[0];
    expect(firstLine).toBe(`error: unify can only change files git can restore — 1 path(s) under ${forge} are not:`);

    // Forge unchanged
    const forgeAfter = await snapshot(forge);
    expect(forgeAfter).toEqual(forgeBefore);
  });

  it("test 11: without --prune-recipes the identical-to-sibling warning ends with the prune hint", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Without --prune-recipes
    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Assert the whole warnings array with exactly this warning
    const siblingWarning = out.warnings.filter((w: string) => w.includes("identical to base"));
    expect(siblingWarning).toEqual([
      "recipe base--acme is now identical to base — it can be removed by hand after repointing the profiles, extends and workspace recipes lists that name it; unify does not, because a workspace or an extends chain may also name base and the recipe order or param precedence would change — or restore the Forge with git and rerun this unify with --prune-recipes",
    ]);
  });

  it("test 12: multi-candidate prune — profile lists both recipes, both are pruned, final profile text has neither suffix", async () => {
    // Bug: pruneRecipes check 4 reads each candidate's profile from disk, so with profile
    // `acme: [base--acme, web--acme]` and BOTH recipes left identical to their siblings,
    // candidate 2's edit is built from the original text and the CLI's sequential writes
    // let it overwrite candidate 1's: the profile ends `[base--acme, web]` while
    // `recipes/base--acme.yaml` is deleted; exit 0.
    const root = await tmpDir("craftar-prune-multi-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Forge: profile acme uses both base--acme and web--acme; both recipes reference the same
    // variant ingredient rule/wf--acme, so unifying that single variant makes both recipes
    // identical to their siblings.
    await makeForge(forge, {
      ingredients: [
        rule("wf", "a\n"),
        rule("wf--acme", "b\n", { as: "wf" }),
      ],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("web", ["rule/wf"]),
        recipe("web--acme", ["rule/wf--acme"]),
      ],
      profiles: [profile("acme", ["base--acme", "web--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Both recipes should be pruned (whole value assertion)
    expect(out.recipes.pruned).toEqual([
      { recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] },
      { recipe: "web--acme", sibling: "web", profiles: ["profiles/acme/profile.yaml"] },
    ]);
    expect(out.recipes.kept).toEqual([]);

    // The whole profile text — both suffixed entries replaced
    const profilePath = path.join(forge, "profiles/acme/profile.yaml");
    const profileText = await fs.readFile(profilePath, "utf8");
    expect(profileText).toBe("name: acme\nrecipes:\n  - base\n  - web\ntargets:\n  - claude-code\n");

    // Both suffixed recipe files should be deleted
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(false);
    expect(await exists(path.join(forge, "recipes/web--acme.yaml"))).toBe(false);

    // recipes --forge --profile acme should show no warnings on stderr
    const recipesCmd = runCli(["recipes", "--forge", forge, "--profile", "acme"]);
    expect(recipesCmd.code).toBe(0);
    expect(recipesCmd.stderr).toBe("");
  });

  it("test 12b: multi-candidate prune — workspace is on a different profile, no conflict", async () => {
    // Same multi-candidate fixture but the registered workspace is on profile `globex`,
    // so there is no conflict with the workspace's recipes.add/remove.
    const root = await tmpDir("craftar-prune-multi-globex-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [
        rule("wf", "a\n"),
        rule("wf--acme", "b\n", { as: "wf" }),
      ],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("web", ["rule/wf"]),
        recipe("web--acme", ["rule/wf--acme"]),
      ],
      profiles: [
        profile("acme", ["base--acme", "web--acme"]),
        profile("globex", ["base"]),
      ],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Workspace is on profile globex, not acme
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: globex\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Both recipes should be pruned
    expect(out.recipes.pruned).toEqual([
      { recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] },
      { recipe: "web--acme", sibling: "web", profiles: ["profiles/acme/profile.yaml"] },
    ]);

    // The whole profile text — both suffixed entries replaced
    const profilePath = path.join(forge, "profiles/acme/profile.yaml");
    const profileText = await fs.readFile(profilePath, "utf8");
    expect(profileText).toBe("name: acme\nrecipes:\n  - base\n  - web\ntargets:\n  - claude-code\n");
  });

  it("test 13: profile whose recipe list does not round-trip keeps the candidate", async () => {
    const root = await tmpDir("craftar-prune-noround-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Build Forge with makeForge, then overwrite the profile with a non-round-trip format
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });

    // Overwrite profile with flow syntax + inner spaces — does not round-trip
    const profilePath = path.join(forge, "profiles/acme/profile.yaml");
    const nonRoundTripProfile = `name: acme
recipes: [ base--acme ]
targets:
  - claude-code
`;
    await fs.writeFile(profilePath, nonRoundTripProfile);

    // Commit the non-round-trip profile so git gate passes
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Register a workspace
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Pruned should be empty — profile cannot be edited
    expect(out.recipes.pruned).toEqual([]);

    // Kept should have the exact reason (copied from a run)
    expect(out.recipes.kept).toEqual([
      {
        recipe: "base--acme",
        reason: "unify: cannot edit profiles/acme/profile.yaml in place (it does not round-trip unchanged through the YAML writer: line 2, under recipes) — reformat it by hand, commit, and re-run",
      },
    ]);

    // Profile file unchanged
    const profileAfter = await fs.readFile(profilePath, "utf8");
    expect(profileAfter).toBe(nonRoundTripProfile);

    // Recipe file still exists
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(true);
  });
});

describe("cli — craftar cache prune (spec 26 §4)", () => {
  const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };
  const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

  async function setup() {
    const root = await tmpDir("craftar-prune-cli-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home });
    const key = cacheKey(r.url);
    const run = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
      runCli(["cache", "prune", ...args], { cwd: opts.cwd ?? root, env: { CRAFTAR_HOME: home, CRAFTAR_NO_REGISTRY: "", ...opts.env } });
    return { root, home, r, key, forges: path.join(home, "forges"), run };
  }

  it("an orphan entry: the header, one removed line, the total; exit 0; the entry is gone", async () => {
    const s = await setup();
    const out = s.run([]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const lines = out.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^craftar cache prune — ${s.forges.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(1 entry, \\d+\\.\\d MB\\)$`));
    const UNVOUCHED = UNVOUCHED_HIDDEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(lines[1]).toMatch(new RegExp(`^  removed {6}${UNVOUCHED} orphan: nothing names it \\d+\\.\\d MB$`));
    expect(lines.slice(2)).toEqual([expect.stringMatching(/^freed \d+\.\d MB$/), ""]);
    expect(await fs.readdir(s.forges)).toEqual([]);
  });

  it("--dry-run: would remove, would free, nothing removed", async () => {
    const s = await setup();
    const out = s.run(["--dry-run"]);
    expect(out.code).toBe(0);
    const UNVOUCHED = UNVOUCHED_HIDDEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(out.stdout.split("\n").slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^  would remove ${UNVOUCHED} orphan: nothing names it \\d+\\.\\d MB$`)),
      expect.stringMatching(/^would free \d+\.\d MB$/),
      "",
    ]);
    expect(await fs.readdir(s.forges)).toEqual([s.key]);
  });

  it("--json prints the report only, keys in the contract's order", async () => {
    const s = await setup();
    const out = s.run(["--json", "--dry-run"]);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(Object.keys(report)).toEqual(["home", "dryRun", "removed", "kept", "freedBytes", "warnings"]);
    expect([report.home, report.dryRun, report.removed.map((x: { path: string; kind: string; reason: string }) => [x.path, x.kind, x.reason]), report.kept, report.warnings]).toEqual([
      s.home,
      true,
      [[`forges/${UNVOUCHED_HIDDEN}`, "entry", "orphan"]],
      [],
      [],
    ]);
  });

  it("the current directory naming the Forge keeps its entry; CRAFTAR_NO_REGISTRY keeps every entry, with the warning", async () => {
    const s = await setup();
    const ws = path.join(s.root, "acme-a");
    await writeFiles(ws, { "craftar.yaml": `forge: ${s.r.url}\nprofile: acme\n` });
    const here = s.run([], { cwd: ws });
    expect(here.stdout.split("\n").slice(1)).toEqual([`  kept         ${s.key} named by ${await fs.realpath(ws)}`, "freed 0.0 MB", ""]);
    const off = s.run([], { env: { CRAFTAR_NO_REGISTRY: "1" } });
    expect(off.code).toBe(0);
    expect(off.stdout.split("\n").slice(1)).toEqual([
      `  kept         ${UNVOUCHED_HIDDEN} not checked`,
      "  warn whole entries kept: CRAFTAR_NO_REGISTRY is set — nothing can tell which ones are used",
      "freed 0.0 MB",
      "",
    ]);
    expect(await fs.readdir(s.forges)).toEqual([s.key]);
  });

  it("an explicit --workspace without craftar.yaml exits 1 on stderr; an unreadable forges/ exits 1 naming it; no forges/: nothing to prune", async () => {
    const s = await setup();
    for (const extra of [[], ["--json"]]) {
      const bad = s.run(["--workspace", s.root, ...extra]);
      expect([bad.code, bad.stdout]).toEqual([1, ""]);
      expect(bad.stderr).toBe(`error: no craftar.yaml in ${s.root} — run cache prune inside a workspace, or without --workspace\n`);
    }
    await fs.rm(s.forges, { recursive: true, force: true });
    const none = s.run([]);
    expect([none.code, none.stdout, none.stderr]).toEqual([0, "nothing to prune\n", ""]);
    expect(await fs.readdir(s.home)).toEqual([]);
    await fs.writeFile(s.forges, "not a directory");
    const unreadable = s.run([]);
    expect([unreadable.code, unreadable.stdout, unreadable.stderr]).toEqual([1, "", `error: cannot read ${s.forges}: not a directory\n`]);
  });

  it("--help names the three options", async () => {
    const out = runCli(["cache", "prune", "--help"]);
    expect(out.code).toBe(0);
    for (const flag of ["--dry-run", "--workspace <dir>", "--json"]) expect(out.stdout).toContain(flag);
  });
});


describe("cli — pinned before spec 28", () => {
  /**
   * Pin the order of two or more states on `craftar forge impact` rows and `next sync:` lines.
   * The order reads NEXT_SYNC_STATES in src/cli.ts (and FILE_STATE_ORDER_MAP in src/core/impact.ts
   * for --json); spec 28 will move the counting half of nextSyncLine to the core over the one
   * FileState record. These tests fail when the order moves.
   */

  const SPEC = {
    ingredients: [
      rule("a", "# A\n"),
      rule("b", "# B\n"),
      rule("c", "# C\n"),
      rule("d", "# D\n"),
    ],
    recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
    profiles: [profile("acme", ["base"])],
  };

  async function setup() {
    const root = await tmpDir("craftar-pinned-spec28-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const registry = path.join(home, "registry.json");
    return { root, home, forge, run, registry };
  }

  it("test 1: a row with three states in FileState order — new, update, drift, orphan", async () => {
    const s = await setup();
    // Create a workspace with rules a, b, c
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);

    // Hand-edit rule a → drift
    await fs.writeFile(path.join(ws, ".claude/rules/a.md"), "# A edited by hand\n");
    // Change rule b in the Forge → update
    await fs.writeFile(path.join(s.forge, "ingredients/rules/b/rule.md"), "# B changed in Forge\n");
    // Add rule d to the recipe → new
    const baseRecipe = YAML.parse(await fs.readFile(path.join(s.forge, "recipes/base.yaml"), "utf8"));
    baseRecipe.ingredients.push("rule/d");
    await fs.writeFile(path.join(s.forge, "recipes/base.yaml"), YAML.stringify(baseRecipe));
    // Remove rule c from the recipe → orphan
    baseRecipe.ingredients = baseRecipe.ingredients.filter((i: string) => i !== "rule/c");
    await fs.writeFile(path.join(s.forge, "recipes/base.yaml"), YAML.stringify(baseRecipe));

    const realWs = await fs.realpath(ws);
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 1 registered workspace (1 by path)\n` +
      `  ${realWs}  acme  1 new, 1 update, 1 drift, 1 orphan\n`
    );
  });

  it("test 2: the same counts through --json — keys in FileState order", async () => {
    const s = await setup();
    // Create a workspace with rules a, b, c
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);

    // Hand-edit rule a → drift
    await fs.writeFile(path.join(ws, ".claude/rules/a.md"), "# A edited by hand\n");
    // Change rule b in the Forge → update
    await fs.writeFile(path.join(s.forge, "ingredients/rules/b/rule.md"), "# B changed in Forge\n");
    // Add rule d to the recipe → new
    const baseRecipe = YAML.parse(await fs.readFile(path.join(s.forge, "recipes/base.yaml"), "utf8"));
    baseRecipe.ingredients.push("rule/d");
    await fs.writeFile(path.join(s.forge, "recipes/base.yaml"), YAML.stringify(baseRecipe));
    // Remove rule c from the recipe → orphan
    baseRecipe.ingredients = baseRecipe.ingredients.filter((i: string) => i !== "rule/c");
    await fs.writeFile(path.join(s.forge, "recipes/base.yaml"), YAML.stringify(baseRecipe));

    const realWs = await fs.realpath(ws);
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge, "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    const out = JSON.parse(r.stdout);
    expect(out.forge).toBe(realForge);

    // Find the workspace row
    const row = out.workspaces.find((w: { path: string }) => w.path === realWs);
    expect(row).toBeDefined();

    // The counts object's keys must be in FileState order: new, update, drift, orphan
    expect(JSON.stringify(Object.keys(row.counts))).toBe(JSON.stringify(["new", "update", "drift", "orphan"]));
    expect(row.counts).toEqual({ new: 1, update: 1, drift: 1, orphan: 1 });
  });

  it("test 3: next sync: with new before collision — 3 new, 1 collision", async () => {
    // A SEPARATE Forge for this test: four rules a, b, c, d
    const SPEC2 = {
      ingredients: [
        rule("a", "# A\n"),
        rule("b", "# B\n"),
        rule("c", "# C\n"),
        rule("d", "# D\n"),
      ],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c", "rule/d"])],
      profiles: [profile("acme", ["base"])],
    };

    const root = await tmpDir("craftar-pinned-spec28-nextsync-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC2);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });

    // Create workspace dir with a pre-existing .claude/rules/a.md that differs → collision
    const ws = path.join(root, "ws");
    await writeFiles(ws, {
      ".claude/rules/a.md": "# My own A\n",
    });

    const r = run(["init", "--workspace", ws, "--forge", forge, "--profile", "acme", "--no-sync"]);
    expect(r.code, r.stderr).toBe(0);

    const lines = r.stdout.split("\n");
    // The next sync: line must have new before collision
    expect(lines[2]).toBe("next sync: 3 new, 1 collision — run `craftar sync`");
  });
});


describe("cli — craftar init off a terminal (spec 28 §4.5)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("p", "# P {{nope}}\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("extra", ["rule/b"]), recipe("ph", ["rule/p"])],
    profiles: [profile("acme", ["base"])],
  };

  /** A temporary root with its own CRAFTAR_HOME and a path Forge; workspaces are siblings of the Forge. */
  async function setup() {
    const root = await tmpDir("craftar-init-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const init = (ws: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      run(["init", "--workspace", ws, "--forge", forge, "--profile", "acme", ...extra], env);
    const registry = path.join(home, "registry.json");
    return { root, home, forge, run, init, registry };
  }

  it("test 2: --forge missing → N2", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws, "--profile", "acme"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: --forge is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked\n");
    expect(await exists(ws)).toBe(false);
  });

  it("test 3: both --forge and --profile missing → N2", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: --forge and --profile are required when craftar init does not run in a terminal — pass them, or run craftar init in a terminal to be asked\n");
    expect(await exists(ws)).toBe(false);
  });

  it("test 4: N1 before N2 — craftar.yaml already exists", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: elsewhere\nprofile: other\n" });
    const r = s.run(["init", "--workspace", ws, "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: craftar.yaml already exists in ${ws} — change recipes with craftar add recipe / remove recipe, or edit it\n`);
    // craftar.yaml unchanged
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: elsewhere\nprofile: other\n");
  });

  it("test 5: N9 before N2 — --workspace is a file", async () => {
    const s = await setup();
    const file = path.join(s.root, "a-file");
    await fs.writeFile(file, "x\n");
    const r = s.run(["init", "--workspace", file, "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: cannot use ${file} as a workspace: it is not a directory\n`);
  });

  it("test 6: N7 before N2 — unknown target", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws, "--forge", s.forge, "--targets", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error: unknown target "nope" (claude-code, kiro, agents-md)\n');
    expect(await exists(ws)).toBe(false);
  });

  it("test 7: N3 before N2 — credential in --forge, value never printed", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const secret = "s3" + "cr3t";
    const r = s.run(["init", "--workspace", ws, "--forge", `https://alice:${secret}@example.invalid/f.git`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: --forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(await exists(ws)).toBe(false);
  });

  it("test 8: N2 reads no file — craftar.local.yaml invalid YAML does not cause error before N2", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.local.yaml": "forge: [\n" });
    const r = s.run(["init", "--workspace", ws, "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // N2 message, not a YAML error
    expect(r.stderr).toBe("error: --profile is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked\n");
    // craftar.local.yaml unchanged, no craftar.yaml created
    expect(await fs.readFile(path.join(ws, "craftar.local.yaml"), "utf8")).toBe("forge: [\n");
    expect(await exists(path.join(ws, "craftar.yaml"))).toBe(false);
  });

  it("test 9: flags mode is untouched by local file read once — no again line", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.local.yaml": "targets: [kiro]\n" });
    const r = s.init(ws, ["--no-sync"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[1]).toBe("  forge ../forge · profile acme · recipes base · targets kiro (from craftar.local.yaml)");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  again "))).toEqual([]);
  });

  it("--help of import names --report and that it never holds content (spec 29)", () => {
    const help = runCli(["import", "--help"]).stdout.replace(/\s+/g, " ");
    expect(help).toContain("--report <file.md>");
    expect(help).toContain("paths and line counts, never content");
  });

  it("--help of status and sync name the unset-parameter refusal (spec 29)", () => {
    expect(runCli(["status", "--help"]).stdout.replace(/\s+/g, " ")).toContain("exits 1 when a declared parameter a file cites has no value");
    expect(runCli(["sync", "--help"]).stdout.replace(/\s+/g, " ")).toContain("refuses, writing nothing, when a declared parameter a file cites has no value");
  });

  it("test 10: --help shows the updated option descriptions", async () => {
    // Commander wraps lines at ~80 columns. The filter gets lines matching --forge or --profile,
    // which picks the first line of each option (before wrapping continues on indented lines).
    const out = runCli(["init", "--help"]);
    expect(out.code).toBe(0);
    // Check that the help text contains the new description keywords (wrapped across lines)
    expect(out.stdout).toContain("--forge <dir|url>");
    expect(out.stdout).toContain("--profile <name>");
    // The text "asked for in a terminal when" appears before wrapping
    expect(out.stdout).toContain("asked for in a terminal when");
    // Check the starting parts match what we expect (lines are wrapped by commander)
    const lines = out.stdout.split("\n").filter((l) => /^\s+--forge|^\s+--profile/.test(l)).map((l) => l.trim());
    expect(lines).toEqual([
      "--forge <dir|url>       the Forge: a directory (written relative to the",
      "--profile <name>        the client profile in the Forge; asked for in a",
    ]);
  });
});


describe("cli — init under a file (spec 28 §14)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n")],
    recipes: [recipe("base", ["rule/a"])],
    profiles: [profile("acme", ["base"])],
  };

  async function setup() {
    const root = await tmpDir("craftar-init-under-file-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    return { root, home, forge, run };
  }

  it("test 1: init --workspace <file>/ws → N9 naming the file", async () => {
    const s = await setup();
    const f = path.join(s.root, "regular_file");
    await fs.writeFile(f, "content\n");
    const r = s.run(["init", "--workspace", `${f}/ws`, "--forge", s.forge, "--profile", "acme"]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: cannot use ${f} as a workspace: it is not a directory\n`]);
    expect(await fs.readFile(f, "utf8")).toBe("content\n");
  });

  it("test 2: two levels down --workspace <file>/a/b → N9 naming the file", async () => {
    const s = await setup();
    const f = path.join(s.root, "regular_file");
    await fs.writeFile(f, "content\n");
    const r = s.run(["init", "--workspace", `${f}/a/b`, "--forge", s.forge, "--profile", "acme"]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: cannot use ${f} as a workspace: it is not a directory\n`]);
  });

  it("test 3: off a terminal with --profile missing and --workspace <file>/ws → N9, not N2", async () => {
    const s = await setup();
    const f = path.join(s.root, "regular_file");
    await fs.writeFile(f, "content\n");
    const r = s.run(["init", "--workspace", `${f}/ws`, "--forge", s.forge]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: cannot use ${f} as a workspace: it is not a directory\n`]);
  });

  it("test 4: --workspace <dir>/a/b/c where none exist → code 0, creates the workspace", async () => {
    const s = await setup();
    const dir = path.join(s.root, "existing_dir");
    await fs.mkdir(dir);
    const ws = path.join(dir, "a", "b", "c");
    const r = s.run(["init", "--workspace", ws, "--forge", s.forge, "--profile", "acme"]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../../../../forge\nprofile: acme\n");
  });
});

describe("diff — example file withholding (spec 27 §4.2, Ruling 4)", () => {
  const EX = ".claude/settings.craftar.example.json";
  const PLANNED = '{\n  "env": {\n    "ACME_TRACKER_TOKEN": ""\n  }\n}\n';
  const MARK = "MARKER_TYPED_27";
  const mcp = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx" } } };

  async function exScenario(files?: Record<string, string | Buffer>) {
    const s = await scenario(
      { ingredients: [mcp], recipes: [recipe("base", ["mcp/tracker"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" }, files },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("8. drift: sync then write marker; diff prints headers and 'content not shown' line, not the marker; with --exit-code: same stdout, code 1", async () => {
    const s = await exScenario();
    runCli(["sync", "--workspace", s.wsRoot]);
    const drifted = '{\n  "env": {\n    "ACME_TRACKER_TOKEN": "' + MARK + '"\n  }\n}\n';
    await fs.writeFile(path.join(s.wsRoot, EX), drifted);
    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/settings.craftar.example.json (disk, drift)\n" +
        "+++ .claude/settings.craftar.example.json (forge)\n" +
        "  content not shown: an example file may hold a value typed by hand\n",
    );
    const ec = runCli(["diff", "--exit-code", "--workspace", s.wsRoot]);
    expect(ec.code).toBe(1);
    expect(ec.stdout).toBe(r.stdout);
  });

  it("9. collision: no sync; write marker file; diff stdout contains headers with (disk, collision) and 'content not shown', marker never printed; assert whole stdout after observing .mcp.json part", async () => {
    // The spec says: capture the .mcp.json part from unchanged code first, then assert the whole stdout literally after.
    // .mcp.json is new (no sync), so its diff is the full content added.
    const s = await exScenario({ [EX]: '{"env":{"OTHER":"' + MARK + '"}}' });
    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // The marker must never appear in stdout
    expect(r.stdout.includes(MARK)).toBe(false);
    // The output must contain the example file headers with collision and the "content not shown" line
    expect(r.stdout).toContain("--- .claude/settings.craftar.example.json (disk, collision)");
    expect(r.stdout).toContain("+++ .claude/settings.craftar.example.json (forge)");
    expect(r.stdout).toContain("  content not shown: an example file may hold a value typed by hand");
    // The exact expected stdout (example file first as it comes before .mcp.json alphabetically):
    expect(r.stdout).toBe(
      "--- .claude/settings.craftar.example.json (disk, collision)\n" +
        "+++ .claude/settings.craftar.example.json (forge)\n" +
        "  content not shown: an example file may hold a value typed by hand\n" +
        "--- .mcp.json (disk, new)\n" +
        "+++ .mcp.json (forge)\n" +
        "+ {\n" +
        '+   "mcpServers": {\n' +
        '+     "tracker": {\n' +
        '+       "command": "npx"\n' +
        "+     }\n" +
        "+   }\n" +
        "+ }\n",
    );
  });

  it("10. orphan-drift (as test 3 in status): stdout is the unchanged code's output — pinned", async () => {
    const s = await exScenario();
    runCli(["sync", "--workspace", s.wsRoot]);
    await fs.appendFile(path.join(s.wsRoot, EX), " ");
    // Remove authEnv to make it an orphan
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/mcp/tracker/ingredient.yaml"),
      YAML.stringify({ type: "mcp", name: "tracker", server: { command: "npx" } }),
    );
    const r = runCli(["diff", "--workspace", s.wsRoot]);
    // orphan-drift output is: header + explainSkip line
    expect(r.stdout).toBe(
      "--- .claude/settings.craftar.example.json (disk, orphan-drift)\n" +
        "  no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself\n",
    );
  });

  it("11. update for another file is untouched: an ordinary rule drifted in the same workspace still prints its hunks", async () => {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n"), mcp],
        recipes: [recipe("base", ["rule/a", "mcp/tracker"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    runCli(["sync", "--workspace", s.wsRoot]);
    // Edit the rule to cause drift
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/a.md"), "# A modified\n");
    // Also edit the example file to cause drift there too
    await fs.writeFile(path.join(s.wsRoot, EX), PLANNED.replace('""', '"secret"'));
    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    // The rule's hunks should be shown (the diff uses "- " and "+ " with leading space)
    expect(r.stdout).toContain("--- .claude/rules/a.md (disk, drift)");
    expect(r.stdout).toContain("+++ .claude/rules/a.md (forge)");
    expect(r.stdout).toContain("- # A modified");
    expect(r.stdout).toContain("+ # A");
    // The example file should NOT show its content (drift)
    expect(r.stdout).toContain("--- .claude/settings.craftar.example.json (disk, drift)");
    expect(r.stdout).toContain("  content not shown: an example file may hold a value typed by hand");
    // The secret should not appear
    expect(r.stdout.includes("secret")).toBe(false);
  });

  it("12. collision with --exit-code: exits 1, same stdout as without --exit-code", async () => {
    const s = await exScenario({ [EX]: '{"env":{"OTHER":"' + MARK + '"}}' });
    const plain = runCli(["diff", "--workspace", s.wsRoot]);
    // A `diff` that throws exits 1 with nothing on stdout: the plain run pins that it printed.
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout.startsWith("--- .claude/settings.craftar.example.json (disk, collision)\n+++ .claude/settings.craftar.example.json (forge)\n  content not shown: an example file may hold a value typed by hand\n")).toBe(true);
    const ec = runCli(["diff", "--exit-code", "--workspace", s.wsRoot]);
    expect(ec.code).toBe(1);
    expect(ec.stdout).toBe(plain.stdout);
    // Marker never appears
    expect(ec.stdout.includes(MARK)).toBe(false);
  });
});
