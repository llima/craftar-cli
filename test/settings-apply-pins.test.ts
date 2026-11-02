/**
 * Spec 52 §12 item 1, task 1: Pin what a workspace with a hook registration and an authEnv
 * sees today BEFORE any source change, so the later task can prove hooks-registered fix text
 * is the only change.
 */
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { forgeAt } from "./helpers/integrations.js";
import { profile, recipe, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import type { Check } from "../src/core/doctor.js";

const PIN_FILE = path.resolve(__dirname, "pins/settings-apply-off.json");

// No test here runs Docker: doctor's child gets a PATH that holds only an empty temp dir,
// so `docker` is never found.
let EMPTY_DIR: string;
let NO_DOCKER: { PATH: string; Path: string };
beforeAll(() => {
  EMPTY_DIR = mkdtempSync(path.join(os.tmpdir(), "craftar-test-no-docker-"));
  NO_DOCKER = { PATH: EMPTY_DIR, Path: EMPTY_DIR };
});
afterAll(() => {
  if (EMPTY_DIR) rmSync(EMPTY_DIR, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * Fixture H: a hook `guard-path` with params: { "hooks.python": { default: "python3" } }
 * and one registration PreToolUse, matcher Bash|PowerShell, command {{hooks.python}},
 * args ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"], timeout 10.
 */
const fixtureH = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
    params: { "hooks.python": { default: "python3" } },
    registration: [
      {
        event: "PreToolUse",
        matcher: "Bash|PowerShell",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
        timeout: 10,
      },
    ],
  },
  files: { "guard-path.py": 'print("ok")\n' },
});

/** An MCP ingredient with authEnv: ["ACME_TOKEN"] and server { command: "npx", args: ["acme-mcp"] }. */
const fixtureM = (): IngredientSpec => ({
  meta: {
    type: "mcp",
    name: "acme",
    authEnv: ["ACME_TOKEN"],
    server: { command: "npx", args: ["acme-mcp"] },
  },
});

interface PlannedEntry {
  path: string;
  sha256: string;
}

interface Observed {
  /** Planned paths sorted with sha256 of each file's bytes. */
  planned: PlannedEntry[];
  /** status --json object. */
  status: unknown;
  /** doctor --json checks minus machine-dependent lines (docker). */
  doctorChecks: Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>;
}

/**
 * Build the scenario: Forge at schema 1 with fixture H and M, targets claude-code.
 */
async function buildScenario() {
  const forge: ForgeSpec = {
    ingredients: [fixtureH(), fixtureM()],
    recipes: [recipe("base", ["hook/guard-path", "mcp/acme"])],
    profiles: [profile("acme", ["base"], ["claude-code"])],
  };
  const s = await forgeAt(1, forge);
  cleanups.push(s.cleanup);

  const home = path.join(s.root, "home");
  const claudeDir = path.join(s.root, "claudeconfig");
  await fs.mkdir(claudeDir, { recursive: true });

  return { ...s, home, claudeDir };
}

/**
 * doctor's `docker` line names the machine's Compose version, or that docker is not on
 * the PATH the test gives: not part of what the pin proves.
 */
function withoutMachine(checks: Observed["doctorChecks"]): Observed["doctorChecks"] {
  return checks.filter((c) => c.id !== "docker");
}

/**
 * Normalize paths: replace the scenario root with <root>, handling both forward and backslash.
 */
function normalizePaths(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    // Normalize lock check message: "schema 3, generated 2026-10-23 23:13 UTC" -> "schema 3, generated <timestamp>"
    s = s.replace(/^(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, "$1<timestamp>");
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizePaths(v, roots));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizePaths(v, roots);
    }
    return out;
  }
  return value;
}

