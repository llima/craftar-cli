import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeSections } from "./helpers/target-sections.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import type { Scenario } from "./helpers/forge.js";

/**
 * Spec 41 Part B §11.4: pin what a workspace whose Forge writes no `targets=` sees today,
 * BEFORE any source change, so a later change can prove it changes nothing for it.
 */

const PIN_FILE = path.resolve(__dirname, "pins/target-sections-off.json");

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
    // Normalize lock check message: "schema 3, generated 2026-10-23 23:13 UTC" -> "schema 3, generated <timestamp>"
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

/** Every file of a directory, by relative POSIX path, as bytes. */
async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs).split(path.sep).join("/"), await fs.readFile(abs));
    }
  };
  await walk(root);
  return out;
}

function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): void {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [k, v] of a) expect(b.get(k)!.equals(v), k).toBe(true);
}

interface ExplainJson {
  path: string;
  target: string;
  ingredient: string | null;
  origin: unknown;
  via: unknown;
  sections: unknown;
  params: unknown;
  profile: string;
  recipes: string[];
  hash: string | null;
  warnings: string[];
}

interface Observed {
  planned: Record<string, string>;
  planWarnings: string[];
  freshStatus: unknown;
  freshExit: { syncCheck: number | null; status: number | null; diffExitCode: number | null };
  lock: unknown;
  syncedStatus: unknown;
  syncedExit: { syncCheck: number | null; status: number | null; diffExitCode: number | null; doctorStrict: number | null };
  doctorWorkspace: Array<{ id: string; level: string; message: string; fix: string | null }>;
  explainStyle: ExplainJson | null;
  explainAgentsMd: ExplainJson | null;
}

async function buildObserved(s: Scenario): Promise<Observed> {
  const wsRoot = s.wsRoot;
  const W = ["--workspace", wsRoot];

  // Get both raw and realpath versions of the root
  const realRoot = await fs.realpath(s.root);
  const roots = [s.root, realRoot];

  // Compute plan
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);

  // planned: { [path]: utf8 content } sorted by path
  const planned: Record<string, string> = {};
  const sortedPaths = [...p.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sortedPaths) {
    planned[f.path] = f.content.toString("utf8");
  }

  // planWarnings
  const planWarnings = p.warnings;

  // freshStatus: status --json BEFORE any sync
  const freshStatusResult = runCli(["status", "--json", ...W]);
  const freshStatus = JSON.parse(freshStatusResult.stdout);

  // freshExit: exit codes before any sync
  const freshExit = {
    syncCheck: runCli(["sync", "--check", ...W]).code,
    status: freshStatusResult.code,
    diffExitCode: runCli(["diff", "--exit-code", ...W]).code,
  };

  // Run sync
  const syncResult = runCli(["sync", ...W]);
  if (syncResult.code !== 0) {
    throw new Error(`sync failed: ${syncResult.stderr}`);
  }

  // lock: craftar.lock after sync, with generatedAt deleted
  const lockText = await fs.readFile(path.join(wsRoot, "craftar.lock"), "utf8");
  const lock = JSON.parse(lockText);
  delete lock.generatedAt;

  // syncedStatus: status --json after sync
  const syncedStatusResult = runCli(["status", "--json", ...W]);
  const syncedStatus = JSON.parse(syncedStatusResult.stdout);

  // doctorStrict: exit code of doctor --strict
  const doctorResult = runCli(["doctor", "--strict", "--json", ...W]);
  const doctorJson = JSON.parse(doctorResult.stdout);

  // syncedExit: exit codes after sync
  const syncedExit = {
    syncCheck: runCli(["sync", "--check", ...W]).code,
    status: syncedStatusResult.code,
    diffExitCode: runCli(["diff", "--exit-code", ...W]).code,
    doctorStrict: doctorResult.code,
  };

  // doctorWorkspace: from doctor --strict --json, filtered to scope === "workspace"
  const doctorWorkspace = (doctorJson.checks as Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>)
    .filter((c) => c.scope === "workspace")
    .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));

  // explain --json for .claude/rules/style.md and AGENTS.md
  const explainStyleResult = runCli(["explain", ".claude/rules/style.md", "--json", ...W]);
  const explainStyle = explainStyleResult.code === 0 ? JSON.parse(explainStyleResult.stdout) as ExplainJson : null;

  const explainAgentsMdResult = runCli(["explain", "AGENTS.md", "--json", ...W]);
  const explainAgentsMd = explainAgentsMdResult.code === 0 ? JSON.parse(explainAgentsMdResult.stdout) as ExplainJson : null;

  const observed: Observed = {
    planned,
    planWarnings,
    freshStatus,
    freshExit,
    lock,
    syncedStatus,
    syncedExit,
    doctorWorkspace,
    explainStyle,
    explainAgentsMd,
  };

  return normalize(observed, roots) as Observed;
}

