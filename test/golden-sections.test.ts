import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { addAgentsMd, addFlavorsMarkers, addGlobexRow } from "./helpers/golden-sections-edits.js";

/**
 * The sections golden round trip (spec 11 §10.5, AC 5): two workspaces that differ only in a
 * reviewer table, a variant turned into a hand-made section, and both workspaces re-imported —
 * the profile ends up holding globex's table, the generated files hold no marker, and no workspace
 * byte moves, AGENTS.md included. See `test/helpers/golden-sections-edits.ts` for the inputs, the
 * edits and how to regenerate `test/golden/forge-sections-expected/`.
 */
const GOLDEN = path.resolve(__dirname, "golden");
const INPUT = { acme: path.join(GOLDEN, "sections-acme"), globex: path.join(GOLDEN, "sections-globex") };
const EXPECTED = path.join(GOLDEN, "forge-sections-expected");
const FIXED = new Date("2026-09-28T12:00:00Z");
const PROFILES = ["acme", "globex"] as const;
type P = (typeof PROFILES)[number];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
});

const treeFiles = async (dir: string) => (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await treeFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await treeFiles(dir)) out[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
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
const gitStatus = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
const statesOf = (ws: string) => {
  const r = runCli(["status", "--workspace", ws, "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return Object.fromEntries((JSON.parse(r.stdout).statuses as Array<{ path: string; state: string }>).map((s) => [s.path, s.state]));
};
const importCli = (forge: string, profile: P, ws: string) => runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", profile, "--workspace", ws]);
async function edit(file: string, f: (text: string) => string): Promise<void> {
  await fs.writeFile(file, f(await fs.readFile(file, "utf8")));
}

interface RoundTrip {
  forge: string;
  ws: Record<P, string>;
  /** Both workspaces after step 2's sync, locks included. */
  synced: Record<P, Record<string, string>>;
}

/** Steps 1–6 of spec 11 §10.5, each checked as it goes. */
async function roundTrip(): Promise<RoundTrip> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-sections-"));
  cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
  const forge = path.join(tmp, "forge");
  const ws = { acme: path.join(tmp, "acme"), globex: path.join(tmp, "globex") };

  // 1. Import acme, then globex, with --write-config, at a fixed date (the profile's description).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED);
  for (const p of PROFILES) {
    await copyTree(INPUT[p], ws[p]);
    const r = await importClaudeCode({ workspaceRoot: ws[p], forgeRoot: forge, profileName: p, writeWorkspaceConfig: true });
    expect(r.rejected, p).toEqual([]);
    if (p === "globex") {
      expect(r.variants.map((v) => v.name)).toEqual(["rule/review-posture--globex"]);
      expect(r.recipes).toEqual(["base--globex"]);
    }
  }
  vi.useRealTimers();
  for (const p of PROFILES) {
    await edit(path.join(forge, "profiles", p, "profile.yaml"), addAgentsMd);
    await edit(path.join(ws[p], "craftar.yaml"), addAgentsMd);
  }
  execFileSync("git", ["init", "-q", forge]);
  gitCommitAll(forge, "import acme and globex");

  // 2. Sync both: the workspace's own files adopt, AGENTS.md is new.
  const synced = {} as Record<P, Record<string, string>>;
  for (const p of PROFILES) {
    const before = statesOf(ws[p]);
    expect(before["AGENTS.md"], p).toBe("new");
    expect(Object.entries(before).filter(([f, s]) => f !== "AGENTS.md" && s !== "adopt"), p).toEqual([]);
    expect(Object.keys(before).sort(), p).toEqual([".claude/rules/review-posture.md", ".claude/rules/shared.md", ".kiro/steering/review-posture.md", ".kiro/steering/shared.md", "AGENTS.md"]);
    const r = runCli(["sync", "--workspace", ws[p]]);
    expect(r.code, r.stderr).toBe(0);
    synced[p] = await snapshot(ws[p]);
  }

  // 3. The hand-made section, manifest left at schema: 1.
  const ruleFile = path.join(forge, "ingredients/rules/review-posture/rule.md");
  await edit(ruleFile, addFlavorsMarkers);
  gitCommitAll(forge, "wrap the reviewer table in a flavors section");

  // 4. The schema gate (Ruling 7).
  const gated = runCli(["status", "--workspace", ws.acme]);
  expect(gated.code).toBe(1);
  expect(gated.stderr).toContain(
    "craftar.forge.yaml declares schema: 1, but ingredients/rules/review-posture/rule.md:5 holds a section marker — set schema: 2 in craftar.forge.yaml, so that craftar 0.6.2 and older refuse this Forge instead of emitting the markers",
  );

  // 5. Re-import acme: a rendered reuse of the marked base; only the manifest is bumped.
  const manifest = path.join(forge, "craftar.forge.yaml");
  const manifestBefore = await fs.readFile(manifest, "utf8");
  expect(manifestBefore).toContain("\nschema: 1\n");
  const a = importCli(forge, "acme", ws.acme);
  expect(a.code, a.stderr).toBe(0);
  expect(a.stdout).toContain("0 created, 2 reused, 0 variants, 0 rejected");
  expect(a.stdout).toContain("forge craftar.forge.yaml edited (schema: 2)\n");
  expect(gitStatus(forge)).toBe(" M craftar.forge.yaml\n");
  expect(await fs.readFile(manifest, "utf8")).toBe(manifestBefore.replace("\nschema: 1\n", "\nschema: 2\n"));
  gitCommitAll(forge, "re-import acme");

  // 6. Re-import globex: section inference, and the profile re-pointed to base (Ruling 9).
  const g = importCli(forge, "globex", ws.globex);
  expect(g.code, g.stderr).toBe(0);
  expect(g.stdout).toContain("0 created, 2 reused, 0 variants, 0 rejected");
  expect(g.stdout).toContain("sectioned rule/review-posture — flavors\n");
  expect(g.stdout).toContain("section rule/review-posture flavors: (default) → 5 lines\n");
  expect(g.stdout).toContain("profile profiles/globex/profile.yaml edited (sections, recipes)\n");
  expect(g.stdout).toContain("  recipes: base\n");
  expect(gitStatus(forge)).toBe(" M profiles/globex/profile.yaml\n");
  const profile = YAML.parse(await fs.readFile(path.join(forge, "profiles/globex/profile.yaml"), "utf8"));
  expect(profile.recipes).toEqual(["base"]);
  expect(Object.keys(profile.sections)).toEqual(["rule/review-posture"]);
  expect(profile.sections["rule/review-posture"].flavors).toContain("`globex-desktop`");

  if (process.env.CRAFTAR_REGEN_GOLDEN_SECTIONS) {
    await fs.rm(EXPECTED, { recursive: true, force: true });
    await copyTree(forge, EXPECTED);
  }
  expect(await treeFiles(forge)).toEqual(await treeFiles(EXPECTED));
  expect(await snapshot(forge)).toEqual(await snapshot(EXPECTED));
  gitCommitAll(forge, "re-import globex");
  return { forge, ws, synced };
}

/** Step 7: every file of both workspaces unchanged, byte for byte, and no marker anywhere. */
async function nothingMoved(t: RoundTrip): Promise<void> {
  for (const p of PROFILES) {
    expect(Object.entries(statesOf(t.ws[p])).filter(([, s]) => s !== "unchanged"), p).toEqual([]);
    const check = runCli(["sync", "--check", "--workspace", t.ws[p]]);
    expect(check.code, `${p}: ${check.stdout}${check.stderr}`).toBe(0);
    expect(await snapshot(t.ws[p]), p).toEqual(t.synced[p]);
    for (const rel of await treeFiles(t.ws[p])) expect(await fs.readFile(path.join(t.ws[p], rel), "utf8"), `${p} ${rel}`).not.toContain("craftar:section");
  }
}

describe("golden: sections round trip (spec 11 §10.5)", () => {
  it("steps 1–8: the variant becomes a section, the Forge equals the snapshot, and no workspace byte moves", { timeout: 120_000 }, async () => {
    const t = await roundTrip();
    await nothingMoved(t);

    // 8. unify --take base removes the leftover variant; base--globex is now identical to base.
    const u = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--take", "base", "--forge", t.forge]);
    expect(u.code, u.stderr).toBe(0);
    expect(u.stdout).toContain("recipe base--globex is now identical to base");
    await expect(fs.stat(path.join(t.forge, "ingredients/rules/review-posture--globex"))).rejects.toThrow();
    expect(YAML.parse(await fs.readFile(path.join(t.forge, "recipes/base--globex.yaml"), "utf8")).ingredients).toEqual(
      YAML.parse(await fs.readFile(path.join(t.forge, "recipes/base.yaml"), "utf8")).ingredients,
    );
    gitCommitAll(t.forge, "unify review-posture for globex");
    await nothingMoved(t);
  });

  it("step 9, negative control: without globex's sections its review-posture files and AGENTS.md would change", { timeout: 120_000 }, async () => {
    const t = await roundTrip();
    const prof = path.join(t.forge, "profiles/globex/profile.yaml");
    const parsed = YAML.parse(await fs.readFile(prof, "utf8"));
    delete parsed.sections;
    await fs.writeFile(prof, YAML.stringify(parsed));
    const st = statesOf(t.ws.globex);
    for (const f of [".claude/rules/review-posture.md", ".kiro/steering/review-posture.md", "AGENTS.md"]) expect(st[f], f).toBe("update");
    expect(st[".claude/rules/shared.md"]).toBe("unchanged");
  });

  it("step 10: a changed table updates the profile's value, and only what renders it moves", { timeout: 120_000 }, async () => {
    const t = await roundTrip();
    await edit(path.join(t.ws.globex, ".claude/rules/review-posture.md"), addGlobexRow);
    const r = importCli(t.forge, "globex", t.ws.globex);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("0 variants");
    expect(r.stdout).toContain("section rule/review-posture flavors: 5 lines → 6 lines\n");
    expect(gitStatus(t.forge)).toBe(" M profiles/globex/profile.yaml\n");
    const st = statesOf(t.ws.globex);
    expect(st[".kiro/steering/review-posture.md"]).toBe("update");
    expect(st["AGENTS.md"]).toBe("update");
    expect(st[".claude/rules/review-posture.md"]).toBe("unchanged");
  });
});
