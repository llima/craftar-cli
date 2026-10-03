import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";

/**
 * The take-section golden round trip (spec 12 §10.5, AC 3): three workspaces that differ only in a
 * reviewer table, a block hunk turned into a section via `forge unify`, and every workspace
 * remaining unchanged — the profiles hold their section values, the generated files hold no
 * marker, and no workspace byte moves, AGENTS.md included.
 *
 * Inputs: `test/golden/take-section-acme/`, `take-section-globex/` and `take-section-initech/` hold
 * a hand-written `.claude/rules/` (`review-posture.md`, which differs only in its reviewer table,
 * and `shared.md`).
 *
 * The expected Forge after step 3 (the first unify), `test/golden/forge-take-section-expected/`,
 * is regenerated only with the user's confirmation, and its diff reviewed like code:
 *   CRAFTAR_REGEN_GOLDEN_TAKE_SECTION=1 npx vitest run test/golden-take-section.test.ts
 */
const GOLDEN = path.resolve(__dirname, "golden");
const INPUT = {
  acme: path.join(GOLDEN, "take-section-acme"),
  globex: path.join(GOLDEN, "take-section-globex"),
  initech: path.join(GOLDEN, "take-section-initech"),
};
const EXPECTED = path.join(GOLDEN, "forge-take-section-expected");
const FIXED = new Date("2026-10-02T12:00:00Z");
const PROFILES = ["acme", "globex", "initech"] as const;
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
const importCli = (forge: string, profile: P, ws: string) =>
  runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", profile, "--workspace", ws, "--write-config"]);

/** Appends `agents-md` to a block `targets` list. */
function addAgentsMd(yaml: string): string {
  const out = yaml.replace(/^(targets:\n(?: {2}- .*\n)+)/m, "$1  - agents-md\n");
  if (out === yaml) throw new Error("expected a block targets list");
  return out;
}

async function edit(file: string, f: (text: string) => string): Promise<void> {
  await fs.writeFile(file, f(await fs.readFile(file, "utf8")));
}

interface RoundTrip {
  forge: string;
  tmp: string;
  ws: Record<P, string>;
  /** All three workspaces after step 1's sync, locks included. */
  synced: Record<P, Record<string, string>>;
}

/**
 * Step 1: Import acme, globex, initech with --write-config at a fixed date. Append agents-md to
 * profiles and workspaces. Commit. Sync and snapshot. Assert variants created.
 */
async function step1_importAndSync(): Promise<RoundTrip> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-take-section-"));
  cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
  const forge = path.join(tmp, "forge");
  const ws: Record<P, string> = {
    acme: path.join(tmp, "acme"),
    globex: path.join(tmp, "globex"),
    initech: path.join(tmp, "initech"),
  };

  // Import all three with --write-config at a fixed date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED);
  for (const p of PROFILES) {
    await copyTree(INPUT[p], ws[p]);
    const r = await importClaudeCode({ workspaceRoot: ws[p], forgeRoot: forge, profileName: p, writeWorkspaceConfig: true });
    expect(r.rejected, p).toEqual([]);
    if (p === "globex") {
      expect(r.variants.map((v) => v.name)).toEqual(["rule/review-posture--globex"]);
    }
    if (p === "initech") {
      expect(r.variants.map((v) => v.name)).toEqual(["rule/review-posture--initech"]);
    }
  }
  vi.useRealTimers();

  // Append agents-md to profiles and workspaces.
  for (const p of PROFILES) {
    await edit(path.join(forge, "profiles", p, "profile.yaml"), addAgentsMd);
    await edit(path.join(ws[p], "craftar.yaml"), addAgentsMd);
  }

  execFileSync("git", ["init", "-q", forge]);
  gitCommitAll(forge, "import acme, globex and initech");

  // Sync and snapshot all three.
  const synced = {} as Record<P, Record<string, string>>;
  for (const p of PROFILES) {
    const r = runCli(["sync", "--workspace", ws[p]]);
    expect(r.code, r.stderr).toBe(0);
    synced[p] = await snapshot(ws[p]);
  }

  return { forge, tmp, ws, synced };
}

/** Step 4 / after step 5: All workspaces unchanged, byte-equal, no marker in generated files. */
async function assertNothingMoved(t: RoundTrip): Promise<void> {
  for (const p of PROFILES) {
    const states = statesOf(t.ws[p]);
    expect(Object.entries(states).filter(([, s]) => s !== "unchanged"), `${p} has non-unchanged files`).toEqual([]);
    const check = runCli(["sync", "--check", "--workspace", t.ws[p]]);
    expect(check.code, `${p}: ${check.stdout}${check.stderr}`).toBe(0);
    expect(await snapshot(t.ws[p]), `${p} snapshot mismatch`).toEqual(t.synced[p]);
    for (const rel of await treeFiles(t.ws[p])) {
      expect(await fs.readFile(path.join(t.ws[p], rel), "utf8"), `${p} ${rel}`).not.toContain("craftar:section");
    }
  }
}

