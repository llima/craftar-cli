import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { asParamPlan } from "./helpers/golden-param-edits.js";

/**
 * The byte net for parameter extraction (spec 09 §11.3, §11.4): a committed input Forge
 * (`test/golden/forge-param/`), the two committed plans beside it, and the expected tree after
 * both unifies — plus the proof that two workspaces, one per profile, see no byte move.
 * `test/helpers/regen-golden-param.ts` produces the plans and the expected tree the same way.
 */
const GOLDEN = path.resolve(__dirname, "golden");
const INPUT = path.join(GOLDEN, "forge-param");
const EXPECTED = path.join(GOLDEN, "forge-param-expected");
const PLANS = { deploy: path.join(GOLDEN, "forge-param-plan-deploy.yaml"), ports: path.join(GOLDEN, "forge-param-plan-ports.yaml") };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const forgeFiles = async (dir: string) => (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await forgeFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await forgeFiles(dir)) out[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
  return out;
}
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

/** A committed copy of the input Forge in tmp. */
async function freshForge(): Promise<{ tmp: string; forge: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-param-"));
  cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
  const forge = path.join(tmp, "forge");
  await copyTree(INPUT, forge);
  execFileSync("git", ["init", "-q", forge]);
  execFileSync("git", ["-C", forge, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", forge, "config", "gc.auto", "0"]);
  gitCommitAll(forge, "init");
  return { tmp, forge };
}

async function unifyBoth(forge: string): Promise<void> {
  for (const [name, plan] of Object.entries(PLANS)) {
    const r = runCli(["forge", "unify", `rule/${name}`, "--profile", "acme", "--plan", plan, "--forge", forge]);
    expect(r.code, r.stderr).toBe(0);
    gitCommitAll(forge, `unify ${name}`);
  }
}

describe("golden: parameter extraction writes exact bytes into a Forge", () => {
  it("both committed plans reproduce the expected tree byte for byte", async () => {
    const { forge } = await freshForge();
    await unifyBoth(forge);
    expect(await forgeFiles(forge)).toEqual(await forgeFiles(EXPECTED));
    expect(await snapshot(forge)).toEqual(await snapshot(EXPECTED));
  });

  it("a fresh --save-plan, edited as the regen script edits it, reproduces the committed plans", async () => {
    const { tmp, forge } = await freshForge();
    for (const [name, committed] of Object.entries(PLANS)) {
      const saved = path.join(tmp, `${name}.yaml`);
      expect(runCli(["forge", "unify", `rule/${name}`, "--profile", "acme", "--save-plan", saved, "--forge", forge]).code).toBe(0);
      expect(YAML.stringify(asParamPlan(YAML.parse(await fs.readFile(saved, "utf8"))))).toBe(await fs.readFile(committed, "utf8"));
    }
  });
});

describe("two-profile sync proof (spec 09 §11.4)", () => {
  async function workspaces(tmp: string, forge: string) {
    const ws: Record<string, string> = {};
    for (const p of ["acme", "globex"]) {
      ws[p] = path.join(tmp, `ws-${p}`);
      await fs.mkdir(ws[p], { recursive: true });
      await fs.writeFile(path.join(ws[p], "craftar.yaml"), YAML.stringify({ forge: path.relative(ws[p], forge).split(path.sep).join("/"), profile: p }));
      const r = runCli(["sync", "--workspace", ws[p]]);
      expect(r.code, r.stderr).toBe(0);
    }
    return ws;
  }
  const states = (ws: string) =>
    (JSON.parse(runCli(["status", "--workspace", ws, "--json"]).stdout).statuses as Array<{ path: string; state: string }>).map((s) => [s.path, s.state]);

  it("after both extractions every file of both workspaces is unchanged, byte for byte", async () => {
    const { tmp, forge } = await freshForge();
    const ws = await workspaces(tmp, forge);
    const before = { acme: await snapshot(ws.acme), globex: await snapshot(ws.globex) };
    expect(Object.keys(before.acme)).toEqual(expect.arrayContaining([".claude/rules/deploy.md", ".kiro/steering/deploy.md", "AGENTS.md"]));
    await unifyBoth(forge);
    for (const p of ["acme", "globex"] as const) {
      expect(states(ws[p]).filter(([, s]) => s !== "unchanged"), p).toEqual([]);
      expect(runCli(["sync", "--check", "--workspace", ws[p]]).code, p).toBe(0);
      expect(await snapshot(ws[p]), p).toEqual(before[p]);
    }
  });

  it("negative control: without acme's profile values its generated files would change", async () => {
    const { tmp, forge } = await freshForge();
    const ws = await workspaces(tmp, forge);
    await unifyBoth(forge);
    const prof = path.join(forge, "profiles/acme/profile.yaml");
    const parsed = YAML.parse(await fs.readFile(prof, "utf8"));
    delete parsed.params;
    await fs.writeFile(prof, YAML.stringify(parsed));
    const moved = states(ws.acme).filter(([, s]) => s === "update").map(([p]) => p);
    expect(moved).toEqual(expect.arrayContaining([".claude/rules/deploy.md", ".kiro/steering/deploy.md", "AGENTS.md"]));
  });
});

describe("golden import round trip (spec 10 §10.3, §10.5)", () => {
  async function syncedWorkspaces(tmp: string, forge: string, profiles: string[]) {
    const ws: Record<string, string> = {};
    for (const p of profiles) {
      ws[p] = path.join(tmp, `ws-${p}`);
      await fs.mkdir(ws[p], { recursive: true });
      await fs.writeFile(path.join(ws[p], "craftar.yaml"), YAML.stringify({ forge: path.relative(ws[p], forge).split(path.sep).join("/"), profile: p }));
      const r = runCli(["sync", "--workspace", ws[p]]);
      expect(r.code, r.stderr).toBe(0);
    }
    return ws;
  }
  const importCli = (forge: string, profile: string, ws: string, ...extra: string[]) =>
    runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", profile, "--workspace", ws, ...extra]);
  const statesOf = (ws: string) =>
    (JSON.parse(runCli(["status", "--workspace", ws, "--json"]).stdout).statuses as Array<{ path: string; state: string }>).map((s) => [s.path, s.state] as const);
  const gitStatus = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

  it("re-importing both clients after the extractions reuses every base and moves no workspace byte (AC 4)", async () => {
    const { tmp, forge } = await freshForge();
    const ws = await syncedWorkspaces(tmp, forge, ["acme", "globex"]);
    const before = { acme: await snapshot(ws.acme), globex: await snapshot(ws.globex) };
    await unifyBoth(forge);
    for (const p of ["acme", "globex"]) {
      const r = importCli(forge, p, ws[p]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout, p).toContain("0 created, 3 reused, 0 variants, 0 rejected");
      expect(r.stdout, p).toMatch(/rendered rule\/deploy — deploy\.api, deploy\.web/);
      expect(r.stdout, p).toMatch(/rendered rule\/ports — ports\.api/);
    }
    // import re-points acme at the shared base, which lists the same rules in the same order.
    expect(gitStatus(forge)).toBe(" M profiles/acme/profile.yaml\n");
    expect(YAML.parse(await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8")).recipes).toEqual(["base"]);
    for (const p of ["acme", "globex"] as const) {
      expect(statesOf(ws[p]).filter(([, s]) => s !== "unchanged"), p).toEqual([]);
      expect(runCli(["sync", "--check", "--workspace", ws[p]]).code, p).toBe(0);
      expect(await snapshot(ws[p]), p).toEqual(before[p]);
    }
  });

  it("a changed value updates the profile, not the Forge's text, and only what renders it moves (AC 5)", async () => {
    const { tmp, forge } = await freshForge();
    const ws = await syncedWorkspaces(tmp, forge, ["acme"]);
    await unifyBoth(forge);
    expect(importCli(forge, "acme", ws.acme).code).toBe(0);
    gitCommitAll(forge, "re-import acme");
    const rule = path.join(ws.acme, ".claude/rules/deploy.md");
    await fs.writeFile(rule, (await fs.readFile(rule, "utf8")).replaceAll("acme-api", "acme-api-v2"));
    const r = importCli(forge, "acme", ws.acme);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('param deploy.api: "acme-api" → "acme-api-v2"');
    expect(r.stdout).toContain("0 variants");
    expect(gitStatus(forge)).toBe(" M profiles/acme/profile.yaml\n");
    const moved = statesOf(ws.acme).filter(([, s]) => s !== "unchanged");
    expect(moved.map(([p]) => p).sort()).toEqual([".kiro/steering/deploy.md", "AGENTS.md"]);
  });

  it("a new client's values are inferred into its new profile, and its workspace adopts (AC 6, 7)", async () => {
    const { tmp, forge } = await freshForge();
    await unifyBoth(forge);
    // A workspace rendered for a client the Forge has never seen, with no trace of Craftar.
    const scratch = path.join(tmp, "scratch-forge");
    await copyTree(forge, scratch);
    await fs.mkdir(path.join(scratch, "profiles/initech"), { recursive: true });
    await fs.writeFile(
      path.join(scratch, "profiles/initech/profile.yaml"),
      YAML.stringify({ name: "initech", recipes: ["base"], targets: ["claude-code", "kiro", "agents-md"], params: { "deploy.api": "initech-api", "deploy.web": "initech-web", "ports.api": "7070" } }),
    );
    const [init] = Object.values(await syncedWorkspaces(tmp, scratch, ["initech"]));
    await fs.rm(path.join(init, "craftar.yaml"));
    await fs.rm(path.join(init, "craftar.lock"));

    const twin = path.join(tmp, "ws-twin");
    await copyTree(init, twin);
    const r = importCli(forge, "initech", init, "--write-config");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("0 variants");
    expect(r.stdout.split("\n").filter((l) => l.includes("inferred "))).toHaveLength(2);
    expect(YAML.parse(await fs.readFile(path.join(forge, "profiles/initech/profile.yaml"), "utf8")).params).toEqual({
      "deploy.api": "initech-api",
      "deploy.web": "initech-web",
      "ports.api": "7070",
    });
    expect(await fs.readFile(path.join(forge, "profiles/initech/profile.yaml"), "utf8")).toContain('ports.api: "7070"');
    const states = statesOf(init);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter(([, s]) => s !== "adopt")).toEqual([]);

    // The ambiguous twin: a line two splits can explain becomes a variant, naming why.
    const deploy = path.join(twin, ".claude/rules/deploy.md");
    await fs.writeFile(deploy, (await fs.readFile(deploy, "utf8")).replace("`initech-api` and `initech-web`", "`initech-api` and `x` and `initech-web`"));
    const t = importCli(forge, "umbrella", twin);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toContain("variant rule/deploy--umbrella — differs from rule/deploy already in the Forge (inference ambiguous on line 5 of rule.md)");
  });
});