/** Load the pinned baseline for comparison. */
async function loadPin(): Promise<Observed> {
  const pinText = await fs.readFile(PIN_FILE, "utf8");
  return JSON.parse(pinText);
}

describe("target-sections=off baseline pin (spec 41 Part B §11.4)", () => {
  it("matches the pinned snapshot (schema 5, no targets= in markers)", async () => {
    const s = kept(await acmeSections({ schema: 5 }));
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

  it("the pin is not vacuous: holds section defaults, profile values, services, and CRLF in kiro files", async () => {
    const s = kept(await acmeSections({ schema: 5 }));
    const observed = await buildObserved(s);

    // 1. planned holds the service file (services are included)
    expect(observed.planned).toHaveProperty(".craftar/services/echo/compose.yaml");
    expect(observed.planned).toHaveProperty(".craftar/compose.yaml");

    // 2. The kiro steering file has CRLF (kiro outputs CRLF)
    const styleKiroFile = observed.planned[".kiro/steering/style.md"];
    expect(styleKiroFile).toContain("\r\n");

    // 3. There is at least one section default — the "intro" section has the default "Default intro text."
    const styleClaudeFile = observed.planned[".claude/rules/style.md"];
    expect(styleClaudeFile).toContain("Default intro text.");

    // 4. There is at least one profile value — the "flavors" section has "UK" and "BR" from the profile
    expect(styleClaudeFile).toContain("UK");
    expect(styleClaudeFile).toContain("BR");

    // 5. The api rule has the param substituted
    const apiFile = observed.planned[".claude/rules/api.md"];
    expect(apiFile).toContain("/api/v2"); // from profile param

    // 6. AGENTS.md exists and has the style rule
    expect(observed.planned["AGENTS.md"]).toContain("# Style Guide");

    // 7. After sync, everything is in sync (syncCheck=0 means files match)
    expect(observed.syncedExit.syncCheck).toBe(0);
    // doctorStrict may be 1 because of plan warnings (agents-md skipped ingredients)
    // Check that there are plan warnings as expected
    expect(observed.planWarnings.length).toBeGreaterThan(0);
  });

  it("import round trip: importing the synced workspace into a copy of the Forge with markers changes nothing", async () => {
    const s = kept(await acmeSections({ schema: 5 }));

    // 1. Sync the workspace from the built scenario Forge (which has section markers)
    const syncResult = runCli(["sync", "--workspace", s.wsRoot]);
    expect(syncResult.code, syncResult.stderr).toBe(0);

    // 2. Copy the Forge (with its section markers) to a new directory
    const forgeCopy = path.join(s.root, "forge-copy");
    await fs.cp(s.forgeRoot, forgeCopy, { recursive: true });

    // Snapshot the Forge copy BEFORE import
    const beforeImport = await snapshot(forgeCopy);

    // 3. Import from the synced workspace into the Forge copy (no --write-config)
    const importResult = runCli([
      "import",
      "--from", "claude-code",
      "--workspace", s.wsRoot,
      "--forge", forgeCopy,
      "--profile", "acme",
    ]);

    // Get both raw and realpath versions of the root for normalization
    const realRoot = await fs.realpath(s.root);
    const roots = [s.root, realRoot];

    // Normalize the stdout for comparison
    let stdout = importResult.stdout;
    for (const r of roots) {
      stdout = stdout.split(r).join("<root>");
      stdout = stdout.split(r.replace(/\\/g, "/")).join("<root>");
      stdout = stdout.split(r.replace(/\//g, "\\")).join("<root>");
    }
    // Platform-independent path separator
    stdout = stdout.replace(/<root>[/\\]/g, "<root>/");

    // Import should succeed
    expect(importResult.code, importResult.stderr).toBe(0);

    // Pin the import stdout
    const IMPORT_PIN_FILE = path.resolve(__dirname, "pins/target-sections-off-import.txt");
    if (process.env.CRAFTAR_WRITE_PINS === "1") {
      await fs.mkdir(path.dirname(IMPORT_PIN_FILE), { recursive: true });
      await fs.writeFile(IMPORT_PIN_FILE, stdout);
      console.log(`Import pin written to ${IMPORT_PIN_FILE}`);
    } else {
      const expectedStdout = await fs.readFile(IMPORT_PIN_FILE, "utf8");
      expect(stdout).toBe(expectedStdout);
    }

    // Import summary should say 0 variants, and not mention any rule variant
    expect(stdout).toContain("0 variants");
    expect(stdout).not.toContain("variant rule/");

    // Forge copy should be byte-identical after import (every base reused, profile unchanged)
    const afterImport = await snapshot(forgeCopy);
    sameTree(beforeImport, afterImport);
  });

  it("schema 6, no targets= — equals the schema 5 pin", async () => {
    const s = kept(await acmeSections({ schema: 6 }));
    const observed = await buildObserved(s);

    // Compare with the same pin as schema 5 — they must be identical
    const expected = await loadPin();
    expect(observed).toEqual(expected);
  });
});