describe("golden: take-section round trip (spec 12 §10.5)", () => {
  it("steps 1–6: a block hunk becomes a section, an existing section is filled, and no workspace byte moves", { timeout: 180_000 }, async () => {
    // Step 1: Import and sync.
    const t = await step1_importAndSync();

    // Step 2: Save plan for globex.
    const planGlobex = path.join(t.tmp, "globex.yaml");
    const savePlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--save-plan", planGlobex, "--forge", t.forge]);
    expect(savePlan.code, savePlan.stderr).toBe(0);

    // The block hunk should have a pre-filled section with name derived from "## Reviewer flavors".
    const planRaw = await fs.readFile(planGlobex, "utf8");
    const plan = YAML.parse(planRaw);
    const ruleFile = plan.files.find((f: { file: string }) => f.file === "rule.md");
    expect(ruleFile).toBeDefined();
    // The globex variant has extra rows = block hunk(s).
    const blockHunk = ruleFile.hunks.find((h: any) => h.suggestion?.class === "block");
    expect(blockHunk, "expected a block hunk for globex").toBeDefined();
    expect(blockHunk.section?.name).toBe("reviewer-flavors");
    expect(blockHunk.take).toBe("keep");

    // Step 3: Edit the plan, apply it.
    // Set take: section on all hunks, set lines to cover the table header through the last shared row.
    // The table in the base (acme) is:
    //   ## Reviewer flavors    (line 5)
    //   (blank line)           (line 6)
    //   | Repo | Reviewer |    (line 7)
    //   |---|---|              (line 8)
    //   | `acme-api` | ...     (line 9)
    //   | `acme-web` | ...     (line 10)
    //   (blank line)           (line 11)
    // Per the spec: "set section.lines to the base line range of the header through the last shared row".
    // The shared rows are lines 7-10 (header, separator, acme-api, acme-web).
    // We use lines 7-10 to include the table header and the shared rows.
    for (const h of ruleFile.hunks) {
      h.take = "section";
      h.section = { name: "reviewer-flavors", lines: "7-10" };
    }
    await fs.writeFile(planGlobex, YAML.stringify(plan));

    const applyPlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--plan", planGlobex, "--forge", t.forge]);
    expect(applyPlan.code, applyPlan.stderr).toBe(0);
    expect(applyPlan.stdout).toContain("forge craftar.forge.yaml edited (schema: 2)");
    expect(applyPlan.stdout).toContain("section rule/review-posture reviewer-flavors");
    expect(applyPlan.stdout).toContain("default 4 lines");
    expect(applyPlan.stdout).toContain("6 lines (profile globex)");

    // Check git status lists exactly the expected files.
    const status3 = gitStatus(t.forge);
    const statusLines = status3.trim().split("\n").filter(Boolean).sort();
    // Expected: manifest, rule.md, globex profile, owned recipe, and the deleted variant files.
    expect(statusLines).toContainEqual(expect.stringContaining("craftar.forge.yaml"));
    expect(statusLines).toContainEqual(expect.stringContaining("ingredients/rules/review-posture/rule.md"));
    expect(statusLines).toContainEqual(expect.stringContaining("profiles/globex/profile.yaml"));
    // The owned recipe could be base--globex.yaml.
    expect(statusLines.some((l) => l.includes("recipes/") && l.includes("globex"))).toBe(true);
    // The deleted variant files.
    expect(statusLines.some((l) => l.includes("ingredients/rules/review-posture--globex/"))).toBe(true);

    // Regenerate expected Forge if requested.
    if (process.env.CRAFTAR_REGEN_GOLDEN_TAKE_SECTION) {
      await fs.rm(EXPECTED, { recursive: true, force: true });
      await copyTree(t.forge, EXPECTED);
    }
    expect(await treeFiles(t.forge)).toEqual(await treeFiles(EXPECTED));
    expect(await snapshot(t.forge)).toEqual(await snapshot(EXPECTED));
    gitCommitAll(t.forge, "unify review-posture for globex");

    // Step 4: All three workspaces unchanged.
    await assertNothingMoved(t);

    // Step 5: initech — fill the existing section.
    const planInitech = path.join(t.tmp, "initech.yaml");
    const savePlanInitech = runCli(["forge", "unify", "rule/review-posture", "--profile", "initech", "--save-plan", planInitech, "--forge", t.forge]);
    expect(savePlanInitech.code, savePlanInitech.stderr).toBe(0);

    const planInitechRaw = await fs.readFile(planInitech, "utf8");
    const planI = YAML.parse(planInitechRaw);
    const ruleFileI = planI.files.find((f: { file: string }) => f.file === "rule.md");
    expect(ruleFileI).toBeDefined();
    // The hunks should touch the existing section and have name "reviewer-flavors" pre-filled.
    for (const h of ruleFileI.hunks) {
      expect(h.section?.name, "expected initech hunks to touch the existing section").toBe("reviewer-flavors");
      h.take = "section";
    }
    await fs.writeFile(planInitech, YAML.stringify(planI));

    const applyPlanInitech = runCli(["forge", "unify", "rule/review-posture", "--profile", "initech", "--plan", planInitech, "--forge", t.forge]);
    expect(applyPlanInitech.code, applyPlanInitech.stderr).toBe(0);
    expect(applyPlanInitech.stdout).toContain("existing");
    expect(applyPlanInitech.stdout).toContain("4 lines (profile initech)");
    // No manifest line (existing section, schema already 2).
    expect(applyPlanInitech.stdout).not.toContain("craftar.forge.yaml edited");

    // git status: only profile, owned recipe and deleted variant files (body unchanged).
    const status5 = gitStatus(t.forge);
    const statusLines5 = status5.trim().split("\n").filter(Boolean);
    expect(statusLines5.some((l) => l.includes("profiles/initech/profile.yaml"))).toBe(true);
    expect(statusLines5.some((l) => l.includes("recipes/") && l.includes("initech"))).toBe(true);
    expect(statusLines5.some((l) => l.includes("ingredients/rules/review-posture--initech/"))).toBe(true);
    // The body (rule.md) should NOT be in the status (unchanged).
    expect(statusLines5.some((l) => l.includes("ingredients/rules/review-posture/rule.md"))).toBe(false);
    gitCommitAll(t.forge, "unify review-posture for initech");

    // Step 4 again: All three workspaces still unchanged.
    await assertNothingMoved(t);

    // Step 6: Re-import all three — 0 created, 0 variants.
    // Per spec 11 §6.15, Ruling 9: a re-import may re-point a profile from its owned recipe
    // (base--<p>) to the shared recipe (base) when they become identical. Only profile.yaml
    // may change; nothing else may move.
    // Note: we do NOT use --write-config here because the workspace config is already set up
    // and --write-config would overwrite the targets with only what import auto-detects (losing
    // agents-md which was added manually in step 1).
    const expectedStatus: Record<P, string[]> = {
      acme: [], // acme was already on base, nothing changes
      globex: ["M profiles/globex/profile.yaml"], // re-points from base--globex to base
      initech: ["M profiles/initech/profile.yaml"], // re-points from base--initech to base
    };
    for (const p of PROFILES) {
      // Don't use --write-config on re-import: the workspace config already exists.
      const r = runCli(["import", "--from", "claude-code", "--forge", t.forge, "--profile", p, "--workspace", t.ws[p]]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("0 created");
      expect(r.stdout).toContain("0 variants");
      // Assert exactly what git status reports for this profile's re-import.
      const statusLines = gitStatus(t.forge).trim().split("\n").filter(Boolean);
      expect(statusLines, `re-import ${p} should only change profile.yaml or nothing`).toEqual(expectedStatus[p]);
      // Commit any profile re-pointing changes before the next re-import.
      if (statusLines.length) gitCommitAll(t.forge, `re-import ${p}`);
    }

    // After all three re-imports, all workspaces must still be unchanged.
    await assertNothingMoved(t);
  });

  it("step 7, negative control: without globex's section value its files would change", { timeout: 180_000 }, async () => {
    const t = await step1_importAndSync();

    // Apply the globex unify (steps 2–3).
    const planGlobex = path.join(t.tmp, "globex.yaml");
    const savePlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--save-plan", planGlobex, "--forge", t.forge]);
    expect(savePlan.code, savePlan.stderr).toBe(0);
    const plan = YAML.parse(await fs.readFile(planGlobex, "utf8"));
    const ruleFile = plan.files.find((f: { file: string }) => f.file === "rule.md");
    for (const h of ruleFile.hunks) {
      h.take = "section";
      h.section = { name: "reviewer-flavors", lines: "7-10" };
    }
    await fs.writeFile(planGlobex, YAML.stringify(plan));
    const applyPlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--plan", planGlobex, "--forge", t.forge]);
    expect(applyPlan.code, applyPlan.stderr).toBe(0);
    gitCommitAll(t.forge, "unify review-posture for globex");

    // Remove globex's reviewer-flavors section value.
    const profPath = path.join(t.forge, "profiles/globex/profile.yaml");
    const profYaml = YAML.parse(await fs.readFile(profPath, "utf8"));
    delete profYaml.sections;
    await fs.writeFile(profPath, YAML.stringify(profYaml));

    // Now globex's files should report update.
    const states = statesOf(t.ws.globex);
    expect(states[".claude/rules/review-posture.md"]).toBe("update");
    expect(states["AGENTS.md"]).toBe("update");
    // If kiro is a target, the steering file should also update.
    if (".kiro/steering/review-posture.md" in states) {
      expect(states[".kiro/steering/review-posture.md"]).toBe("update");
    }
  });
});
