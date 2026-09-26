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
