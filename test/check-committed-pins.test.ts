import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, writeFiles, type Scenario } from "./helpers/forge.js";

/**
 * Spec 49 Part B §1: pin today's output of sync --check, status, diff, and doctor before
 * any source change, so a later change that makes a commit the source can prove the disk
 * path does not move.
 *
 * The fixture is a synthetic scenario with one file of each state after hand-editing:
 * - unchanged: file `a` untouched
 * - drift: hand-edit `.claude/rules/a.md`
 * - update: change rule `b`'s body in the Forge
 * - new: delete `.claude/rules/c.md`
 * - orphan: rule `d` removed from the recipe after first sync
 * - collision: rule `e` added to the recipe after first sync, but a different file written by hand
 */

const PIN_FILE = path.resolve(__dirname, "pins/check-committed-off.json");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Recursively normalize a value, replacing any occurrence of the scenario's temp root
 * (both raw path and realpath, with `/` and `\` separators) with `<root>`, and
 * normalizing time-dependent lock messages.
 */
function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      // Replace both slash styles
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    // Normalize lock check message: "schema 2, generated 2026-10-23 23:13 UTC" -> "schema 2, generated <timestamp>"
    s = s.replace(/^(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, "$1<timestamp>");
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, roots));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalize(v, roots);
    }
    return out;
  }
  return value;
}

/** IDs of doctor checks that are machine-dependent and should be excluded from the pin. */
const MACHINE_DEPENDENT_IDS = new Set(["node", "git", "home", "registry", "cache", "docker", "dotnet"]);

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Observed {
  /** State after first sync and hand-editing (before re-sync). */
  edited: {
    syncCheck: CliResult;
    status: CliResult;
    statusJson: CliResult;
    diff: CliResult;
    diffExitCode: CliResult;
    doctorJson: { checks: Array<{ id: string; level: string; message: string; fix: string | null }> };
  };
  /** State after a fresh sync (all files in sync). */
  fresh: {
    syncCheck: CliResult;
    status: CliResult;
    statusJson: CliResult;
    diff: CliResult;
    diffExitCode: CliResult;
    doctorJson: { checks: Array<{ id: string; level: string; message: string; fix: string | null }> };
    /** The lock file with generatedAt removed. */
    lock: unknown;
  };
}

/**
 * Build a scenario with rules a, b, c, d in a recipe, profile acme, targets claude-code, kiro, agents-md.
 * Sync once, then edit to produce each state.
 */
async function buildScenario(): Promise<Scenario> {
  // Initial ingredients: a, b, c, d (d will become orphan)
  const ingredients = [
    rule("a", "# Rule A\nFirst rule.\n"),
    rule("b", "# Rule B\nSecond rule.\n"),
    rule("c", "# Rule C\nThird rule.\n"),
    rule("d", "# Rule D\nFourth rule (will be orphan).\n"),
  ];

  const recipes = [recipe("base", ["rule/a", "rule/b", "rule/c", "rule/d"])];
  const profiles = [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // First sync
  const syncResult = runCli(["sync", "--workspace", s.wsRoot]);
  if (syncResult.code !== 0) {
    throw new Error(`Initial sync failed: ${syncResult.stderr}`);
  }

  // Now bring it to a state with one file of each kind:

  // 1. unchanged: rule `a` stays as-is (nothing to do)

  // 2. drift: hand-edit `.claude/rules/a.md`
  await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "Hand-edited line.\n");

  // 3. update: change rule `b`'s body in the Forge
  await fs.writeFile(
    path.join(s.forgeRoot, "ingredients/rules/b/rule.md"),
    "# Rule B\nSecond rule, UPDATED in Forge.\n",
  );

  // 4. new: delete `.claude/rules/c.md`
  await fs.rm(path.join(s.wsRoot, ".claude/rules/c.md"));

  // 5. orphan: remove rule `d` from the recipe
  await fs.writeFile(
    path.join(s.forgeRoot, "recipes/base.yaml"),
    YAML.stringify({ name: "base", ingredients: ["rule/a", "rule/b", "rule/c"] }),
  );

  // 6. collision: add rule `e` to the recipe, but write a different file by hand
  // First, add the rule ingredient to the Forge
  const eDir = path.join(s.forgeRoot, "ingredients/rules/e");
  await fs.mkdir(eDir, { recursive: true });
  await writeFiles(eDir, {
    "ingredient.yaml": YAML.stringify({ type: "rule", name: "e" }),
    "rule.md": "# Rule E\nFifth rule from Forge.\n",
  });
  // Add it to the recipe
  await fs.writeFile(
    path.join(s.forgeRoot, "recipes/base.yaml"),
    YAML.stringify({ name: "base", ingredients: ["rule/a", "rule/b", "rule/c", "rule/e"] }),
  );
  // Write a conflicting file by hand (before sync would write it)
  await writeFiles(s.wsRoot, { ".claude/rules/e.md": "# My Rule E\nUser's own file.\n" });

  return s;
}

function runDoctorFiltered(wsRoot: string): { checks: Array<{ id: string; level: string; message: string; fix: string | null }> } {
  // doctor --json, filtered to checks whose id is not machine-dependent
  // Note: this scenario has no service and no templates, so docker and dotnet are never probed
  const r = runCli(["doctor", "--json", "--workspace", wsRoot]);
  const parsed = JSON.parse(r.stdout) as {
    checks: Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>;
  };
  const filtered = parsed.checks
    .filter((c) => c.scope === "workspace" && !MACHINE_DEPENDENT_IDS.has(c.id))
    .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));
  return { checks: filtered };
}

async function buildObserved(s: Scenario): Promise<Observed> {
  const wsRoot = s.wsRoot;
  const W = ["--workspace", wsRoot];

  // Get both raw and realpath versions of the root
  const realRoot = await fs.realpath(s.root);
  const roots = [s.root, realRoot];

  // --- Edited state (before re-sync) ---
  const editedSyncCheck = runCli(["sync", "--check", ...W]);
  const editedStatus = runCli(["status", ...W]);
  const editedStatusJson = runCli(["status", "--json", ...W]);
  const editedDiff = runCli(["diff", ...W]);
  const editedDiffExitCode = runCli(["diff", "--exit-code", ...W]);
  const editedDoctorJson = runDoctorFiltered(wsRoot);

  // --- Fresh state: run sync to bring everything back in sync ---
  // Remove the collision file so sync can write it
  await fs.rm(path.join(wsRoot, ".claude/rules/e.md"));
  // Also restore the drifted file a.md to its original content so it becomes unchanged
  // (sync doesn't overwrite drift by default)
  await fs.writeFile(path.join(wsRoot, ".claude/rules/a.md"), "# Rule A\nFirst rule.\n");
  const syncResult = runCli(["sync", ...W]);
  if (syncResult.code !== 0) {
    throw new Error(`Re-sync failed: ${syncResult.stderr}`);
  }

  const freshSyncCheck = runCli(["sync", "--check", ...W]);
  const freshStatus = runCli(["status", ...W]);
  const freshStatusJson = runCli(["status", "--json", ...W]);
  const freshDiff = runCli(["diff", ...W]);
  const freshDiffExitCode = runCli(["diff", "--exit-code", ...W]);
  const freshDoctorJson = runDoctorFiltered(wsRoot);

  // Read the lock file and remove generatedAt
  const lockText = await fs.readFile(path.join(wsRoot, "craftar.lock"), "utf8");
  const lock = JSON.parse(lockText);
  delete lock.generatedAt;

  const observed: Observed = {
    edited: {
      syncCheck: { code: editedSyncCheck.code, stdout: editedSyncCheck.stdout, stderr: editedSyncCheck.stderr },
      status: { code: editedStatus.code, stdout: editedStatus.stdout, stderr: editedStatus.stderr },
      statusJson: { code: editedStatusJson.code, stdout: editedStatusJson.stdout, stderr: editedStatusJson.stderr },
      diff: { code: editedDiff.code, stdout: editedDiff.stdout, stderr: editedDiff.stderr },
      diffExitCode: { code: editedDiffExitCode.code, stdout: editedDiffExitCode.stdout, stderr: editedDiffExitCode.stderr },
      doctorJson: editedDoctorJson,
    },
    fresh: {
      syncCheck: { code: freshSyncCheck.code, stdout: freshSyncCheck.stdout, stderr: freshSyncCheck.stderr },
      status: { code: freshStatus.code, stdout: freshStatus.stdout, stderr: freshStatus.stderr },
      statusJson: { code: freshStatusJson.code, stdout: freshStatusJson.stdout, stderr: freshStatusJson.stderr },
      diff: { code: freshDiff.code, stdout: freshDiff.stdout, stderr: freshDiff.stderr },
      diffExitCode: { code: freshDiffExitCode.code, stdout: freshDiffExitCode.stdout, stderr: freshDiffExitCode.stderr },
      doctorJson: freshDoctorJson,
      lock,
    },
  };

  return normalize(observed, roots) as Observed;
}

/** Load the pinned baseline for comparison. */
async function loadPin(): Promise<Observed> {
  const pinText = await fs.readFile(PIN_FILE, "utf8");
  return JSON.parse(pinText);
}

describe("check-committed baseline pin", () => {
  it("matches the pinned snapshot", async () => {
    const s = kept(await buildScenario());
    const observed = await buildObserved(s);

    if (process.env.CRAFTAR_WRITE_PINS === "1") {
      // Write mode: generate the pin file
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      console.log(`Pin written to ${PIN_FILE}`);
      return;
    }

    // Compare mode: load the pin and compare
    const expected = await loadPin();
    expect(observed).toEqual(expected);
  });

  it("the pin is not vacuous — edited state shows the expected states", async () => {
    const s = kept(await buildScenario());
    const observed = await buildObserved(s);

    // edited.syncCheck should exit 1 (out of sync)
    expect(observed.edited.syncCheck.code).toBe(1);

    // edited.statusJson should have all the states
    const editedStatuses = JSON.parse(observed.edited.statusJson.stdout).statuses as Array<{ path: string; state: string }>;

    // Find one of each state (we edited a, so it's drift)
    const byPath = new Map(editedStatuses.map((s) => [s.path, s.state]));

    // drift: .claude/rules/a.md was hand-edited
    expect(byPath.get(".claude/rules/a.md")).toBe("drift");

    // update: rule b changed in Forge
    expect(byPath.get(".claude/rules/b.md")).toBe("update");

    // new: rule c was deleted from disk
    expect(byPath.get(".claude/rules/c.md")).toBe("new");

    // orphan: rule d was removed from recipe
    expect(byPath.get(".claude/rules/d.md")).toBe("orphan");

    // collision: rule e has a user file
    expect(byPath.get(".claude/rules/e.md")).toBe("collision");

    // fresh.syncCheck should exit 0 (in sync)
    expect(observed.fresh.syncCheck.code).toBe(0);

    // fresh.diffExitCode should exit 0
    expect(observed.fresh.diffExitCode.code).toBe(0);
  });

  it("the pin is not vacuous — fresh state is in sync", async () => {
    const s = kept(await buildScenario());
    const observed = await buildObserved(s);

    // After re-sync, all files should be unchanged
    const freshStatuses = JSON.parse(observed.fresh.statusJson.stdout).statuses as Array<{ path: string; state: string }>;
    const nonUnchanged = freshStatuses.filter((s) => s.state !== "unchanged");
    expect(nonUnchanged).toEqual([]);

    // The lock should have the expected files
    const lock = observed.fresh.lock as { files: Array<{ path: string }> };
    const lockPaths = lock.files.map((f) => f.path).filter((p) => p.startsWith(".claude/rules/"));
    // Should have a, b, c, e (d was removed from recipe)
    expect(lockPaths.sort()).toEqual([
      ".claude/rules/a.md",
      ".claude/rules/b.md",
      ".claude/rules/c.md",
      ".claude/rules/e.md",
    ]);
  });
});