async function buildObserved(s: Awaited<ReturnType<typeof buildScenario>>): Promise<Observed> {
  const W = ["--workspace", s.wsRoot];
  const env = { CRAFTAR_HOME: s.home, CLAUDE_CONFIG_DIR: s.claudeDir, ...NO_DOCKER };

  // Get realpath for normalization
  const realRoot = await fs.realpath(s.root);
  const roots = [s.root, realRoot];

  // 1. Run sync first
  const syncResult = runCli(["sync", ...W], { env });
  if (syncResult.code !== 0) {
    throw new Error(`sync failed: ${syncResult.stderr}`);
  }

  // 2. Collect planned files with sha256
  const planned: PlannedEntry[] = [];
  const wsFiles = await walkDir(s.wsRoot);
  for (const rel of wsFiles.sort()) {
    // Skip craftar.yaml and craftar.lock (not planned files)
    if (rel === "craftar.yaml" || rel === "craftar.lock") continue;
    const content = await fs.readFile(path.join(s.wsRoot, rel));
    const sha256 = createHash("sha256").update(content).digest("hex");
    planned.push({ path: rel, sha256 });
  }

  // 3. Run status --json
  const statusResult = runCli(["status", "--json", ...W], { env });
  const status = JSON.parse(statusResult.stdout);

  // 4. Run doctor --json
  const doctorResult = runCli(["doctor", "--json", ...W], { env });
  const doctorJson = JSON.parse(doctorResult.stdout);
  const doctorChecks = (doctorJson.checks as Check[]).map((c) => ({
    id: c.id,
    scope: c.scope,
    level: c.level,
    message: c.message,
    fix: c.fix,
  }));

  const observed: Observed = {
    planned,
    status: normalizePaths(status, roots),
    doctorChecks: normalizePaths(doctorChecks, roots) as Observed["doctorChecks"],
  };

  return observed;
}

/** Recursively list all files in a directory (relative POSIX paths). */
async function walkDir(dir: string, base = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkDir(path.join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

describe("settings-apply baseline pin (spec 52 task 1)", () => {
  it("matches the pinned snapshot — plan, status, and doctor before settings apply", { timeout: 120_000 }, async () => {
    const s = await buildScenario();
    const observed = await buildObserved(s);

    if (process.env.UPDATE_PINS === "1") {
      // Write mode: generate the pin file
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      console.log(`Pin written to ${PIN_FILE}`);
      return;
    }

    // Compare mode: load the pin and compare
    const pinText = await fs.readFile(PIN_FILE, "utf8");
    const expected: Observed = JSON.parse(pinText);

    // Compare planned files
    expect(observed.planned).toEqual(expected.planned);

    // Compare status
    expect(observed.status).toEqual(expected.status);

    // Compare doctor checks without machine-dependent lines
    // NOTE: In task 2, only hooks-registered fix text may change; this comment marks that.
    expect(withoutMachine(observed.doctorChecks)).toEqual(withoutMachine(expected.doctorChecks));
  });

  it("the pin is not vacuous: holds the example settings file with hooks and env", { timeout: 120_000 }, async () => {
    const s = await buildScenario();
    const observed = await buildObserved(s);

    // 1. The planned files include the example settings file
    const exampleFile = observed.planned.find((p) => p.path === ".claude/settings.craftar.example.json");
    expect(exampleFile, "example settings file should be planned").toBeDefined();

    // 2. The example file exists and has the expected content
    const examplePath = path.join(s.wsRoot, ".claude/settings.craftar.example.json");
    const exampleContent = JSON.parse(await fs.readFile(examplePath, "utf8"));

    // env should have ACME_TOKEN
    expect(exampleContent.env).toEqual({ ACME_TOKEN: "" });

    // hooks should have the PreToolUse registration
    expect(exampleContent.hooks).toEqual({
      PreToolUse: [
        {
          matcher: "Bash|PowerShell",
          hooks: [
            {
              type: "command",
              command: "python3",
              args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
              timeout: 10,
            },
          ],
        },
      ],
    });

    // 3. The hook file exists
    const hookFile = observed.planned.find((p) => p.path === ".claude/hooks/guard-path.py");
    expect(hookFile, "hook file should be planned").toBeDefined();

    // 4. The MCP file exists
    const mcpFile = observed.planned.find((p) => p.path === ".mcp.json");
    expect(mcpFile, "MCP file should be planned").toBeDefined();

    // 5. Doctor has hooks-registered check with warn (no settings file)
    const hooksCheck = observed.doctorChecks.find((c) => c.id === "hooks-registered" && c.level === "warn");
    expect(hooksCheck, "hooks-registered should warn when no settings file").toBeDefined();
    expect(hooksCheck!.message).toContain("is in no settings file");
    // The fix text points at the example file
    expect(hooksCheck!.fix).toContain(".claude/settings.craftar.example.json");
  });
});
